import type { Ref } from 'vue'
import type { VoiceSessionToken, VoiceSignalMessage } from './voice-session'

export interface VoiceSignalingPorts {
  connections: Ref<Map<string, RTCPeerConnection>>
  captureSession(): VoiceSessionToken
  isPeerSession(token: VoiceSessionToken, userId: string, pc: RTCPeerConnection): boolean
  canSignal(): boolean
  send(message: VoiceSignalMessage): void
  getOrCreatePeerConnection(userId: string): RTCPeerConnection
  cleanupPeer(userId: string): void
  hasLocalScreen(): boolean
}

type InboundSignal =
  | { type: 'voice-offer' | 'voice-answer'; userId: string; roomId?: string | null; data: RTCSessionDescriptionInit }
  | { type: 'voice-ice-candidate'; userId: string; roomId?: string | null; data: RTCIceCandidateInit }

function parseSignal(value: unknown): InboundSignal | null {
  if (!value || typeof value !== 'object') return null
  const message = value as Record<string, unknown>
  if (typeof message.userId !== 'string' || !message.userId) return null
  if (message.roomId !== undefined && message.roomId !== null && typeof message.roomId !== 'string') return null
  if (!message.data || typeof message.data !== 'object') return null
  const data = message.data as Record<string, unknown>
  if (message.type === 'voice-offer' || message.type === 'voice-answer') {
    if (data.type !== (message.type === 'voice-offer' ? 'offer' : 'answer')) return null
    if (data.sdp !== undefined && typeof data.sdp !== 'string') return null
    return {
      type: message.type, userId: message.userId, roomId: message.roomId as string | null | undefined,
      data: data as unknown as RTCSessionDescriptionInit
    }
  }
  if (message.type === 'voice-ice-candidate') {
    if (data.candidate !== undefined && typeof data.candidate !== 'string') return null
    return {
      type: message.type, userId: message.userId, roomId: message.roomId as string | null | undefined,
      data: data as RTCIceCandidateInit
    }
  }
  return null
}

export function createVoiceSignalingController(ports: VoiceSignalingPorts) {
  // Candidate and refresh state belongs to this exact connection, not just its user ID.
  const pendingCandidates = new Map<string, { pc: RTCPeerConnection; candidates: RTCIceCandidateInit[] }>()
  const screenRefreshes = new Map<string, RTCPeerConnection>()

  async function flushPendingCandidates(userId: string, pc: RTCPeerConnection, token: VoiceSessionToken) {
    const pending = pendingCandidates.get(userId)
    if (!pending || pending.pc !== pc) return
    pendingCandidates.delete(userId)
    for (const candidate of pending.candidates) {
      if (!ports.isPeerSession(token, userId, pc)) return
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)) } catch {}
    }
  }

  function handleSignal(value: unknown): void {
    if (!ports.canSignal()) return
    const signal = parseSignal(value)
    if (!signal) return
    const token = ports.captureSession()
    if (!token.roomId || signal.userId === token.userId || (signal.roomId && signal.roomId !== token.roomId)) return
    const pc = ports.getOrCreatePeerConnection(signal.userId)
    const valid = () => ports.isPeerSession(token, signal.userId, pc)
    if (!valid()) return
    switch (signal.type) {
      case 'voice-offer': {
        const polite = token.userId < signal.userId
        void (async () => {
          try {
            if (pc.signalingState === 'have-local-offer') {
              if (!polite) return
              await pc.setLocalDescription({ type: 'rollback' })
              if (!valid()) return
            }
            await pc.setRemoteDescription(new RTCSessionDescription(signal.data))
            if (!valid()) return
            await flushPendingCandidates(signal.userId, pc, token)
            if (!valid()) return
            const answer = await pc.createAnswer()
            if (!valid()) return
            await pc.setLocalDescription(answer)
            if (!valid()) return
            ports.send({ type: 'voice-answer', roomId: token.roomId, targetUserId: signal.userId, data: answer })
          } catch {}
        })()
        break
      }
      case 'voice-answer': {
        void (async () => {
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(signal.data))
            if (!valid()) return
            await flushPendingCandidates(signal.userId, pc, token)
          } catch {}
        })()
        break
      }
      case 'voice-ice-candidate': {
        void (async () => {
          try {
            const candidate = new RTCIceCandidate(signal.data)
            if (!valid()) return
            if (!pc.remoteDescription) {
              let pending = pendingCandidates.get(signal.userId)
              if (!pending || pending.pc !== pc) {
                pending = { pc, candidates: [] }
                pendingCandidates.set(signal.userId, pending)
              }
              pending.candidates.push(signal.data)
            } else {
              await pc.addIceCandidate(candidate)
            }
          } catch {}
        })()
        break
      }
    }
  }

  async function createOffer(userId: string): Promise<void> {
    if (!ports.canSignal() || !userId) return
    const token = ports.captureSession()
    if (!token.roomId || userId === token.userId) return
    // Rebuilding while sharing attaches the current screen to a reconnecting receiver.
    if (ports.hasLocalScreen()) {
      if (ports.connections.value.has(userId)) ports.cleanupPeer(userId)
      const pc = ports.getOrCreatePeerConnection(userId)
      const offer = await pc.createOffer()
      if (!ports.isPeerSession(token, userId, pc)) return
      await pc.setLocalDescription(offer)
      if (!ports.isPeerSession(token, userId, pc)) return
      ports.send({ type: 'voice-offer', roomId: token.roomId, targetUserId: userId, data: offer })
      return
    }
    const pc = ports.getOrCreatePeerConnection(userId)
    // For initial connections the smaller user ID offers; later ICE restarts are unrestricted.
    if (token.userId > userId && !pc.remoteDescription) return
    if (pc.signalingState !== 'stable') return
    if (pc.connectionState === 'connected' && pc.remoteDescription) return
    const offer = await pc.createOffer()
    if (!ports.isPeerSession(token, userId, pc)) return
    await pc.setLocalDescription(offer)
    if (!ports.isPeerSession(token, userId, pc)) return
    ports.send({ type: 'voice-offer', roomId: token.roomId, targetUserId: userId, data: offer })
  }

  function ensureConnections(members: string[]): void {
    if (!ports.canSignal()) return
    const token = ports.captureSession()
    for (const userId of members) {
      if (!userId || userId === token.userId) continue
      const pc = ports.connections.value.get(userId)
      const connected = !!pc && (pc.connectionState === 'connected' || pc.connectionState === 'connecting') && !!pc.remoteDescription
      if (!connected) void createOffer(userId).catch(() => {})
    }
  }

  function ensureVideoTransceiver(pc: RTCPeerConnection) {
    try {
      if (!pc.getTransceivers().some(transceiver => transceiver.receiver?.track?.kind === 'video')) {
        pc.addTransceiver('video', { direction: 'recvonly' })
      }
    } catch {}
  }

  async function requestScreenRefresh(targetUserId?: string): Promise<void> {
    if (!ports.canSignal()) return
    const token = ports.captureSession()
    for (const [userId, pc] of ports.connections.value) {
      if (targetUserId && userId !== targetUserId) continue
      if (!ports.isPeerSession(token, userId, pc)) return
      if (screenRefreshes.get(userId) === pc) continue
      screenRefreshes.set(userId, pc)
      ensureVideoTransceiver(pc)
      try {
        const offer = await pc.createOffer({ iceRestart: true })
        if (!ports.isPeerSession(token, userId, pc)) return
        await pc.setLocalDescription(offer)
        if (!ports.isPeerSession(token, userId, pc)) return
        ports.send({ type: 'voice-offer', roomId: token.roomId, targetUserId: userId, data: offer })
      } catch {} finally {
        if (screenRefreshes.get(userId) === pc) screenRefreshes.delete(userId)
      }
    }
  }

  function cleanupPeer(userId: string) {
    pendingCandidates.delete(userId)
    screenRefreshes.delete(userId)
  }

  function cleanupAll() {
    pendingCandidates.clear()
    screenRefreshes.clear()
  }

  return { handleSignal, createOffer, ensureConnections, requestScreenRefresh, cleanupPeer, cleanupAll }
}
