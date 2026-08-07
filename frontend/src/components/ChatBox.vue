<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useServerStore } from '../stores/server'
import { useChatStore } from '../stores/chat'
import { useAuthStore } from '../stores/auth'
import { ws } from '../utils/ws'
import { api } from '../utils/api'
import MessageList from './MessageList.vue'

const emit = defineEmits<{ 'open-user-profile': [userId: string]; 'toggle-channels': []; 'toggle-members': [] }>()

const serverStore = useServerStore()
const chatStore = useChatStore()
const authStore = useAuthStore()

const messageInput = ref('')
const fileInputRef = ref<HTMLInputElement | null>(null)
const messagesContainer = ref<HTMLElement | null>(null)
const replyTo = ref<{ id: string; content: string; username: string } | null>(null)
const showEmojiPicker = ref(false)
const uploading = ref(false)
const pastedImage = ref<{ file: File; preview: string } | null>(null)
const typingUsers = ref<Set<string>>(new Set())
let typingTimer: any = null

watch(() => serverStore.currentChannel?.id, () => {
  replyTo.value = null
  showEmojiPicker.value = false
  typingUsers.value.clear()
  clearPastedImage()
})

async function sendMessage() {
  const channel = serverStore.currentChannel
  if (!channel) return
  const content = messageInput.value.trim()
  if (!content && !pastedImage.value) return

  messageInput.value = ''

  if (pastedImage.value) {
    uploading.value = true
    try {
      const res = await api.uploadImage(pastedImage.value.file)
      await chatStore.sendMessage({
        channelId: channel.id,
        content,
        image: res.url,
        replyTo: replyTo.value?.id || null
      })
    } catch (e: any) {
      alert(e.message)
      return
    } finally {
      uploading.value = false
    }
    clearPastedImage()
    replyTo.value = null
    return
  }

  try {
    await chatStore.sendMessage({
      channelId: channel.id,
      content,
      replyTo: replyTo.value?.id || null
    })
    replyTo.value = null
  } catch (e: any) {
    alert(e.message)
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMessage()
  }
  if (!typingTimer) {
    ws.send({ type: 'typing', channelId: serverStore.currentChannel?.id })
  }
  clearTimeout(typingTimer)
  typingTimer = setTimeout(() => { typingTimer = null }, 2000)
}

async function handleFileUpload(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files?.length) return
  const file = input.files[0]
  uploading.value = true
  try {
    let res
    if (file.type.startsWith('image/')) {
      res = await api.uploadImage(file)
      await chatStore.sendMessage({
        channelId: serverStore.currentChannel!.id,
        content: '',
        image: res.url
      })
    } else {
      res = await api.uploadFile(file)
      await chatStore.sendMessage({
        channelId: serverStore.currentChannel!.id,
        content: '',
        file: res.url,
        fileName: res.filename
      })
    }
  } catch (e: any) {
    alert(e.message)
  } finally {
    uploading.value = false
    input.value = ''
  }
}

function handlePaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items
  if (!items) return
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault()
      const file = item.getAsFile()
      if (!file) return
      clearPastedImage()
      pastedImage.value = {
        file,
        preview: URL.createObjectURL(file)
      }
      return
    }
  }
}

function clearPastedImage() {
  if (pastedImage.value) {
    URL.revokeObjectURL(pastedImage.value.preview)
  }
  pastedImage.value = null
}

function setReply(message: any) {
  replyTo.value = {
    id: message.id,
    content: message.content.slice(0, 100),
    username: message.user?.username || 'Unknown'
  }
}

function cancelReply() {
  replyTo.value = null
}

function insertEmoji(emoji: string) {
  messageInput.value += emoji
  showEmojiPicker.value = false
}

const commonEmojis = ['😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','🥰','😘','🤗','🤩','👍','👎','👊','✊','🤝','🙏','💪','🔥','⭐','❤️','💔','💯','✅','❌','🎉','🎊','🎈','🚀','💡','📌','💬','🗨️']

onMounted(() => {
  ws.on('typing', handleTyping)
})

onUnmounted(() => {
  ws.off('typing', handleTyping)
})

function handleTyping(data: any) {
  if (data.channelId === serverStore.currentChannel?.id && data.userId !== authStore.user?.id) {
    typingUsers.value.add(data.username)
    clearTimeout((typingUsers as any)._timer)
    ;(typingUsers as any)._timer = setTimeout(() => typingUsers.value.clear(), 3000)
  }
}
</script>

<template>
  <div class="flex-1 flex flex-col bg-discord-700 min-w-0">
    <div class="h-12 flex items-center px-4 shadow-sm border-b border-discord-600">
      <button class="md:hidden p-1 mr-2 text-discord-200 hover:text-white" title="频道列表"
              @click="emit('toggle-channels')">
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
      <div class="flex items-center gap-2">
        <svg v-if="serverStore.currentChannel?.type === 'text'" class="w-5 h-5 text-discord-200" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
        </svg>
        <h3 class="text-white font-bold text-sm"># {{ serverStore.currentChannel?.name }}</h3>
      </div>
      <button class="md:hidden p-1 ml-auto text-discord-200 hover:text-white" title="成员列表"
              @click="emit('toggle-members')">
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>
    </div>

    <MessageList @reply="setReply" @open-user-profile="(id) => emit('open-user-profile', id)" />

    <div v-if="replyTo" class="px-4 py-2 bg-discord-800 border-t border-discord-600 flex items-center gap-2 text-sm">
      <div class="w-0.5 h-8 bg-blurple rounded"></div>
      <div class="flex-1">
        <span class="text-blurple font-medium">回复 {{ replyTo.username }}</span>
        <p class="text-discord-200 truncate">{{ replyTo.content }}</p>
      </div>
      <button @click="cancelReply" class="text-discord-200 hover:text-white">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>

    <div v-if="typingUsers.size > 0" class="px-4 py-1 text-xs text-discord-200">
      {{ Array.from(typingUsers).join(', ') }} 正在输入...
    </div>

    <div class="px-4 pb-4 pt-2">
      <div v-if="pastedImage" class="relative inline-block mb-2 rounded-lg overflow-hidden border border-discord-600">
        <img :src="pastedImage.preview" alt="粘贴的图片"
             class="max-h-40 max-w-xs object-contain bg-discord-900" />
        <button @click="clearPastedImage"
                class="absolute top-1 right-1 bg-black/60 hover:bg-black/80 text-white rounded-full p-1"
                title="移除图片">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div class="bg-discord-800 rounded-xl border border-discord-600/60 focus-within:border-discord-500 focus-within:ring-2 focus-within:ring-blurple/20 transition-all flex items-end px-3 py-2">
        <button @click="fileInputRef?.click()" class="text-discord-200 hover:text-white rounded hover:bg-discord-600/60 active:scale-90 transition p-1" title="上传文件">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
        </button>
        <input ref="fileInputRef" type="file" class="hidden" @change="handleFileUpload" />

        <div class="flex-1 mx-2">
          <textarea v-model="messageInput" @keydown="handleKeydown" @paste="handlePaste"
                    class="w-full bg-transparent text-white placeholder-discord-300 resize-none outline-none text-sm md:text-sm text-base max-h-40 py-1"
                    placeholder="发送消息到 #" :rows="1"
                    @input="$event.target.style.height = 'auto'; $event.target.style.height = $event.target.scrollHeight + 'px'">
          </textarea>
        </div>

        <div class="relative">
          <button @click="showEmojiPicker = !showEmojiPicker" class="text-discord-200 hover:text-white rounded hover:bg-discord-600/60 active:scale-90 transition p-1" title="表情">
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
          <div v-if="showEmojiPicker"
               class="absolute bottom-full right-0 mb-2 bg-discord-800 border border-discord-600 rounded-lg p-3 w-64 sm:w-72 shadow-xl animate-scale-in">
            <div class="grid grid-cols-8 gap-1">
              <button v-for="emoji in commonEmojis" :key="emoji"
                      @click="insertEmoji(emoji)"
                      class="w-8 h-8 hover:bg-discord-600 rounded text-lg flex items-center justify-center">
                {{ emoji }}
              </button>
            </div>
          </div>
        </div>

        <button @click="sendMessage" class="text-blurple hover:text-blurple-hover rounded hover:bg-blurple/15 active:scale-90 transition p-1 ml-1" title="发送">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19V5m0 0l-7 7m7-7l7 7" />
          </svg>
        </button>
      </div>
      <p v-if="uploading" class="text-xs text-discord-200 mt-1">上传中...</p>
    </div>
  </div>
</template>
