<script setup lang="ts">
import { ref, onMounted, nextTick, watch } from 'vue'
import { useServerStore } from '../stores/server'
import { useChatStore } from '../stores/chat'
import { useAuthStore } from '../stores/auth'
import { api } from '../utils/api'
import { formatMessageContent } from '../utils/escape'
import type { Message } from '../types'
import Avatar from './Avatar.vue'

const emit = defineEmits<{ reply: [message: any]; 'open-user-profile': [userId: string] }>()

const serverStore = useServerStore()
const chatStore = useChatStore()
const authStore = useAuthStore()

const containerRef = ref<HTMLElement | null>(null)
const editingMessageId = ref<string | null>(null)
const editContent = ref('')
const showMenu = ref<string | null>(null)
const loadingMore = ref(false)

watch(() => serverStore.currentChannel?.id, async () => {
  await nextTick()
  scrollToBottom()
})

watch(() => chatStore.messages.length, () => {
  nextTick(() => scrollToBottom())
})

function scrollToBottom() {
  if (containerRef.value) {
    containerRef.value.scrollTop = containerRef.value.scrollHeight
  }
}

async function handleScroll() {
  const el = containerRef.value
  if (!el || el.scrollTop > 100 || !chatStore.hasMore || loadingMore.value) return
  loadingMore.value = true
  try {
    await chatStore.loadMore(serverStore.currentChannel!.id)
  } finally {
    loadingMore.value = false
  }
}

function formatTime(dateStr: string) {
  const d = new Date(dateStr)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  if (diff < 86400000) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function startEdit(msg: Message) {
  editingMessageId.value = msg.id
  editContent.value = msg.content
  showMenu.value = null
}

async function saveEdit() {
  if (!editingMessageId.value) return
  try {
    await api.editMessage(editingMessageId.value, editContent.value)
    chatStore.updateMessage(editingMessageId.value, { content: editContent.value, editedAt: new Date().toISOString() })
  } catch {}
  editingMessageId.value = null
}

async function deleteMsg(msgId: string) {
  if (!confirm('确定删除此消息？')) return
  try {
    await api.deleteMessage(msgId)
    chatStore.removeMessage(msgId)
  } catch {}
  showMenu.value = null
}

function canManage(msg: Message) {
  return msg.userId === authStore.user?.id
}

function openUrl(url: string) { window.open(url, '_blank') }
</script>

<template>
  <div ref="containerRef" class="flex-1 overflow-y-auto px-4 py-2" @scroll="handleScroll">
    <div v-if="loadingMore" class="text-center text-discord-200 text-sm py-4">加载更多...</div>
    <div v-if="chatStore.messages.length === 0 && !chatStore.loading"
         class="flex items-center justify-center h-full text-discord-200 text-sm">
      <div class="text-center">
        <p class="text-4xl mb-2">👋</p>
        <p>开始聊天吧！</p>
      </div>
    </div>

    <div v-for="(msg, idx) in chatStore.messages" :key="msg.id"
         class="message-row group flex gap-3 px-2 py-1.5 rounded hover:bg-discord-600/40 relative"
         @contextmenu.prevent="showMenu = showMenu === msg.id ? null : msg.id">
      <Avatar :src="msg.user?.avatar"
              :name="msg.user?.nickname || msg.user?.username"
              size="md" class="mt-0.5 cursor-pointer"
              @click="emit('open-user-profile', msg.userId)" />

      <div class="flex-1 min-w-0">
        <div class="flex items-baseline gap-2">
          <span class="text-sm font-medium text-white cursor-pointer hover:underline"
                @click="emit('open-user-profile', msg.userId)">
            {{ msg.user?.nickname || msg.user?.username }}
          </span>
          <span class="text-xs text-discord-200">{{ formatTime(msg.createdAt) }}</span>
          <span v-if="msg.editedAt" class="text-xs text-discord-300">(已编辑)</span>
        </div>

        <div v-if="editingMessageId !== msg.id">
          <div v-if="msg.replyTo" class="text-xs text-discord-200 mb-1 flex items-center gap-1">
            <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
            回复了一条消息
          </div>

          <div v-if="msg.image" class="mt-1">
            <img :src="msg.image" class="max-w-full sm:max-w-sm max-h-80 rounded-lg object-cover cursor-pointer"
                 @click="openUrl(msg.image!)" />
          </div>

          <div v-if="msg.file" class="mt-1">
            <a :href="msg.file" target="_blank"
               class="flex items-center gap-2 bg-discord-600 rounded p-2 hover:bg-discord-500 transition-colors max-w-full sm:max-w-sm">
              <svg class="w-6 h-6 text-blurple" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <span class="text-sm text-discord-100">{{ msg.fileName || '下载文件' }}</span>
            </a>
          </div>

          <div v-if="msg.content" class="text-sm text-discord-50 mt-0.5 leading-relaxed whitespace-pre-wrap break-words"
               v-html="formatMessageContent(msg.content)">
          </div>
        </div>

        <div v-else class="mt-1">
          <textarea v-model="editContent" class="input-discord w-full text-sm" rows="2"
                    @keydown.enter.ctrl="saveEdit" @keydown.escape="editingMessageId = null"></textarea>
          <div class="flex gap-2 mt-1">
            <button @click="saveEdit" class="text-xs btn-primary py-1 px-2">保存</button>
            <button @click="editingMessageId = null" class="text-xs btn-ghost py-1 px-2">取消</button>
          </div>
        </div>
      </div>

      <div v-if="showMenu === msg.id"
           class="context-menu absolute right-0 top-8 z-50">
        <div v-if="canManage(msg)" class="context-item" @click="startEdit(msg)">编辑</div>
            <div class="context-item" @click="showMenu = null; emit('reply', msg)">回复</div>
            <div v-if="canManage(msg)" class="context-item danger" @click="deleteMsg(msg.id)">删除</div>
      </div>
    </div>
  </div>
</template>
