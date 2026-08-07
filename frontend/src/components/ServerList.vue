<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useServerStore } from '../stores/server'
import { useAuthStore } from '../stores/auth'
import { ws } from '../utils/ws'

const emit = defineEmits<{ 'create-server': [] }>()
const router = useRouter()
const route = useRoute()
const serverStore = useServerStore()
const authStore = useAuthStore()

function handleServerEvent(data: any) {
  if (data.type === 'server-deleted') {
    serverStore.handleServerDeleted(data.serverId)
    if (route.path === '/' && !serverStore.currentServer) {
      router.push('/')
    }
    return
  }
  serverStore.fetchServers()
}

onMounted(() => {
  serverStore.fetchServers()
  ws.on('server-added', handleServerEvent)
  ws.on('server-removed', handleServerEvent)
  ws.on('server-deleted', handleServerEvent)
})

onUnmounted(() => {
  ws.off('server-added', handleServerEvent)
  ws.off('server-removed', handleServerEvent)
  ws.off('server-deleted', handleServerEvent)
})

async function selectServer(serverId: string) {
  await serverStore.fetchServer(serverId)
}

async function selectDM() {
  serverStore.currentServer = null as any
  serverStore.currentChannel = null as any
  await router.push('/friend')
}

function goHome() {
  serverStore.currentServer = null as any
  serverStore.currentChannel = null as any
  router.push('/')
}

function goMe() {
  router.push('/me')
}

function handleJoinServer() {
  const code = prompt('请输入邀请码:')
  if (code) {
    serverStore.joinServer(code).catch((e: any) => alert(e.message))
  }
}
</script>

<template>
  <div class="hidden md:flex w-server-bar min-w-server-bar bg-discord-900 flex-col items-center py-3 gap-2 overflow-y-auto">
    <div class="sidebar-item" :class="{ active: !serverStore.currentServer && route.path === '/' }"
         @click="goHome" title="首页">
      <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
      </svg>
    </div>

    <div class="w-8 h-0.5 bg-discord-500 rounded-full my-1"></div>

    <div class="sidebar-item dm" :class="{ active: route.path === '/friend' }"
         @click="selectDM" title="好友">
      <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    </div>

    <div class="w-8 h-0.5 bg-discord-500 rounded-full my-1"></div>

    <div v-for="server in serverStore.servers" :key="server.id"
         class="sidebar-item relative"
         :class="{ active: serverStore.currentServer?.id === server.id }"
         @click="selectServer(server.id)"
         :title="server.name">
      <img v-if="server.avatar && server.avatar !== 'default'"
           :src="server.avatar" class="w-full h-full object-cover rounded-2xl" />
      <span v-else class="text-white text-lg font-semibold truncate text-center text-xs leading-tight px-1">
        {{ server.name.slice(0, 3) }}
      </span>
    </div>

    <div class="flex flex-col items-center gap-2 mt-2">
      <div class="sidebar-item bg-green/20 hover:bg-green text-green hover:text-white"
           @click="emit('create-server')" title="创建服务器">
        <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
        </svg>
      </div>

      <div class="sidebar-item bg-discord-700 hover:bg-discord-500"
           @click="handleJoinServer" title="加入服务器">
        <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
        </svg>
      </div>
    </div>

    <div class="flex-1"></div>

    <div class="sidebar-item w-10 h-10 text-sm" @click="goMe" title="个人设置">
      <div class="w-full h-full rounded-2xl bg-discord-600 flex items-center justify-center overflow-hidden">
        <img v-if="authStore.user?.avatar && authStore.user.avatar !== 'default'"
             :src="authStore.user.avatar" class="w-full h-full object-cover" />
        <span v-else class="text-white font-bold">{{ authStore.user?.username?.charAt(0).toUpperCase() }}</span>
      </div>
    </div>
  </div>

  <nav class="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-discord-900 border-t border-discord-700 flex items-center gap-2 px-2 py-2 overflow-x-auto no-scrollbar"
       style="padding-bottom: calc(env(safe-area-inset-bottom) + 0.5rem)">
    <div class="mobile-nav-item" :class="{ active: !serverStore.currentServer && route.path === '/' }"
         @click="goHome" title="首页">
      <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
      </svg>
    </div>

    <div class="mobile-nav-item" :class="{ active: route.path === '/friend' }"
         @click="selectDM" title="好友">
      <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    </div>

    <div class="w-px h-6 bg-discord-600 flex-shrink-0"></div>

    <div v-for="server in serverStore.servers" :key="server.id"
         class="w-10 h-10 rounded-full flex-shrink-0 relative overflow-hidden flex items-center justify-center cursor-pointer transition-colors"
         :class="serverStore.currentServer?.id === server.id ? 'bg-green' : 'bg-discord-600 hover:bg-discord-500'"
         @click="selectServer(server.id)" :title="server.name">
      <img v-if="server.avatar && server.avatar !== 'default'"
           :src="server.avatar" class="w-full h-full object-cover" />
      <span v-else class="text-white text-xs font-semibold truncate px-0.5">{{ server.name.slice(0, 3) }}</span>
    </div>

    <div class="w-10 h-10 rounded-full flex-shrink-0 bg-green/20 text-green flex items-center justify-center cursor-pointer"
         @click="emit('create-server')" title="创建服务器">
      <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
      </svg>
    </div>

    <div class="w-10 h-10 rounded-full flex-shrink-0 bg-discord-600 text-discord-200 flex items-center justify-center cursor-pointer"
         @click="handleJoinServer" title="加入服务器">
      <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
      </svg>
    </div>

    <div class="flex-1 min-w-2 flex-shrink-0"></div>

    <div class="w-10 h-10 rounded-full flex-shrink-0 bg-discord-600 overflow-hidden cursor-pointer" @click="goMe" title="个人设置">
      <div class="w-full h-full flex items-center justify-center">
        <img v-if="authStore.user?.avatar && authStore.user.avatar !== 'default'"
             :src="authStore.user.avatar" class="w-full h-full object-cover" />
        <span v-else class="text-white text-sm font-bold">{{ authStore.user?.username?.charAt(0).toUpperCase() }}</span>
      </div>
    </div>
  </nav>
</template>
