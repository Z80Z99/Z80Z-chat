<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useServerStore } from '../stores/server'
import { api } from '../utils/api'
import { ws } from '../utils/ws'
import { messageContentText } from '../utils/escape'
import type { Message } from '../types'

const props = defineProps<{ mode: 'pins' | 'search'; channelId: string; locateError?: string; locating?: boolean }>()
const emit = defineEmits<{ close: []; locate: [messageId: string] }>()
const authStore = useAuthStore()
const serverStore = useServerStore()
const panelRef = ref<HTMLElement | null>(null)
const searchRef = ref<HTMLInputElement | null>(null)
const closeRef = ref<HTMLButtonElement | null>(null)
const keyword = ref('')
const authorId = ref('')
const messages = ref<Message[]>([])
const loading = ref(false)
const loadingMore = ref(false)
const error = ref('')
const hasMore = ref(false)
const nextBefore = ref<string | null>(null)
const submittedQuery = ref<{ q: string; authorId: string } | null>(null)
let generation = 0
let mounted = false
let disposed = false
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let trigger: HTMLElement | null = null
let lastPanelFocus: Element | null = null
let shouldRestoreFocus = false
// Pushes can arrive while a page is in flight. Overlay only changes received during
// that request so a later refresh can still supersede changes from before a disconnect.
const pushedChanges = new Map<string, Message | null>()

const title = computed(() => props.mode === 'pins' ? '置顶消息' : '搜索消息')
const authors = computed(() => serverStore.members.map(member => ({
  id: member.userId,
  name: member.user?.nickname || member.user?.username || '未知成员'
})).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')))
const resultSummary = computed(() => {
  if (loading.value) return props.mode === 'pins' ? '正在加载置顶消息…' : '正在搜索…'
  if (props.mode === 'search' && !submittedQuery.value) return '输入关键词，或选择发送者后搜索。'
  if (!messages.value.length) return props.mode === 'pins' ? '这个频道还没有置顶消息。' : '没有找到符合条件的消息。'
  return props.mode === 'pins' ? `${messages.value.length} 条置顶消息` : `已显示 ${messages.value.length} 条结果${hasMore.value ? '，可继续加载' : ''}`
})

function accountToken() { return localStorage.getItem('token') }
function isCurrent(request: { generation: number; channelId: string; mode: string; userId: string | undefined; token: string | null }) {
  return !disposed && request.generation === generation && request.channelId === props.channelId &&
    request.mode === props.mode && request.userId === authStore.user?.id && !!request.userId &&
    request.token === accountToken()
}
function requestContext() {
  return { generation: ++generation, channelId: props.channelId, mode: props.mode, userId: authStore.user?.id, token: accountToken() }
}
function clearRefreshTimer() {
  if (refreshTimer !== null) clearTimeout(refreshTimer)
  refreshTimer = null
}
function resetResults() {
  generation++
  clearRefreshTimer()
  messages.value = []
  loading.value = false
  loadingMore.value = false
  error.value = ''
  hasMore.value = false
  nextBefore.value = null
  pushedChanges.clear()
}
function messageMatches(message: Message, query = submittedQuery.value) {
  if (!query) return false
  if (query.authorId && message.userId !== query.authorId) return false
  const searchable = `${messageContentText(message.content || '', message.mentionUsers)}\n${message.fileName || ''}`.toLowerCase()
  return !query.q || searchable.includes(query.q.toLocaleLowerCase())
}
function mergePushes(page: Message[]) {
  return page.map(message => {
    if (!pushedChanges.has(message.id)) return message
    const pushed = pushedChanges.get(message.id)
    if (!pushed) return null
    return (message.revision || 0) > (pushed.revision || 0) ? message : pushed
  })
    .filter((message): message is Message => !!message && message.channelId === props.channelId &&
      (props.mode === 'pins' ? !!message.pin : messageMatches(message)))
}

async function loadPins() {
  if (!authStore.user?.id || !props.channelId || disposed) return
  clearRefreshTimer()
  const request = requestContext()
  pushedChanges.clear()
  loading.value = true
  loadingMore.value = false
  error.value = ''
  try {
    const result = await api.getPinnedMessages(request.channelId)
    if (!isCurrent(request)) return
    messages.value = mergePushes(Array.isArray(result.pins) ? result.pins : []).sort((a, b) =>
      (b.pin?.createdAt || '').localeCompare(a.pin?.createdAt || '') || b.sequence - a.sequence)
  } catch (failure) {
    if (isCurrent(request)) error.value = failure instanceof Error ? failure.message : '置顶消息加载失败，请重试。'
  } finally {
    if (isCurrent(request)) loading.value = false
  }
}

async function runSearch(append = false) {
  const query = submittedQuery.value
  if (!query || !authStore.user?.id || !props.channelId || disposed) return
  if (append && (loading.value || loadingMore.value || !hasMore.value || !nextBefore.value)) return
  clearRefreshTimer()
  const before = append ? nextBefore.value! : undefined
  const request = requestContext()
  pushedChanges.clear()
  loading.value = !append
  loadingMore.value = append
  error.value = ''
  try {
    const result = await api.searchMessages(request.channelId, { ...query, before, limit: 20 })
    if (!isCurrent(request)) return
    const page = mergePushes(Array.isArray(result.messages) ? result.messages : [])
    const unique = new Map<string, Message>()
    for (const message of append ? [...messages.value, ...page] : page) unique.set(message.id, message)
    messages.value = [...unique.values()].sort((a, b) => b.sequence - a.sequence)
    nextBefore.value = typeof result.nextBefore === 'string' ? result.nextBefore : null
    hasMore.value = !!result.hasMore && !!nextBefore.value && nextBefore.value !== before
  } catch (failure) {
    if (isCurrent(request)) error.value = failure instanceof Error ? failure.message : '搜索失败，请重试。'
  } finally {
    if (isCurrent(request)) {
      loading.value = false
      loadingMore.value = false
    }
  }
}

function submitSearch() {
  const q = keyword.value.trim()
  if (!q && !authorId.value) {
    error.value = '请输入关键词，或选择发送者。'
    searchRef.value?.focus()
    return
  }
  if (q.length > 100) {
    error.value = '关键词不能超过 100 个字符。'
    return
  }
  resetResults()
  submittedQuery.value = { q, authorId: authorId.value }
  void runSearch()
}

function refresh() {
  if (props.mode === 'pins') void loadPins()
  else if (submittedQuery.value) void runSearch()
}
function queuePinRefresh() {
  clearRefreshTimer()
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    if (!disposed && props.mode === 'pins' && authStore.user?.id) void loadPins()
  }, 120)
}
function handlesEvent(data: { channelId?: string }) {
  return mounted && !disposed && !!authStore.user?.id && data.channelId === props.channelId
}
function handleUpdated(data: { channelId?: string; message?: Message }) {
  if (!handlesEvent(data) || !data.message || data.message.channelId !== props.channelId) return
  const message = data.message
  const index = messages.value.findIndex(item => item.id === message.id)
  const previousPush = pushedChanges.get(message.id)
  if (pushedChanges.has(message.id) && previousPush === null) return
  const previous = previousPush || (index !== -1 ? messages.value[index] : null)
  if (previous && (previous.revision || 0) > (message.revision || 0)) return
  pushedChanges.set(message.id, message)
  if (index !== -1) {
    if (props.mode === 'pins' ? !!message.pin : messageMatches(message)) {
      messages.value = messages.value.map(item => item.id === message.id ? message : item)
    } else messages.value = messages.value.filter(item => item.id !== message.id)
  }
  if (props.mode === 'pins') queuePinRefresh()
}
function handleDeleted(data: { channelId?: string; messageId?: string }) {
  if (!handlesEvent(data) || !data.messageId) return
  pushedChanges.set(data.messageId, null)
  messages.value = messages.value.filter(item => item.id !== data.messageId)
  if (props.mode === 'pins') queuePinRefresh()
}
function handleReconnect() {
  if (!disposed && mounted && authStore.user?.id) {
    // The socket may have missed changes during the disconnect. Let the refreshed
    // server snapshot supersede push content retained from before the disconnect.
    pushedChanges.clear()
    refresh()
  }
}

function displayName(message: Message) { return message.user?.nickname || message.user?.username || '未知成员' }
function displayContent(message: Message) { return messageContentText(message.content, message.mentionUsers) }
function pinActor(message: Message) {
  return message.pin?.user?.nickname || message.pin?.user?.username ||
    serverStore.members.find(member => member.userId === message.pin?.userId)?.user?.nickname || '成员'
}
function formatTime(value: string | undefined) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
  })
}
function focusableElements() {
  return Array.from(panelRef.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') || [])
    .filter(element => !element.hidden && element.getAttribute('aria-hidden') !== 'true')
}
function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('close')
    return
  }
  if (event.key !== 'Tab') return
  const controls = focusableElements()
  const first = controls[0]
  const last = controls[controls.length - 1]
  if (!first) { event.preventDefault(); panelRef.value?.focus(); return }
  const focusedControl = controls.includes(document.activeElement as HTMLElement)
  if (event.shiftKey && (document.activeElement === first || !focusedControl)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (document.activeElement === last || !focusedControl)) {
    event.preventDefault()
    first.focus()
  }
}
async function focusInitial() {
  await nextTick()
  if (!disposed && mounted) (props.mode === 'search' ? searchRef.value : closeRef.value)?.focus({ preventScroll: true })
}

watch(() => props.locating, async value => {
  if (!value) return
  await nextTick()
  // Disabling the clicked result can move browser focus to the document body.
  if (!disposed && mounted && props.locating) closeRef.value?.focus({ preventScroll: true })
})

watch([() => props.channelId, () => props.mode, () => authStore.user?.id], () => {
  resetResults()
  keyword.value = ''
  authorId.value = ''
  submittedQuery.value = null
  if (mounted) {
    if (props.mode === 'pins') void loadPins()
    void focusInitial()
  }
}, { flush: 'sync' })

onMounted(() => {
  mounted = true
  trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
  ws.on('message-updated', handleUpdated)
  ws.on('message-deleted', handleDeleted)
  ws.onReconnect(handleReconnect)
  if (props.mode === 'pins') void loadPins()
  void focusInitial()
})
onBeforeUnmount(() => {
  lastPanelFocus = document.activeElement
  shouldRestoreFocus = !!panelRef.value?.contains(lastPanelFocus)
})
onUnmounted(() => {
  disposed = true
  mounted = false
  resetResults()
  ws.off('message-updated', handleUpdated)
  ws.off('message-deleted', handleDeleted)
  ws.offReconnect(handleReconnect)
  void nextTick(() => {
    if (shouldRestoreFocus && trigger?.isConnected &&
      (document.activeElement === document.body || document.activeElement === lastPanelFocus)) trigger.focus({ preventScroll: true })
  })
})
</script>

<template>
  <div class="message-find-overlay" @click.self="emit('close')">
    <section ref="panelRef" class="message-find-panel" role="dialog" aria-modal="true" aria-labelledby="message-find-title" tabindex="-1" @keydown="handleKeydown">
      <header class="message-find-header">
        <div class="message-find-heading">
          <h2 id="message-find-title">{{ title }}</h2>
          <p>{{ serverStore.currentChannel?.name || '当前频道' }}</p>
        </div>
        <button ref="closeRef" type="button" class="message-find-icon-button" :aria-label="`关闭${title}`" title="关闭" @click="emit('close')">
          <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </header>

      <form v-if="mode === 'search'" class="message-find-form" @submit.prevent="submitSearch">
        <label for="message-find-keyword">关键词</label>
        <input id="message-find-keyword" ref="searchRef" v-model="keyword" type="search" maxlength="100" placeholder="搜索消息内容或文件名" autocomplete="off" />
        <label for="message-find-author">发送者</label>
        <div class="message-find-filter-row">
          <select id="message-find-author" v-model="authorId">
            <option value="">所有成员</option>
            <option v-for="author in authors" :key="author.id" :value="author.id">{{ author.name }}</option>
          </select>
          <button type="submit" class="message-find-primary-button" :disabled="loading">搜索</button>
        </div>
      </form>

      <div class="message-find-summary" aria-live="polite" role="status">
        <span>{{ resultSummary }}</span>
        <button v-if="mode === 'pins' || submittedQuery" type="button" class="message-find-text-button" :disabled="loading || loadingMore" aria-label="刷新消息结果" @click="refresh">刷新</button>
      </div>

      <div class="message-find-results" :aria-busy="loading || loadingMore">
        <div v-if="locateError" class="message-find-error" role="alert"><p>{{ locateError }}</p></div>
        <div v-if="error" class="message-find-error" role="alert">
          <p>{{ error }}</p>
          <button v-if="mode === 'pins' || submittedQuery" type="button" class="message-find-secondary-button" :disabled="loading || loadingMore" @click="refresh">重试</button>
        </div>
        <div v-if="!loading && !messages.length && !error" class="message-find-empty">
          <svg aria-hidden="true" viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.5"><path v-if="mode === 'pins'" d="m8 3 8 0-1 6 3 4H6l3-4-1-6Z M12 13v8" /><template v-else><circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" /></template></svg>
          <p>{{ mode === 'pins' ? '将重要消息置顶，方便成员查找。' : (submittedQuery ? '可以换一个关键词，或调整发送者。' : '支持按关键词和发送者查找频道历史消息。') }}</p>
        </div>
        <ol v-if="messages.length" class="message-find-list" aria-label="消息结果">
          <li v-for="message in messages" :key="message.id" class="message-find-card">
            <div class="message-find-author-row">
              <span class="message-find-avatar" aria-hidden="true">{{ displayName(message).slice(0, 1) }}</span>
              <strong>{{ displayName(message) }}</strong>
              <time :datetime="message.createdAt">{{ formatTime(message.createdAt) }}</time>
            </div>
            <p v-if="message.content" class="message-find-content">{{ displayContent(message) }}</p>
            <p v-if="message.file || message.image" class="message-find-attachment">{{ message.fileName || (message.image ? '图片附件' : '文件附件') }}</p>
            <p v-if="!message.content && !message.file && !message.image" class="message-find-attachment">消息内容为空</p>
            <p v-if="mode === 'pins' && message.pin" class="message-find-pin-info">{{ pinActor(message) }} 置顶于 {{ formatTime(message.pin.createdAt) }}</p>
            <button type="button" class="message-find-locate-button" :disabled="locating" @click="emit('locate', message.id)" :aria-label="`定位 ${displayName(message)} 的消息`">{{ locating ? '正在定位…' : '跳转到消息' }}<span v-if="!locating" aria-hidden="true"> →</span></button>
          </li>
        </ol>
        <button v-if="mode === 'search' && hasMore" type="button" class="message-find-load-more" :disabled="loading || loadingMore" @click="runSearch(true)">{{ loadingMore ? '正在加载…' : '加载更多结果' }}</button>
      </div>
    </section>
  </div>
</template>
