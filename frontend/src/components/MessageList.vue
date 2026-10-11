<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onUnmounted } from 'vue'
import { useServerStore } from '../stores/server'
import { useChatStore } from '../stores/chat'
import { useAuthStore } from '../stores/auth'
import { useReadStateStore } from '../stores/read-state'
import { api } from '../utils/api'
import { isMessageChannel } from '../utils/channel-type'
import { formatMessageContent, messageContentText } from '../utils/escape'
import { parseMentionText, updateMentionSpans, serializeMentionText } from '../utils/message-mentions'
import type { MentionSpan, MentionEditIntent } from '../utils/message-mentions'
import { MAX_DRAFT_LENGTH } from '../utils/chat-draft'
import { shouldGroupMessages, sameMessageDay, appendedMessageIds, isNearMessageBottom } from '../utils/message-layout'
import { createMessagePress } from '../utils/message-press'
import type { Message } from '../types'
import Avatar from './Avatar.vue'
import MessageReactions from './MessageReactions.vue'

const emit = defineEmits<{ reply: [message: any]; 'open-user-profile': [userId: string] }>()
const props = defineProps<{ blocked?: boolean }>()

const serverStore = useServerStore()
const chatStore = useChatStore()
const authStore = useAuthStore()
const readStateStore = useReadStateStore()

const containerRef = ref<HTMLElement | null>(null)
const editingMessageId = ref<string | null>(null)
const editContent = ref('')
const editMentionSpans = ref<MentionSpan[]>([])
const editComposing = ref(false)
let pendingEditIntent: MentionEditIntent | null = null
const showMenu = ref<string | null>(null)
const menuPresentation = ref<'menu' | 'sheet'>('menu')
const sheetRef = ref<HTMLElement | null>(null)
const menuPosition = ref({ left: 0, top: 0 })
const loadingMore = ref(false)
const followingLatest = ref(true)
const newMessageIds = ref<Set<string>>(new Set())
const feedback = ref('')
const savingEdit = ref(false)
const reactionPickerId = ref<string | null>(null)
const pinningId = ref<string | null>(null)
const locating = ref(false)
const highlightedId = ref<string | null>(null)
let locationGeneration = 0
let pinGeneration = 0
let editGeneration = 0
let highlightTimer: ReturnType<typeof setTimeout> | null = null
let historyGeneration = 0
let resizeObserver: ResizeObserver | null = null
let menuTrigger: HTMLElement | null = null
let readTimer: ReturnType<typeof setTimeout> | null = null
let menuGeneration = 0
let disposed = false
const selectedMessage = computed(() => chatStore.messages.find(message => message.id === showMenu.value))
const messagePress = createMessagePress<{ messageId: string; channelId: string; row: HTMLElement }>(context => {
  const message = chatStore.messages.find(message => message.id === context.messageId)
  if (disposed || !message || context.channelId !== serverStore.currentChannel?.id || !context.row.isConnected) return false
  openMessageActions(message, context.row, 'sheet')
  return true
})
const entryReadSequence = ref<number | null>(null)
const firstUnreadIndex = computed(() => entryReadSequence.value === null ? -1 : chatStore.messages.findIndex(message =>
  message.sequence > entryReadSequence.value! && message.userId !== authStore.user?.id))
const rows = computed(() => chatStore.messages.map((message, index) => ({
  message,
  grouped: index !== firstUnreadIndex.value && shouldGroupMessages(chatStore.messages[index - 1], message),
  showUnread: index === firstUnreadIndex.value,
  showDate: index === 0 || !sameMessageDay(chatStore.messages[index - 1].createdAt, message.createdAt)
})))
const newMessageCount = computed(() => chatStore.messages.filter(message => newMessageIds.value.has(message.id)).length)
const canPin = computed(() => {
  const server = serverStore.currentServer
  const member = serverStore.members?.find(member => member.userId === authStore.user?.id)
  if (!server || !member) return false
  if (server.ownerId === authStore.user?.id) return true
  return serverStore.roles.some(role => (role.isDefault || member.roles.includes(role.id)) && role.permissions?.manageMessages)
})
const canPublish = computed(() => serverStore.currentChannel?.type !== 'announcement' || (serverStore.canPublishAnnouncements
  && serverStore.hasPermission('viewChannel') && serverStore.hasPermission('sendMessage') && !serverStore.members.find(member => member.userId === authStore.user?.id)?.muted))

onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    if (followingLatest.value && !loadingMore.value) scrollToBottom()
  })
  if (containerRef.value) resizeObserver.observe(containerRef.value)
  document.addEventListener('click', closeMenuOnOutsideClick)
  document.addEventListener('click', suppressLongPressClick, true)
  document.addEventListener('pointerup', finishMessagePress)
  document.addEventListener('pointercancel', finishMessagePress)
  document.addEventListener('pointerdown', handleDocumentPointerDown, true)
  window.addEventListener('resize', handleWindowResize)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  window.addEventListener('focus', queueReadVisible)
  window.addEventListener('blur', handleWindowBlur)
  queueReadVisible()
})

onUnmounted(() => {
  disposed = true
  locationGeneration++
  pinGeneration++
  editGeneration++
  if (highlightTimer !== null) clearTimeout(highlightTimer)
  historyGeneration++
  locating.value = false
  highlightedId.value = null
  reactionPickerId.value = null
  pinningId.value = null
  menuGeneration++
  messagePress.reset()
  resizeObserver?.disconnect()
  document.removeEventListener('click', closeMenuOnOutsideClick)
  document.removeEventListener('click', suppressLongPressClick, true)
  document.removeEventListener('pointerup', finishMessagePress)
  document.removeEventListener('pointercancel', finishMessagePress)
  document.removeEventListener('pointerdown', handleDocumentPointerDown, true)
  window.removeEventListener('resize', handleWindowResize)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  window.removeEventListener('focus', queueReadVisible)
  window.removeEventListener('blur', handleWindowBlur)
  cancelReadTimer()
})

watch([() => serverStore.currentChannel?.id, () => authStore.user?.id], async () => {
  historyGeneration++
  const generation = ++locationGeneration
  pinGeneration++
  editGeneration++
  locating.value = false
  reactionPickerId.value = null
  pinningId.value = null
  highlightedId.value = null
  if (highlightTimer !== null) clearTimeout(highlightTimer)
  highlightTimer = null
  loadingMore.value = false
  followingLatest.value = true
  newMessageIds.value = new Set()
  messagePress.reset()
  closeMenu()
  editingMessageId.value = null
  editMentionSpans.value = []
  pendingEditIntent = null
  editComposing.value = false
  savingEdit.value = false
  feedback.value = ''
  cancelReadTimer()
  entryReadSequence.value = readStateStore.states[serverStore.currentChannel?.id || '']?.readSequence ?? null
  await nextTick()
  if (generation === locationGeneration && !locating.value) scrollToBottom()
}, { immediate: true, flush: 'sync' })

watch(selectedMessage, message => {
  if (showMenu.value && !message) closeMenuAndRestoreFocus()
}, { flush: 'sync' })

watch(() => readStateStore.states[serverStore.currentChannel?.id || '']?.readSequence, async sequence => {
  const initial = entryReadSequence.value === null && sequence !== undefined
  if (initial) entryReadSequence.value = sequence!
  await nextTick()
  if (initial && followingLatest.value && !loadingMore.value) scrollToBottom()
  else queueReadVisible()
}, { immediate: true })
watch(() => chatStore.loading, () => nextTick(queueReadVisible))
watch(() => chatStore.messages.map(message => `${message.id}:${message.revision ?? 0}`), async () => {
  if (locating.value || loadingMore.value) return
  await nextTick()
  if (followingLatest.value) scrollToBottom()
  else queueReadVisible()
})
watch(() => props.blocked, () => nextTick(queueReadVisible))
watch(() => chatStore.viewingContext, async (value, previous) => {
  if (previous && !value && !locating.value) { await nextTick(); scrollToBottom() }
})

watch(() => chatStore.messages.map(message => message.id), async (ids, previous) => {
  if (loadingMore.value || locating.value) return
  if (chatStore.viewingContext) { await nextTick(); queueReadVisible(); return }
  const channelId = serverStore.currentChannel?.id
  const arrivals = appendedMessageIds(previous, ids)
  const ownMessage = chatStore.messages.some(message => arrivals.includes(message.id) && message.userId === authStore.user?.id)
  if (!previous.length || followingLatest.value || ownMessage) {
    await nextTick()
    if (channelId === serverStore.currentChannel?.id) scrollToBottom()
  } else if (arrivals.length) {
    newMessageIds.value = new Set([...newMessageIds.value, ...arrivals])
    await nextTick()
    queueReadVisible()
  }
})

function scrollToBottom() {
  if (containerRef.value) {
    containerRef.value.scrollTop = containerRef.value.scrollHeight
  }
  followingLatest.value = !chatStore.viewingContext
  newMessageIds.value = new Set()
  queueReadVisible()
}

function cancelReadTimer() {
  if (readTimer !== null) clearTimeout(readTimer)
  readTimer = null
}

function visibleReadTarget() {
  const el = containerRef.value
  const channelId = serverStore.currentChannel?.id
  if (disposed || props.blocked || locating.value || (showMenu.value && menuPresentation.value === 'sheet') || !el || !channelId || chatStore.currentChannelId !== channelId || chatStore.loading || loadingMore.value ||
      document.visibilityState !== 'visible' || !document.hasFocus()) return null
  const state = readStateStore.states[channelId]
  if (!state) return null
  const viewport = el.getBoundingClientRect()
  let target: Message | undefined
  for (const row of el.querySelectorAll<HTMLElement>('[data-message-id]')) {
    const rect = row.getBoundingClientRect()
    if (rect.bottom <= viewport.top || rect.bottom > viewport.bottom + 1) continue
    const message = chatStore.messages.find(message => message.id === row.dataset.messageId)
    if (message && message.sequence > state.readSequence && (!target || message.sequence > target.sequence)) target = message
  }
  return target ? { channelId, message: target } : null
}

function queueReadVisible() {
  cancelReadTimer()
  const target = visibleReadTarget()
  if (!target) return
  readTimer = setTimeout(() => {
    readTimer = null
    const current = visibleReadTarget()
    if (current?.channelId === target.channelId && current.message.id === target.message.id) {
      void readStateStore.markRead(current.channelId, current.message.id, current.message.sequence)
    }
  }, 500)
}

function handleImageLoad() {
  if (followingLatest.value) scrollToBottom()
  else queueReadVisible()
}

async function handleScroll() {
  messagePress.cancel()
  updateMenuPosition()
  const el = containerRef.value
  if (!el || loadingMore.value || locating.value) return
  followingLatest.value = !chatStore.viewingContext && isNearMessageBottom(el.scrollTop, el.clientHeight, el.scrollHeight)
  if (followingLatest.value) newMessageIds.value = new Set()
  queueReadVisible()
  const channelId = serverStore.currentChannel?.id
  if (!channelId || el.scrollTop > 100 || !chatStore.hasMore || chatStore.loading) return
  const generation = ++historyGeneration
  const height = el.scrollHeight
  const top = el.scrollTop
  const viewportTop = el.getBoundingClientRect().top
  const anchor = Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]'))
    .find(row => row.getBoundingClientRect().bottom > viewportTop)
  const anchorId = anchor?.dataset.messageId
  const anchorTop = anchor ? anchor.getBoundingClientRect().top - viewportTop : 0
  const previousIds = chatStore.messages.map(message => message.id)
  loadingMore.value = true
  try {
    await chatStore.loadMore(channelId)
  } catch {
    // The store exposes the failed history request to the retry notice below.
  } finally {
    if (generation === historyGeneration && channelId === serverStore.currentChannel?.id) {
      await nextTick()
      loadingMore.value = false
      await nextTick()
      if (generation !== historyGeneration || channelId !== serverStore.currentChannel?.id) return
      const restoredAnchor = anchorId
        ? Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]')).find(row => row.dataset.messageId === anchorId)
        : undefined
      if (restoredAnchor) {
        el.scrollTop += restoredAnchor.getBoundingClientRect().top - el.getBoundingClientRect().top - anchorTop
      } else {
        el.scrollTop = top + el.scrollHeight - height
      }
      followingLatest.value = !chatStore.viewingContext && isNearMessageBottom(el.scrollTop, el.clientHeight, el.scrollHeight)
      const arrivals = appendedMessageIds(previousIds, chatStore.messages.map(message => message.id))
      if (chatStore.messages.some(message => arrivals.includes(message.id) && message.userId === authStore.user?.id)) scrollToBottom()
      else if (!followingLatest.value && arrivals.length) newMessageIds.value = new Set([...newMessageIds.value, ...arrivals])
      queueReadVisible()
    }
  }
}

async function reloadMessages() {
  const channel = serverStore.currentChannel
  if (!isMessageChannel(channel) || chatStore.loading) return
  followingLatest.value = true
  try { await chatStore.loadMessages(channel.id) } catch {}
}

function formatDate(dateStr: string) { return new Date(dateStr).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }) }
function replySummary(message: Message) {
  const original = chatStore.messages.find(candidate => candidate.id === message.replyTo)
  if (!original) return '回复了一条消息 · 点击定位原消息'
  return `${original.user?.nickname || original.user?.username || '成员'}：${displayContent(original) || (original.image ? '[图片]' : '[文件]')}`
}

function mentionUsers(message: Message) {
  const users = new Map((message.mentionUsers || []).map(user => [user.id, user]))
  for (const member of serverStore.members || []) if (message.mentions?.includes(member.userId) && member.user) users.set(member.userId, member.user)
  return [...users.values()]
}
function displayContent(message: Message) { return messageContentText(message.content, mentionUsers(message)) }
function mentionedMe(message: Message) {
  return message.userId !== authStore.user?.id && (message.mentionEveryone || message.mentions?.includes(authStore.user?.id || ''))
}
function openMentionProfile(message: Message, event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Element)) return
  const button = target.closest<HTMLElement>('[data-mention-id]')
  const id = button?.dataset.mentionId
  if (id && message.mentions?.includes(id)) emit('open-user-profile', id)
}

async function locateMessage(messageId: string) {
  const channelId = serverStore.currentChannel?.id
  const userId = authStore.user?.id
  if (!channelId || !userId || locating.value) return false
  const generation = ++locationGeneration
  historyGeneration++
  loadingMore.value = false
  locating.value = true
  followingLatest.value = false
  cancelReadTimer()
  closeMenu()
  feedback.value = ''
  try {
    if (!await chatStore.locateMessage(channelId, messageId)) return false
    await nextTick()
    if (disposed || generation !== locationGeneration || channelId !== serverStore.currentChannel?.id || userId !== authStore.user?.id) return false
    const el = containerRef.value
    const row = Array.from(el?.querySelectorAll<HTMLElement>('[data-message-id]') || []).find(row => row.dataset.messageId === messageId)
    if (!el || !row) throw new Error('原消息已被删除')
    el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - Math.max(0, (el.clientHeight - row.getBoundingClientRect().height) / 2)
    highlightedId.value = messageId
    if (highlightTimer !== null) clearTimeout(highlightTimer)
    highlightTimer = setTimeout(() => { highlightedId.value = null; highlightTimer = null }, 3000)
    row.focus({ preventScroll: true })
    return true
  } catch (error) {
    if (generation === locationGeneration && userId === authStore.user?.id && channelId === serverStore.currentChannel?.id) {
      feedback.value = (error as { status?: number })?.status === 404 ? '原消息已被删除，无法定位' : error instanceof Error ? error.message : '定位失败，请重试'
    }
    return false
  } finally {
    if (generation === locationGeneration) { locating.value = false; queueReadVisible() }
  }
}
function cancelLocation() {
  if (!locating.value) return
  locationGeneration++
  locating.value = false
  chatStore.cancelContextLookup()
  queueReadVisible()
}
defineExpose({ locateMessage, cancelLocation, getLocationError: () => feedback.value })

async function returnToLatest() {
  const channelId = serverStore.currentChannel?.id
  if (!channelId || chatStore.loading) return
  if (!chatStore.viewingContext) { scrollToBottom(); return }
  try { await chatStore.loadMessages(channelId); await nextTick(); if (channelId === serverStore.currentChannel?.id) scrollToBottom() } catch {}
}

function openReactions(message: Message) {
  closeMenuAndRestoreFocus()
  reactionPickerId.value = message.id
  nextTick(() => {
    const row = Array.from(containerRef.value?.querySelectorAll<HTMLElement>('[data-message-id]') || []).find(row => row.dataset.messageId === message.id)
    row?.querySelector<HTMLElement>('.message-reaction-picker')?.scrollIntoView({ block: 'nearest' })
    row?.querySelector<HTMLButtonElement>('.message-reaction-picker button')?.focus({ preventScroll: true })
  })
}

async function togglePin(message: Message) {
  if (pinningId.value) return
  closeMenuAndRestoreFocus()
  const channelId = serverStore.currentChannel?.id
  const userId = authStore.user?.id
  const generation = ++pinGeneration
  pinningId.value = message.id
  try {
    const data = await api.setMessagePin(message.id, !message.pin)
    if (!disposed && generation === pinGeneration && channelId === serverStore.currentChannel?.id && userId === authStore.user?.id) {
      chatStore.updateMessage(message.id, data.message)
      feedback.value = ''
    }
  } catch (error) {
    if (!disposed && generation === pinGeneration && channelId === serverStore.currentChannel?.id && userId === authStore.user?.id) feedback.value = error instanceof Error ? error.message : '置顶更新失败，请重试'
  } finally { if (generation === pinGeneration) pinningId.value = null }
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
  if (!canEdit(msg)) return
  editGeneration++
  savingEdit.value = false
  pendingEditIntent = null
  editComposing.value = false
  editingMessageId.value = msg.id
  editMentionSpans.value = []
  const draft = parseMentionText(msg.content, mentionUsers(msg))
  editContent.value = draft.text
  editMentionSpans.value = draft.mentionSpans
  feedback.value = ''
  closeMenu()
  nextTick(() => containerRef.value?.querySelector<HTMLTextAreaElement>(`[data-message-id="${msg.id}"] textarea`)?.focus({ preventScroll: true }))
}
function recordEditIntent(event: InputEvent) {
  const input = event.target as HTMLTextAreaElement
  pendingEditIntent = { text: input.value, start: input.selectionStart, end: input.selectionEnd, inputType: event.inputType }
}
function handleEditInput() {
  if (pendingEditIntent && !editComposing.value) {
    editMentionSpans.value = updateMentionSpans(editContent.value, editContent.value, editMentionSpans.value, pendingEditIntent)
    pendingEditIntent = null
  }
}
watch(editContent, (text, previous) => {
  editMentionSpans.value = updateMentionSpans(previous, text, editMentionSpans.value, pendingEditIntent)
  pendingEditIntent = null
}, { flush: 'sync' })
function handleEditKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229 || editComposing.value) return
  if (event.key === 'Enter' && event.ctrlKey) { event.preventDefault(); void saveEdit() }
  if (event.key === 'Escape') { event.preventDefault(); editingMessageId.value = null }
}

async function saveEdit() {
  if (!canPublish.value) { feedback.value = '当前没有发布或编辑公告的权限，编辑内容已保留'; return }
  if (!editingMessageId.value || savingEdit.value || editComposing.value || !editContent.value.trim()) return
  const id = editingMessageId.value
  const content = editContent.value
  const payload = serializeMentionText(content, editMentionSpans.value)
  const spans = JSON.stringify(editMentionSpans.value)
  if (content.length > MAX_DRAFT_LENGTH || payload.content.length > MAX_DRAFT_LENGTH) {
    feedback.value = '包含成员提及后的消息过长，请缩短文字后保存。'
    return
  }
  const channelId = serverStore.currentChannel?.id
  const userId = authStore.user?.id
  const generation = ++editGeneration
  savingEdit.value = true
  try {
    const result = await api.editMessage(id, payload.content)
    if (disposed || generation !== editGeneration || userId !== authStore.user?.id || channelId !== serverStore.currentChannel?.id) return
    chatStore.updateMessage(id, result.message)
    if (editingMessageId.value === id && editContent.value === content && JSON.stringify(editMentionSpans.value) === spans) editingMessageId.value = null
    feedback.value = ''
  } catch (error) {
    if (!disposed && generation === editGeneration && userId === authStore.user?.id && channelId === serverStore.currentChannel?.id) feedback.value = error instanceof Error ? error.message : '编辑失败，内容已保留'
  } finally { if (generation === editGeneration) savingEdit.value = false }
}

async function deleteMsg(msgId: string) {
  closeMenuAndRestoreFocus()
  if (!confirm('确定删除此消息？')) return
  const channelId = serverStore.currentChannel?.id
  try {
    await api.deleteMessage(msgId)
    if (channelId === serverStore.currentChannel?.id) { chatStore.removeMessage(msgId); feedback.value = '' }
  } catch (error) {
    if (channelId === serverStore.currentChannel?.id) feedback.value = error instanceof Error ? error.message : '删除失败，请稍后重试'
  }
}

function canManage(msg: Message) {
  return msg.userId === authStore.user?.id
}

function canEdit(msg: Message) { return canManage(msg) && canPublish.value }

function closeMenu() {
  menuGeneration++
  const wasSheet = showMenu.value !== null && menuPresentation.value === 'sheet'
  showMenu.value = null
  if (wasSheet && !disposed) nextTick(queueReadVisible)
}

function closeMenuAndRestoreFocus() {
  closeMenu()
  const trigger = menuTrigger
  const generation = menuGeneration
  if (trigger?.isConnected) trigger.focus({ preventScroll: true })
  else containerRef.value?.focus({ preventScroll: true })
  nextTick(() => {
    if (disposed || generation !== menuGeneration || showMenu.value || trigger?.isConnected) return
    if (!document.activeElement || document.activeElement === document.body || document.activeElement === trigger) containerRef.value?.focus({ preventScroll: true })
  })
}

function closeMenuOnOutsideClick(event: MouseEvent) {
  if (menuPresentation.value === 'sheet' && showMenu.value) return
  const target = event.target
  if (target instanceof Element && !target.closest('.message-menu-button, .message-context-menu')) closeMenu()
}

function toggleMenu(message: Message, event: MouseEvent) {
  if (showMenu.value === message.id) { closeMenu(); return }
  messagePress.cancel()
  openMessageActions(message, event.currentTarget as HTMLElement, window.innerWidth < 768 ? 'sheet' : 'menu')
}

function openMessageActions(message: Message, target: HTMLElement, presentation: 'menu' | 'sheet') {
  menuTrigger = target.matches('.message-menu-button') ? target : target.querySelector('.message-menu-button')
  menuPresentation.value = presentation
  showMenu.value = message.id
  const generation = ++menuGeneration
  if (presentation === 'sheet') cancelReadTimer()
  updateMenuPosition()
  nextTick(() => {
    if (disposed || generation !== menuGeneration || showMenu.value !== message.id) return
    const first = presentation === 'sheet'
      ? sheetRef.value?.querySelector<HTMLButtonElement>('button')
      : document.querySelector<HTMLButtonElement>('.message-context-menu button')
    first?.focus({ preventScroll: true })
  })
}

function beginMessagePress(message: Message, event: PointerEvent) {
  if (event.pointerType !== 'touch') return
  const target = event.target
  if (target instanceof Element && target.closest('button, input, textarea, select, [contenteditable="true"]')) return
  const channelId = serverStore.currentChannel?.id
  if (!channelId || editingMessageId.value === message.id || showMenu.value) return
  messagePress.begin(event, { messageId: message.id, channelId, row: event.currentTarget as HTMLElement })
}

function finishMessagePress(event: PointerEvent) { messagePress.end(event) }
function handleDocumentPointerDown(event: PointerEvent) {
  if (event.pointerType === 'touch' && !event.isPrimary) messagePress.cancel()
  else messagePress.clearClickBlock()
}

function handleMessageContextMenu(message: Message, event: MouseEvent) {
  if (showMenu.value === message.id && menuPresentation.value === 'sheet') return
  const touch = 'pointerType' in event && event.pointerType === 'touch'
  if (touch || window.innerWidth < 768) {
    messagePress.blockClick()
    openMessageActions(message, event.currentTarget as HTMLElement, 'sheet')
  } else toggleMenu(message, event)
}

function suppressLongPressClick(event: MouseEvent) {
  // Touch release can retarget its synthetic click to a button in the new sheet.
  if (event.detail !== 0 && messagePress.suppressesClick()) {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
}

function handleWindowResize() { messagePress.cancel(); closeMenu() }
function handleWindowBlur() { messagePress.cancel(); cancelReadTimer() }
function handleVisibilityChange() {
  if (document.visibilityState !== 'visible') messagePress.cancel()
  queueReadVisible()
}

function replyToMessage(message: Message) {
  if (!canPublish.value) return
  closeMenuAndRestoreFocus()
  emit('reply', message)
}

function handleSheetKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeMenuAndRestoreFocus()
    return
  }
  if (event.key !== 'Tab' || !sheetRef.value) return
  const buttons = Array.from(sheetRef.value.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
  const first = buttons[0]
  const last = buttons[buttons.length - 1]
  if (!first) return
  if (event.shiftKey && (document.activeElement === first || !sheetRef.value.contains(document.activeElement))) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && (document.activeElement === last || !sheetRef.value.contains(document.activeElement))) {
    event.preventDefault()
    first.focus()
  }
}

function actionSummary(message: Message) {
  return displayContent(message) || (message.image ? '图片消息' : message.fileName || '文件消息')
}

function updateMenuPosition() {
  if (menuPresentation.value !== 'menu' || !showMenu.value || !menuTrigger || !containerRef.value) return
  const message = chatStore.messages.find(message => message.id === showMenu.value)
  const rect = menuTrigger.getBoundingClientRect()
  const viewport = containerRef.value.getBoundingClientRect()
  if (!message || rect.bottom <= viewport.top || rect.top >= viewport.bottom) { closeMenu(); return }
  const height = (2 + (canManage(message) ? 2 : 0) + (canPin.value ? 1 : 0)) * 36 + 16
  menuPosition.value = {
    left: Math.max(8, Math.min(window.innerWidth - 188, rect.right - 180)),
    top: rect.bottom + height + 4 <= window.innerHeight - 8 ? rect.bottom + 4 : Math.max(8, rect.top - height - 4)
  }
}

function openUrl(url: string) { window.open(url, '_blank', 'noopener,noreferrer') }
</script>

<template>
  <div class="message-list-shell">
  <div ref="containerRef" class="message-scroll-area" aria-label="频道消息" tabindex="-1" @scroll="handleScroll">
    <div v-if="loadingMore" class="text-center text-discord-200 text-sm py-4">加载更多...</div>
    <div v-else-if="chatStore.loading && chatStore.messages.length === 0" class="text-center text-discord-200 text-sm py-4" role="status">正在加载消息…</div>
    <div v-if="chatStore.messages.length === 0 && !chatStore.loading && !chatStore.loadError"
         class="message-empty-state flex items-center justify-center h-full text-discord-200 text-sm">
      <div class="text-center">
        <p class="text-4xl mb-2">👋</p>
        <p>开始聊天吧！</p>
      </div>
    </div>

    <template v-for="({ message: msg, grouped, showDate, showUnread }) in rows" :key="msg.id">
    <div v-if="showDate" class="message-date-divider"><span>{{ formatDate(msg.createdAt) }}</span></div>
    <div v-if="showUnread" class="message-unread-divider"><span>新消息</span></div>
    <div :data-message-id="msg.id" :data-message-sequence="msg.sequence" tabindex="-1" class="message-row group message-entry" :class="{ 'message-entry-grouped': grouped, 'message-entry-highlighted': highlightedId === msg.id, 'message-entry-mentioned': mentionedMe(msg) }"
         @contextmenu.prevent="handleMessageContextMenu(msg, $event)"
         @pointerdown="beginMessagePress(msg, $event)" @pointermove="messagePress.move($event)"
         @pointerup="finishMessagePress" @pointercancel="finishMessagePress" @pointerleave="messagePress.end($event)">
      <div class="message-avatar-column">
      <button v-if="!grouped" type="button" class="message-avatar-button" :aria-label="`查看 ${msg.user?.nickname || msg.user?.username || '成员'} 的资料`" @click="emit('open-user-profile', msg.userId)">
      <Avatar :src="msg.user?.avatar"
              :name="msg.user?.nickname || msg.user?.username"
              size="md" />
      </button>
      <time v-else class="message-group-time" :title="new Date(msg.createdAt).toLocaleString('zh-CN')">{{ formatTime(msg.createdAt) }}</time>
      </div>

      <div class="flex-1 min-w-0">
        <div v-if="!grouped" class="flex items-baseline flex-wrap gap-x-2">
          <button type="button" class="message-author text-sm font-medium text-white hover:underline"
                @click="emit('open-user-profile', msg.userId)">
            {{ msg.user?.nickname || msg.user?.username }}
          </button>
          <time class="message-timestamp text-xs text-discord-200" :datetime="msg.createdAt">{{ formatTime(msg.createdAt) }}</time>
        </div>

        <div v-if="editingMessageId !== msg.id">
          <button v-if="msg.replyTo" type="button" class="message-reply-summary message-reply-link" :disabled="locating" @click="locateMessage(msg.replyTo)">
            <svg class="inline-block align-middle w-3 h-3 mr-1" aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
            {{ replySummary(msg) }}
          </button>
          <span v-if="msg.pin" class="message-pin-label">已置顶</span>

          <div v-if="msg.image" class="mt-1">
            <img :src="msg.image" alt="消息图片" class="max-w-full sm:max-w-sm max-h-80 rounded-lg object-contain cursor-pointer"
                 @load="handleImageLoad"
                 @click="openUrl(msg.image!)" />
          </div>

          <div v-if="msg.file" class="mt-1">
            <a :href="msg.file" target="_blank" rel="noopener noreferrer" class="message-file-card">
              <svg class="w-6 h-6 text-blurple" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <span class="text-sm text-discord-100 break-all min-w-0">{{ msg.fileName || '下载文件' }}</span>
            </a>
          </div>

          <div v-if="msg.content" class="message-content text-sm text-discord-50 mt-0.5 leading-relaxed whitespace-pre-wrap break-words"
               v-html="formatMessageContent(msg.content, mentionUsers(msg), msg.mentionEveryone)" @click="openMentionProfile(msg, $event)">
          </div>
          <span v-if="msg.editedAt" class="text-xs text-discord-300">已编辑</span>
          <MessageReactions :message="msg" :picker-open="reactionPickerId === msg.id" @close-picker="reactionPickerId = null" />
        </div>

        <div v-else class="mt-1">
          <textarea v-model="editContent" aria-label="编辑消息" class="input-discord w-full text-sm" rows="2" :maxlength="MAX_DRAFT_LENGTH"
                    @beforeinput="recordEditIntent" @input="handleEditInput" @compositionstart="editComposing = true" @compositionend="editComposing = false" @keydown="handleEditKeydown"></textarea>
          <div class="message-edit-actions flex gap-2 mt-1">
            <button type="button" :disabled="savingEdit || !editContent.trim()" @click="saveEdit" class="text-xs btn-primary py-1 px-2">{{ savingEdit ? '保存中…' : '保存' }}</button>
            <button @click="editingMessageId = null" class="text-xs btn-ghost py-1 px-2">取消</button>
          </div>
        </div>
      </div>

      <button type="button" class="message-menu-button" :aria-expanded="showMenu === msg.id" aria-label="消息操作" @click="toggleMenu(msg, $event)" @keydown.escape="closeMenu">···</button>

      <Teleport to="body">
      <div v-if="showMenu === msg.id && menuPresentation === 'menu'"
           class="context-menu message-context-menu fixed z-50 w-[180px]" :style="{ left: `${menuPosition.left}px`, top: `${menuPosition.top}px` }" @click.stop @keydown.escape="closeMenuAndRestoreFocus">
        <button v-if="canEdit(msg)" type="button" class="context-item w-full text-left" @click="startEdit(msg)">编辑</button>
        <button v-if="canPublish" type="button" class="context-item w-full text-left" @click="replyToMessage(msg)">回复</button>
        <button type="button" class="context-item w-full text-left" @click="openReactions(msg)">添加回应</button>
        <button v-if="canPin" type="button" class="context-item w-full text-left" :disabled="!!pinningId" @click="togglePin(msg)">{{ msg.pin ? '取消置顶' : '置顶消息' }}</button>
        <button v-if="canManage(msg)" type="button" class="context-item danger w-full text-left" @click="deleteMsg(msg.id)">删除</button>
      </div>
      </Teleport>
    </div>
    </template>
  </div>
    <Teleport to="body">
      <div v-if="selectedMessage && showMenu && menuPresentation === 'sheet'" class="message-action-overlay" @click.self="closeMenuAndRestoreFocus">
        <section ref="sheetRef" class="message-action-sheet" role="dialog" aria-modal="true" aria-labelledby="message-action-title" aria-describedby="message-action-preview" @keydown="handleSheetKeydown">
          <div class="message-action-handle" aria-hidden="true"></div>
          <div class="message-action-header">
            <h2 id="message-action-title" class="message-action-author">{{ selectedMessage.user?.nickname || selectedMessage.user?.username || '成员' }} 的消息</h2>
            <time class="message-action-time" :datetime="selectedMessage.createdAt">{{ new Date(selectedMessage.createdAt).toLocaleString('zh-CN') }}</time>
          </div>
          <p id="message-action-preview" class="message-action-preview">{{ actionSummary(selectedMessage) }}</p>
          <div class="message-action-buttons">
            <button v-if="canPublish" type="button" class="message-action-button" @click="replyToMessage(selectedMessage)">回复消息</button>
            <button type="button" class="message-action-button" @click="openReactions(selectedMessage)">添加回应</button>
            <button v-if="canPin" type="button" class="message-action-button" :disabled="!!pinningId" @click="togglePin(selectedMessage)">{{ selectedMessage.pin ? '取消置顶' : '置顶消息' }}</button>
            <button v-if="canEdit(selectedMessage) && selectedMessage.content" type="button" class="message-action-button" @click="startEdit(selectedMessage)">编辑消息</button>
            <button v-if="canManage(selectedMessage)" type="button" class="message-action-button danger" @click="deleteMsg(selectedMessage.id)">删除消息</button>
          </div>
          <button type="button" class="message-action-cancel" @click="closeMenuAndRestoreFocus">取消</button>
        </section>
      </div>
    </Teleport>
    <button v-if="!followingLatest || chatStore.viewingContext" type="button" class="message-jump-button" :disabled="chatStore.loading" @click="returnToLatest">{{ (newMessageCount || chatStore.contextNewMessageIds?.size) ? `${newMessageCount || chatStore.contextNewMessageIds.size} 条新消息 · ` : '' }}回到最新 ↓</button>
    <p v-if="locating" class="px-4 py-2 text-xs text-discord-100" role="status">正在定位原消息…</p>
    <div v-if="chatStore.loadError" class="message-feedback" role="alert">消息加载失败：{{ chatStore.loadError }}<button type="button" class="ml-3 underline" :disabled="chatStore.loading" @click="reloadMessages">重新加载频道</button></div>
    <div v-if="serverStore.currentChannel && readStateStore.readErrors[serverStore.currentChannel.id]" class="px-4 py-2 text-xs text-discord-100" role="status">阅读状态暂未同步<button type="button" class="ml-2 underline" @click="queueReadVisible">重试</button></div>
    <div v-if="feedback" class="message-feedback" role="alert">{{ feedback }}<button type="button" class="ml-3 underline" @click="feedback = ''">关闭</button></div>
  </div>
</template>
