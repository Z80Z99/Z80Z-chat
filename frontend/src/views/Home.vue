<script setup lang="ts">
import { computed, ref, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useServerStore } from '../stores/server'
import { useChatStore } from '../stores/chat'
import { useAuthStore } from '../stores/auth'
import { useVoiceStore } from '../stores/voice'
import { useSiteStore } from '../stores/site'
import { useNotificationStore } from '../stores/notifications'
import { api } from '../utils/api'
import type { MessageNotification } from '../types'
import { ws } from '../utils/ws'
import { observeChatViewport } from '../utils/chat-viewport'
import type { ChatViewportState } from '../utils/chat-viewport'
import ServerList from '../components/ServerList.vue'
import ChannelList from '../components/ChannelList.vue'
import ChatBox from '../components/ChatBox.vue'
import MemberList from '../components/MemberList.vue'
import CreateServerModal from '../components/CreateServerModal.vue'
import CreateChannelModal from '../components/CreateChannelModal.vue'
import InviteModal from '../components/InviteModal.vue'
import ServerSettings from '../components/ServerSettings.vue'
import CommunityWelcome from '../components/CommunityWelcome.vue'
import { isMessageChannel } from '../utils/channel-type'
import ChannelSettingsModal from '../components/ChannelSettingsModal.vue'
import UserProfileModal from '../components/UserProfileModal.vue'
import VoiceAudioSettings from '../components/VoiceAudioSettings.vue'
import VoiceParticipantVolumes from '../components/VoiceParticipantVolumes.vue'
import { installPushToTalk } from '../utils/push-to-talk'
import ScreenShareStage from '../components/ScreenShareStage.vue'
import VoiceDiagnostics from '../components/VoiceDiagnostics.vue'
import VoicePushToTalkButton from '../components/VoicePushToTalkButton.vue'
import type { ScreenPlaybackState } from '../utils/screen-playback'
import Avatar from '../components/Avatar.vue'

const route = useRoute()
const router = useRouter()
const serverStore = useServerStore()
const chatStore = useChatStore()
const authStore = useAuthStore()
const voiceStore = useVoiceStore()
const siteStore = useSiteStore()
const notificationStore = useNotificationStore()
const chatBoxRef = ref<{ locateMessage: (id: string) => Promise<boolean>; cancelLocation?: () => void } | null>(null)
const homeReady = ref(false)
let homeDisposed = false
let navigationGeneration = 0
let voiceRestoreGeneration = 0
let committingVoiceRestore = false
let channelLoad = Promise.resolve()
let activeNavigation: { item: MessageNotification; serverId: string | undefined; channelId: string | undefined; committed: boolean } | null = null

const cinemaMode = ref(false)
const diagnosticsOpen = ref(false)
const viewingCurrentVoice = computed(() => Boolean(authStore.user?.id && voiceStore.currentRoom &&
  serverStore.currentChannel?.type === 'voice' && serverStore.currentChannel.id === voiceStore.currentRoom))
const screenEntries = computed(() => {
  const entries = voiceStore.remoteScreens.map(entry => ({ ...entry, name: memberName(entry.userId), local: false }))
  if (voiceStore.isScreenSharing && voiceStore.screenStream && authStore.user?.id) {
    entries.unshift({ userId: authStore.user.id, stream: voiceStore.screenStream, ts: 0,
      name: memberName(authStore.user.id), local: true })
  }
  return entries
})
const diagnosticNames = computed(() => Object.fromEntries(serverStore.members.map(member => [member.userId, memberName(member.userId)])))
let cinemaTrigger: HTMLElement | null = null
let cinemaFocusVersion = 0
let screenUiVersion = 0
const screenRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

function setCinemaMode(value: boolean, restoreFocus = true) {
  if (value && (!viewingCurrentVoice.value || screenEntries.value.length === 0)) return
  if (cinemaMode.value === value) return
  const version = ++cinemaFocusVersion
  if (value) {
    cinemaTrigger = document.activeElement as HTMLElement | null
    mobileChannelsOpen.value = false
    mobileMembersOpen.value = false
    shareMenuOpen.value = false
  }
  cinemaMode.value = value
  pushToTalkKeys?.release()
  voiceStore.releasePushToTalk()
  void nextTick().then(() => {
    if (homeDisposed || version !== cinemaFocusVersion) return
    if (value) document.querySelector<HTMLButtonElement>('[aria-label="退出影院模式"]')?.focus({ preventScroll: true })
    else if (restoreFocus) {
      if (cinemaTrigger?.isConnected) cinemaTrigger.focus({ preventScroll: true })
      else document.querySelector<HTMLElement>('[data-voice-heading]')?.focus({ preventScroll: true })
      cinemaTrigger = null
    }
  })
}

function closeDiagnostics() {
  diagnosticsOpen.value = false
  void nextTick().then(() => {
    if (!homeDisposed && viewingCurrentVoice.value) document.querySelector<HTMLButtonElement>('[data-voice-diagnostics-trigger]')?.focus({ preventScroll: true })
  })
}

function handleCinemaEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
  if (diagnosticsOpen.value) { event.preventDefault(); closeDiagnostics() }
  else if (shareMenuOpen.value) { event.preventDefault(); shareMenuOpen.value = false }
  else if (cinemaMode.value && !document.fullscreenElement) { event.preventDefault(); setCinemaMode(false) }
}

function clearScreenRefresh(userId?: string) {
  if (userId) {
    const timer = screenRefreshTimers.get(userId)
    if (timer !== undefined) clearTimeout(timer)
    screenRefreshTimers.delete(userId)
  } else {
    screenRefreshTimers.forEach(timer => clearTimeout(timer))
    screenRefreshTimers.clear()
  }
}

function reportScreenPlayback(userId: string, state: ScreenPlaybackState, stream: MediaStream) {
  if (viewingCurrentVoice.value && userId !== authStore.user?.id) voiceStore.reportScreenPlayback(userId, state, stream)
}

function clearScreenPlaybackReports() {
  voiceStore.remoteScreens.forEach(entry => voiceStore.reportScreenPlayback(entry.userId, null, entry.stream))
}

watch([() => serverStore.currentServer?.id, () => serverStore.currentChannel?.id,
  () => voiceStore.currentRoom, () => authStore.user?.id], () => {
  screenUiVersion++
  clearScreenRefresh()
  diagnosticsOpen.value = false
  setCinemaMode(false, false)
  if (!viewingCurrentVoice.value) clearScreenPlaybackReports()
}, { flush: 'sync' })
watch(() => screenEntries.value.length, count => { if (!count) setCinemaMode(false) }, { flush: 'sync' })
const screenShareOpts = ref({ width: 1920, height: 1080, fps: 30 })
const showCreateServer = ref(false)
const showCreateChannel = ref(false)
const showInviteModal = ref(false)
const showServerSettings = ref(false)
const showUserProfile = ref(false)
const profileUserId = ref<string | null>(null)
const showChannelSettings = ref(false)
const settingsChannel = ref<any>(null)
const backgroundBlocked = computed(() => diagnosticsOpen.value || showServerSettings.value || showCreateServer.value ||
  showCreateChannel.value || showInviteModal.value || showChannelSettings.value || showUserProfile.value)
const inviteCode = ref(route.params.code as string || '')
const mobileChannelsOpen = ref(false)
const mobileMembersOpen = ref(false)
const viewport = ref<ChatViewportState>({ isMobile: window.innerWidth < 768, keyboardOpen: false, style: {} })
const desktopMembersOpen = ref(readMemberPreference())
let stopViewport: (() => void) | null = null

function readMemberPreference() {
  try {
    const saved = localStorage.getItem('z80z:members-visible')
    if (saved === '1' || saved === '0') return saved === '1'
  } catch {}
  return window.innerWidth >= 1280
}
function toggleMembers() {
  if (viewport.value.isMobile) mobileMembersOpen.value = !mobileMembersOpen.value
  else {
    desktopMembersOpen.value = !desktopMembersOpen.value
    try { localStorage.setItem('z80z:members-visible', desktopMembersOpen.value ? '1' : '0') } catch {}
  }
}
let pushToTalkKeys: ReturnType<typeof installPushToTalk> | null = null
const shareMenuOpen = ref(false)
const sharePresetOptions = [
  { value: 0, label: '源画质' },
  { value: 1280, label: '720p' },
  { value: 1920, label: '1080p' },
  { value: 2560, label: '2K' },
  { value: 3840, label: '4K' }
]
const shareFpsOptions = [15, 30, 60]

async function startShareFromMenu() {
  shareMenuOpen.value = false
  await voiceStore.startScreenShare({ width: screenShareOpts.value.width, fps: screenShareOpts.value.fps })
}

watch(() => serverStore.currentServer?.id, () => {
  showServerSettings.value = false
  showCreateChannel.value = false
  showChannelSettings.value = false
  settingsChannel.value = null
  if (window.innerWidth < 768) {
    mobileChannelsOpen.value = false
    mobileMembersOpen.value = false
  }
})

watch([() => voiceStore.currentRoom, () => voiceStore.voiceMode, () => voiceStore.pushToTalkKey, () => authStore.user?.id,
  () => voiceStore.isMuted, () => voiceStore.isDeafened, () => voiceStore.micAvailable, () => notificationStore.inboxOpen, backgroundBlocked], () => {
  pushToTalkKeys?.release()
}, { flush: 'sync' })

watch([() => serverStore.currentServer?.id, () => serverStore.currentChannel?.id, () => notificationStore.pendingTarget], () => {
  if (!committingVoiceRestore) voiceRestoreGeneration++
}, { flush: 'sync' })

onMounted(async () => {
  const initialVoiceRestoreVersion = voiceRestoreGeneration
  pushToTalkKeys = installPushToTalk(window, document, {
    enabled: () => Boolean(voiceStore.currentRoom && voiceStore.voiceMode === 'push-to-talk' && !notificationStore.inboxOpen && !backgroundBlocked.value),
    code: () => voiceStore.pushToTalkKey,
    setPressed: pressed => voiceStore.setPushToTalkPressed(pressed)
  })
  stopViewport = observeChatViewport(window, state => { viewport.value = state })
  document.addEventListener('keydown', handleCinemaEscape)
  ws.on('message', handleWSMessage)
  ws.on('message-updated', handleWSMessage)
  ws.on('message-deleted', handleWSMessage)
  ws.on('voice-user-joined', handleVoiceUserJoined)
  ws.on('voice-user-left', handleVoiceUserLeft)
  ws.on('voice-offer', handleVoiceSignal)
  ws.on('voice-answer', handleVoiceSignal)
  ws.on('voice-ice-candidate', handleVoiceSignal)
  ws.on('voice-members', handleVoiceMembers)
  ws.on('voice-mute', handleVoiceMute)
  ws.on('voice-unmute', handleVoiceUnmute)
  ws.on('screen-share-start', handleScreenShareStart)
  ws.on('screen-share-stop', handleScreenShareStop)
  ws.on('voice-room-members', handleVoiceRoomMembers)
  ws.on('user-profile-updated', handleUserProfileUpdated)
  document.addEventListener('click', handleGlobalClick)

  ws.onReconnect(handleReconnect)
  syncCurrentChannel()

  await serverStore.fetchServers()
  if (homeDisposed) return
  if (!authStore.user) {
    try { await authStore.fetchMe() } catch {}
  }
  if (homeDisposed) return
  if (inviteCode.value) {
    try {
      const account = authStore.user?.id, token = localStorage.getItem('token')
      const result = await serverStore.joinServer(inviteCode.value)
      if (!homeDisposed && authStore.user?.id === account && localStorage.getItem('token') === token) await serverStore.fetchServer(result.serverId)
      router.replace('/')
    } catch {}
  }

  if (homeDisposed) return

  homeReady.value = true
  // Opening a text notification should not be superseded by a saved voice-room restore.
  if (notificationStore.pendingTarget) { voiceStore.clearVoiceState(); return }

  const savedVoice = voiceStore.loadVoiceState()
  if (savedVoice) voiceStore.clearVoiceState()
  if (savedVoice?.serverId && !voiceStore.currentRoom && initialVoiceRestoreVersion === voiceRestoreGeneration) {
    const version = initialVoiceRestoreVersion
    const account = authStore.user?.id, token = localStorage.getItem('token')
    const valid = () => !homeDisposed && version === voiceRestoreGeneration && !notificationStore.pendingTarget &&
      !voiceStore.currentRoom && authStore.user?.id === account && localStorage.getItem('token') === token
    try {
      if (!account || !token) return
      const snapshot = serverStore.captureServerSnapshot(savedVoice.serverId)
      const data = await api.getServer(savedVoice.serverId)
      if (!valid()) return
      const channel = data.channels.find((value: any) => value.id === savedVoice.roomId && value.type === 'voice')
      if (channel && data.members.some((member: any) => member.userId === account)) {
        committingVoiceRestore = true
        if (!serverStore.commitServerSnapshot(data, snapshot)) return
        const liveChannel = serverStore.channels.find(value => value.id === channel.id && value.type === 'voice')
        if (!liveChannel) return
        serverStore.setCurrentChannel(liveChannel)
        committingVoiceRestore = false
        if (valid()) await voiceStore.joinRoom(savedVoice.roomId, { isMuted: savedVoice.isMuted, isDeafened: savedVoice.isDeafened })
      }
    } catch {} finally { committingVoiceRestore = false }
  }
})

onUnmounted(() => {
  pushToTalkKeys?.dispose()
  pushToTalkKeys = null
  homeDisposed = true
  cinemaFocusVersion++
  screenUiVersion++
  clearScreenRefresh()
  clearScreenPlaybackReports()
  navigationGeneration++
  stopViewport?.()
  ws.off('message', handleWSMessage)
  ws.off('message-updated', handleWSMessage)
  ws.off('message-deleted', handleWSMessage)
  ws.offReconnect(handleReconnect)
  ws.off('voice-user-joined', handleVoiceUserJoined)
  ws.off('voice-user-left', handleVoiceUserLeft)
  ws.off('voice-offer', handleVoiceSignal)
  ws.off('voice-answer', handleVoiceSignal)
  ws.off('voice-ice-candidate', handleVoiceSignal)
  ws.off('voice-members', handleVoiceMembers)
  ws.off('voice-mute', handleVoiceMute)
  ws.off('voice-unmute', handleVoiceUnmute)
  ws.off('screen-share-start', handleScreenShareStart)
  ws.off('screen-share-stop', handleScreenShareStop)
  ws.off('voice-room-members', handleVoiceRoomMembers)
  ws.off('user-profile-updated', handleUserProfileUpdated)
  document.removeEventListener('click', handleGlobalClick)
  document.removeEventListener('keydown', handleCinemaEscape)
})

function handleGlobalClick(e: MouseEvent) {
  if (!shareMenuOpen.value) return
  const target = e.target as HTMLElement
  if (!target.closest('#share-menu') && !target.closest('#share-toggle-btn')) {
    shareMenuOpen.value = false
  }
}

watch(() => serverStore.currentChannel?.id, syncCurrentChannel)

function syncCurrentChannel() {
  const channel = serverStore.currentChannel
  chatStore.clearMessages()
  if (isMessageChannel(channel)) {
    channelLoad = chatStore.loadMessages(channel.id).catch(() => {})
    ws.send({ type: 'join-channel', channelId: channel.id })
  } else ws.send({ type: 'leave-channel' })
}

watch([() => notificationStore.pendingTarget, homeReady], ([item, ready]) => {
  if (activeNavigation) chatBoxRef.value?.cancelLocation?.()
  navigationGeneration++
  if (ready && item) void navigateToNotification(item)
}, { immediate: true })

watch([() => serverStore.currentServer?.id, () => serverStore.currentChannel?.id], ([serverId, channelId]) => {
  const navigation = activeNavigation
  if (!navigation || notificationStore.pendingTarget !== navigation.item) return
  const expectedServer = navigation.committed ? navigation.item.serverId : navigation.serverId
  const expectedChannel = navigation.committed ? navigation.item.channelId : navigation.channelId
  if (serverId !== expectedServer || channelId !== expectedChannel) {
    navigationGeneration++
    notificationStore.finishNavigation(navigation.item)
    activeNavigation = null
  }
})

async function navigateToNotification(item: MessageNotification) {
  serverStore.cancelServerNavigation()
  const version = navigationGeneration
  const account = authStore.user?.id, token = localStorage.getItem('token')
  const valid = () => !homeDisposed && version === navigationGeneration && notificationStore.pendingTarget === item &&
    authStore.user?.id === account && localStorage.getItem('token') === token
  const navigation = { item, serverId: serverStore.currentServer?.id, channelId: serverStore.currentChannel?.id, committed: false }
  activeNavigation = navigation
  try {
    if (!account || !token) throw new Error('请重新登录后查看消息')
    // Request first, then commit only while this notification still owns navigation.
    const snapshot = serverStore.captureServerSnapshot(item.serverId)
    const data = await api.getServer(item.serverId)
    if (!valid()) return
    const channel = data.channels.find((value: any) => value.id === item.channelId && isMessageChannel(value))
    if (!channel || !data.members.some((value: any) => value.userId === account)) throw new Error('你已无法访问这条消息所在的频道')
    navigation.committed = true
    if (!serverStore.commitServerSnapshot(data, snapshot)) throw new Error('社区选择或访问权限已变化，请重新打开通知')
    const liveChannel = serverStore.channels.find(value => value.id === channel.id && isMessageChannel(value))
    if (!liveChannel) throw new Error('原消息所在的频道已删除，请刷新通知')
    serverStore.setCurrentChannel(liveChannel)
    await nextTick()
    await channelLoad
    if (!valid()) return
    mobileChannelsOpen.value = false
    mobileMembersOpen.value = false
    await nextTick()
    if (!valid()) return
    if (!chatBoxRef.value || !await chatBoxRef.value.locateMessage(item.message.id)) throw new Error('原消息已删除或暂时无法定位，请重试')
    if (valid()) notificationStore.finishNavigation(item)
  } catch (failure: any) {
    if (valid()) notificationStore.finishNavigation(item, failure?.message || '通知定位失败，请重试')
  } finally { if (activeNavigation === navigation) activeNavigation = null }
}

function handleReconnect() {
  screenUiVersion++
  clearScreenRefresh()
  const channel = serverStore.currentChannel
  if (isMessageChannel(channel)) {
    ws.send({ type: 'join-channel', channelId: channel.id })
    void chatStore.loadMessages(channel.id).catch(() => {})
  }
  if (voiceStore.currentRoom) void voiceStore.rejoinRoom(voiceStore.currentRoom)
}

function handleWSMessage(data: any) {
  const ch = serverStore.currentChannel?.id
  if (data.type === 'message' && data.channelId === ch) {
    chatStore.addMessage(data.message)
  } else if (data.type === 'message-updated' && data.channelId === ch) {
    chatStore.updateMessage(data.message.id, data.message)
  } else if (data.type === 'message-deleted' && data.channelId === ch) {
    chatStore.removeMessage(data.messageId)
  }
}

function handleVoiceUserJoined(data: any) {
  if (data.roomId === voiceStore.currentRoom) {
    voiceStore.participants = [...voiceStore.participants, data.userId]
    voiceStore.createOffer(data.userId)
    voiceStore.playSystemTone('enter')
  }
}

function handleVoiceUserLeft(data: any) {
  if (data.roomId === voiceStore.currentRoom) {
    clearScreenRefresh(data.userId)
    voiceStore.participants = voiceStore.participants.filter(id => id !== data.userId)
    voiceStore.cleanupPeer(data.userId)
    voiceStore.playSystemTone('exit')
  }
}

function handleVoiceSignal(data: any) {
  voiceStore.handleSignal(data)
}

function handleVoiceMembers(data: any) {
  if (data.roomId === voiceStore.currentRoom) {
    voiceStore.participants = data.members
    voiceStore.ensureConnections(data.members)
  }
}

// mute/unmute 广播发给所有客户端：仅当前房间内其他用户的静音变化播放提示音
function handleVoiceMute(data: any) {
  if (data.roomId === voiceStore.currentRoom && data.userId !== authStore.user?.id) {
    voiceStore.playSystemTone('mute')
  }
}
function handleVoiceUnmute(data: any) {
  if (data.roomId === voiceStore.currentRoom && data.userId !== authStore.user?.id) {
    voiceStore.playSystemTone('unmute')
  }
}
function handleScreenShareStop(data: any) {
  if (!voiceStore.currentRoom || data.roomId !== voiceStore.currentRoom) return
  clearScreenRefresh(data.userId)
  voiceStore.cleanupRemoteScreen(data.userId)
}

function handleScreenShareStart(data: any) {
  if (!voiceStore.currentRoom || data.roomId !== voiceStore.currentRoom || !data.userId || data.userId === authStore.user?.id) return
  const uid = data.userId
  const roomId = voiceStore.currentRoom, account = authStore.user?.id, token = localStorage.getItem('token'), version = screenUiVersion
  clearScreenRefresh(uid)
  const timer = setTimeout(() => {
    if (screenRefreshTimers.get(uid) !== timer) return
    screenRefreshTimers.delete(uid)
    if (!homeDisposed && version === screenUiVersion && roomId === voiceStore.currentRoom &&
      account === authStore.user?.id && token === localStorage.getItem('token') && !voiceStore.remoteScreens.some(e => e.userId === uid)) {
      void voiceStore.requestScreenRefresh(uid)
    }
  }, 2000)
  screenRefreshTimers.set(uid, timer)
}

function handleScreenRefresh(userId: string) {
  if (viewingCurrentVoice.value) void voiceStore.requestScreenRefresh(userId)
}

function handleVoiceRoomMembers(data: any) {
  voiceStore.handleVoiceRoomMembers(data)
}

function handleUserProfileUpdated(data: { userId: string; avatar?: string; nickname?: string }) {
  serverStore.handleUserProfileUpdated(data)
}

async function changeShareQuality(opts: { width: number; fps: number }) {
  await voiceStore.changeShareQuality(opts)
}

function openUserProfile(userId: string) {
  profileUserId.value = userId
  showUserProfile.value = true
}

function memberOf(userId: string) {
  return serverStore.members.find(m => m.userId === userId)
}

function memberName(userId: string) {
  const u = memberOf(userId)?.user
  return u?.nickname || u?.username || '未知用户'
}

function roomNameById(roomId: string | null) {
  if (!roomId) return ''
  return serverStore.channels.find(c => c.id === roomId)?.name || '语音频道'
}
</script>

<template>
  <div class="chat-app-shell flex" :class="{ 'chat-keyboard-open': viewport.keyboardOpen, 'voice-cinema': cinemaMode }" :style="viewport.style">
    <div class="community-content-zone" :inert="backgroundBlocked ? true : undefined">
    <div v-show="!cinemaMode" class="voice-navigation-zone" :inert="cinemaMode || diagnosticsOpen ? true : undefined" :aria-hidden="cinemaMode ? true : undefined">
      <ServerList @create-server="showCreateServer = true" />
    </div>

    <template v-if="serverStore.currentServer">
      <div v-show="!cinemaMode" class="voice-navigation-zone" :inert="cinemaMode || diagnosticsOpen ? true : undefined" :aria-hidden="cinemaMode ? true : undefined">
      <ChannelList
        :mobile-open="mobileChannelsOpen"
        :is-mobile="viewport.isMobile"
        @close="mobileChannelsOpen = false"
        @select-channel="serverStore.setCurrentChannel"
        @create-channel="showCreateChannel = true"
        @open-invite="showInviteModal = true"
        @open-settings="showServerSettings = true"
        @channel-settings="settingsChannel = $event; showChannelSettings = true"
      />
      </div>

      <ChatBox
        v-if="isMessageChannel(serverStore.currentChannel)"
        ref="chatBoxRef"
        :members-visible="viewport.isMobile ? mobileMembersOpen : desktopMembersOpen"
        @open-user-profile="openUserProfile"
        @toggle-channels="mobileChannelsOpen = true"
        @toggle-members="toggleMembers"
      />

      <div v-else-if="serverStore.currentChannel && serverStore.currentChannel.type === 'voice'"
           class="voice-page flex-1 min-w-0 flex flex-col bg-discord-700" :inert="diagnosticsOpen ? true : undefined">
        <div v-show="!cinemaMode" class="h-12 flex items-center px-4 shadow-sm border-b border-discord-600 md:hidden">
          <button class="p-1 mr-2 text-discord-200 hover:text-white" title="频道列表"
                  @click="mobileChannelsOpen = true">
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div class="flex items-center gap-2 min-w-0">
            <svg class="w-5 h-5 text-discord-200 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
            <h3 class="text-white font-bold text-sm truncate">{{ serverStore.currentChannel.name }}</h3>
          </div>
          <button class="p-1 ml-auto text-discord-200 hover:text-white" title="成员列表"
                  @click="mobileMembersOpen = true">
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
        <div class="voice-page-scroll flex-1 min-h-0 overflow-y-auto">
          <div v-if="!voiceStore.currentRoom || voiceStore.currentRoom !== serverStore.currentChannel.id"
               class="min-h-full flex flex-col items-center justify-center p-4">
            <div class="text-center w-full max-w-md">
            <div class="bg-discord-800/70 border border-discord-600/50 rounded-2xl shadow-2xl py-8 px-4 sm:px-8">
              <div class="flex justify-end mb-2">
              <button type="button" class="composer-action notification-trigger" title="通知" aria-label="通知" :aria-expanded="notificationStore.inboxOpen" @click="notificationStore.inboxOpen = !notificationStore.inboxOpen">
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 8a6 6 0 00-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>
                <span v-if="notificationStore.unreadCount" class="notification-trigger-count" aria-hidden="true">{{ notificationStore.unreadCount > 99 ? '99+' : notificationStore.unreadCount }}</span>
                <span v-if="notificationStore.unreadCount" class="sr-only">{{ notificationStore.unreadCount }} 条未读提醒</span>
              </button>
              </div>
              <div class="relative w-24 h-24 mx-auto mb-5">
                <div class="absolute -inset-3 rounded-full bg-green/5"></div>
                <div class="absolute inset-0 rounded-full bg-green/10 animate-ping"></div>
                <div class="relative w-24 h-24 bg-gradient-to-br from-discord-500 to-discord-700 rounded-full flex items-center justify-center ring-8 ring-discord-800/60">
                  <svg class="w-12 h-12 text-discord-100" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                </div>
              </div>
              <h2 class="text-2xl font-bold text-white mb-1">{{ serverStore.currentChannel.name }}</h2>
              <p class="text-discord-200 text-sm mb-6">语音频道 · 实时语音通话</p>

              <div v-if="voiceStore.currentRoom && voiceStore.currentRoom !== serverStore.currentChannel.id"
                   class="bg-yellow/10 border border-yellow/30 rounded-xl p-3 mb-6">
                <p class="text-yellow text-sm font-medium flex items-center justify-center gap-2">
                  <svg class="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                  </svg>
                  你仍在「{{ roomNameById(voiceStore.currentRoom) }}」中，加入后将自动切换
                </p>
              </div>

              <div v-if="voiceStore.voiceRoomMembers[serverStore.currentChannel.id]?.length" class="mb-6">
                <p class="text-xs font-bold text-green uppercase tracking-wider mb-3">
                  频道内 {{ voiceStore.voiceRoomMembers[serverStore.currentChannel.id].length }} 人在线
                </p>
                <div class="flex flex-wrap justify-center gap-3">
                  <div v-for="uid in voiceStore.voiceRoomMembers[serverStore.currentChannel.id]" :key="uid"
                       class="flex flex-col items-center gap-1 w-16">
                    <Avatar :src="memberOf(uid)?.user?.avatar" :name="memberName(uid)" size="lg"
                            bg="bg-discord-600" status="bg-green border-discord-700" />
                    <span class="text-xs text-discord-100 truncate w-full text-center">{{ memberName(uid) }}</span>
                  </div>
                </div>
              </div>
              <div v-else class="mb-6">
                <p class="text-discord-200 text-sm">频道中还没有人，快来第一个进入吧</p>
              </div>

              <button @click="voiceStore.joinRoom(serverStore.currentChannel.id)"
                      class="btn-green px-8 py-3 text-base rounded-full w-full sm:w-auto">
                <span class="flex items-center justify-center gap-2">
                  <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                  </svg>
                  进入语音频道
                </span>
              </button>
              <p class="text-discord-300 text-xs mt-3">加入后将自动连接语音，需要麦克风权限</p>
            </div>
            <VoiceAudioSettings class="mt-4" :stop-key="`${authStore.user?.id || ''}:${voiceStore.currentRoom || ''}:${serverStore.currentChannel.id}`" />
            </div>
          </div>

          <div v-else class="voice-room-content w-full max-w-4xl mx-auto flex flex-col gap-4 p-4">

            <div v-show="!cinemaMode" data-voice-heading tabindex="-1" class="flex items-center justify-between gap-3 flex-wrap bg-gradient-to-r from-discord-800/90 to-discord-800/60 border border-discord-600/50 rounded-xl px-4 py-3">
              <div class="flex items-center gap-3 min-w-0">
                <div class="relative flex-shrink-0">
                  <div class="w-10 h-10 rounded-xl bg-green/15 border border-green/30 flex items-center justify-center">
                    <svg class="w-5 h-5 text-green" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                    </svg>
                  </div>
                  <span class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-green border-2 border-discord-800"></span>
                </div>
                <div class="min-w-0">
                  <p class="text-white text-sm font-bold truncate leading-none">
                    {{ roomNameById(voiceStore.currentRoom) }}
                  </p>
                </div>
              </div>
              <div class="flex items-center gap-2 text-xs flex-wrap">
              <button type="button" class="composer-action notification-trigger" title="通知" aria-label="通知" :aria-expanded="notificationStore.inboxOpen" @click="notificationStore.inboxOpen = !notificationStore.inboxOpen">
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 8a6 6 0 00-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>
                <span v-if="notificationStore.unreadCount" class="notification-trigger-count" aria-hidden="true">{{ notificationStore.unreadCount > 99 ? '99+' : notificationStore.unreadCount }}</span>
                <span v-if="notificationStore.unreadCount" class="sr-only">{{ notificationStore.unreadCount }} 条未读提醒</span>
              </button>
                <span class="flex items-center gap-1.5 bg-discord-900/60 rounded-full px-2.5 py-1" title="连接质量">
                  <span class="w-2 h-2 rounded-full"
                        :class="voiceStore.connectionStats.quality === 'good' ? 'bg-green' : voiceStore.connectionStats.quality === 'fair' ? 'bg-yellow' : voiceStore.connectionStats.quality === 'poor' ? 'bg-red' : 'bg-discord-400'"></span>
                  <span class="text-discord-200">
                    {{ voiceStore.connectionStats.quality === 'good' ? '优' : voiceStore.connectionStats.quality === 'fair' ? '中' : voiceStore.connectionStats.quality === 'poor' ? '差' : '等待' }}
                  </span>
                </span>
                <span class="bg-discord-900/60 rounded-full px-2.5 py-1 text-discord-200" title="延迟">
                  {{ voiceStore.connectionStats.rtt > 0 ? `${voiceStore.connectionStats.rtt}ms` : '延迟待测' }}
                </span>
              </div>
            </div>

            <ScreenShareStage v-if="screenEntries.length" :entries="screenEntries" :cinema="cinemaMode"
                              @update:cinema="setCinemaMode" @refresh="handleScreenRefresh" @playback="reportScreenPlayback" />

            <div v-if="voiceStore.isScreenSharing" v-show="!cinemaMode" class="voice-share-controls">
              <label>
                <span>共享画质</span>
                <select :value="voiceStore.currentShareOpts.width" aria-label="共享画质"
                        @change="changeShareQuality({ width: Number(($event.target as HTMLSelectElement).value), fps: voiceStore.currentShareOpts.fps })">
                  <option v-for="preset in sharePresetOptions" :key="preset.value" :value="preset.value"
                          :disabled="preset.value > 0 && preset.value > voiceStore.sourceResolution.width">{{ preset.label }}</option>
                </select>
              </label>
              <label>
                <span>共享帧率</span>
                <select :value="voiceStore.currentShareOpts.fps" aria-label="共享帧率"
                        @change="changeShareQuality({ width: voiceStore.currentShareOpts.width, fps: Number(($event.target as HTMLSelectElement).value) })">
                  <option v-for="fps in shareFpsOptions" :key="fps" :value="fps">{{ fps }}fps</option>
                </select>
              </label>
              <button type="button" class="voice-control-button btn-ghost" @click="voiceStore.switchScreenSource()">切换共享窗口</button>
              <span v-if="voiceStore.sourceResolution.width" class="voice-share-source-size">源画面 {{ voiceStore.sourceResolution.width }}×{{ voiceStore.sourceResolution.height }}</span>
            </div>

            <div v-show="!cinemaMode" class="bg-discord-800/70 border border-discord-600/50 rounded-xl p-4">
              <p class="text-xs font-bold text-green uppercase tracking-wider mb-3">
                语音中成员 · {{ voiceStore.participants.length }} 人
              </p>
              <div class="flex flex-wrap gap-3">
                <div v-for="uid in voiceStore.participants" :key="uid"
                     class="flex flex-col items-center gap-1 w-16">
                  <Avatar :src="memberOf(uid)?.user?.avatar" :name="memberName(uid)" size="lg"
                          bg="bg-discord-600" status="bg-green border-discord-700" />
                  <span class="text-xs text-discord-100 truncate w-full text-center">
                    {{ memberName(uid) }}<span v-if="uid === authStore.user?.id" class="text-discord-400"> (你)</span>
                  </span>
                </div>
              </div>
              <VoiceParticipantVolumes />
            </div>

            <VoiceAudioSettings v-show="!cinemaMode" :stop-key="`${authStore.user?.id || ''}:${voiceStore.currentRoom || ''}:${cinemaMode}`" />

            <div class="voice-room-controls sticky bottom-0 z-10 flex items-center justify-center gap-2 flex-wrap bg-discord-800/80 border border-discord-600/50 rounded-xl px-4 py-3 backdrop-blur">
              <VoicePushToTalkButton v-if="cinemaMode && voiceStore.voiceMode === 'push-to-talk'" class="voice-cinema-talk" />
              <button type="button" data-voice-diagnostics-trigger class="voice-control-button btn-ghost"
                      :aria-expanded="diagnosticsOpen" aria-controls="voice-diagnostics"
                      @click="diagnosticsOpen = !diagnosticsOpen">{{ diagnosticsOpen ? '收起诊断' : '连接诊断' }}</button>
              <Transition name="pop">
              <div v-if="shareMenuOpen && !voiceStore.isScreenSharing" id="share-menu"
                   class="absolute bottom-full left-1/2 -translate-x-1/2 mb-4 z-20 w-[380px] max-w-[92vw] bg-discord-800 border border-discord-600/50 rounded-2xl shadow-2xl overflow-visible">
                <div class="absolute left-1/2 -translate-x-1/2 -bottom-1.5 w-3 h-3 bg-discord-800 border-r border-b border-discord-600/50 rotate-45"></div>
                <div class="px-5 pt-4 pb-3 flex items-center justify-between border-b border-discord-600/40">
                  <p class="text-sm font-bold text-white flex items-center gap-2.5">
                    <span class="w-8 h-8 rounded-lg bg-green/15 border border-green/30 flex items-center justify-center">
                      <svg class="w-4 h-4 text-green" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                      </svg>
                    </span>
                    开始投屏
                  </p>
                  <button @click="shareMenuOpen = false"
                          class="p-1.5 text-discord-300 hover:text-white hover:bg-discord-600 rounded-lg transition-colors cursor-pointer">
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                <div class="p-4 space-y-4">
                  <div>
                    <p class="text-discord-100 text-xs font-medium mb-2">画面质量</p>
                    <div class="flex flex-wrap gap-1.5">
                      <button v-for="p in sharePresetOptions" :key="p.value"
                              @click="screenShareOpts.width = p.value"
                              class="px-3 py-1.5 rounded-lg text-xs font-medium border transition-all"
                              :class="screenShareOpts.width === p.value
                                  ? 'bg-green/15 border-green/50 text-green shadow-sm shadow-green/10 cursor-pointer'
                                  : 'bg-discord-900 border-discord-600 text-discord-100 hover:border-discord-400 hover:text-white cursor-pointer'">
                        {{ p.label }}
                      </button>
                    </div>
                    <p class="text-discord-300 text-[11px] mt-1.5">画质越高，观看越清晰，占用带宽越大</p>
                  </div>
                  <div>
                    <p class="text-discord-100 text-xs font-medium mb-2">帧率</p>
                    <div class="grid grid-cols-3 gap-1 bg-discord-900 border border-discord-600 rounded-xl p-1">
                      <button v-for="f in shareFpsOptions" :key="f"
                              @click="screenShareOpts.fps = f"
                              class="py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer"
                              :class="screenShareOpts.fps === f
                                ? 'bg-green text-white shadow'
                                : 'text-discord-200 hover:text-white hover:bg-discord-600/50'">
                        {{ f }}fps
                      </button>
                    </div>
                    <p class="text-discord-300 text-[11px] mt-1.5">更高的帧率让画面更流畅，但更占带宽</p>
                  </div>
                </div>
                <div class="px-4 py-3 bg-discord-900/60 border-t border-discord-600/40 flex items-center justify-between gap-3">
                  <p class="text-discord-300 text-[11px] leading-tight flex-shrink-0">
                    投屏内容将实时发送给<br>频道内所有人
                  </p>
                  <div class="flex items-center gap-2 flex-shrink-0">
                    <button @click="shareMenuOpen = false" class="btn-ghost px-4 py-2 rounded-full text-sm">
                      取消
                    </button>
                    <button @click="startShareFromMenu" class="btn-green px-5 py-2 rounded-full text-sm">
                      <span class="flex items-center gap-1.5">
                        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                        </svg>
                        开始投屏
                      </span>
                    </button>
                  </div>
                </div>
              </div>
              </Transition>
              <button @click="voiceStore.leaveRoom()" class="btn-red px-5 py-2 rounded-full text-sm">
                <span class="flex items-center gap-1.5">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 3h5m0 0v5m0-5l-6 6M5 3a2 2 0 00-2 2v1c0 8.284 6.716 15 15 15h1a2 2 0 002-2v-3.28a1 1 0 00-.684-.948l-4.493-1.498a1 1 0 00-1.21.502l-1.13 2.257a11.042 11.042 0 01-5.516-5.517l2.257-1.128a1 1 0 00.502-1.21L9.228 3.683A1 1 0 008.279 3H5z" />
                  </svg>
                  离开
                </span>
              </button>
              <button @click="voiceStore.toggleMute()"
                      :class="[voiceStore.isMuted ? 'btn-red' : 'btn-ghost', !voiceStore.micAvailable ? 'opacity-50 cursor-not-allowed' : '']"
                      class="px-4 py-2 rounded-full text-sm"
                      :disabled="!voiceStore.micAvailable">
                <span class="flex items-center gap-1.5">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                  {{ voiceStore.isMuted ? '取消静音' : '静音' }}
                </span>
              </button>
              <button @click="voiceStore.toggleDeafen()"
                      :class="voiceStore.isDeafened ? 'btn-red' : 'btn-ghost'"
                      class="px-4 py-2 rounded-full text-sm">
                <span class="flex items-center gap-1.5">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                  </svg>
                  {{ voiceStore.isDeafened ? '取消静音' : '静音喇叭' }}
                </span>
              </button>
              <template v-if="voiceStore.screenShareSupported">
              <template v-if="!voiceStore.isScreenSharing">
                <button id="share-toggle-btn" @click="shareMenuOpen = !shareMenuOpen"
                        class="btn-ghost px-4 py-2 rounded-full text-xs text-green hover:text-green border border-green/30 hover:border-green/60"
                        :class="shareMenuOpen ? 'bg-green/10' : ''">
                  <span class="flex items-center justify-center gap-1">
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                    </svg>
                    投屏
                  </span>
                </button>
              </template>
              <template v-else>
                <button @click="voiceStore.stopScreenShare()"
                        class="btn-red px-4 py-2 rounded-full text-sm">
                  <span class="flex items-center gap-1">
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0zM9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
                    </svg>
                    停止投屏
                  </span>
                </button>
              </template>
              </template>
            </div>
          </div>
        </div>
      </div>

      <div v-else class="community-welcome-shell">
        <header class="community-mobile-header md:hidden">
          <button type="button" aria-label="打开频道列表" @click="mobileChannelsOpen = true">频道</button>
          <span>{{ serverStore.currentServer.name }}</span>
          <button type="button" aria-label="打开成员列表" @click="mobileMembersOpen = true">成员</button>
        </header>
        <CommunityWelcome :server="serverStore.currentServer" :channels="serverStore.channels" :can-manage="serverStore.canManageServer"
                          @select-channel="serverStore.setCurrentChannel" @open-settings="showServerSettings = true" />
      </div>

      <div v-show="!cinemaMode" class="voice-navigation-zone" :inert="cinemaMode || diagnosticsOpen ? true : undefined" :aria-hidden="cinemaMode ? true : undefined">
      <MemberList
        :mobile-open="mobileMembersOpen"
        :is-mobile="viewport.isMobile"
        :desktop-open="isMessageChannel(serverStore.currentChannel) ? desktopMembersOpen : true"
        @close="mobileMembersOpen = false"
        @open-user-profile="openUserProfile" />
      </div>
    </template>

    <template v-else>
      <div class="chat-empty-state flex-1 flex items-center justify-center bg-discord-700">
        <div class="chat-empty-content text-center">
          <div class="w-24 h-24 bg-discord-600 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg class="w-12 h-12 text-discord-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </div>
          <h2 class="text-xl font-bold text-white mb-2">欢迎使用 {{ siteStore.siteName }}</h2>
          <p class="text-discord-200 mb-6">选择一个服务器开始聊天，或创建一个新的服务器</p>
          <button @click="showCreateServer = true" class="btn-primary px-6 py-3 text-base">
            创建服务器
          </button>
        </div>
      </div>
    </template>

    </div>
    <VoiceDiagnostics v-if="diagnosticsOpen" :names="diagnosticNames" @close="closeDiagnostics" />
    <CreateServerModal v-if="showCreateServer" @close="showCreateServer = false" />
    <CreateChannelModal v-if="showCreateChannel" @close="showCreateChannel = false" />
    <InviteModal v-if="showInviteModal" @close="showInviteModal = false" />
    <ServerSettings v-if="showServerSettings" :key="serverStore.currentServer?.id" @close="showServerSettings = false" />
    <ChannelSettingsModal v-if="showChannelSettings && settingsChannel"
                          :channel="settingsChannel"
                          @close="showChannelSettings = false; settingsChannel = null" />
    <UserProfileModal v-if="showUserProfile && profileUserId" :userId="profileUserId" @close="showUserProfile = false; profileUserId = null" />
  </div>
</template>

<style scoped>
.pop-enter-active,
.pop-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}
.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: translate(-50%, 10px) scale(0.95);
}
</style>
