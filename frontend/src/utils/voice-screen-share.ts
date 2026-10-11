import { markRaw, type Ref } from 'vue'
import type { ScreenSenderHealth } from './voice-diagnostics'
import type { VoiceSessionToken } from './voice-session'

export interface ScreenShareOptions { width: number; fps: number }
export interface ScreenSourceResolution { width: number; height: number }
export type ScreenShareMessage =
  | { type: 'screen-share-start' | 'screen-share-stop'; roomId: string | null }
  | { type: 'voice-offer'; roomId: string | null; targetUserId: string; data: RTCSessionDescriptionInit }
export interface ScreenSenderSample { pc: RTCPeerConnection; sender: RTCRtpSender; health: ScreenSenderHealth }

export interface ScreenShareControllerPorts {
  screenStream: Ref<MediaStream | null>
  isScreenSharing: Ref<boolean>
  screenSenders: Ref<Map<string, RTCRtpSender>>
  currentShareOpts: Ref<ScreenShareOptions>
  sourceResolution: Ref<ScreenSourceResolution>
  peerConnections: Ref<Map<string, RTCPeerConnection>>
  sessionToken: () => VoiceSessionToken
  isSession: (token: VoiceSessionToken) => boolean
  isPeerSession: (token: VoiceSessionToken, userId: string, pc: RTCPeerConnection) => boolean
  sendVoice: (message: ScreenShareMessage) => void
  stopStream: (stream: MediaStream | null) => void
}

const sharePresets: Record<string, { label: string; w: number; h: number }> = {
  '0': { label: '源画质', w: 0, h: 0 },
  '1280': { label: '720p', w: 1280, h: 720 },
  '1920': { label: '1080p', w: 1920, h: 1080 },
  '2560': { label: '2K', w: 2560, h: 1440 },
  '3840': { label: '4K', w: 3840, h: 2160 }
}
const bitrateCeilings: Record<string, number> = {
  '0': 10_000_000, '1280': 6_000_000, '1920': 10_000_000,
  '2560': 16_000_000, '3840': 24_000_000
}
const BITRATE_FLOOR = 2_000_000

function bitrateCeilingFor(width: number) { return bitrateCeilings[String(width)] || bitrateCeilings['1920'] }
function snapPresetToSource(width: number, sourceW: number): number {
  if (width <= 0) return 0
  if (sourceW <= 0 || width <= sourceW) return width
  return [3840, 2560, 1920, 1280].find(preset => preset <= sourceW) || 0
}

function applyPreferredVideoCodec(pc: RTCPeerConnection) {
  try {
    const transceiver = pc.getTransceivers().find(entry => entry.sender.track?.kind === 'video')
    const caps = RTCRtpSender.getCapabilities?.('video')
    if (!transceiver || !caps?.codecs?.length || typeof transceiver.setCodecPreferences !== 'function') return
    const preferred: RTCRtpCapabilities['codecs'] = []
    const append = (codec: RTCRtpCapabilities['codecs'][number]) => {
      if (!preferred.some(entry => entry.mimeType === codec.mimeType && entry.sdpFmtpLine === codec.sdpFmtpLine)) preferred.push(codec)
    }
    for (const name of ['H264', 'VP8']) {
      caps.codecs.filter(codec => codec.mimeType.toLowerCase().includes(name.toLowerCase())).forEach(append)
    }
    caps.codecs.filter(codec => !/VP9/i.test(codec.mimeType)).forEach(append)
    if (preferred.length) transceiver.setCodecPreferences(preferred)
  } catch {}
}

export function createScreenShareController(ports: ScreenShareControllerPorts) {
  const { screenStream, isScreenSharing, screenSenders, currentShareOpts, sourceResolution,
    peerConnections, sessionToken, isSession, isPeerSession, sendVoice, stopStream } = ports
  let bitrateLimit = 0
  let goodQualityStreak = 0
  let isSwitching = false
  let screenGeneration = 0
  let qualityGeneration = 0
  let sourceChanges = Promise.resolve()
  const trackChanges = new WeakMap<RTCRtpSender, Promise<void>>()
  const parameterChanges = new WeakMap<RTCRtpSender, Promise<void>>()
  const constraintChanges = new WeakMap<MediaStreamTrack, Promise<void>>()
  const pendingCaptures = new Set<MediaStream>()

  function stopPendingCaptures() {
    pendingCaptures.forEach(stopStream)
    pendingCaptures.clear()
  }

  function shareScaleFor(width: number) {
    return width <= 0 || sourceResolution.value.width <= 0 ? 1 : Math.max(sourceResolution.value.width / width, 1)
  }

  function replaceTrack(sender: RTCRtpSender, track: MediaStreamTrack | null, valid: () => boolean = () => true) {
    const change = (trackChanges.get(sender) || Promise.resolve()).catch(() => {}).then(async () => {
      if (valid()) await sender.replaceTrack(track)
    })
    trackChanges.set(sender, change)
    return change
  }

  function applyTrackConstraints(track: MediaStreamTrack, fps: number, valid: () => boolean, maximum = false) {
    const change = (constraintChanges.get(track) || Promise.resolve()).catch(() => {}).then(async () => {
      if (!valid()) return
      try { await track.applyConstraints({ frameRate: maximum ? { ideal: fps, max: fps } : { ideal: fps } }) } catch {}
    })
    constraintChanges.set(track, change)
    return change
  }

  function applyQuality(sender: RTCRtpSender, maxBitrate: number, maxFramerate: number, scaleResolutionDownBy: number, valid: () => boolean) {
    const change = (parameterChanges.get(sender) || Promise.resolve()).catch(() => {}).then(async () => {
      if (!valid()) return
      try {
        const params = sender.getParameters()
        if (!params.encodings?.length) params.encodings = [{}]
        params.encodings[0].maxBitrate = maxBitrate
        params.encodings[0].maxFramerate = maxFramerate
        params.encodings[0].scaleResolutionDownBy = scaleResolutionDownBy
        params.degradationPreference = 'maintain-framerate'
        await sender.setParameters(params)
      } catch {}
    })
    parameterChanges.set(sender, change)
    return change
  }

  async function applySenderQuality(maxBitrate: number, maxFramerate: number, scale: number, request = qualityGeneration) {
    const token = sessionToken()
    const stream = screenStream.value
    for (const [userId, sender] of screenSenders.value) {
      const pc = peerConnections.value.get(userId)
      const valid = () => request === qualityGeneration && isSession(token) && screenStream.value === stream &&
        !!pc && isPeerSession(token, userId, pc) && screenSenders.value.get(userId) === sender
      if (!valid()) continue
      await applyQuality(sender, maxBitrate, maxFramerate, scale, valid)
    }
  }

  function attachToPeer(userId: string, pc: RTCPeerConnection) {
    const stream = screenStream.value
    if (!stream || !isScreenSharing.value) return
    const token = sessionToken()
    const request = qualityGeneration
    stream.getVideoTracks().forEach(track => {
      const sender = pc.addTrack(track, stream)
      screenSenders.value.set(userId, markRaw(sender))
      void applyQuality(sender, bitrateLimit || bitrateCeilingFor(currentShareOpts.value.width), currentShareOpts.value.fps,
        shareScaleFor(currentShareOpts.value.width), () => request === qualityGeneration && isSession(token) &&
          screenStream.value === stream && screenSenders.value.get(userId) === sender && isPeerSession(token, userId, pc))
      applyPreferredVideoCodec(pc)
    })
  }

  async function startScreenShare(opts: Partial<ScreenShareOptions> = {}) {
    const token = sessionToken()
    if (!token.roomId) return
    const request = ++screenGeneration
    stopPendingCaptures()
    const valid = () => isSession(token) && request === screenGeneration
    currentShareOpts.value = { width: opts.width ?? 1920, fps: opts.fps ?? 30 }
    const preset = sharePresets[String(currentShareOpts.value.width)] || sharePresets['1920']
    const fps = currentShareOpts.value.fps
    let captured: MediaStream | null = null
    let installed = false
    try {
      captured = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: fps } }, audio: false })
      pendingCaptures.add(captured)
      if (!valid()) return
      const stream = captured
      const track = stream.getVideoTracks()[0]
      if (!track) return
      try { track.contentHint = 'motion' } catch {}
      await applyTrackConstraints(track, fps, valid, true)
      if (!valid() || track.readyState === 'ended') return
      // The capture stays locally owned until all asynchronous setup has settled.
      // An obsolete capture must never leave a stopped stream installed in Pinia.
      stopStream(screenStream.value)
      screenStream.value = markRaw(stream)
      isScreenSharing.value = true
      installed = true
      pendingCaptures.delete(stream)
      const settings = track.getSettings()
      sourceResolution.value = { width: settings.width || preset.w || 1920, height: settings.height || preset.h || 1080 }
      currentShareOpts.value = { ...currentShareOpts.value, width: snapPresetToSource(currentShareOpts.value.width, sourceResolution.value.width) }
      bitrateLimit = bitrateCeilingFor(currentShareOpts.value.width)
      goodQualityStreak = 0
      qualityGeneration++
      track.onended = () => { if (isScreenSharing.value && screenStream.value === stream && !isSwitching) stopScreenShare() }
      for (const [userId, pc] of peerConnections.value) {
        if (!valid()) return
        if (!isPeerSession(token, userId, pc)) continue
        const sender = pc.addTrack(track, stream)
        screenSenders.value.set(userId, markRaw(sender))
        applyPreferredVideoCodec(pc)
        const qualityRequest = qualityGeneration
        const peerValid = () => valid() && isPeerSession(token, userId, pc) && screenSenders.value.get(userId) === sender
        await applyQuality(sender, bitrateLimit, currentShareOpts.value.fps, shareScaleFor(currentShareOpts.value.width), () => peerValid() && qualityRequest === qualityGeneration)
        if (!valid()) return
        if (!peerValid()) continue
        const offer = await pc.createOffer({ iceRestart: true })
        if (!valid()) return
        if (!peerValid()) continue
        await pc.setLocalDescription(offer)
        if (!valid()) return
        if (peerValid()) sendVoice({ type: 'voice-offer', roomId: token.roomId, targetUserId: userId, data: offer })
      }
      if (valid()) sendVoice({ type: 'screen-share-start', roomId: token.roomId })
    } catch {
      if (valid() && installed && screenStream.value === captured) stopScreenShare()
    } finally {
      if (captured) pendingCaptures.delete(captured)
      if (captured && (!installed || screenStream.value !== captured)) stopStream(captured)
    }
  }

  async function changeShareQuality(opts: ScreenShareOptions) {
    const stream = screenStream.value
    if (!isScreenSharing.value || !stream) return
    const token = sessionToken()
    const request = ++qualityGeneration
    const valid = () => request === qualityGeneration && isSession(token) && screenStream.value === stream
    const width = snapPresetToSource(opts.width, sourceResolution.value.width)
    currentShareOpts.value = { width, fps: opts.fps }
    bitrateLimit = bitrateCeilingFor(width)
    goodQualityStreak = 0
    const track = stream.getVideoTracks()[0]
    if (track) await applyTrackConstraints(track, opts.fps, valid)
    if (!valid()) return
    await applySenderQuality(bitrateLimit, opts.fps, shareScaleFor(width), request)
  }

  function stopScreenShare() {
    screenGeneration++
    qualityGeneration++
    isSwitching = false
    stopPendingCaptures()
    const stream = screenStream.value
    if (isScreenSharing.value) sendVoice({ type: 'screen-share-stop', roomId: sessionToken().roomId })
    for (const sender of screenSenders.value.values()) void replaceTrack(sender, null).catch(() => {})
    stopStream(stream)
    screenStream.value = null
    isScreenSharing.value = false
    screenSenders.value.clear()
    sourceResolution.value = { width: 0, height: 0 }
    bitrateLimit = 0
    goodQualityStreak = 0
  }

  async function switchScreenSource() {
    const token = sessionToken()
    if (!isScreenSharing.value || !token.roomId) return
    const request = ++screenGeneration
    stopPendingCaptures()
    const valid = () => isSession(token) && request === screenGeneration && isScreenSharing.value
    const fps = currentShareOpts.value.fps
    isSwitching = true
    let captured: MediaStream | null = null
    let installed = false
    try {
      captured = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: fps } }, audio: false })
      pendingCaptures.add(captured)
      captured.getVideoTracks().forEach(track => { track.enabled = false })
      if (!valid()) return
      const newStream = captured
      const newTrack = newStream.getVideoTracks()[0]
      if (!newTrack) return
      try { newTrack.contentHint = 'motion' } catch {}
      await applyTrackConstraints(newTrack, fps, valid, true)
      if (!valid() || newTrack.readyState === 'ended') return
      // Only the replacement/commit phase is serialized. A later picker may open
      // immediately, but cannot overtake an uncancellable replaceTrack promise.
      const change = sourceChanges.catch(() => {}).then(async () => {
        const sourceValid = () => valid() && newTrack.readyState !== 'ended'
        if (!sourceValid()) return
        const replaced: { userId: string; pc: RTCPeerConnection; sender: RTCRtpSender }[] = []
        try {
          for (const [userId, sender] of screenSenders.value) {
            if (!sourceValid()) return
            const pc = peerConnections.value.get(userId)
            if (!pc || !isPeerSession(token, userId, pc)) continue
            const peerValid = () => sourceValid() && isPeerSession(token, userId, pc) && screenSenders.value.get(userId) === sender
            await replaceTrack(sender, newTrack, peerValid)
            replaced.push({ userId, pc, sender })
            if (!sourceValid()) return
          }
          if (!sourceValid()) return
          stopStream(screenStream.value)
          screenStream.value = markRaw(newStream)
          installed = true
          pendingCaptures.delete(newStream)
          newTrack.enabled = true
          const settings = newTrack.getSettings()
          sourceResolution.value = { width: settings.width || 1920, height: settings.height || 1080 }
          newTrack.onended = () => { if (isScreenSharing.value && screenStream.value === newStream && !isSwitching) stopScreenShare() }
          await changeShareQuality(currentShareOpts.value)
        } finally {
          // Cancelled or obsolete transactions restore the still-current source.
          // The next source transaction waits for this rollback before replacing.
          if (!installed) {
            for (const { userId, pc, sender } of replaced) {
              const stillOwned = () => isPeerSession(token, userId, pc) && screenSenders.value.get(userId) === sender
              if (!stillOwned()) continue
              const currentTrack = isScreenSharing.value ? screenStream.value?.getVideoTracks()[0] || null : null
              try { await replaceTrack(sender, currentTrack, stillOwned) } catch {}
            }
          }
        }
      })
      sourceChanges = change
      await change
    } catch {
      // Cancelling the picker preserves the current capture.
    } finally {
      if (captured) pendingCaptures.delete(captured)
      if (captured && !installed) stopStream(captured)
      if (request === screenGeneration) {
        isSwitching = false
        if (isScreenSharing.value && !screenStream.value?.getVideoTracks().some(track => track.readyState === 'live')) stopScreenShare()
      }
    }
  }

  function adaptBitrate(senderHealth: Map<string, ScreenSenderSample>, sharedStream: MediaStream | null) {
    if (!isScreenSharing.value || isSwitching || sharedStream !== screenStream.value || screenSenders.value.size === 0 || bitrateLimit <= 0) return
    const sharedTrack = sharedStream?.getVideoTracks()[0]
    const ceiling = bitrateCeilingFor(currentShareOpts.value.width)
    const actualSenders = [...screenSenders.value.entries()].filter(([, sender]) => sender.track === sharedTrack && sharedTrack?.readyState !== 'ended')
    const health = actualSenders.map(([userId, sender]) => {
      const sample = senderHealth.get(userId)
      return sample?.sender === sender && sample.pc === peerConnections.value.get(userId) ? sample.health : null
    })
    const poor = health.some(sample => sample && ((sample.lossPercent !== null && sample.lossPercent > 5) || (sample.rttMs !== null && sample.rttMs > 300)))
    const good = health.length > 0 && health.every(sample => sample && sample.lossPercent !== null && sample.rttMs !== null && sample.lossPercent < 2 && sample.rttMs < 150)
    if (poor) {
      const next = Math.max(Math.round(bitrateLimit * 0.7), BITRATE_FLOOR)
      goodQualityStreak = 0
      if (next < bitrateLimit) { bitrateLimit = next; void applySenderQuality(next, currentShareOpts.value.fps, shareScaleFor(currentShareOpts.value.width)) }
    } else if (good) {
      goodQualityStreak++
      if (goodQualityStreak >= 3 && bitrateLimit < ceiling) {
        const next = Math.min(Math.round(bitrateLimit * 1.3), ceiling)
        if (next > bitrateLimit) { bitrateLimit = next; void applySenderQuality(next, currentShareOpts.value.fps, shareScaleFor(currentShareOpts.value.width)) }
        goodQualityStreak = 0
      }
    } else goodQualityStreak = 0
  }

  return { sharePresets, startScreenShare, changeShareQuality, stopScreenShare, switchScreenSource, attachToPeer, adaptBitrate }
}
