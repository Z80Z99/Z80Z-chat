<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { api } from '../utils/api'
import { useAuthStore } from '../stores/auth'
import { usePresence } from '../stores/presence'
import type { User } from '../types'
import Avatar from './Avatar.vue'

const props = defineProps<{ userId: string }>()
const emit = defineEmits<{ close: [] }>()

const authStore = useAuthStore()
const { onlineUserIds } = usePresence()
const user = ref<User | null>(null)
const friendStatus = ref<string | null>(null)
const loading = ref(true)

function isOnline() {
  return user.value?.id ? onlineUserIds.value.has(user.value.id) : false
}

onMounted(async () => {
  try {
    const data = await api.getUser(props.userId)
    user.value = data.user
    const friends = await api.getFriends()
    const rel = friends.friends.find((f: any) => f.friend?.id === props.userId)
    if (rel) friendStatus.value = rel.status
  } catch {} finally {
    loading.value = false
  }
})

async function addFriend() {
  if (!user.value) return
  try {
    await api.addFriend(user.value.username)
    friendStatus.value = 'pending'
  } catch (e: any) {
    alert(e.message)
  }
}

async function removeFriend() {
  if (!user.value) return
  try {
    await api.removeFriend(user.value.id)
    friendStatus.value = null
  } catch {}
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="bg-discord-800 rounded-lg w-full max-w-sm overflow-hidden shadow-2xl">
      <div class="h-24 bg-blurple/30"></div>

      <div class="px-6 pb-6 -mt-12">
        <Avatar :src="user?.avatar" :name="user?.username || '?'" size="profile"
                bg="bg-discord-600" border="border-4 border-discord-800"
                textClass="text-3xl" class="mx-auto" />

        <div v-if="loading" class="text-center py-4">
          <p class="text-discord-200">加载中...</p>
        </div>

        <div v-else-if="user" class="text-center">
          <h2 class="text-xl font-bold text-white mt-2">{{ user.nickname || user.username }}</h2>
          <p class="text-discord-200 text-sm">@{{ user.username }}</p>

          <div class="flex items-center justify-center gap-2 mt-2">
            <div :class="isOnline() ? 'bg-green' : 'bg-discord-400'"
                 class="w-3 h-3 rounded-full"></div>
            <span class="text-sm text-discord-200">{{ isOnline() ? '在线' : '离线' }}</span>
          </div>

          <div class="mt-4 text-xs text-discord-200">
            <p>ID: {{ user.id }}</p>
            <p>注册于 {{ user.createdAt?.slice(0, 10) }}</p>
          </div>

          <div v-if="user.id !== authStore.user?.id" class="mt-4 flex justify-center gap-2">
            <button v-if="!friendStatus" @click="addFriend" class="btn-green">添加好友</button>
            <button v-else-if="friendStatus === 'pending'" class="btn-ghost" disabled>已发送请求</button>
            <button v-else @click="removeFriend" class="btn-red">删除好友</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
