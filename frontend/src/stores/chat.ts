import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../utils/api'
import type { Message } from '../types'

type RequestChange =
  | { type: 'add'; message: Message }
  | { type: 'update'; updates: Partial<Message> }
  | { type: 'delete' }

export const useChatStore = defineStore('chat', () => {
  const messages = ref<Message[]>([])
  const loading = ref(false)
  const loadError = ref('')
  const hasMore = ref(true)
  const currentChannelId = ref<string | null>(null)
  const viewingContext = ref(false)
  const contextMessageId = ref<string | null>(null)
  const hasNewer = ref(false)
  const contextNewMessageIds = ref<Set<string>>(new Set())
  let requestGeneration = 0
  let activeRequest: { generation: number; mode: 'latest' | 'history' | 'context'; changes: Map<string, RequestChange> } | null = null

  function beginRequest(mode: 'latest' | 'history' | 'context' = 'latest') {
    const request = { generation: ++requestGeneration, mode, changes: new Map<string, RequestChange>() }
    activeRequest = request
    loading.value = true
    loadError.value = ''
    return request
  }

  function mergeChanges(base: Message[], changes: Map<string, RequestChange>, allowNew = true) {
    const merged = new Map<string, Message>(base.map(message => [message.id, message]))
    for (const [id, change] of changes) {
      if (change.type === 'delete') merged.delete(id)
      else if (change.type === 'add') {
        const previous = merged.get(id)
        if ((allowNew || previous) && (!previous || (change.message.revision ?? 0) >= (previous.revision ?? 0))) merged.set(id, change.message)
      }
      else {
        const message = merged.get(id)
        if (message && (change.updates.revision === undefined || change.updates.revision >= (message.revision ?? 0))) merged.set(id, { ...message, ...change.updates })
      }
    }
    return [...merged.values()].sort((a, b) => Number.isSafeInteger(a.sequence) && Number.isSafeInteger(b.sequence)
      ? a.sequence - b.sequence : a.createdAt.localeCompare(b.createdAt))
  }

  function finishRequest(request: NonNullable<typeof activeRequest>) {
    if (activeRequest !== request) return
    activeRequest = null
    loading.value = false
  }

  function recordLoadError(request: NonNullable<typeof activeRequest>, error: unknown) {
    if (activeRequest !== request) return
    const message = error && typeof error === 'object' && 'message' in error ? error.message : null
    loadError.value = typeof message === 'string' && message.trim() ? message : '加载消息失败，请重试'
  }

  async function loadMessages(channelId: string, limit = 50) {
    if (currentChannelId.value !== channelId) {
      clearMessages()
      currentChannelId.value = channelId
    }
    const request = beginRequest()
    try {
      const data = await api.getMessages(channelId, limit)
      if (request.generation !== requestGeneration || currentChannelId.value !== channelId) return
      // Replace stale caches with a complete server window; only overlay events received during this request.
      messages.value = mergeChanges(data.messages, request.changes)
      hasMore.value = data.messages.length >= limit
      viewingContext.value = false
      contextMessageId.value = null
      hasNewer.value = false
      contextNewMessageIds.value = new Set()
    } catch (error) {
      recordLoadError(request, error)
      throw error
    } finally {
      finishRequest(request)
    }
  }

  async function loadMore(channelId: string, limit = 50) {
    if (currentChannelId.value !== channelId || loading.value || !hasMore.value || messages.value.length === 0) return
    const oldest = messages.value[0]
    const request = beginRequest('history')
    try {
      const data = await api.getMessages(channelId, limit, oldest.id)
      if (request.generation !== requestGeneration || currentChannelId.value !== channelId) return
      messages.value = mergeChanges([...data.messages, ...messages.value], request.changes, !viewingContext.value)
      hasMore.value = data.messages.length >= limit
    } catch (error) {
      recordLoadError(request, error)
      throw error
    } finally {
      finishRequest(request)
    }
  }

  async function locateMessage(channelId: string, messageId: string) {
    if (currentChannelId.value !== channelId) return false
    if (!activeRequest && messages.value.some(message => message.id === messageId)) return true
    const request = beginRequest('context')
    const wasViewingContext = viewingContext.value
    let applied = false
    try {
      const data = await api.getMessageContext(channelId, messageId)
      if (request.generation !== requestGeneration || currentChannelId.value !== channelId) return false
      const window = mergeChanges(data.messages, request.changes, false)
      if (!window.some(message => message.id === messageId)) throw new Error('原消息已被删除')
      messages.value = window
      hasMore.value = data.hasMoreBefore
      hasNewer.value = data.hasMoreAfter || [...request.changes.values()].some(change => change.type === 'add' && !window.some(message => message.id === change.message.id))
      viewingContext.value = true
      contextMessageId.value = messageId
      contextNewMessageIds.value = new Set([...request.changes].filter(([id, change]) => change.type === 'add' && !window.some(message => message.id === id)).map(([id]) => id))
      applied = true
      return true
    } finally {
      // A failed lookup keeps the previous latest window, including arrivals held while it was in flight.
      if (activeRequest === request && !applied && !wasViewingContext) {
        messages.value = mergeChanges(messages.value, request.changes)
        hasNewer.value = false
        contextNewMessageIds.value = new Set()
      }
      finishRequest(request)
    }
  }

  function cancelContextLookup() {
    if (activeRequest?.mode !== 'context') return
    const request = activeRequest
    requestGeneration++
    activeRequest = null
    loading.value = false
    if (!viewingContext.value) {
      messages.value = mergeChanges(messages.value, request.changes)
      hasNewer.value = false
      contextNewMessageIds.value = new Set()
    }
  }

  function addMessage(message: Message) {
    if (message.channelId !== currentChannelId.value) return
    if (activeRequest?.changes.get(message.id)?.type === 'delete') return
    const exists = messages.value.find(m => m.id === message.id)
    if (exists) { updateMessage(message.id, message); return }
    if (viewingContext.value || activeRequest?.mode === 'context') {
      hasNewer.value = true
      contextNewMessageIds.value = new Set([...contextNewMessageIds.value, message.id])
      activeRequest?.changes.set(message.id, { type: 'add', message })
      return
    }
    if (!exists) {
      messages.value.push(message)
      activeRequest?.changes.set(message.id, { type: 'add', message })
    }
  }

  function updateMessage(messageId: string, updates: Partial<Message>) {
    if (updates.channelId && updates.channelId !== currentChannelId.value) return
    const change = activeRequest?.changes.get(messageId)
    if (change?.type === 'delete') return
    const idx = messages.value.findIndex(m => m.id === messageId)
    const current = idx === -1 ? null : messages.value[idx]
    if (updates.revision !== undefined && current && updates.revision < (current.revision ?? 0)) return
    if (updates.revision !== undefined && change?.type === 'update' && updates.revision < (change.updates.revision ?? 0)) return
    if (updates.revision !== undefined && change?.type === 'add' && updates.revision < (change.message.revision ?? 0)) return
    if (idx !== -1) {
      messages.value[idx] = { ...messages.value[idx], ...updates }
    }
    if (change?.type === 'add') {
      activeRequest?.changes.set(messageId, { type: 'add', message: { ...change.message, ...updates } })
    } else {
      activeRequest?.changes.set(messageId, {
        type: 'update', updates: { ...(change?.type === 'update' ? change.updates : {}), ...updates }
      })
    }
  }

  function removeMessage(messageId: string) {
    contextNewMessageIds.value = new Set([...contextNewMessageIds.value].filter(id => id !== messageId))
    activeRequest?.changes.set(messageId, { type: 'delete' })
    messages.value = messages.value.filter(m => m.id !== messageId)
  }

  async function sendMessage(data: any) {
    return api.sendMessage(data)
  }

  function clearMessages() {
    requestGeneration++
    activeRequest = null
    currentChannelId.value = null
    messages.value = []
    loading.value = false
    loadError.value = ''
    hasMore.value = true
    viewingContext.value = false
    contextMessageId.value = null
    hasNewer.value = false
    contextNewMessageIds.value = new Set()
  }

  return {
    messages, loading, loadError, hasMore, currentChannelId, viewingContext, contextMessageId, hasNewer, contextNewMessageIds,
    loadMessages, loadMore, locateMessage, cancelContextLookup, addMessage, updateMessage, removeMessage, sendMessage, clearMessages
  }
})
