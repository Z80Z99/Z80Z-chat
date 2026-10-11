import type { Ref } from 'vue'
import {
  emptyPeerDiagnostics, extractPeerDiagnostics, extractScreenSenderHealth, normalizePlaybackReport,
  type PeerDiagnostics, type PeerStatsBaseline, type ScreenPlaybackDiagnostics, type ScreenPlaybackReport
} from './voice-diagnostics'
import type { ScreenSenderSample } from './voice-screen-share'
import type { VoiceSessionToken } from './voice-session'

export interface VoiceConnectionStats {
  rtt: number
  packetsLost: number
  totalPackets: number
  lossRate: number
  quality: 'good' | 'fair' | 'poor' | 'unknown'
  cpuCores: number
  outBitrate: number
  outFps: number
  outWidth: number
  outHeight: number
  outLossRate: number
  inBitrate: number
  inFps: number
  inWidth: number
  inHeight: number
  inLossRate: number
}

interface RemoteScreenEntry {
  userId: string
  stream: MediaStream
  ts: number
}

export interface VoiceStatisticsPorts {
  connectionStats: Ref<VoiceConnectionStats>
  diagnosticsEnabled: Ref<boolean>
  peerDiagnostics: Ref<Record<string, PeerDiagnostics>>
  screenPlayback: Ref<Record<string, ScreenPlaybackDiagnostics>>
  peerConnections: Ref<Map<string, RTCPeerConnection>>
  remoteScreens: Ref<RemoteScreenEntry[]>
  screenStream: Ref<MediaStream | null>
  isScreenSharing: Ref<boolean>
  screenSenders: Ref<Map<string, RTCRtpSender>>
  inputLevel: Ref<number>
  outputLevel: Ref<number>
  sessionToken(): VoiceSessionToken
  isSession(token: VoiceSessionToken): boolean
  isPeerSession(token: VoiceSessionToken, userId: string, pc: RTCPeerConnection): boolean
  getInputLevel(): number
  getOutputLevel(): number
  isTransmitting(): boolean
  isDeafened(): boolean
  adaptBitrate(samples: Map<string, ScreenSenderSample>, stream: MediaStream | null): void
}

export function emptyConnectionStats(): VoiceConnectionStats {
  return {
    rtt: 0, packetsLost: 0, totalPackets: 0, lossRate: 0, quality: 'unknown',
    cpuCores: navigator.hardwareConcurrency || 0,
    outBitrate: 0, outFps: 0, outWidth: 0, outHeight: 0, outLossRate: 0,
    inBitrate: 0, inFps: 0, inWidth: 0, inHeight: 0, inLossRate: 0
  }
}

function updateQualityFromRtt(rtt: number, lossRate: number): VoiceConnectionStats['quality'] {
  if (rtt > 300 || lossRate > 5) return 'poor'
  if (rtt > 150 || lossRate > 2) return 'fair'
  if (rtt > 0) return 'good'
  return 'unknown'
}

/** Polling resources belong to one voice store; observable state remains in its refs. */
export function createVoiceStatisticsController(ports: VoiceStatisticsPorts) {
  const { connectionStats, diagnosticsEnabled, peerDiagnostics, screenPlayback, peerConnections,
    remoteScreens, screenStream, isScreenSharing, screenSenders, inputLevel, outputLevel,
    sessionToken, isSession, isPeerSession } = ports
  let statsTimer: ReturnType<typeof setInterval> | null = null
  let levelTimer: ReturnType<typeof setInterval> | null = null
  let statsGeneration = 0
  let levelGeneration = 0
  let statsInFlight: Promise<void> | null = null
  let diagnosticsGeneration = 0
  const diagnosticBaselines = new Map<string, { pc: RTCPeerConnection; baseline: PeerStatsBaseline }>()
  let prevBytesOut = 0
  let prevBytesIn = 0
  let prevTs = 0

  function resetDiagnostics() {
    diagnosticsGeneration++
    peerDiagnostics.value = {}
    screenPlayback.value = {}
    diagnosticBaselines.clear()
  }

  function setDiagnosticsEnabled(enabled: boolean) {
    if (diagnosticsEnabled.value === enabled) return
    diagnosticsEnabled.value = enabled
    diagnosticsGeneration++
    diagnosticBaselines.clear()
    peerDiagnostics.value = {}
    if (enabled && sessionToken().roomId) {
      for (const [userId, pc] of peerConnections.value) {
        peerDiagnostics.value[userId] = emptyPeerDiagnostics(userId, pc, screenPlayback.value[userId] || null)
      }
      void pollStats()
    }
  }

  function clearScreenPlayback(userId: string) {
    const { [userId]: removed, ...remaining } = screenPlayback.value
    screenPlayback.value = remaining
    if (peerDiagnostics.value[userId]) {
      peerDiagnostics.value[userId] = { ...peerDiagnostics.value[userId], playback: null }
    }
  }

  function reportScreenPlayback(userId: string, payload: ScreenPlaybackReport | null, stream: MediaStream) {
    const token = sessionToken()
    if (!token.roomId || !token.userId || !remoteScreens.value.some(entry => entry.userId === userId && entry.stream === stream)) return
    if (payload === null) {
      clearScreenPlayback(userId)
      return
    }
    const playback = normalizePlaybackReport(payload)
    screenPlayback.value = { ...screenPlayback.value, [userId]: playback }
    if (diagnosticsEnabled.value && peerDiagnostics.value[userId]) {
      peerDiagnostics.value[userId] = { ...peerDiagnostics.value[userId], playback }
    }
  }

  function syncDiagnosticState(userId: string, pc: RTCPeerConnection) {
    if (!diagnosticsEnabled.value || !sessionToken().roomId || peerConnections.value.get(userId) !== pc) return
    const state = emptyPeerDiagnostics(userId, pc, screenPlayback.value[userId] || null)
    const previous = peerDiagnostics.value[userId]
    peerDiagnostics.value = { ...peerDiagnostics.value, [userId]: previous
      ? { ...previous, connectionState: state.connectionState, iceConnectionState: state.iceConnectionState }
      : state }
  }

  function peerCreated(userId: string, pc: RTCPeerConnection) {
    diagnosticBaselines.delete(userId)
    if (diagnosticsEnabled.value) {
      peerDiagnostics.value = { ...peerDiagnostics.value, [userId]: emptyPeerDiagnostics(userId, pc) }
    }
  }

  function cleanupPeer(userId: string) {
    clearScreenPlayback(userId)
    const { [userId]: removed, ...remaining } = peerDiagnostics.value
    peerDiagnostics.value = remaining
    diagnosticBaselines.delete(userId)
  }

  function startLevelPolling() {
    stopLevelPolling()
    const generation = levelGeneration
    levelTimer = setInterval(() => {
      if (generation !== levelGeneration) return
      const targetIn = ports.isTransmitting() ? ports.getInputLevel() : 0
      inputLevel.value += (targetIn - inputLevel.value) * 0.35
      const targetOut = ports.isDeafened() ? 0 : ports.getOutputLevel()
      outputLevel.value += (targetOut - outputLevel.value) * 0.35
    }, 80)
  }

  function stopLevelPolling() {
    levelGeneration++
    if (levelTimer !== null) clearInterval(levelTimer)
    levelTimer = null
  }

  function startStatsPolling() {
    stopStatsPolling()
    prevBytesOut = 0
    prevBytesIn = 0
    prevTs = 0
    const generation = statsGeneration
    statsTimer = setInterval(() => {
      if (generation === statsGeneration) return pollStats()
    }, 2000)
  }

  function stopStatsPolling() {
    statsGeneration++
    if (statsTimer !== null) clearInterval(statsTimer)
    statsTimer = null
    connectionStats.value = emptyConnectionStats()
  }

  async function pollStats() {
    // getStats cannot be cancelled. Keep the outstanding collection across room
    // changes so a pending browser request never creates overlapping pollers.
    if (statsInFlight) return statsInFlight
    const work = collectStats()
    statsInFlight = work
    try { await work } finally { if (statsInFlight === work) statsInFlight = null }
  }

  async function collectStats() {
    const token = sessionToken()
    const generation = statsGeneration
    const detailedGeneration = diagnosticsGeneration
    const detailed = diagnosticsEnabled.value
    const valid = () => isSession(token) && generation === statsGeneration
    if (!token.roomId || !valid()) return
    if (peerConnections.value.size === 0) {
      connectionStats.value.quality = connectionStats.value.rtt > 0
        ? updateQualityFromRtt(connectionStats.value.rtt, connectionStats.value.lossRate)
        : 'fair'
      return
    }

    let bestRtt = 0, foundCp = false
    let outVideo: any = null, inVideo: any = null
    let audioIn: any = null, audioOut: any = null
    const sharedStream = screenStream.value
    const sharedTrack = sharedStream?.getVideoTracks()[0]
    const senderHealth = new Map<string, ScreenSenderSample>()

    for (const [userId, pc] of peerConnections.value) {
      try {
        const report = await pc.getStats()
        if (!valid()) return
        if (!isPeerSession(token, userId, pc)) continue
        const screenSender = screenSenders.value.get(userId)
        if (isScreenSharing.value && sharedTrack && sharedStream === screenStream.value && screenSender?.track === sharedTrack) {
          senderHealth.set(userId, { pc, sender: screenSender, health: extractScreenSenderHealth(report, sharedTrack.id) })
        }
        if (detailed && diagnosticsEnabled.value && detailedGeneration === diagnosticsGeneration) {
          const previous = diagnosticBaselines.get(userId)
          const result = extractPeerDiagnostics(userId, pc, report, previous?.pc === pc ? previous.baseline : undefined)
          result.diagnostics.playback = screenPlayback.value[userId] || null
          diagnosticBaselines.set(userId, { pc, baseline: result.baseline })
          peerDiagnostics.value = { ...peerDiagnostics.value, [userId]: result.diagnostics }
        }
        report.forEach((stat: any) => {
          if (stat.type === 'candidate-pair' && (stat.state === 'succeeded' || stat.state === 'in-progress')) {
            foundCp = true
            const v = Math.round(stat.currentRoundTripTime * 1000) || 0
            if (v > 0 && (!bestRtt || v < bestRtt)) bestRtt = v
          }
          if (stat.type === 'outbound-rtp' && stat.kind === 'video' && (!outVideo || (stat.bytesSent || 0) > (outVideo.bytesSent || 0))) {
            outVideo = stat
          }
          if (stat.type === 'inbound-rtp' && stat.kind === 'video' && (!inVideo || (stat.bytesReceived || 0) > (inVideo.bytesReceived || 0))) {
            inVideo = stat
          }
          if (stat.type === 'inbound-rtp' && stat.kind === 'audio' && !audioIn) audioIn = stat
          if (stat.type === 'outbound-rtp' && stat.kind === 'audio' && !audioOut) audioOut = stat
        })
      } catch {
        if (!valid()) return
        if (detailed && diagnosticsEnabled.value && detailedGeneration === diagnosticsGeneration && isPeerSession(token, userId, pc)) {
          const unavailable = emptyPeerDiagnostics(userId, pc, screenPlayback.value[userId] || null)
          unavailable.error = '浏览器暂未提供连接统计'
          peerDiagnostics.value = { ...peerDiagnostics.value, [userId]: unavailable }
          diagnosticBaselines.delete(userId)
        }
      }
    }

    if (!valid()) return
    connectionStats.value.rtt = bestRtt
    const now = Date.now()
    const dt = prevTs > 0 ? (now - prevTs) / 1000 : 0

    if (outVideo) {
      const tp = outVideo.packetsSent || 0
      connectionStats.value.outLossRate = tp > 0 ? Math.round(((outVideo.packetsLost || 0) / tp) * 100) : 0
      connectionStats.value.outWidth = outVideo.frameWidth || 0
      connectionStats.value.outHeight = outVideo.frameHeight || 0
      connectionStats.value.outFps = Math.round(outVideo.framesPerSecond) || 0
      if (prevTs > 0 && outVideo.bytesSent > prevBytesOut && dt > 0) {
        connectionStats.value.outBitrate = Math.round(((outVideo.bytesSent - prevBytesOut) * 8) / dt / 1000)
      }
      prevBytesOut = outVideo.bytesSent
    } else if (isScreenSharing.value && screenStream.value) {
      const settings = screenStream.value.getVideoTracks()[0]?.getSettings()
      if (settings?.width) connectionStats.value.outWidth = settings.width
      if (settings?.height) connectionStats.value.outHeight = settings.height
      if (settings?.frameRate) connectionStats.value.outFps = Math.round(settings.frameRate)
    } else {
      connectionStats.value.outBitrate = 0
      connectionStats.value.outLossRate = 0
      connectionStats.value.outWidth = 0
      connectionStats.value.outHeight = 0
      connectionStats.value.outFps = 0
    }

    if (inVideo) {
      const tp = inVideo.packetsReceived || 0
      connectionStats.value.inLossRate = tp > 0 ? Math.round(((inVideo.packetsLost || 0) / tp) * 100) : 0
      connectionStats.value.inWidth = inVideo.frameWidth || 0
      connectionStats.value.inHeight = inVideo.frameHeight || 0
      connectionStats.value.inFps = Math.round(inVideo.framesPerSecond) || 0
      if (prevTs > 0 && inVideo.bytesReceived > prevBytesIn && dt > 0) {
        connectionStats.value.inBitrate = Math.round(((inVideo.bytesReceived - prevBytesIn) * 8) / dt / 1000)
      }
      prevBytesIn = inVideo.bytesReceived
    } else {
      connectionStats.value.inBitrate = 0
      connectionStats.value.inLossRate = 0
      connectionStats.value.inWidth = 0
      connectionStats.value.inHeight = 0
      connectionStats.value.inFps = 0
    }

    const audioStats = audioIn || audioOut
    if (audioStats) {
      const tp = audioStats.packetsSent ?? audioStats.packetsReceived ?? 0
      connectionStats.value.packetsLost = audioStats.packetsLost ?? 0
      connectionStats.value.totalPackets = tp
      connectionStats.value.lossRate = tp > 0 ? Math.round(((audioStats.packetsLost || 0) / tp) * 100) : 0
    } else if (outVideo || inVideo) {
      connectionStats.value.lossRate = Math.max(connectionStats.value.outLossRate, connectionStats.value.inLossRate)
    }

    prevTs = now
    const quality = updateQualityFromRtt(connectionStats.value.rtt, connectionStats.value.lossRate)
    if (quality !== 'unknown') connectionStats.value.quality = quality
    else if (foundCp) connectionStats.value.quality = 'fair'
    ports.adaptBitrate(senderHealth, sharedStream)
  }

  return {
    startStatsPolling, stopStatsPolling, pollStats, startLevelPolling, stopLevelPolling,
    resetDiagnostics, setDiagnosticsEnabled, reportScreenPlayback, syncDiagnosticState,
    peerCreated, cleanupPeer, clearScreenPlayback, cleanupRemoteScreen: clearScreenPlayback
  }
}
