import type { Ref } from 'vue'
import { clampVoiceVolume } from './voice-preferences'
import type { VoiceSessionToken } from './voice-session'

export interface VoiceAudioPlaybackPorts {
  outputDeviceId: Ref<string>
  outputVolume: Ref<number>
  isDeafened: Ref<boolean>
  captureSession(): VoiceSessionToken
  isSession(token: VoiceSessionToken): boolean
  isPeerSession(token: VoiceSessionToken, userId: string, pc: RTCPeerConnection): boolean
  hasUser(): boolean
  getUserVolume(userId: string): number
  stopStream(stream: MediaStream | null): void
}

interface RemoteAudio {
  element: HTMLAudioElement
  track: MediaStreamTrack
  retry: ReturnType<typeof setTimeout> | null
  play(): void
}

interface OutputAnalyser {
  source: MediaStreamAudioSourceNode
  analyser: AnalyserNode
  buffer: Uint8Array<ArrayBuffer>
}

interface LocalTone {
  element: HTMLAudioElement
  stream: MediaStream
  context: AudioContext
  tones: { oscillator: OscillatorNode; gain: GainNode }[]
  timer: ReturnType<typeof setTimeout> | null
}

/** Audio elements, routing queues and Web Audio resources belong to one store instance. */
export function createVoiceAudioPlaybackController(ports: VoiceAudioPlaybackPorts) {
  const remoteAudio = new Map<string, RemoteAudio>()
  const outputAnalysers = new Map<string, OutputAnalyser>()
  const localTones = new Set<LocalTone>()
  const ownedElements = new WeakSet<HTMLMediaElement>()
  const sinkChanges = new WeakMap<HTMLMediaElement, Promise<void>>()
  let outputContext: AudioContext | null = null

  function cleanupRemoteAudio(userId: string) {
    const remote = remoteAudio.get(userId)
    if (remote) {
      // Remove ownership before releasing media so queued browser work cannot revive it.
      remoteAudio.delete(userId)
      ownedElements.delete(remote.element)
      if (remote.retry !== null) clearTimeout(remote.retry)
      remote.retry = null
      remote.track.removeEventListener('unmute', remote.play)
      try { remote.element.pause() } catch {}
      remote.element.srcObject = null
      remote.element.remove()
    }
    const resource = outputAnalysers.get(userId)
    try { resource?.source.disconnect() } catch {}
    try { resource?.analyser.disconnect() } catch {}
    outputAnalysers.delete(userId)
  }

  function cleanupRemoteAudioAll() {
    for (const userId of [...remoteAudio.keys()]) cleanupRemoteAudio(userId)
    // Also release a partially installed analyser if a browser operation threw.
    outputAnalysers.forEach(resource => {
      try { resource.source.disconnect() } catch {}
      try { resource.analyser.disconnect() } catch {}
    })
    outputAnalysers.clear()
  }

  function cleanupLocalTone(tone: LocalTone) {
    if (!localTones.delete(tone)) return
    ownedElements.delete(tone.element)
    if (tone.timer !== null) clearTimeout(tone.timer)
    tone.timer = null
    try { tone.element.pause() } catch {}
    tone.element.srcObject = null
    ports.stopStream(tone.stream)
    tone.tones.forEach(({ oscillator, gain }) => {
      try { oscillator.stop() } catch {}
      try { oscillator.disconnect() } catch {}
      try { gain.disconnect() } catch {}
    })
    void tone.context.close().catch(() => {})
  }

  function cleanupLocalTones() {
    for (const tone of [...localTones]) cleanupLocalTone(tone)
  }

  function closeOutputContext() {
    const context = outputContext
    outputContext = null
    if (context) void context.close().catch(() => {})
  }

  function cleanupAll() {
    cleanupRemoteAudioAll()
    cleanupLocalTones()
    closeOutputContext()
  }

  function setElementSink(element: HTMLMediaElement, deviceId: string, token = ports.captureSession()): Promise<void> {
    if (typeof element.setSinkId !== 'function') return Promise.resolve()
    // An old setSinkId promise must settle before a newer device is applied. Queued
    // selections additionally require an element still owned by this controller.
    const change = (sinkChanges.get(element) || Promise.resolve()).catch(() => {}).then(async () => {
      if (!ownedElements.has(element) || !ports.isSession(token) || deviceId !== ports.outputDeviceId.value) return
      try { await element.setSinkId(deviceId) } catch {}
    })
    sinkChanges.set(element, change)
    return change
  }

  function applyRemoteVolume(userId: string) {
    const element = remoteAudio.get(userId)?.element
    if (element) {
      element.volume = ports.isDeafened.value ? 0
        : clampVoiceVolume(ports.outputVolume.value) * clampVoiceVolume(ports.getUserVolume(userId))
    }
  }

  function applyVolumes() {
    remoteAudio.forEach((_, userId) => applyRemoteVolume(userId))
    localTones.forEach(tone => {
      tone.element.volume = ports.isDeafened.value ? 0 : clampVoiceVolume(ports.outputVolume.value)
    })
  }

  function setOutputVolume(value: number) {
    ports.outputVolume.value = clampVoiceVolume(value)
    applyVolumes()
  }

  async function changeOutputDevice(deviceId: string) {
    ports.outputDeviceId.value = deviceId
    const token = ports.captureSession()
    const valid = () => ports.isSession(token) && ports.outputDeviceId.value === deviceId
    for (const [userId, remote] of remoteAudio) {
      if (!valid()) return
      await setElementSink(remote.element, deviceId, token)
      if (!valid()) return
      if (remoteAudio.get(userId) === remote) applyRemoteVolume(userId)
    }
    for (const tone of localTones) {
      if (!valid()) return
      await setElementSink(tone.element, deviceId, token)
    }
  }

  function ensureOutputContext(): AudioContext {
    if (!outputContext || outputContext.state === 'closed') outputContext = new AudioContext()
    if (outputContext.state === 'suspended') void outputContext.resume().catch(() => {})
    return outputContext
  }

  function attachRemoteAudio(userId: string, pc: RTCPeerConnection, event: RTCTrackEvent, token: VoiceSessionToken) {
    const valid = () => ports.isPeerSession(token, userId, pc)
    if (event.track.kind !== 'audio' || !valid()) return
    const track = event.track
    const stream = event.streams[0] || new MediaStream([track])
    const element = document.createElement('audio')
    element.srcObject = stream
    element.autoplay = true
    element.id = `audio-${userId}`
    cleanupRemoteAudio(userId)
    const remote: RemoteAudio = {
      element, track, retry: null,
      play() {
        if (!valid() || remoteAudio.get(userId) !== remote) return
        if (remote.retry !== null) { clearTimeout(remote.retry); remote.retry = null }
        void element.play().catch(() => {
          if (!valid() || remoteAudio.get(userId) !== remote || remote.retry !== null) return
          remote.retry = setTimeout(() => {
            remote.retry = null
            remote.play()
          }, 1000)
        })
      }
    }
    remoteAudio.set(userId, remote)
    ownedElements.add(element)
    document.body.appendChild(element)
    if (ports.outputDeviceId.value) void setElementSink(element, ports.outputDeviceId.value, token)
    applyRemoteVolume(userId)
    remote.play()
    track.addEventListener('unmute', remote.play)
    let source: MediaStreamAudioSourceNode | null = null
    let analyser: AnalyserNode | null = null
    try {
      const context = ensureOutputContext()
      source = context.createMediaStreamSource(stream)
      analyser = context.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      outputAnalysers.set(userId, { source, analyser, buffer: new Uint8Array(analyser.fftSize) })
    } catch {
      try { source?.disconnect() } catch {}
      try { analyser?.disconnect() } catch {}
    }
  }

  function resume() {
    if (outputContext?.state === 'suspended') void outputContext.resume().catch(() => {})
    remoteAudio.forEach(remote => { if (remote.element.paused) remote.play() })
  }

  function getOutputLevel(): number {
    if (!outputAnalysers.size) return 0
    let total = 0
    outputAnalysers.forEach(resource => {
      const { analyser } = resource
      if (resource.buffer.length !== analyser.fftSize) resource.buffer = new Uint8Array(analyser.fftSize)
      const buffer = resource.buffer
      analyser.getByteTimeDomainData(buffer)
      let sum = 0
      for (const sample of buffer) {
        const value = (sample - 128) / 128
        sum += value * value
      }
      total += Math.min(1, Math.sqrt(sum / buffer.length) * 4)
    })
    return total / outputAnalysers.size
  }

  // Local prompts use their own destination and audio element; no node is
  // connected to the microphone pipeline or to a peer's sending track.
  function playLocalTone(frequencies: number[], volume = 0.15) {
    if (ports.isDeafened.value || !ports.hasUser()) return
    let tone: LocalTone | null = null
    let context: AudioContext | null = null
    try {
      context = new AudioContext()
      if (context.state === 'suspended') void context.resume().catch(() => {})
      const startTime = context.currentTime
      const destination = context.createMediaStreamDestination()
      const element = new Audio()
      element.srcObject = destination.stream
      element.volume = clampVoiceVolume(ports.outputVolume.value)
      tone = { element, stream: destination.stream, context, tones: [], timer: null }
      localTones.add(tone)
      ownedElements.add(element)
      for (const [index, frequency] of frequencies.entries()) {
        const start = startTime + index * 0.1
        const duration = 0.12
        const oscillator = context.createOscillator()
        const gain = context.createGain()
        tone.tones.push({ oscillator, gain })
        oscillator.type = 'sine'
        oscillator.frequency.value = frequency
        gain.gain.setValueAtTime(0, start)
        gain.gain.linearRampToValueAtTime(volume, start + 0.015)
        gain.gain.setValueAtTime(volume, start + duration - 0.04)
        gain.gain.linearRampToValueAtTime(0, start + duration)
        oscillator.connect(gain)
        gain.connect(destination)
        oscillator.start(start)
        oscillator.stop(start + duration + 0.05)
      }
      if (ports.outputDeviceId.value) void setElementSink(element, ports.outputDeviceId.value)
      const activeTone = tone
      void element.play().catch(() => cleanupLocalTone(activeTone))
      tone.timer = setTimeout(() => cleanupLocalTone(activeTone), frequencies.length * 100 + 300)
    } catch {
      if (tone) cleanupLocalTone(tone)
      else if (context) void context.close().catch(() => {})
    }
  }

  function playTestSound(id: number) {
    playLocalTone(id === 1 ? [880] : [440, 660])
  }

  function playSystemTone(kind: 'enter' | 'exit' | 'mute' | 'unmute') {
    if (kind === 'enter') playLocalTone([880, 1320])
    else if (kind === 'exit') playLocalTone([1320, 880])
    else if (kind === 'mute') playLocalTone([440])
    else if (kind === 'unmute') playLocalTone([660])
  }

  return {
    attachRemoteAudio, cleanupRemoteAudio, cleanupRemoteAudioAll, cleanupLocalTones,
    closeOutputContext, cleanupAll, resume, changeOutputDevice, setOutputVolume,
    applyRemoteVolume, applyVolumes, playLocalTone, playTestSound, playSystemTone, getOutputLevel
  }
}
