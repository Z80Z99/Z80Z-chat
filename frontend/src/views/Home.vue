<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useServerStore } from '../stores/server'
import { useChatStore } from '../stores/chat'
import { useAuthStore } from '../stores/auth'
import { useVoiceStore } from '../stores/voice'
import { useSiteStore } from '../stores/site'
import { ws } from '../utils/ws'
import ServerList from '../components/ServerList.vue'
import ChannelList from '../components/ChannelList.vue'
import ChatBox from '../components/ChatBox.vue'
import MemberList from '../components/MemberList.vue'
import CreateServerModal from '../components/CreateServerModal.vue'
import CreateChannelModal from '../components/CreateChannelModal.vue'
import InviteModal from '../components/InviteModal.vue'
import ServerSettings from '../components/ServerSettings.vue'
import ChannelSettingsModal from '../components/ChannelSettingsModal.vue'
import UserProfileModal from '../components/UserProfileModal.vue'
import DeviceSelect from '../components/DeviceSelect.vue'
import MarqueeText from '../components/MarqueeText.vue'
import ScreenShareVideo from '../components/ScreenShareVideo.vue'
import Avatar from '../components/Avatar.vue'

const route = useRoute()
const router = useRouter()
const serverStore = useServerStore()
const chatStore = useChatStore()
const authStore = useAuthStore()
const voiceStore = useVoiceStore()
const siteStore = useSiteStore()

const localPreviewRef = ref<HTMLVideoElement | null>(null)
const screenShareOpts = ref({ width: 1920, height: 1080, fps: 30 })
const showCreateServer = ref(false)
const showCreateChannel = ref(false)
const showInviteModal = ref(false)
const showServerSettings = ref(false)
const showUserProfile = ref(false)
const profileUserId = ref<string | null>(null)
const showChannelSettings = ref(false)
const settingsChannel = ref<any>(null)
const inviteCode = ref(route.params.code as string || '')
const mobileChannelsOpen = ref(false)
const mobileMembersOpen = ref(false)
const audioSettingsOpen = ref(true)
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
  if (window.innerWidth < 768) {
    mobileChannelsOpen.value = true
    mobileMembersOpen.value = false
  }
})

onMounted(async () => {
  await serverStore.fetchServers()
  if (inviteCode.value) {
    try {
      await serverStore.joinServer(inviteCode.value)
      router.replace('/')
    } catch {}
  }

  ws.on('message', handleWSMessage)
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

  ws.onReconnect(() => {
    if (voiceStore.currentRoom) {
      voiceStore.rejoinRoom(voiceStore.currentRoom)
    }
  })

  if (!authStore.user) {
    try {
      await authStore.fetchMe()
    } catch {}
  }

  const savedVoice = voiceStore.loadVoiceState()
  if (savedVoice && savedVoice.serverId) {
    try {
      await serverStore.fetchServer(savedVoice.serverId)
      const channel = serverStore.channels.find(c => c.id === savedVoice.roomId && c.type === 'voice')
      if (channel) {
        serverStore.setCurrentChannel(channel)
        await voiceStore.rejoinRoom(savedVoice.roomId)
        if (savedVoice.isMuted) voiceStore.toggleMute()
        if (savedVoice.isDeafened) voiceStore.toggleDeafen()
      }
    } catch {}
    voiceStore.clearVoiceState()
  }
})

onUnmounted(() => {
  ws.off('message', handleWSMessage)
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
})

function handleGlobalClick(e: MouseEvent) {
  if (!shareMenuOpen.value) return
  const target = e.target as HTMLElement
  if (!target.closest('#share-menu') && !target.closest('#share-toggle-btn')) {
    shareMenuOpen.value = false
  }
}

watch(() => serverStore.currentChannel, (channel) => {
  if (channel) {
    chatStore.clearMessages()
    chatStore.loadMessages(channel.id)
    ws.send({ type: 'join-channel', channelId: channel.id })
  }
})

watch(() => voiceStore.isScreenSharing, async (sharing) => {
  if (sharing && voiceStore.screenStream) {
    await nextTick()
    if (localPreviewRef.value) {
      localPreviewRef.value.srcObject = voiceStore.screenStream
    }
  } else if (!sharing && localPreviewRef.value) {
    localPreviewRef.value.srcObject = null
  }
})

// 投屏源切换时 isScreenSharing 不变，需单独监听 screenStream 重新绑定预览
watch(() => voiceStore.screenStream, async (stream) => {
  await nextTick()
  if (localPreviewRef.value) {
    localPreviewRef.value.srcObject = stream
  }
})

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
    voiceStore.participants = voiceStore.participants.filter(id => id !== data.userId)
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
  voiceStore.cleanupRemoteScreen(data.userId)
}

function handleScreenShareStart(data: any) {
  const uid = data.userId
  setTimeout(() => {
    if (voiceStore.currentRoom && !voiceStore.remoteScreens.some(e => e.userId === uid)) {
      voiceStore.requestScreenRefresh()
    }
  }, 2000)
}

function handleScreenRefresh() {
  voiceStore.requestScreenRefresh()
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
  <div class="h-full flex pb-16 md:pb-0">
    <ServerList @create-server="showCreateServer = true" />

    <template v-if="serverStore.currentServer">
      <ChannelList
        :mobile-open="mobileChannelsOpen"
        @close="mobileChannelsOpen = false"
        @select-channel="serverStore.setCurrentChannel"
        @create-channel="showCreateChannel = true"
        @open-invite="showInviteModal = true"
        @open-settings="showServerSettings = true"
        @channel-settings="settingsChannel = $event; showChannelSettings = true"
      />

      <ChatBox
        v-if="serverStore.currentChannel && serverStore.currentChannel.type === 'text'"
        @open-user-profile="openUserProfile"
        @toggle-channels="mobileChannelsOpen = true"
        @toggle-members="mobileMembersOpen = true"
      />

      <div v-else-if="serverStore.currentChannel && serverStore.currentChannel.type === 'voice'"
           class="flex-1 flex flex-col bg-discord-700">
        <div class="h-12 flex items-center px-4 shadow-sm border-b border-discord-600 md:hidden">
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
        <div class="flex-1 min-h-0 overflow-y-auto">
          <div v-if="!voiceStore.currentRoom || voiceStore.currentRoom !== serverStore.currentChannel.id"
               class="min-h-full flex flex-col items-center justify-center p-4">
            <div class="text-center w-full max-w-md">
            <div class="bg-discord-800/70 border border-discord-600/50 rounded-2xl shadow-2xl py-12 px-8">
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
            </div>
          </div>

          <div v-else class="w-full max-w-4xl mx-auto flex flex-col gap-4 p-4">

            <div class="flex items-center justify-between gap-3 flex-wrap bg-gradient-to-r from-discord-800/90 to-discord-800/60 border border-discord-600/50 rounded-xl px-4 py-3">
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
                <span class="flex items-center gap-1.5 bg-discord-900/60 rounded-full px-2.5 py-1" title="连接质量">
                  <span class="w-2 h-2 rounded-full"
                        :class="voiceStore.connectionStats.quality === 'good' ? 'bg-green' : voiceStore.connectionStats.quality === 'fair' ? 'bg-yellow' : voiceStore.connectionStats.quality === 'poor' ? 'bg-red' : 'bg-discord-400'"></span>
                  <span class="text-discord-200">
                    {{ voiceStore.connectionStats.quality === 'good' ? '优' : voiceStore.connectionStats.quality === 'fair' ? '中' : voiceStore.connectionStats.quality === 'poor' ? '差' : '等待' }}
                  </span>
                </span>
                <span class="bg-discord-900/60 rounded-full px-2.5 py-1 text-discord-200" title="延迟">
                  <span class="text-discord-100">{{ voiceStore.connectionStats.rtt }}</span>ms
                </span>
                <span class="bg-discord-900/60 rounded-full px-2.5 py-1 text-discord-200" title="丢包率">
                  丢包 <span class="text-discord-100">{{ voiceStore.connectionStats.lossRate }}</span>%
                </span>
              </div>
            </div>

            <div v-if="voiceStore.isScreenSharing" class="rounded-xl overflow-hidden bg-black border border-discord-600/50">
              <video ref="localPreviewRef" autoplay muted playsinline
                     class="w-full aspect-video object-contain"></video>
              <p class="text-green text-xs text-center py-1.5 bg-discord-900/80">
                <span class="inline-block w-2 h-2 bg-green rounded-full animate-pulse mr-1"></span>
                你的投屏预览
              </p>
              <div class="grid grid-cols-[auto_1fr_auto] items-center gap-1.5 px-2 py-2 bg-discord-900/80 border-t border-discord-600/40">
                <div class="flex items-center gap-1">
                  <select :value="voiceStore.currentShareOpts.width"
                          @change="changeShareQuality({ width: Number(($event.target as HTMLSelectElement).value), fps: voiceStore.currentShareOpts.fps })"
                          class="bg-discord-900 text-xs text-discord-100 border border-discord-600 rounded px-1.5 py-1 outline-none cursor-pointer">
                    <option v-for="p in sharePresetOptions" :key="p.value" :value="p.value"
                            :disabled="p.value > 0 && p.value > voiceStore.sourceResolution.width">
                      {{ p.label }}
                    </option>
                  </select>
                  <select :value="voiceStore.currentShareOpts.fps"
                          @change="changeShareQuality({ width: voiceStore.currentShareOpts.width, fps: Number(($event.target as HTMLSelectElement).value) })"
                          class="bg-discord-900 text-xs text-discord-100 border border-discord-600 rounded px-1.5 py-1 outline-none cursor-pointer">
                    <option v-for="f in shareFpsOptions" :key="f" :value="f">{{ f }}fps</option>
                  </select>
                </div>
                <div class="flex items-center justify-center gap-3 text-[11px] hidden sm:flex">
                  <span class="flex items-center gap-1 text-discord-300" title="上行码率">
                    <svg class="w-3 h-3 text-green" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16V4m0 0L3 8m4-4l4 4m6 4v10m0 0l4-4m-4 4l-4-4" />
                    </svg>
                    <span class="text-discord-100 font-medium">{{ voiceStore.connectionStats.outBitrate }}</span><span class="text-discord-400">kbps</span>
                  </span>
                  <span class="w-px h-3 bg-discord-600"></span>
                  <span class="flex items-center gap-1 text-discord-300" title="发送分辨率">
                    <svg class="w-3 h-3 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                    </svg>
                    <span class="text-discord-100 font-medium">{{ voiceStore.connectionStats.outWidth }}×{{ voiceStore.connectionStats.outHeight }}</span>
                  </span>
                  <span class="w-px h-3 bg-discord-600"></span>
                  <span class="flex items-center gap-1 text-discord-300" title="发送帧率">
                    <svg class="w-3 h-3 text-yellow" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span class="text-discord-100 font-medium">{{ voiceStore.connectionStats.outFps }}</span><span class="text-discord-400">fps</span>
                  </span>
                  <span class="w-px h-3 bg-discord-600"></span>
                  <span class="flex items-center gap-1 text-discord-300" title="丢包率">
                    <svg class="w-3 h-3" :class="Number(voiceStore.connectionStats.outLossRate) > 1 ? 'text-red' : 'text-green'" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6" />
                    </svg>
                    <span class="text-discord-100 font-medium">{{ voiceStore.connectionStats.outLossRate }}</span><span class="text-discord-400">%</span>
                  </span>
                </div>
                <button @click="voiceStore.switchScreenSource()"
                        class="text-xs text-green border border-green/30 hover:bg-green/10 rounded px-2 py-1 flex items-center gap-1 cursor-pointer"
                        title="切换到其它窗口/屏幕，无需断开">
                  <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                  </svg>
                  切换窗口
                </button>
              </div>
            </div>

            <div v-if="voiceStore.remoteScreens.length > 0"
                 class="grid gap-3 items-start"
                 :class="voiceStore.remoteScreens.length === 1 ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-2'">
              <ScreenShareVideo v-for="entry in voiceStore.remoteScreens"
                                :key="`${entry.userId}-${entry.ts}`"
                                :user-id="entry.userId"
                                :stream="entry.stream"
                                @refresh="handleScreenRefresh" />
            </div>

            <div v-if="voiceStore.remoteScreens.length > 0"
                 class="flex items-center justify-center gap-2 flex-wrap text-xs">
              <span class="bg-discord-900/60 rounded-full px-2.5 py-1 text-discord-200"
                    title="观看投屏的接收端监测数据（反映投屏方传输质量）">
                <svg class="w-3 h-3 inline mr-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8v12m0 0l4-4m-4 4l-4-4M7 4v12m0 0l4-4m-4 4l-4-4" />
                </svg>
                下行 <span class="text-discord-100">{{ voiceStore.connectionStats.inBitrate }}</span>kbps
                · {{ voiceStore.connectionStats.inWidth }}×{{ voiceStore.connectionStats.inHeight }}
                · <span class="text-discord-100">{{ voiceStore.connectionStats.inFps }}</span>fps
                · 丢包 <span class="text-discord-100">{{ voiceStore.connectionStats.inLossRate }}</span>%
              </span>
              <span class="bg-discord-900/60 rounded-full px-2.5 py-1 text-discord-200" title="CPU 核心数">
                <svg class="w-3 h-3 inline mr-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
                </svg>
                {{ voiceStore.connectionStats.cpuCores }}核
              </span>
            </div>

            <div class="bg-discord-800/70 border border-discord-600/50 rounded-xl p-4">
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
            </div>

            <div class="bg-discord-800/70 border border-discord-600/50 rounded-xl p-4">
              <button @click="audioSettingsOpen = !audioSettingsOpen; if (!audioSettingsOpen) voiceStore.refreshDevices()"
                      class="w-full flex items-center justify-between">
                <p class="text-xs font-bold text-green uppercase tracking-wider flex items-center gap-1.5">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                  音频设置
                </p>
                <svg class="w-4 h-4 text-discord-200 transition-transform"
                     :class="audioSettingsOpen ? 'rotate-180' : ''"
                     fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              <div v-if="!voiceStore.micAvailable && voiceStore.micError"
                   class="bg-yellow/10 border border-yellow/30 rounded-lg px-3 py-2 mt-3 flex items-center gap-2 flex-wrap">
                <svg class="w-4 h-4 text-yellow flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
                <p class="text-yellow text-xs flex-1 min-w-0">
                  {{ voiceStore.micError }}
                </p>
                <button @click="voiceStore.retryMic()"
                        class="text-yellow text-xs px-2.5 py-1 rounded-full border border-yellow/30 hover:bg-yellow/10 hover:border-yellow/50 flex-shrink-0 cursor-pointer">
                  重新检测
                </button>
              </div>

              <div v-if="audioSettingsOpen" class="grid md:grid-cols-2 gap-4 mt-4 text-left">
                <div class="min-w-0">
                  <p class="text-discord-100 text-xs font-medium mb-2">输入设备（麦克风）</p>
                  <DeviceSelect v-if="voiceStore.inputDevices.length > 1"
                                :devices="voiceStore.inputDevices"
                                :model-value="voiceStore.inputDeviceId"
                                @change="voiceStore.changeInputDevice" />
                  <MarqueeText v-else
                               :text="'仅有一个可用麦克风，使用系统默认设备'"
                               class="text-discord-300 text-xs bg-discord-900 border border-discord-600 rounded-lg px-2 py-1.5" />
                  <div class="flex items-center gap-2 mt-3">
                    <svg class="w-4 h-4 text-discord-200 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                    </svg>
                    <input type="range" min="0" max="200" step="5"
                           :value="Math.round(voiceStore.inputVolume * 100)"
                           @input="voiceStore.setInputVolume(Number(($event.target as HTMLInputElement).value) / 100)"
                           class="w-full min-w-0 accent-green cursor-pointer" />
                    <span class="text-discord-200 text-xs w-11 text-right flex-shrink-0">{{ Math.round(voiceStore.inputVolume * 100) }}%</span>
                  </div>
                  <div class="mt-3">
                    <div class="flex items-center justify-between mb-1">
                      <span class="text-xs text-discord-400">麦克风强度</span>
                      <span class="text-xs font-mono text-discord-200">{{ Math.round(voiceStore.inputLevel * 100) }}%</span>
                    </div>
                    <div class="flex items-end gap-px h-6">
                      <div v-for="i in 32" :key="i"
                           class="flex-1 h-full rounded-sm transition-colors duration-75"
                           :class="voiceStore.inputLevel * 32 >= i
                             ? (i <= 21 ? 'bg-green' : i <= 27 ? 'bg-yellow' : 'bg-red')
                             : 'bg-discord-600/50'">
                      </div>
                    </div>
                  </div>
                </div>

                <div class="min-w-0">
                  <p class="text-discord-100 text-xs font-medium mb-2">输出设备（扬声器）</p>
                  <DeviceSelect v-if="voiceStore.outputSelectionSupported && voiceStore.outputDevices.length > 1"
                                :devices="voiceStore.outputDevices"
                                :model-value="voiceStore.outputDeviceId"
                                @change="voiceStore.changeOutputDevice" />
                  <MarqueeText v-else
                               :text="'当前设备不支持切换输出设备，声音播放到系统默认扬声器（耳机/蓝牙由系统控制）'"
                               class="text-discord-300 text-xs bg-discord-900 border border-discord-600 rounded-lg px-2 py-1.5" />
                  <div class="flex items-center gap-2 mt-3">
                    <svg class="w-4 h-4 text-discord-200 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                    </svg>
                    <input type="range" min="0" max="200" step="5"
                           :value="Math.round(voiceStore.outputVolume * 100)"
                           @input="voiceStore.setOutputVolume(Number(($event.target as HTMLInputElement).value) / 100)"
                           class="w-full min-w-0 accent-green cursor-pointer" />
                    <span class="text-discord-200 text-xs w-11 text-right flex-shrink-0">{{ Math.round(voiceStore.outputVolume * 100) }}%</span>
                  </div>
                  <div class="mt-3">
                    <div class="flex items-center justify-between mb-1">
                      <span class="text-xs text-discord-400">播放强度</span>
                      <span class="text-xs font-mono text-discord-200">{{ Math.round(voiceStore.outputLevel * voiceStore.outputVolume * 100) }}%</span>
                    </div>
                    <div class="flex items-end gap-px h-6">
                      <div v-for="i in 32" :key="i"
                           class="flex-1 h-full rounded-sm transition-colors duration-75"
                           :class="(voiceStore.outputLevel * voiceStore.outputVolume) * 32 >= i
                             ? (i <= 21 ? 'bg-blurple' : i <= 27 ? 'bg-yellow' : 'bg-red')
                             : 'bg-discord-600/50'">
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div class="flex items-center gap-2 mt-4 pt-3 border-t border-discord-600/50">
                <p class="text-discord-100 text-xs font-medium mr-1 flex items-center gap-1.5">
                  <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                  </svg>
                  测试
                </p>
                <button @click="voiceStore.playTestSound(1)"
                        :disabled="!voiceStore.micAvailable"
                        class="btn-ghost px-3 py-1.5 rounded-full text-xs flex items-center gap-1 border border-discord-600 hover:border-discord-400 disabled:opacity-50 disabled:cursor-not-allowed">
                  <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z" />
                  </svg>
                  滴
                </button>
                <button @click="voiceStore.playTestSound(2)"
                        :disabled="!voiceStore.micAvailable"
                        class="btn-ghost px-3 py-1.5 rounded-full text-xs flex items-center gap-1 border border-discord-600 hover:border-discord-400 disabled:opacity-50 disabled:cursor-not-allowed">
                  <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z" />
                  </svg>
                  嘟嘟
                </button>
                <span class="text-discord-300 text-xs hidden sm:inline">音效从麦克风通道发出，对方应能听到</span>
              </div>
            </div>

            <div class="sticky bottom-0 z-10 flex items-center justify-center gap-2 flex-wrap bg-discord-800/80 border border-discord-600/50 rounded-xl px-4 py-3 backdrop-blur">
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

      <div v-else class="flex-1 flex items-center justify-center bg-discord-700">
        <div class="text-center">
          <div class="w-20 h-20 bg-discord-600 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg class="w-10 h-10 text-discord-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          </div>
          <h2 class="text-xl font-bold text-white">选择一个频道</h2>
          <p class="text-discord-200 mt-1">从左侧选择一个文字或语音频道</p>
          <button @click="mobileChannelsOpen = true" class="btn-primary mt-4 md:hidden">
            打开频道列表
          </button>
        </div>
      </div>

      <MemberList
        :mobile-open="mobileMembersOpen"
        @close="mobileMembersOpen = false"
        @open-user-profile="openUserProfile" />
    </template>

    <template v-else>
      <div class="flex-1 flex items-center justify-center bg-discord-700">
        <div class="text-center">
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

    <CreateServerModal v-if="showCreateServer" @close="showCreateServer = false" />
    <CreateChannelModal v-if="showCreateChannel" @close="showCreateChannel = false" />
    <InviteModal v-if="showInviteModal" @close="showInviteModal = false" />
    <ServerSettings v-if="showServerSettings" @close="showServerSettings = false" />
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
