import { markRaw, type Ref } from 'vue'
import type { VoiceSessionToken, VoiceSignalMessage } from './voice-session'

export interface VoiceMicrophoneControllerPorts {
  localStream: Ref<MediaStream | null>
  inputDeviceId: Ref<string>
  inputVolume: Ref<number>
  micAvailable: Ref<boolean>
  micError: Ref<string>
  micChanging: Ref<boolean>
  peerConnections: Ref<Map<string, RTCPeerConnection>>
  sessionToken: () => VoiceSessionToken
  isSession: (token: VoiceSessionToken) => boolean
  isPeerSession: (token: VoiceSessionToken, userId: string, pc: RTCPeerConnection) => boolean
  isTransmitting: () => boolean
  releasePushToTalk: () => void
  sendVoice: (message: VoiceSignalMessage) => void
  stopStream: (stream: MediaStream | null) => void
}

/** Owns microphone capture and processing; playback never connects to this graph. */
export function createVoiceMicrophoneController(ports: VoiceMicrophoneControllerPorts) {
  const { localStream, inputDeviceId, inputVolume, micAvailable, micError, micChanging,
    peerConnections, sessionToken, isSession, isPeerSession, isTransmitting,
    releasePushToTalk, sendVoice, stopStream } = ports
  let micGeneration = 0
  let audioCtx: AudioContext | null = null
  let gainNode: GainNode | null = null
  let micSource: MediaStreamAudioSourceNode | null = null
  let micDest: MediaStreamAudioDestinationNode | null = null
  let sentAudioTrack: MediaStreamTrack | null = null
  let inputAnalyser: AnalyserNode | null = null
  let analyserBuffer: Uint8Array<ArrayBuffer> | null = null
  let micEndedListeners: { track: MediaStreamTrack; handler: () => void }[] = []
  const trackChanges = new WeakMap<RTCRtpSender, Promise<void>>()
  const audioSenders = new WeakMap<RTCPeerConnection, RTCRtpSender>()

  function applyMicEnabled() {
    const enabled = isTransmitting()
    localStream.value?.getAudioTracks().forEach(track => { track.enabled = enabled })
    if (sentAudioTrack) sentAudioTrack.enabled = enabled
  }

  function cleanupMicListeners() {
    micEndedListeners.forEach(({ track, handler }) => track.removeEventListener('ended', handler))
    micEndedListeners = []
  }

  function installMicStream(stream: MediaStream) {
    cleanupMicListeners()
    stopStream(localStream.value)
    localStream.value = markRaw(stream)
    stream.getAudioTracks().forEach(track => {
      const handler = () => {
        // Raw capture can survive a reconnect; its current stream identity owns this listener.
        if (localStream.value !== stream || !sessionToken().roomId || stream.getAudioTracks().some(item => item.readyState === 'live')) return
        micAvailable.value = false
        micError.value = '麦克风已断开，请重新选择设备或重试'
        releasePushToTalk()
        applyMicEnabled()
      }
      track.addEventListener('ended', handler)
      micEndedListeners.push({ track, handler })
    })
  }

  async function ensureMic(token = sessionToken()) {
    if (!isSession(token)) return false
    if (localStream.value?.getAudioTracks().some(track => track.readyState === 'live')) return true
    if (localStream.value) {
      // Retaining a raw stream across rooms does not make an ended device reusable.
      cleanupMicListeners()
      stopStream(localStream.value)
      localStream.value = null
      destroyAudioPipeline()
    }
    const request = ++micGeneration
    micAvailable.value = true
    micError.value = ''
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: inputDeviceId.value ? { deviceId: { exact: inputDeviceId.value } } : true
      })
      stream.getAudioTracks().forEach(track => { track.enabled = false })
      if (!isSession(token) || request !== micGeneration) { stopStream(stream); return false }
      installMicStream(stream)
      applyMicEnabled()
      return true
    } catch (error: unknown) {
      if (!isSession(token) || request !== micGeneration) return false
      micAvailable.value = false
      const failure = error && typeof error === 'object' ? error as { name?: unknown; message?: unknown } : {}
      const message = typeof failure.message === 'string' ? failure.message : ''
      if (failure.name === 'NotFoundError' || message.includes('Requested device not found') || message.includes('device not found')) {
        micError.value = '未检测到麦克风 — 你可以进入频道听别人说话，但无法发言'
      } else if (failure.name === 'NotAllowedError' || failure.name === 'PermissionDeniedError') {
        micError.value = '麦克风权限被拒绝 — 你可以听但无法发言，浏览器地址栏左侧可修改权限'
      } else {
        micError.value = '麦克风不可用 — 进入频道后仅能听'
      }
      return false
    }
  }

  function ensureAudioCtx() {
    try {
      if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AudioContext()
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
    } catch {}
  }

  function resume() {
    if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {})
  }

  function findAudioSender(pc: RTCPeerConnection) {
    return pc.getSenders().find(sender => sender.track?.kind === 'audio') || audioSenders.get(pc) ||
      pc.getTransceivers().find(transceiver => transceiver.receiver.track?.kind === 'audio')?.sender
  }

  function replaceAudioTrack(token: VoiceSessionToken, userId: string, pc: RTCPeerConnection,
    sender: RTCRtpSender, track: MediaStreamTrack) {
    // Pipeline replacement and receive-only recovery share one queue. A new capture
    // must never overtake an earlier native replaceTrack Promise for the same sender.
    const relevant = () => isPeerSession(token, userId, pc) && track === sentAudioTrack && track.readyState === 'live'
    const change = (trackChanges.get(sender) || Promise.resolve()).catch(() => {}).then(async () => {
      if (!relevant()) return
      await sender.replaceTrack(track)
      if (!relevant() && sender.track === track) {
        // Browser media Promises cannot be cancelled. Remove a stale completed
        // replacement before a queued current capture gets its turn to install.
        try { await sender.replaceTrack(null) } catch {}
      }
    })
    trackChanges.set(sender, change)
    return change
  }

  function replaceExistingSenders() {
    const track = sentAudioTrack
    if (!track) return
    const token = sessionToken()
    for (const [userId, pc] of peerConnections.value) {
      if (!isPeerSession(token, userId, pc)) continue
      const sender = findAudioSender(pc)
      if (sender) {
        audioSenders.set(pc, sender)
        void replaceAudioTrack(token, userId, pc, sender, track).catch(() => {})
      }
    }
  }

  function destroyAudioPipeline() {
    try { micSource?.disconnect() } catch {}
    try { gainNode?.disconnect() } catch {}
    try { inputAnalyser?.disconnect() } catch {}
    audioCtx?.close().catch(() => {})
    stopStream(micDest?.stream || null)
    micSource = null
    gainNode = null
    micDest = null
    audioCtx = null
    sentAudioTrack = null
    inputAnalyser = null
    analyserBuffer = null
  }

  function initAudioPipeline() {
    try {
      if (!localStream.value) return
      destroyAudioPipeline()
      ensureAudioCtx()
      if (!audioCtx) throw new Error('Web Audio unavailable')
      gainNode = audioCtx.createGain()
      gainNode.gain.value = inputVolume.value
      micDest = audioCtx.createMediaStreamDestination()
      inputAnalyser = audioCtx.createAnalyser()
      inputAnalyser.fftSize = 512
      analyserBuffer = new Uint8Array(inputAnalyser.fftSize)
      micSource = audioCtx.createMediaStreamSource(localStream.value)
      micSource.connect(gainNode)
      gainNode.connect(inputAnalyser)
      inputAnalyser.connect(micDest)
      sentAudioTrack = micDest.stream.getAudioTracks()[0] || null
      applyMicEnabled()
      replaceExistingSenders()
    } catch (error) {
      console.error('音频处理管线初始化失败', error)
      destroyAudioPipeline()
      sentAudioTrack = localStream.value?.getAudioTracks()[0] || null
      micAvailable.value = !!sentAudioTrack
      micError.value = sentAudioTrack ? '音频增强不可用，已切换为直接发送麦克风' : '音频处理不可用，仅能听'
      applyMicEnabled()
      replaceExistingSenders()
    }
  }

  async function restoreAudioSenders(token = sessionToken(), request = micGeneration) {
    const track = sentAudioTrack
    if (!track) return
    for (const [userId, pc] of peerConnections.value) {
      const valid = () => isPeerSession(token, userId, pc) && request === micGeneration && track === sentAudioTrack && track.readyState === 'live'
      if (!valid()) return
      try {
        let sender = findAudioSender(pc)
        const transceiver = pc.getTransceivers().find(item => item.sender === sender && item.receiver.track?.kind === 'audio')
        if (sender) {
          audioSenders.set(pc, sender)
          await replaceAudioTrack(token, userId, pc, sender, track)
          if (!valid()) return
          if (transceiver) transceiver.direction = 'sendrecv'
        } else {
          sender = pc.addTrack(track, micDest?.stream || new MediaStream([track]))
          audioSenders.set(pc, sender)
        }
        if (!valid()) return
        if (pc.signalingState === 'stable') {
          const offer = await pc.createOffer()
          if (!valid()) return
          await pc.setLocalDescription(offer)
          if (!valid()) return
          sendVoice({ type: 'voice-offer', roomId: token.roomId, targetUserId: userId, data: pc.localDescription })
        }
      } catch {}
    }
  }

  async function captureReplacement(deviceId: string, retry: boolean) {
    const token = sessionToken()
    if (!token.roomId) {
      if (!retry) { inputDeviceId.value = deviceId; releasePushToTalk() }
      return
    }
    const request = ++micGeneration
    releasePushToTalk()
    micChanging.value = true
    applyMicEnabled()
    if (retry) micError.value = ''
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true
      })
      stream.getAudioTracks().forEach(track => { track.enabled = false })
      if (!isSession(token) || request !== micGeneration) { stopStream(stream); return }
      installMicStream(stream)
      if (!retry) inputDeviceId.value = deviceId
      micAvailable.value = true
      micError.value = ''
      applyMicEnabled()
      initAudioPipeline()
      await restoreAudioSenders(token, request)
    } catch {
      if (!isSession(token) || request !== micGeneration) return
      micAvailable.value = !!localStream.value?.getAudioTracks().some(track => track.readyState === 'live')
      micError.value = retry ? '麦克风仍不可用' : '无法切换输入设备，已保持原设备'
      // A later denied picker can supersede a successful capture still waiting on
      // its sender. Finish adopting that current device, including receive-only recovery.
      const needsRestore = micAvailable.value && !!sentAudioTrack && [...peerConnections.value].some(([userId, pc]) => {
        if (!isPeerSession(token, userId, pc)) return false
        const sender = findAudioSender(pc)
        return sender?.track !== sentAudioTrack || pc.getTransceivers().some(item => item.sender === sender && item.direction === 'recvonly')
      })
      if (needsRestore) await restoreAudioSenders(token, request)
    } finally {
      if (isSession(token) && request === micGeneration) { micChanging.value = false; applyMicEnabled() }
    }
  }

  function changeInputDevice(deviceId: string) { return captureReplacement(deviceId, false) }
  function retryMic() { return captureReplacement(inputDeviceId.value, true) }

  function setInputVolume(value: number) {
    inputVolume.value = Number.isFinite(value) ? Math.max(0, Math.min(2, value)) : 1
    if (gainNode && audioCtx) gainNode.gain.setTargetAtTime(inputVolume.value, audioCtx.currentTime, 0.05)
  }

  function getInputLevel() {
    if (!isTransmitting() || !inputAnalyser) return 0
    if (!analyserBuffer || analyserBuffer.length !== inputAnalyser.fftSize) analyserBuffer = new Uint8Array(inputAnalyser.fftSize)
    const buffer = analyserBuffer
    inputAnalyser.getByteTimeDomainData(buffer)
    let sum = 0
    for (const value of buffer) { const sample = (value - 128) / 128; sum += sample * sample }
    return buffer.length ? Math.min(1, Math.sqrt(sum / buffer.length) * 4) : 0
  }

  function attachToPeer(pc: RTCPeerConnection) {
    applyMicEnabled()
    if (localStream.value) {
      if (sentAudioTrack && micDest) audioSenders.set(pc, pc.addTrack(sentAudioTrack, micDest.stream))
      else localStream.value.getAudioTracks().forEach(track => { audioSenders.set(pc, pc.addTrack(track, localStream.value!)) })
    } else {
      try {
        const audio = pc.addTransceiver('audio', { direction: 'recvonly' })
        audioSenders.set(pc, audio.sender)
        pc.addTransceiver('video', { direction: 'recvonly' })
      } catch {}
    }
  }

  function invalidate() { micGeneration++ }

  function cleanup(options?: { keepStream?: boolean }) {
    invalidate()
    localStream.value?.getAudioTracks().forEach(track => { track.enabled = false })
    if (sentAudioTrack) sentAudioTrack.enabled = false
    if (options?.keepStream) return
    cleanupMicListeners()
    stopStream(localStream.value)
    localStream.value = null
    destroyAudioPipeline()
  }

  return { ensureMic, ensureAudioCtx, initAudioPipeline, changeInputDevice, retryMic, setInputVolume,
    applyMicEnabled, resume, getInputLevel, invalidate, cleanup, attachToPeer }
}
