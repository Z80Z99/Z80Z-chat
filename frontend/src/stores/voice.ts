import { defineStore } from 'pinia'
import { computed, markRaw, onScopeDispose, ref, watch } from 'vue'
import { ws } from '../utils/ws'
import { useAuthStore } from './auth'
import { clampVoiceVolume, normalizeVoicePreferences, validPushToTalkKey, voicePreferencesKey, type VoiceMode } from '../utils/voice-preferences'
import type { PeerDiagnostics, ScreenPlaybackDiagnostics } from '../utils/voice-diagnostics'
import { createVoiceMicrophoneController } from '../utils/voice-microphone'
import { createVoiceAudioPlaybackController } from '../utils/voice-audio-playback'
import { createVoiceStatisticsController, emptyConnectionStats } from '../utils/voice-statistics'
import { createScreenShareController } from '../utils/voice-screen-share'
import { createVoicePeerController } from '../utils/voice-peers'
import { createVoiceSignalingController } from '../utils/voice-signaling'
import type { VoiceSessionToken, VoiceSignalMessage } from '../utils/voice-session'

export const useVoiceStore = defineStore('voice', () => {
  const authStore = useAuthStore()
  const currentRoom = ref<string | null>(null)
  const participants = ref<string[]>([])
  const voiceRoomMembers = ref<Record<string, string[]>>({})
  const isMuted = ref(false)
  const isDeafened = ref(false)
  const localStream = ref<MediaStream | null>(null)
  const peerConnections = ref<Map<string, RTCPeerConnection>>(new Map())
  const micAvailable = ref(true)
  const micError = ref('')
  const voiceMode = ref<VoiceMode>('open')
  const pushToTalkKey = ref('Space')
  const pushToTalkPressed = ref(false)
  const userVolumes = ref<Record<string, number>>({})
  const signalingConnected = ref(ws.isConnected())
  const sessionReady = ref(false)
  const micChanging = ref(false)
  let sessionGeneration = 0
  let deviceGeneration = 0
  let preferenceAccount = authStore.user?.id || ''
  let loadingPreferences = false
  const isTransmitting = computed(() => !!currentRoom.value && !!authStore.user?.id && sessionReady.value &&
    signalingConnected.value && !micChanging.value && micAvailable.value && !isMuted.value && !isDeafened.value &&
    (voiceMode.value === 'open' || pushToTalkPressed.value))

  function sessionToken(): VoiceSessionToken {
    return { generation: sessionGeneration, roomId: currentRoom.value, userId: authStore.user?.id || '', token: localStorage.getItem('token') }
  }

  function isSession(token: ReturnType<typeof sessionToken>) {
    return token.generation === sessionGeneration && token.roomId === currentRoom.value &&
      token.userId === (authStore.user?.id || '') && token.token === localStorage.getItem('token')
  }

  function isPeerSession(token: ReturnType<typeof sessionToken>, userId: string, pc: RTCPeerConnection) {
    return !!token.roomId && isSession(token) && peerConnections.value.get(userId) === pc && pc.signalingState !== 'closed'
  }

  function stopStream(stream: MediaStream | null) {
    stream?.getTracks().forEach(track => { track.enabled = false; track.stop() })
  }

  const inputDevices = ref<MediaDeviceInfo[]>([])
  const outputDevices = ref<MediaDeviceInfo[]>([])
  const inputDeviceId = ref('')
  const outputDeviceId = ref('')
  const inputVolume = ref(1)
  const outputVolume = ref(1)
  const outputSelectionSupported = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype
  const screenShareSupported = typeof navigator.mediaDevices?.getDisplayMedia === 'function'

  const inputLevel = ref(0)
  const outputLevel = ref(0)
  let mediaReady = false
  let seenConnection = signalingConnected.value

  function sendVoice(data: VoiceSignalMessage) {
    // Room controls describe this live connection, so replaying them after reconnect
    // would apply a stale leave/offer to a newly joined room.
    if (ws.isConnected()) ws.send(data)
  }

  function cleanupPeers() {
    peerController.cleanupAll()
    signalingController.cleanupAll()
    screenSenders.value.clear()
    remoteScreens.value = []
    audioPlaybackController.cleanupRemoteAudioAll()
    resetDiagnostics()
  }

  const screenStream = ref<MediaStream | null>(null)
  const isScreenSharing = ref(false)
  const screenSenders = ref<Map<string, RTCRtpSender>>(new Map())
  interface RemoteScreenEntry {
    userId: string
    stream: MediaStream
    ts: number
  }
  const remoteScreens = ref<RemoteScreenEntry[]>([])

  const connectionStats = ref(emptyConnectionStats())
  const diagnosticsEnabled = ref(false)
  const peerDiagnostics = ref<Record<string, PeerDiagnostics>>({})
  const screenPlayback = ref<Record<string, ScreenPlaybackDiagnostics>>({})
  const currentShareOpts = ref({ width: 1920, fps: 30 })
  const sourceResolution = ref({ width: 0, height: 0 })

  async function refreshDevices() {
    const request = ++deviceGeneration
    const token = sessionToken()
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      if (request !== deviceGeneration || !isSession(token)) return
      inputDevices.value = all.filter(d => d.kind === 'audioinput')
      outputDevices.value = all.filter(d => d.kind === 'audiooutput')
      if (!inputDevices.value.some(d => d.deviceId === inputDeviceId.value)) {
        inputDeviceId.value = inputDevices.value[0]?.deviceId || ''
      }
      if (!outputDevices.value.some(d => d.deviceId === outputDeviceId.value)) {
        outputDeviceId.value = outputDevices.value[0]?.deviceId || ''
      }
    } catch {}
  }

  function getUserVolume(userId: string) { return clampVoiceVolume(userVolumes.value[userId]) }

  function setUserVolume(userId: string, value: number) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(userId) || ['__proto__', 'constructor', 'prototype'].includes(userId)) return
    userVolumes.value = { ...userVolumes.value, [userId]: clampVoiceVolume(value) }
    applyRemoteVolume(userId)
  }

  function releasePushToTalk() { pushToTalkPressed.value = false; applyMicEnabled() }

  function setVoiceMode(value: VoiceMode) {
    releasePushToTalk()
    voiceMode.value = value === 'push-to-talk' ? value : 'open'
    applyMicEnabled()
  }

  function setPushToTalkKey(value: string) { releasePushToTalk(); pushToTalkKey.value = validPushToTalkKey(value) }

  function setPushToTalkPressed(value: boolean) {
    pushToTalkPressed.value = value === true && voiceMode.value === 'push-to-talk' && !!currentRoom.value &&
      sessionReady.value && signalingConnected.value && !micChanging.value && !isMuted.value && !isDeafened.value && micAvailable.value
    applyMicEnabled()
  }

  async function joinRoom(roomId: string, initialState?: { isMuted?: boolean; isDeafened?: boolean }) {
    if (!roomId || !authStore.user?.id || currentRoom.value === roomId) return
    const previousMute = currentRoom.value ? isMuted.value : false
    const previousDeafen = currentRoom.value ? isDeafened.value : false
    leaveRoom({ keepStream: !!localStream.value })
    isMuted.value = initialState?.isMuted ?? previousMute
    isDeafened.value = initialState?.isDeafened ?? previousDeafen
    currentRoom.value = roomId
    sessionReady.value = false
    mediaReady = false
    const token = sessionToken()
    await ensureIceServers()
    if (!isSession(token)) return
    ensureAudioCtx()
    await ensureMic(token)
    if (!isSession(token)) return
    initAudioPipeline()
    await refreshDevices()
    if (!isSession(token)) return
    mediaReady = true
    sessionReady.value = signalingConnected.value
    releasePushToTalk()
    sendVoice({ type: 'voice-join', roomId })
    startStatsPolling()
    startLevelPolling()
  }

  function leaveRoom(opts?: { keepStream?: boolean }) {
    sessionGeneration++
    microphoneController.invalidate()
    deviceGeneration++
    sessionReady.value = false
    mediaReady = false
    micChanging.value = false
    releasePushToTalk()
    audioPlaybackController.cleanupLocalTones()
    stopStatsPolling()
    stopLevelPolling()
    stopScreenShare()
    if (currentRoom.value) sendVoice({ type: 'voice-leave', roomId: currentRoom.value })
    cleanupPeers()
    audioPlaybackController.closeOutputContext()
    inputLevel.value = 0
    outputLevel.value = 0
    microphoneController.cleanup(opts)
    currentRoom.value = null
    participants.value = []
    micAvailable.value = true
    micError.value = ''
    isMuted.value = false
    isDeafened.value = false
  }

  function toggleMute() {
    if (!micAvailable.value) return
    releasePushToTalk()
    isMuted.value = !isMuted.value
    applyMicEnabled()
    sendVoice({ type: isMuted.value ? 'voice-mute' : 'voice-unmute', roomId: currentRoom.value })
  }

  function toggleDeafen() {
    releasePushToTalk()
    isDeafened.value = !isDeafened.value
    if (isDeafened.value) audioPlaybackController.cleanupLocalTones()
    audioPlaybackController.applyVolumes()
    applyMicEnabled()
  }

  function cleanupRemoteScreen(userId: string) {
    remoteScreens.value = remoteScreens.value.filter(entry => entry.userId !== userId)
    statisticsController.cleanupRemoteScreen(userId)
  }

  function handleVoiceRoomMembers(data: any) {
    if (data.roomId) {
      voiceRoomMembers.value = {
        ...voiceRoomMembers.value,
        [data.roomId]: data.members || []
      }
    }
  }

  // Each media controller owns its tracks and graph; the store coordinates attachment.
  function attachLocalTracks(userId: string, pc: RTCPeerConnection) {
    microphoneController.attachToPeer(pc)
    screenController.attachToPeer(userId, pc)
  }

  function handlePeerTrack(userId: string, pc: RTCPeerConnection, event: RTCTrackEvent, token: VoiceSessionToken) {
    const valid = () => isPeerSession(token, userId, pc)
    if (!valid()) return
    const track = event.track
    if (track.kind === 'audio') {
      audioPlaybackController.attachRemoteAudio(userId, pc, event, token)
    } else if (track.kind === 'video') {
      const stream = markRaw(event.streams[0] || new MediaStream([track]))
      statisticsController.clearScreenPlayback(userId)
      remoteScreens.value = [
        ...remoteScreens.value.filter(entry => entry.userId !== userId),
        { userId, stream, ts: Date.now() }
      ]
      track.onended = () => {
        if (valid() && remoteScreens.value.some(entry => entry.userId === userId && entry.stream.getVideoTracks().includes(track))) cleanupRemoteScreen(userId)
      }
    }
  }

  function cleanupPeerMedia(userId: string) {
    screenSenders.value.delete(userId)
    audioPlaybackController.cleanupRemoteAudio(userId)
    cleanupRemoteScreen(userId)
    statisticsController.cleanupPeer(userId)
  }

  const microphoneController = createVoiceMicrophoneController({
    localStream, inputDeviceId, inputVolume, micAvailable, micError, micChanging, peerConnections,
    sessionToken, isSession, isPeerSession, isTransmitting: () => isTransmitting.value,
    releasePushToTalk, sendVoice, stopStream
  })
  const { ensureMic, ensureAudioCtx, initAudioPipeline, changeInputDevice, retryMic, setInputVolume, applyMicEnabled } = microphoneController
  const audioPlaybackController = createVoiceAudioPlaybackController({
    outputDeviceId, outputVolume, isDeafened, captureSession: sessionToken, isSession, isPeerSession,
    hasUser: () => !!authStore.user?.id, getUserVolume, stopStream
  })
  const { changeOutputDevice, setOutputVolume, applyRemoteVolume, playTestSound, playSystemTone } = audioPlaybackController
  const statisticsController = createVoiceStatisticsController({
    connectionStats, diagnosticsEnabled, peerDiagnostics, screenPlayback, peerConnections,
    remoteScreens, screenStream, isScreenSharing, screenSenders, inputLevel, outputLevel,
    sessionToken, isSession, isPeerSession,
    getInputLevel: microphoneController.getInputLevel, getOutputLevel: audioPlaybackController.getOutputLevel,
    isTransmitting: () => isTransmitting.value, isDeafened: () => isDeafened.value,
    adaptBitrate: (samples, stream) => screenController.adaptBitrate(samples, stream)
  })
  const { startStatsPolling, stopStatsPolling, startLevelPolling, stopLevelPolling,
    resetDiagnostics, setDiagnosticsEnabled, reportScreenPlayback, syncDiagnosticState } = statisticsController

  const canSignal = () => !!currentRoom.value && !!authStore.user?.id && sessionReady.value && signalingConnected.value
  const screenController = createScreenShareController({
    screenStream, isScreenSharing, screenSenders, currentShareOpts, sourceResolution, peerConnections,
    sessionToken, isSession, isPeerSession, sendVoice, stopStream
  })
  const { sharePresets, startScreenShare, changeShareQuality, stopScreenShare, switchScreenSource } = screenController
  const peerController = createVoicePeerController({
    connections: peerConnections, captureSession: sessionToken, isPeerSession, canSignal, send: sendVoice,
    attachLocalTracks, onTrack: handlePeerTrack,
    onConnectionStateChange(userId, pc) {
      syncDiagnosticState(userId, pc)
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') cleanupRemoteScreen(userId)
    },
    onIceConnectionStateChange(userId, pc) { syncDiagnosticState(userId, pc) },
    onPeerCreated(userId, pc) { statisticsController.peerCreated(userId, pc) },
    onPeerCleanup(userId) {
      signalingController.cleanupPeer(userId)
      cleanupPeerMedia(userId)
    }
  })
  const signalingController = createVoiceSignalingController({
    connections: peerConnections, captureSession: sessionToken, isPeerSession, canSignal, send: sendVoice,
    getOrCreatePeerConnection: userId => peerController.getOrCreatePeerConnection(userId),
    cleanupPeer: userId => peerController.cleanupPeer(userId),
    hasLocalScreen: () => isScreenSharing.value && !!screenStream.value
  })
  const { ensureIceServers, cleanupPeer } = peerController
  const { handleSignal, createOffer, ensureConnections, requestScreenRefresh } = signalingController

  function tryResumeContexts() {
    microphoneController.resume()
    audioPlaybackController.resume()
  }
  const resumeEvents = ['pointerdown', 'touchstart', 'keydown']
  if (typeof window !== 'undefined') {
    resumeEvents.forEach(event => window.addEventListener(event, tryResumeContexts, { passive: true }))
  }

  const VOICE_STATE_TTL = 60000

  function voiceStateKey() {
    return `z80z-chat_voice_reconnect_${authStore.user?.id || 'guest'}`
  }

  function saveVoiceState(serverId?: string) {
    if (!currentRoom.value) return
    try {
      localStorage.setItem(voiceStateKey(), JSON.stringify({
        roomId: currentRoom.value,
        serverId: serverId || null,
        isMuted: isMuted.value,
        isDeafened: isDeafened.value,
        ts: Date.now()
      }))
    } catch {}
  }

  function loadVoiceState(): { roomId: string; serverId: string | null; isMuted: boolean; isDeafened: boolean } | null {
    try {
      const raw = localStorage.getItem(voiceStateKey())
      if (!raw) return null
      const state = JSON.parse(raw)
      if (Date.now() - state.ts > VOICE_STATE_TTL) {
        localStorage.removeItem(voiceStateKey())
        return null
      }
      return { roomId: state.roomId, serverId: state.serverId || null, isMuted: state.isMuted, isDeafened: state.isDeafened }
    } catch {
      return null
    }
  }

  function clearVoiceState() {
    localStorage.removeItem(voiceStateKey())
  }

  async function rejoinRoom(roomId: string) {
    // Reconnect only the desired live room. A pending old reconnect cannot undo leave/switch.
    if (!roomId || roomId !== currentRoom.value || !authStore.user?.id || !signalingConnected.value) return
    sessionGeneration++
    microphoneController.invalidate()
    sessionReady.value = false
    mediaReady = false
    micChanging.value = false
    releasePushToTalk()
    const token = sessionToken()
    cleanupPeers()
    await ensureIceServers()
    if (!isSession(token)) return
    await ensureMic(token)
    if (!isSession(token)) return
    // 新麦克风轨道默认 enabled=true，重连后须恢复静音/耳聋状态
    applyMicEnabled()
    initAudioPipeline()
    await refreshDevices()
    if (!isSession(token) || !signalingConnected.value) return
    mediaReady = true
    sessionReady.value = true
    applyMicEnabled()
    sendVoice({ type: 'voice-join', roomId })
    startStatsPolling()
    startLevelPolling()
  }

  function loadPreferences(userId: string) {
    loadingPreferences = true
    let value: unknown = null
    try { if (userId) value = JSON.parse(localStorage.getItem(voicePreferencesKey(userId)) || 'null') } catch {}
    const preferences = normalizeVoicePreferences(value)
    voiceMode.value = preferences.voiceMode
    pushToTalkKey.value = preferences.pushToTalkKey
    userVolumes.value = preferences.userVolumes
    outputVolume.value = preferences.outputVolume
    pushToTalkPressed.value = false
    loadingPreferences = false
  }

  loadPreferences(preferenceAccount)
  watch([voiceMode, pushToTalkKey, userVolumes, outputVolume], () => {
    if (!loadingPreferences && preferenceAccount && preferenceAccount === authStore.user?.id) {
      try { localStorage.setItem(voicePreferencesKey(preferenceAccount), JSON.stringify({
        voiceMode: voiceMode.value, pushToTalkKey: pushToTalkKey.value,
        userVolumes: userVolumes.value, outputVolume: outputVolume.value
      })) } catch {}
    }
  }, { deep: true, flush: 'sync' })
  watch(() => authStore.user?.id || '', (userId, previousId) => {
    leaveRoom()
    try { if (previousId) localStorage.removeItem(`z80z-chat_voice_reconnect_${previousId}`) } catch {}
    voiceRoomMembers.value = {}
    seenConnection = false
    preferenceAccount = userId
    loadPreferences(userId)
  }, { flush: 'sync' })
  watch(isTransmitting, applyMicEnabled, { flush: 'sync' })

  function onConnectionChange(connected: boolean) {
    signalingConnected.value = connected
    if (!connected) {
      sessionGeneration++
      microphoneController.invalidate()
      sessionReady.value = false
      micChanging.value = false
      releasePushToTalk()
    } else {
      // The first connection has no onReconnect callback. Finish a join requested
      // while that first socket was opening; subsequent connections are rejoined by Home.
      if (!seenConnection && currentRoom.value && mediaReady) {
        sessionReady.value = true
        releasePushToTalk()
        sendVoice({ type: 'voice-join', roomId: currentRoom.value })
      }
      seenConnection = true
    }
    applyMicEnabled()
  }
  ws.onConnectionChange(onConnectionChange)
  onScopeDispose(() => {
    leaveRoom()
    ws.offConnectionChange(onConnectionChange)
    resumeEvents.forEach(evt => window.removeEventListener(evt, tryResumeContexts))
  })

  return {
    currentRoom, participants, voiceRoomMembers, isMuted, isDeafened, localStream, peerConnections,
    micAvailable, micError, screenStream, isScreenSharing, remoteScreens,
    connectionStats, sharePresets, currentShareOpts, sourceResolution,
    inputDevices, outputDevices, inputDeviceId, outputDeviceId, inputVolume, outputVolume,
    outputSelectionSupported, screenShareSupported, inputLevel, outputLevel,
    voiceMode, pushToTalkKey, pushToTalkPressed, isTransmitting, userVolumes,
    peerDiagnostics, diagnosticsEnabled, setDiagnosticsEnabled, reportScreenPlayback,
    setVoiceMode, setPushToTalkKey, setPushToTalkPressed, releasePushToTalk, getUserVolume, setUserVolume,
    joinRoom, leaveRoom, retryMic, toggleMute, toggleDeafen,
    startScreenShare, changeShareQuality, stopScreenShare, switchScreenSource,
    refreshDevices, changeInputDevice, changeOutputDevice, setInputVolume, setOutputVolume,
    playTestSound, playSystemTone,
    handleSignal, createOffer, ensureConnections, cleanupRemoteScreen, cleanupPeer, handleVoiceRoomMembers, requestScreenRefresh,
    saveVoiceState, loadVoiceState, clearVoiceState, rejoinRoom
  }
})
