import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../utils/api'
import type { Message } from '../types'

export const useChatStore = defineStore('chat', () => {
  const messages = ref<Message[]>([])
  const loading = ref(false)
  const hasMore = ref(true)

  async function loadMessages(channelId: string, limit = 50) {
    loading.value = true
    try {
      const data = await api.getMessages(channelId, limit)
      messages.value = data.messages
      hasMore.value = data.messages.length >= limit
    } finally {
      loading.value = false
    }
  }

  async function loadMore(channelId: string, limit = 50) {
    if (!hasMore.value || messages.value.length === 0) return
    const oldest = messages.value[0]
    loading.value = true
    try {
      const data = await api.getMessages(channelId, limit, oldest.id)
      if (data.messages.length > 0) {
        messages.value = [...data.messages, ...messages.value]
        hasMore.value = data.messages.length >= limit
      } else {
        hasMore.value = false
      }
    } finally {
      loading.value = false
    }
  }

  function addMessage(message: Message) {
    const exists = messages.value.find(m => m.id === message.id)
    if (!exists) {
      messages.value.push(message)
    }
  }

  function updateMessage(messageId: string, updates: Partial<Message>) {
    const idx = messages.value.findIndex(m => m.id === messageId)
    if (idx !== -1) {
      messages.value[idx] = { ...messages.value[idx], ...updates }
    }
  }

  function removeMessage(messageId: string) {
    messages.value = messages.value.filter(m => m.id !== messageId)
  }

  async function sendMessage(data: any) {
    return api.sendMessage(data)
  }

  function clearMessages() {
    messages.value = []
    hasMore.value = true
  }

  return {
    messages, loading, hasMore,
    loadMessages, loadMore, addMessage, updateMessage, removeMessage, sendMessage, clearMessages
  }
})
