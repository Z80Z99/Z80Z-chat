<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useAuthStore } from './stores/auth'
import { useSiteStore } from './stores/site'
import { useServerStore } from './stores/server'
import { useVoiceStore } from './stores/voice'
import { ws } from './utils/ws'

const auth = useAuthStore()
const site = useSiteStore()
const serverStore = useServerStore()
const voiceStore = useVoiceStore()
site.init()

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

onMounted(async () => {
  const token = localStorage.getItem('token')
  if (token) {
    try {
      await auth.fetchMe()
      ws.connect(token)
    } catch {
      localStorage.removeItem('token')
    }
  }
  checkVersion()
  versionTimer = setInterval(checkVersion, 10000)
  window.addEventListener('beforeunload', handleBeforeUnload)
})

onUnmounted(() => {
  if (versionTimer) clearInterval(versionTimer)
  window.removeEventListener('beforeunload', handleBeforeUnload)
})
</script>

<template>
  <div class="h-full w-full">
    <router-view />
  </div>
</template>
