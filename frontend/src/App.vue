<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from './stores/auth'
import { useSiteStore } from './stores/site'
import { useServerStore } from './stores/server'
import { useVoiceStore } from './stores/voice'
import { useReadStateStore } from './stores/read-state'
import { useNotificationStore } from './stores/notifications'
import NotificationInbox from './components/NotificationInbox.vue'
import { ws } from './utils/ws'

const auth = useAuthStore()
const router = useRouter()
const site = useSiteStore()
const serverStore = useServerStore()
const voiceStore = useVoiceStore()
const readStateStore = useReadStateStore()
const notificationStore = useNotificationStore()
site.init()

watch(() => auth.user, () => notificationStore.activate(), { immediate: true, flush: 'sync' })

function handleReadState(data: any) { readStateStore.mergeState(data.state, data.serverId) }
function handleCommunityProfile(data: any) { if (auth.user) serverStore.handleServerUpdated(data) }
function handleCommunityChannel(data: any) {
  if (!auth.user) return
  serverStore.handleChannelEvent(data)
  if (serverStore.currentServer?.id === data.serverId) refreshReadStates()
}
function refreshCommunity() {
  if (!auth.user) return
  void serverStore.fetchServers().catch(() => {})
  const id = serverStore.currentServer?.id
  if (id) void serverStore.fetchServer(id).catch(() => {})
}
function refreshReadStates() {
  const id = serverStore.currentServer?.id
  if (auth.user && id) void readStateStore.loadServer(id).catch(() => {})
}
ws.on('read-state', handleReadState)
ws.on('server-updated', handleCommunityProfile)
ws.on('channel-created', handleCommunityChannel)
ws.on('channel-updated', handleCommunityChannel)
ws.on('channel-deleted', handleCommunityChannel)
ws.onReconnect(refreshCommunity)
ws.onReconnect(refreshReadStates)
watch([() => auth.user?.id, () => serverStore.currentServer?.id], refreshReadStates, { immediate: true })

// Activate the socket before child components queue channel/voice subscriptions.
const bootstrapToken = localStorage.getItem('token')
if (bootstrapToken) {
  ws.connect(bootstrapToken)
  void restoreSession(bootstrapToken)
}

async function restoreSession(token: string) {
  try {
    await auth.fetchMe()
  } catch {
    const currentToken = localStorage.getItem('token')
    // A late response from the previous session must not log out a newer login.
    if (currentToken && currentToken !== token) return
    ws.disconnect()
    auth.user = null
    localStorage.removeItem('token')
    router.replace('/login')
  }
}

let versionTimer: any = null
let knownVersion: number | null = null

async function checkVersion() {
  try {
    const res = await fetch('/api/version')
    const data = await res.json()
    if (knownVersion === null) {
      knownVersion = data.version
      return
    }
    if (data.version !== knownVersion) {
      voiceStore.saveVoiceState(serverStore.currentServer?.id || undefined)
      location.reload()
    }
  } catch {}
}

function handleBeforeUnload() {
  voiceStore.saveVoiceState(serverStore.currentServer?.id || undefined)
}

onMounted(() => {
  checkVersion()
  versionTimer = setInterval(checkVersion, 10000)
  window.addEventListener('beforeunload', handleBeforeUnload)
})

onUnmounted(() => {
  if (versionTimer) clearInterval(versionTimer)
  window.removeEventListener('beforeunload', handleBeforeUnload)
  ws.off('read-state', handleReadState)
  ws.off('server-updated', handleCommunityProfile)
  ws.off('channel-created', handleCommunityChannel)
  ws.off('channel-updated', handleCommunityChannel)
  ws.off('channel-deleted', handleCommunityChannel)
  ws.offReconnect(refreshCommunity)
  ws.offReconnect(refreshReadStates)
  notificationStore.deactivate()
})
</script>

<template>
  <div class="h-full w-full">
    <router-view />
    <NotificationInbox v-if="auth.user" />
  </div>
</template>
