import { markRaw, type Ref } from 'vue'
import type { VoiceSessionToken, VoiceSignalMessage } from './voice-session'

/** The store owns observable state; this controller owns connection resources. */
export interface VoicePeerPorts {
  connections: Ref<Map<string, RTCPeerConnection>>
  captureSession(): VoiceSessionToken
  isPeerSession(token: VoiceSessionToken, userId: string, pc: RTCPeerConnection): boolean
  canSignal(): boolean
  send(message: VoiceSignalMessage): void
  attachLocalTracks(userId: string, pc: RTCPeerConnection): void
  onTrack(userId: string, pc: RTCPeerConnection, event: RTCTrackEvent, token: VoiceSessionToken): void
  onConnectionStateChange(userId: string, pc: RTCPeerConnection): void
  onIceConnectionStateChange(userId: string, pc: RTCPeerConnection): void
  onPeerCreated(userId: string, pc: RTCPeerConnection): void
  onPeerCleanup(userId: string): void
}

interface ReconnectJob {
  pc: RTCPeerConnection
  timer: ReturnType<typeof setTimeout>
}

export function createVoicePeerController(ports: VoicePeerPorts) {
  const fallbackIceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]
  let iceServersCache: RTCIceServer[] | null = null
  let iceServersLoading: Promise<void> | null = null
  const reconnectTimers = new Map<string, ReconnectJob>()
  const reconnectAttempts = new Map<string, number>()

  async function ensureIceServers(): Promise<void> {
    if (iceServersCache) return
    if (!iceServersLoading) {
      iceServersLoading = (async () => {
        try {
          const response = await fetch('/api/config')
          const config: { iceServers?: RTCIceServer[] } = await response.json()
          if (Array.isArray(config.iceServers) && config.iceServers.length > 0) {
            iceServersCache = config.iceServers
            return
          }
        } catch {}
        iceServersCache = fallbackIceServers
      })().finally(() => { iceServersLoading = null })
    }
    await iceServersLoading
  }

  function clearReconnect(userId: string) {
    const job = reconnectTimers.get(userId)
    if (job) clearTimeout(job.timer)
    reconnectTimers.delete(userId)
    reconnectAttempts.delete(userId)
  }

  function scheduleReconnect(userId: string, pc: RTCPeerConnection) {
    if (reconnectTimers.has(userId)) return
    const token = ports.captureSession()
    if (!ports.isPeerSession(token, userId, pc)) return
    const attempt = (reconnectAttempts.get(userId) || 0) + 1
    if (attempt > 3) return
    reconnectAttempts.set(userId, attempt)
    const job: ReconnectJob = {
      pc,
      timer: setTimeout(async () => {
        // A callback already queued before cleanup must not remove a new peer's timer.
        if (reconnectTimers.get(userId) !== job) return
        reconnectTimers.delete(userId)
        if (!ports.isPeerSession(token, userId, pc)) return
        if (pc.connectionState === 'connected') {
          reconnectAttempts.delete(userId)
          return
        }
        if (!ports.canSignal()) return
        try {
          const offer = await pc.createOffer({ iceRestart: true })
          if (!ports.isPeerSession(token, userId, pc)) return
          await pc.setLocalDescription(offer)
          if (!ports.isPeerSession(token, userId, pc)) return
          ports.send({ type: 'voice-offer', roomId: token.roomId, targetUserId: userId, data: pc.localDescription })
        } catch {}
      }, 2000 * attempt)
    }
    reconnectTimers.set(userId, job)
  }

  function getOrCreatePeerConnection(userId: string): RTCPeerConnection {
    const existing = ports.connections.value.get(userId)
    if (existing) return existing
    const token = ports.captureSession()
    const pc = markRaw(new RTCPeerConnection({ iceServers: iceServersCache || fallbackIceServers }))
    const valid = () => ports.isPeerSession(token, userId, pc)
    try {
      ports.attachLocalTracks(userId, pc)
    } catch (error) {
      try { pc.close() } catch {}
      ports.onPeerCleanup(userId)
      throw error
    }

    pc.onicecandidate = event => {
      if (event.candidate && valid()) {
        ports.send({ type: 'voice-ice-candidate', roomId: token.roomId, targetUserId: userId, data: event.candidate })
      }
    }
    pc.ontrack = event => {
      if (valid()) ports.onTrack(userId, pc, event, token)
    }
    pc.onconnectionstatechange = () => {
      if (!valid()) return
      ports.onConnectionStateChange(userId, pc)
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') scheduleReconnect(userId, pc)
      if (pc.connectionState === 'connected') clearReconnect(userId)
    }
    pc.oniceconnectionstatechange = () => {
      if (valid()) ports.onIceConnectionStateChange(userId, pc)
    }

    ports.connections.value.set(userId, pc)
    ports.onPeerCreated(userId, pc)
    return pc
  }

  function cleanupPeer(userId: string) {
    const pc = ports.connections.value.get(userId)
    // Remove identity before closing, so synchronous browser callbacks are stale too.
    ports.connections.value.delete(userId)
    clearReconnect(userId)
    try { pc?.close() } catch {}
    ports.onPeerCleanup(userId)
  }

  function cleanupAll() {
    const users = new Set([...ports.connections.value.keys(), ...reconnectTimers.keys(), ...reconnectAttempts.keys()])
    for (const userId of users) cleanupPeer(userId)
    reconnectTimers.clear()
    reconnectAttempts.clear()
  }

  return { ensureIceServers, getOrCreatePeerConnection, cleanupPeer, cleanupAll }
}
