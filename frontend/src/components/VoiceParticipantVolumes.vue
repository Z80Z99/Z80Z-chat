<script setup lang="ts">
import { computed } from 'vue'
import { useVoiceStore } from '../stores/voice'
import { useAuthStore } from '../stores/auth'
import { useServerStore } from '../stores/server'
const voiceStore = useVoiceStore()
const authStore = useAuthStore()
const serverStore = useServerStore()
const others = computed(() => [...new Set(voiceStore.participants)].filter(id => id !== authStore.user?.id))
function memberName(id: string) {
  const user = serverStore.members.find(member => member.userId === id)?.user
  return user?.nickname || user?.username || '未知用户'
}
</script>

<template>
  <div v-if="others.length" class="voice-participant-volumes border-t border-discord-600/50 mt-4 pt-3">
    <p class="text-sm text-discord-100 font-medium">成员音量</p>
    <p class="text-xs text-discord-300 mt-1 mb-2">仅调整你听到的声音，保存在本机。</p>
    <label v-for="id in others" :key="id" class="voice-volume-row">
      <span class="text-sm text-discord-100 truncate" :title="memberName(id)">{{ memberName(id) }}</span>
      <input type="range" min="0" max="100" step="5" :aria-label="`${memberName(id)} 的音量`"
             :value="Math.round(voiceStore.getUserVolume(id) * 100)"
             class="min-w-0 w-full accent-green"
             @input="voiceStore.setUserVolume(id, Number(($event.target as HTMLInputElement).value) / 100)" />
      <span class="text-xs text-discord-200 text-right">{{ Math.round(voiceStore.getUserVolume(id) * 100) }}%</span>
    </label>
  </div>
</template>
