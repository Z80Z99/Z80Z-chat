<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../utils/api'
import { useAuthStore } from '../stores/auth'
import { usePresence } from '../stores/presence'
import { ws } from '../utils/ws'
import type { FriendRelation } from '../types'
import Avatar from '../components/Avatar.vue'
import UserProfileModal from '../components/UserProfileModal.vue'

const router = useRouter()
const auth = useAuthStore()
const { onlineUserIds } = usePresence()

const friends = ref<FriendRelation[]>([])
const searchQuery = ref('')
const searchResults = ref<any[]>([])
const showSearch = ref(false)
const loading = ref(false)
const showProfile = ref(false)
const profileUserId = ref<string | null>(null)

onMounted(() => {
  loadFriends()
  ws.on('friend-updated', loadFriends)
})

onUnmounted(() => {
  ws.off('friend-updated', loadFriends)
})

async function loadFriends() {
  try {
    const data = await api.getFriends()
    friends.value = data.friends
  } catch {}
}

async function handleSearch() {
  if (!searchQuery.value.trim()) return
  showSearch.value = true
  try {
    const data = await api.searchUsers(searchQuery.value)
    searchResults.value = data.users
  } catch {
    searchResults.value = []
  }
}

async function addFriend(username: string) {
  try {
    await api.addFriend(username)
    searchQuery.value = ''
    showSearch.value = false
    searchResults.value = []
  } catch (e: any) {
    alert(e.message)
  }
}

async function acceptFriend(friendId: string) {
  try {
    await api.acceptFriend(friendId)
    await loadFriends()
  } catch {}
}

async function removeFriend(friendId: string) {
  try {
    await api.removeFriend(friendId)
    await loadFriends()
  } catch {}
}

const acceptedFriends = computed(() => friends.value.filter(f => f.status === 'accepted'))
// 收到的请求：我是接收方（可同意/拒绝）
const incomingRequests = computed(() =>
  friends.value.filter(f => f.status === 'pending' && f.direction === 'incoming')
)
// 已发送的请求：我是发起方（等待对方同意，可取消）
const outgoingRequests = computed(() =>
  friends.value.filter(f => f.status === 'pending' && f.direction === 'outgoing')
)

function isOnline(friend: any) {
  return friend?.id ? onlineUserIds.value.has(friend.id) : false
}

function openProfile(userId: string | undefined | null) {
  if (!userId) return
  profileUserId.value = userId
  showProfile.value = true
}
</script>

<template>
  <div class="h-full flex flex-col bg-discord-700">
    <div class="h-12 bg-discord-900 flex items-center px-3 sm:px-4 shadow-md">
      <button @click="router.push('/')" class="btn-ghost flex items-center gap-2 px-2">
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
        </svg>
        <span class="hidden sm:inline">返回</span>
      </button>
      <h1 class="text-white font-bold ml-2 sm:ml-4">好友列表</h1>
    </div>

    <div class="p-4 border-b border-discord-600">
      <div class="flex gap-2">
        <div class="auth-input-wrap flex-1 min-w-0">
          <svg class="auth-input-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input v-model="searchQuery" @keyup.enter="handleSearch"
                 class="input-discord text-base w-full pl-10" placeholder="搜索用户..." />
        </div>
        <button @click="handleSearch" class="btn-primary flex-shrink-0">搜索</button>
      </div>

      <Transition name="search-panel">
        <div v-if="showSearch && searchResults.length > 0" class="mt-2 bg-discord-600 rounded p-2">
          <div v-for="user in searchResults" :key="user.id"
               class="flex items-center justify-between p-2 hover:bg-discord-500 rounded cursor-pointer"
               @click="openProfile(user.id)">
            <div class="flex items-center gap-2">
              <Avatar :src="user.avatar" :name="user.username" size="sm" />
              <span class="text-white">{{ user.username }}</span>
            </div>
            <button @click.stop="addFriend(user.username)" class="btn-green text-xs py-1 px-3">加好友</button>
          </div>
        </div>
      </Transition>
    </div>

    <div class="flex-1 overflow-y-auto p-4">
      <h2 class="text-xs font-bold text-discord-200 uppercase tracking-wider mb-2">
        好友 - {{ acceptedFriends.length }}
      </h2>
      <div v-if="acceptedFriends.length === 0" class="text-discord-200 text-sm text-center py-8">
        <div class="w-20 h-20 bg-discord-600 rounded-full flex items-center justify-center mx-auto mb-3">
          <svg class="w-9 h-9 text-discord-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </div>
        还没有好友，搜索添加吧
      </div>
      <div v-for="rel in acceptedFriends" :key="rel.id"
           class="flex items-center justify-between p-3 hover:bg-discord-600 rounded-lg cursor-pointer transition-colors"
           @click="openProfile(rel.friend?.id)">
        <div class="flex items-center gap-3">
          <Avatar :src="rel.friend?.avatar"
                  :name="rel.friend?.nickname || rel.friend?.username"
                  size="md"
                  :status="isOnline(rel.friend) ? 'bg-green border-discord-700' : 'bg-discord-300 border-discord-700'" />
          <div>
            <p class="text-white font-medium">{{ rel.friend?.nickname || rel.friend?.username }}</p>
            <p class="text-discord-200 text-xs">{{ isOnline(rel.friend) ? '在线' : '离线' }}</p>
          </div>
        </div>
        <button @click.stop="removeFriend(rel.friend?.id!)" class="btn-red text-xs py-1 px-3">删除</button>
      </div>

      <template v-if="incomingRequests.length > 0">
        <h2 class="text-xs font-bold text-discord-200 uppercase tracking-wider mt-6 mb-2">
          收到的请求 - {{ incomingRequests.length }}
        </h2>
        <div v-for="rel in incomingRequests" :key="rel.id"
             class="flex items-center justify-between p-3 hover:bg-discord-600 rounded-lg transition-colors">
          <div class="flex items-center gap-3">
            <Avatar :src="rel.friend?.avatar" :name="rel.friend?.username" size="md" />
            <p class="text-white font-medium">{{ rel.friend?.username }}</p>
          </div>
          <div class="flex gap-2">
            <button @click="acceptFriend(rel.friend?.id!)" class="btn-green text-xs py-1 px-3">同意</button>
            <button @click="removeFriend(rel.friend?.id!)" class="btn-ghost text-xs py-1 px-3">拒绝</button>
          </div>
        </div>
      </template>

      <template v-if="outgoingRequests.length > 0">
        <h2 class="text-xs font-bold text-discord-200 uppercase tracking-wider mt-6 mb-2">
          已发送请求 - {{ outgoingRequests.length }}
        </h2>
        <div v-for="rel in outgoingRequests" :key="rel.id"
             class="flex items-center justify-between p-3 hover:bg-discord-600 rounded-lg transition-colors">
          <div class="flex items-center gap-3">
            <Avatar :src="rel.friend?.avatar" :name="rel.friend?.username" size="md" />
            <p class="text-white font-medium">{{ rel.friend?.username }}</p>
          </div>
          <div class="flex gap-2">
            <span class="text-xs text-discord-300 self-center">等待对方同意</span>
            <button @click="removeFriend(rel.friend?.id!)" class="btn-ghost text-xs py-1 px-3">取消</button>
          </div>
        </div>
      </template>
    </div>

    <UserProfileModal v-if="showProfile && profileUserId"
                      :userId="profileUserId"
                      @close="showProfile = false; profileUserId = null" />
  </div>
</template>

<style scoped>
.search-panel-enter-active {
  animation: search-panel-in 150ms cubic-bezier(0.16, 1, 0.3, 1) both;
  transform-origin: top;
}
.search-panel-leave-active {
  transition: opacity 120ms ease;
}
.search-panel-leave-to {
  opacity: 0;
}
@keyframes search-panel-in {
  from { opacity: 0; transform: translateY(-4px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
</style>
