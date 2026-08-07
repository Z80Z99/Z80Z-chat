<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useServerStore } from '../stores/server'
import { useAuthStore } from '../stores/auth'
import { useVoiceStore } from '../stores/voice'
import { usePresence } from '../stores/presence'
import { ws } from '../utils/ws'
import Avatar from './Avatar.vue'

const emit = defineEmits<{ 'open-user-profile': [userId: string]; 'close': [] }>()

defineProps<{ mobileOpen?: boolean }>()

const serverStore = useServerStore()
const authStore = useAuthStore()
const voiceStore = useVoiceStore()

const { onlineUserIds } = usePresence()

const selfId = computed(() => authStore.user?.id)

function handleMemberEvent(data: any) {
  if (data.serverId && data.serverId === serverStore.currentServer?.id) {
    serverStore.refreshMembers(data.serverId)
  }
}

onMounted(() => {
  ws.on('member-added', handleMemberEvent)
  ws.on('member-removed', handleMemberEvent)
})

onUnmounted(() => {
  ws.off('member-added', handleMemberEvent)
  ws.off('member-removed', handleMemberEvent)
})

const voiceMembers = computed(() =>
  serverStore.members.filter(m => voiceStore.participants.includes(m.userId))
)

const onlineMembers = computed(() =>
  serverStore.members.filter(m => onlineUserIds.value.has(m.userId))
)

const offlineMembers = computed(() =>
  serverStore.members.filter(m => !onlineUserIds.value.has(m.userId))
)
</script>

<template>
  <div v-if="mobileOpen" class="fixed inset-0 bg-black/60 z-40 md:hidden" @click="emit('close')"></div>

  <div class="fixed inset-y-0 right-0 z-40 md:static md:z-auto w-[75vw] max-w-[280px] md:w-member-bar md:min-w-member-bar bg-discord-800 flex flex-col transition-transform duration-200 transform md:translate-x-0"
       :class="mobileOpen ? 'translate-x-0' : 'translate-x-full'">
    <div class="h-12 shadow-md bg-discord-800 z-10 flex items-center justify-end pr-2 md:hidden">
      <button @click="emit('close')" class="p-1 text-discord-200 hover:text-white" title="关闭">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>

    <div class="flex-1 overflow-y-auto py-3 px-2">
      <template v-if="voiceStore.currentRoom && voiceMembers.length > 0">
        <div class="flex items-center px-2 mb-2">
          <span class="text-xs font-bold text-green uppercase tracking-wider">语音中</span>
          <span class="ml-auto text-[10px] font-bold text-discord-300 bg-discord-700 rounded-full px-1.5 min-w-[18px] text-center">{{ voiceMembers.length }}</span>
        </div>

        <div v-for="member in voiceMembers" :key="member.userId"
             class="member-item" @click="emit('open-user-profile', member.userId)">
          <Avatar :src="member.user?.avatar"
                  :name="member.user?.nickname || member.user?.username"
                  status="bg-green border-discord-800" />
          <span class="text-sm text-green truncate">{{ member.user?.nickname || member.user?.username }}</span>
          <span v-if="member.userId === selfId" class="text-xs text-discord-300 font-normal">（你）</span>
          <svg class="ml-auto w-4 h-4 text-green flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" title="语音中">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
          </svg>
        </div>

        <div class="border-t border-discord-600 my-3"></div>
      </template>

      <div class="flex items-center px-2 mb-2">
        <span class="text-xs font-bold text-discord-200 uppercase tracking-wider">在线</span>
        <span class="ml-auto text-[10px] font-bold text-discord-300 bg-discord-700 rounded-full px-1.5 min-w-[18px] text-center">{{ onlineMembers.length }}</span>
      </div>

      <div v-for="member in onlineMembers" :key="member.userId"
           class="member-item" @click="emit('open-user-profile', member.userId)">
        <Avatar :src="member.user?.avatar"
                :name="member.user?.nickname || member.user?.username"
                status="bg-green border-discord-800" />
        <span class="text-sm text-discord-50 truncate">{{ member.user?.nickname || member.user?.username }}</span>
        <span v-if="member.userId === selfId" class="text-xs text-discord-300 font-normal">（你）</span>
      </div>

      <div v-if="offlineMembers.length > 0" class="flex items-center px-2 mt-4 mb-2">
        <span class="text-xs font-bold text-discord-200 uppercase tracking-wider">离线</span>
        <span class="ml-auto text-[10px] font-bold text-discord-300 bg-discord-700 rounded-full px-1.5 min-w-[18px] text-center">{{ offlineMembers.length }}</span>
      </div>

      <div v-for="member in offlineMembers" :key="member.userId"
           class="member-item opacity-60" @click="emit('open-user-profile', member.userId)">
        <span class="grayscale">
          <Avatar :src="member.user?.avatar"
                  :name="member.user?.nickname || member.user?.username"
                  status="bg-discord-400 border-discord-800" />
        </span>
        <span class="text-sm text-discord-200 truncate">{{ member.user?.nickname || member.user?.username }}</span>
        <span v-if="member.userId === selfId" class="text-xs text-discord-300 font-normal">（你）</span>
      </div>
    </div>
  </div>
</template>
