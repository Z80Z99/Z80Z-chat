<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useServerStore } from '../stores/server'
import { api } from '../utils/api'
import Avatar from './Avatar.vue'

const emit = defineEmits<{ close: [] }>()
const serverStore = useServerStore()

const invites = ref<any[]>([])
const maxUses = ref<number | null>(null)
const expiresInHours = ref<number | null>(null)
const loading = ref(false)
const newInviteCode = ref('')
const copied = ref(false)
const friends = ref<any[]>([])
const invitingIds = ref(new Set<string>())

onMounted(() => {
  loadInvites()
  loadFriends()
})

async function loadInvites() {
  if (!serverStore.currentServer) return
  try {
    await serverStore.fetchInvites(serverStore.currentServer.id)
    invites.value = serverStore.invites
  } catch {}
}

async function loadFriends() {
  try {
    const data = await api.getFriends()
    friends.value = data.friends.filter((f: any) => f.status === 'accepted' && f.friend)
  } catch {}
}

const invitableFriends = computed(() => {
  const memberIds = new Set(serverStore.members.map((m: any) => m.userId))
  return friends.value.filter((f: any) => !memberIds.has(f.friend.id))
})

async function inviteFriend(friend: any) {
  if (!serverStore.currentServer) return
  if (invitingIds.value.has(friend.friend.id)) return
  invitingIds.value.add(friend.friend.id)
  try {
    await api.inviteFriend(serverStore.currentServer.id, friend.friend.id)
    await serverStore.fetchServer(serverStore.currentServer.id)
    friends.value = friends.value.filter((f: any) => f.friend.id !== friend.friend.id)
  } catch (e: any) {
    alert(e.message)
  } finally {
    invitingIds.value.delete(friend.friend.id)
  }
}

async function createInvite() {
  if (!serverStore.currentServer) return
  loading.value = true
  try {
    const res = await serverStore.createInvite(
      serverStore.currentServer.id,
      maxUses.value || undefined,
      expiresInHours.value || undefined
    )
    newInviteCode.value = `${window.location.origin}/invite/${res.invite.code}`
    await loadInvites()
  } catch (e: any) {
    alert(e.message)
  } finally {
    loading.value = false
  }
}

function copyCode(code: string) {
  navigator.clipboard.writeText(`${window.location.origin}/invite/${code}`)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}

async function deleteInvite(id: string) {
  try {
    await api.deleteInvite(id)
    await loadInvites()
  } catch (e: any) {
    alert(e.message || '删除失败')
  }
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal-content max-w-lg">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-bold text-white">邀请好友</h2>
        <button @click="emit('close')" class="text-discord-200 hover:text-white">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div class="bg-discord-900 rounded-lg p-4 mb-4">
        <p class="text-sm text-discord-200 mb-3">直接邀请好友加入，无需邀请码</p>
        <div v-if="invitableFriends.length > 0" class="space-y-2 max-h-56 overflow-y-auto">
          <div v-for="f in invitableFriends" :key="f.friend.id"
               class="flex items-center gap-3 bg-discord-800 rounded p-2">
            <Avatar :src="f.friend.avatar" :name="f.friend.nickname || f.friend.username || '?'" size="sm" />
            <span class="text-sm text-discord-50 truncate flex-1">{{ f.friend.nickname || f.friend.username }}</span>
            <button @click="inviteFriend(f)" :disabled="invitingIds.has(f.friend.id)"
                    class="btn-green text-xs whitespace-nowrap">
              {{ invitingIds.has(f.friend.id) ? '邀请中...' : '邀请' }}
            </button>
          </div>
        </div>
        <p v-else class="text-sm text-discord-200">暂无可以邀请的好友（好友需先接受请求且不在本服务器中）</p>
      </div>

      <div class="bg-discord-900 rounded-lg p-4 mb-4">
        <p class="text-sm text-discord-200 mb-3">创建一个新的邀请链接</p>
        <div class="flex gap-2 mb-3">
          <div class="flex-1">
            <label class="text-xs text-discord-200">最大使用次数</label>
            <input v-model.number="maxUses" type="number" min="0" class="input-discord w-full mt-1"
                   placeholder="无限制" />
          </div>
          <div class="flex-1">
            <label class="text-xs text-discord-200">有效期（小时）</label>
            <input v-model.number="expiresInHours" type="number" min="0" class="input-discord w-full mt-1"
                   placeholder="永久" />
          </div>
        </div>
        <button @click="createInvite" :disabled="loading" class="btn-primary w-full">
          {{ loading ? '生成中...' : '生成邀请链接' }}
        </button>
      </div>

      <div v-if="newInviteCode" class="bg-green/10 border border-green/30 rounded-lg p-3 mb-4">
        <p class="text-sm text-green mb-2">邀请链接已生成！</p>
        <div class="flex gap-2">
          <input :value="newInviteCode" class="input-discord flex-1 text-sm" readonly @focus="$event.target.select()" />
          <button @click="copyCode(newInviteCode.split('/').pop()!)" class="btn-green text-xs whitespace-nowrap">
            {{ copied ? '已复制' : '复制' }}
          </button>
        </div>
      </div>

      <div v-if="invites.length > 0">
        <h3 class="text-xs font-bold text-discord-200 uppercase tracking-wider mb-2">已有邀请</h3>
        <div class="space-y-2 max-h-48 overflow-y-auto">
          <div v-for="inv in invites" :key="inv.id"
               class="flex items-center justify-between bg-discord-900 rounded p-2">
            <div>
              <code class="text-sm text-blurple">{{ inv.code }}</code>
              <p class="text-xs text-discord-200">
                使用: {{ inv.uses }}{{ inv.maxUses ? '/' + inv.maxUses : '' }}
                <span v-if="inv.expiresAt"> | {{ new Date(inv.expiresAt).toLocaleDateString() }} 过期</span>
              </p>
            </div>
            <div class="flex gap-1">
              <button @click="copyCode(inv.code)" class="btn-ghost text-xs">复制</button>
              <button @click="deleteInvite(inv.id)" class="btn-ghost text-xs text-red">删除</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
