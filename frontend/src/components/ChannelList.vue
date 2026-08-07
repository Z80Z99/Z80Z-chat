<script setup lang="ts">
import { ref, watch } from 'vue'
import { useServerStore } from '../stores/server'
import { useAuthStore } from '../stores/auth'
import { useVoiceStore } from '../stores/voice'
import type { Channel } from '../types'
import Avatar from './Avatar.vue'

const emit = defineEmits<{
  'select-channel': [channel: Channel]
  'create-channel': []
  'open-invite': []
  'open-settings': []
  'channel-settings': [channel: Channel]
  'close': []
}>()

defineProps<{ mobileOpen?: boolean }>()

const serverStore = useServerStore()
const authStore = useAuthStore()
const voiceStore = useVoiceStore()

const collapsedCats = ref<Set<string>>(new Set())
const channelMenu = ref<Channel | null>(null)

watch(() => serverStore.currentServer?.id, (id) => {
  if (!id) return
  try {
    const saved = JSON.parse(localStorage.getItem(`collapsed-cats-${id}`) || '[]')
    collapsedCats.value = new Set(saved)
  } catch {
    collapsedCats.value = new Set()
  }
}, { immediate: true })

function persistCollapsed() {
  const id = serverStore.currentServer?.id
  if (id) {
    localStorage.setItem(`collapsed-cats-${id}`, JSON.stringify([...collapsedCats.value]))
  }
}

function toggleCollapsed(catId: string | null) {
  const key = catId || '__uncategorized__'
  const next = new Set(collapsedCats.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedCats.value = next
  persistCollapsed()
}

function isCollapsed(catId: string | null) {
  return collapsedCats.value.has(catId || '__uncategorized__')
}

function selectChannel(channel: Channel) {
  serverStore.setCurrentChannel(channel)
  emit('close')
}

function joinVoiceChannel(channel: Channel) {
  if (channel.type === 'voice' && voiceStore.currentRoom !== channel.id) {
    voiceStore.joinRoom(channel.id)
  }
  serverStore.setCurrentChannel(channel)
  emit('close')
}

function isOwner() {
  return serverStore.currentServer?.ownerId === authStore.user?.id
}

function isInVoiceChannel(channelId: string) {
  return voiceStore.currentRoom === channelId
}

function getRoomMembers(channelId: string) {
  return voiceStore.voiceRoomMembers[channelId] || []
}

function getMemberById(userId: string) {
  return serverStore.members.find(m => m.userId === userId)
}
</script>

<template>
  <div v-if="mobileOpen" class="fixed inset-0 bg-black/60 z-40 md:hidden" @click="emit('close')"></div>

  <div class="fixed inset-y-0 left-0 z-40 md:static md:z-auto w-[75vw] max-w-[280px] md:w-channel-bar md:min-w-channel-bar bg-discord-800 flex flex-col transition-transform duration-200 transform md:translate-x-0"
       :class="mobileOpen ? 'translate-x-0' : '-translate-x-full'">
    <div class="h-12 flex items-center justify-between px-4 shadow-md bg-discord-800 z-10"
         @click="emit('open-settings')">
      <h2 class="text-white font-bold text-sm truncate cursor-pointer hover:bg-discord-700 px-2 py-1 rounded">
        {{ serverStore.currentServer?.name }}
      </h2>
      <svg class="w-4 h-4 text-discord-200 cursor-pointer" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
      </svg>
      <button @click.stop="emit('close')" class="md:hidden p-1 text-discord-200 hover:text-white" title="关闭">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>

    <div class="flex-1 overflow-y-auto py-2">
      <div v-for="cat in serverStore.sortedCategories" :key="cat.id">
        <div class="flex items-center gap-1 px-3 py-1 mt-3 group cursor-pointer"
             @click="toggleCollapsed(cat.id)">
          <svg class="w-3 h-3 text-discord-200 transition-transform duration-150"
               :class="isCollapsed(cat.id) ? '-rotate-90' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
          <span class="text-discord-200 text-xs font-bold uppercase tracking-wider">{{ cat.name }}</span>
        </div>

        <div v-if="!isCollapsed(cat.id)">
          <div v-for="ch in serverStore.channelsByCategory(cat.id)" :key="ch.id">
            <div v-if="ch.type === 'text'"
                 class="channel-item group"
                 :class="{ active: serverStore.currentChannel?.id === ch.id }"
                 @click="selectChannel(ch)">
              <svg class="w-5 h-5 mr-1.5 text-discord-200" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
              </svg>
              <span class="truncate">{{ ch.name }}</span>
              <button @click.stop="channelMenu = ch"
                      class="md:hidden ml-auto p-1.5 text-discord-200 hover:text-white"
                      title="更多操作">
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 13a1 1 0 100-2 1 1 0 000 2zm-7 0a1 1 0 100-2 1 1 0 000 2zm14 0a1 1 0 100-2 1 1 0 000 2z" />
                </svg>
              </button>
              <button v-if="isOwner()" @click.stop="emit('channel-settings', ch)"
                      class="hidden md:block ml-auto p-0.5 rounded opacity-0 group-hover:opacity-100 text-discord-200 hover:text-white"
                      title="频道设置">
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>
            </div>

            <div v-else
                 class="channel-item voice group"
                 :class="{ active: serverStore.currentChannel?.id === ch.id }"
                 title="单击选中 · 双击加入"
                 @click="selectChannel(ch)"
                 @dblclick="joinVoiceChannel(ch)">
              <svg class="w-5 h-5 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
              <span class="truncate">{{ ch.name }}</span>

              <div v-if="getRoomMembers(ch.id).length > 0" class="ml-auto flex items-center gap-1">
                <div class="flex -space-x-1.5">
                  <Avatar v-for="uid in getRoomMembers(ch.id).slice(0, 3)" :key="uid"
                          :src="getMemberById(uid)?.user?.avatar"
                          :name="getMemberById(uid)?.user?.nickname || getMemberById(uid)?.user?.username || '?'"
                          size="xs" border="border-2 border-discord-800" textClass="text-[8px]"
                          :title="getMemberById(uid)?.user?.nickname || getMemberById(uid)?.user?.username || '?'" />
                </div>
                <span v-if="getRoomMembers(ch.id).length > 3" class="text-[10px] text-discord-200">
                  +{{ getRoomMembers(ch.id).length - 3 }}
                </span>
                <span v-if="isInVoiceChannel(ch.id)" class="flex gap-0.5">
                  <div class="w-1 h-3 bg-green rounded-full animate-pulse"></div>
                  <div class="w-1 h-3 bg-green rounded-full animate-pulse" style="animation-delay: 0.2s"></div>
                  <div class="w-1 h-3 bg-green rounded-full animate-pulse" style="animation-delay: 0.4s"></div>
                </span>
              </div>

              <div v-else-if="isInVoiceChannel(ch.id)" class="ml-auto">
                <div class="flex gap-0.5">
                  <div class="w-1 h-3 bg-green rounded-full animate-pulse"></div>
                  <div class="w-1 h-3 bg-green rounded-full animate-pulse" style="animation-delay: 0.2s"></div>
                  <div class="w-1 h-3 bg-green rounded-full animate-pulse" style="animation-delay: 0.4s"></div>
                </div>
              </div>

              <button @click.stop="channelMenu = ch"
                      class="md:hidden ml-auto p-1.5 text-discord-200 hover:text-white"
                      title="更多操作">
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 13a1 1 0 100-2 1 1 0 000 2zm-7 0a1 1 0 100-2 1 1 0 000 2zm14 0a1 1 0 100-2 1 1 0 000 2z" />
                </svg>
              </button>
              <button v-if="isOwner()" @click.stop="emit('channel-settings', ch)"
                      class="hidden md:block ml-auto p-0.5 rounded opacity-0 group-hover:opacity-100 text-discord-200 hover:text-white"
                      title="频道设置">
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div>
        <div class="flex items-center gap-1 px-3 py-1 mt-3 text-discord-200 text-xs font-bold uppercase tracking-wider cursor-pointer"
             @click="toggleCollapsed(null)">
          <svg class="w-3 h-3 transition-transform duration-150"
               :class="isCollapsed(null) ? '-rotate-90' : ''" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
          未分类
        </div>

        <div v-if="!isCollapsed(null)">
          <div v-for="ch in serverStore.channelsByCategory(null)" :key="ch.id">
            <div v-if="ch.type === 'text'"
                 class="channel-item group"
                 :class="{ active: serverStore.currentChannel?.id === ch.id }"
                 @click="selectChannel(ch)">
              <svg class="w-5 h-5 mr-1.5 text-discord-200" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
              </svg>
              <span class="truncate">{{ ch.name }}</span>
              <button @click.stop="channelMenu = ch"
                      class="md:hidden ml-auto p-1.5 text-discord-200 hover:text-white"
                      title="更多操作">
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 13a1 1 0 100-2 1 1 0 000 2zm-7 0a1 1 0 100-2 1 1 0 000 2zm14 0a1 1 0 100-2 1 1 0 000 2z" />
                </svg>
              </button>
              <button v-if="isOwner()" @click.stop="emit('channel-settings', ch)"
                      class="hidden md:block ml-auto p-0.5 rounded opacity-0 group-hover:opacity-100 text-discord-200 hover:text-white"
                      title="频道设置">
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>
            </div>

            <div v-else
                 class="channel-item voice group"
                 :class="{ active: serverStore.currentChannel?.id === ch.id }"
                 title="单击选中 · 双击加入"
                 @click="selectChannel(ch)"
                 @dblclick="joinVoiceChannel(ch)">
              <svg class="w-5 h-5 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
              <span class="truncate">{{ ch.name }}</span>

              <div v-if="getRoomMembers(ch.id).length > 0" class="ml-auto flex items-center gap-1">
                <div class="flex -space-x-1.5">
                  <Avatar v-for="uid in getRoomMembers(ch.id).slice(0, 3)" :key="uid"
                          :src="getMemberById(uid)?.user?.avatar"
                          :name="getMemberById(uid)?.user?.nickname || getMemberById(uid)?.user?.username || '?'"
                          size="xs" border="border-2 border-discord-800" textClass="text-[8px]"
                          :title="getMemberById(uid)?.user?.nickname || getMemberById(uid)?.user?.username || '?'" />
                </div>
                <span v-if="getRoomMembers(ch.id).length > 3" class="text-[10px] text-discord-200">
                  +{{ getRoomMembers(ch.id).length - 3 }}
                </span>
                <span v-if="isInVoiceChannel(ch.id)" class="flex gap-0.5">
                  <div class="w-1 h-3 bg-green rounded-full animate-pulse"></div>
                  <div class="w-1 h-3 bg-green rounded-full animate-pulse" style="animation-delay: 0.2s"></div>
                  <div class="w-1 h-3 bg-green rounded-full animate-pulse" style="animation-delay: 0.4s"></div>
                </span>
              </div>

              <div v-else-if="isInVoiceChannel(ch.id)" class="ml-auto">
                <div class="flex gap-0.5">
                  <div class="w-1 h-3 bg-green rounded-full animate-pulse"></div>
                  <div class="w-1 h-3 bg-green rounded-full animate-pulse" style="animation-delay: 0.2s"></div>
                  <div class="w-1 h-3 bg-green rounded-full animate-pulse" style="animation-delay: 0.4s"></div>
                </div>
              </div>

              <button @click.stop="channelMenu = ch"
                      class="md:hidden ml-auto p-1.5 text-discord-200 hover:text-white"
                      title="更多操作">
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 13a1 1 0 100-2 1 1 0 000 2zm-7 0a1 1 0 100-2 1 1 0 000 2zm14 0a1 1 0 100-2 1 1 0 000 2z" />
                </svg>
              </button>
              <button v-if="isOwner()" @click.stop="emit('channel-settings', ch)"
                      class="hidden md:block ml-auto p-0.5 rounded opacity-0 group-hover:opacity-100 text-discord-200 hover:text-white"
                      title="频道设置">
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="p-2 border-t border-discord-600 flex items-center gap-1">
      <button @click="emit('create-channel')" class="btn-ghost text-xs flex items-center gap-1">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
        </svg>
        创建频道
      </button>
      <button @click="emit('open-invite')" class="btn-ghost text-xs flex items-center gap-1 ml-auto">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
        </svg>
        邀请
      </button>
    </div>
  </div>

  <div v-if="channelMenu" class="md:hidden">
    <div class="fixed inset-0 bg-black/60 z-50" @click="channelMenu = null"></div>
    <div class="fixed bottom-0 inset-x-0 z-50 bg-discord-800 rounded-t-2xl p-4 pb-6 shadow-2xl">
      <div class="w-10 h-1 bg-discord-500 rounded-full mx-auto mb-3"></div>
      <div class="flex items-center gap-2 mb-3 px-1">
        <span class="text-discord-200 text-lg flex-shrink-0">{{ channelMenu.type === 'text' ? '#' : '🔊' }}</span>
        <h3 class="text-white font-bold text-sm truncate">{{ channelMenu.name }}</h3>
      </div>
      <div class="space-y-1">
        <button v-if="channelMenu.type === 'voice' && !isInVoiceChannel(channelMenu.id)"
                @click="joinVoiceChannel(channelMenu); channelMenu = null"
                class="w-full text-left px-3 py-3 rounded-lg text-sm text-white hover:bg-discord-600 transition-colors">
          加入语音频道
        </button>
        <button v-if="channelMenu.type === 'text'"
                @click="selectChannel(channelMenu); channelMenu = null"
                class="w-full text-left px-3 py-3 rounded-lg text-sm text-white hover:bg-discord-600 transition-colors">
          进入频道
        </button>
        <button v-if="isOwner()"
                @click="emit('channel-settings', channelMenu); channelMenu = null"
                class="w-full text-left px-3 py-3 rounded-lg text-sm text-white hover:bg-discord-600 transition-colors">
          频道设置
        </button>
      </div>
    </div>
  </div>
</template>
