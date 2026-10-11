<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useServerStore } from '../stores/server'
import { useChatStore } from '../stores/chat'
import { useAuthStore } from '../stores/auth'
import { useNotificationStore } from '../stores/notifications'
import { messageContentText } from '../utils/escape'
import { ws } from '../utils/ws'
import { api } from '../utils/api'
import { isMessageChannel } from '../utils/channel-type'
import { MAX_DRAFT_LENGTH, chatDraftKey, readChatDraft, saveChatDraft } from '../utils/chat-draft'
import type { ChatDraft, DraftReply, DraftStorage } from '../utils/chat-draft'
import { createMessageAttempt, messageAttemptMatches, readMessageAttempt, saveMessageAttempt, clearMessageAttempt } from '../utils/message-attempt'
import type { MessageAttempt, AttemptPayload, AttemptAttachment } from '../utils/message-attempt'
import { normalizeMentionSpans, updateMentionSpans, serializeMentionText, findMentionQuery, mentionChoices } from '../utils/message-mentions'
import type { MentionSpan, MentionQuery, MentionUser, MentionEditIntent } from '../utils/message-mentions'
import MessageList from './MessageList.vue'
import MessageFindPanel from './MessageFindPanel.vue'

const emit = defineEmits<{ 'open-user-profile': [userId: string]; 'toggle-channels': []; 'toggle-members': [] }>()
defineProps<{ membersVisible?: boolean }>()

const serverStore = useServerStore()
const chatStore = useChatStore()
const authStore = useAuthStore()
const notificationStore = useNotificationStore()

const messageInput = ref('')
const mentionSpans = ref<MentionSpan[]>([])
const mentionQuery = ref<MentionQuery | null>(null)
const mentionIndex = ref(0)
const composerFocused = ref(false)
const composingMention = ref(false)
let dismissedMention = ''
let pendingMentionEdit: MentionEditIntent | null = null
const fileInputRef = ref<HTMLInputElement | null>(null)
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const replyTo = ref<DraftReply | null>(null)
const showEmojiPicker = ref(false)
const submitting = ref(false)
const uploading = ref(false)
interface ComposerAttachment { file: File | null; kind: 'image' | 'file'; name: string; size: number; preview: string | null; uploadedUrl?: string; uploadedFileName?: string }
const attachment = ref<ComposerAttachment | null>(null)
const sendError = ref('')
const sendNotice = ref('')
const activeAttempt = ref<MessageAttempt | null>(null)
const attemptPersisted = ref(true)
const terminalFailure = ref(false)
const draftPersisted = ref(true)
const typingUsers = ref<Set<string>>(new Set())
const findMode = ref<'pins' | 'search' | null>(null)
const findLocationError = ref('')
const findingLocation = ref(false)
let findGeneration = 0
const messageListRef = ref<{ locateMessage: (id: string) => Promise<boolean>; cancelLocation: () => void; getLocationError: () => string } | null>(null)
watch(() => [serverStore.currentChannel?.id, authStore.user?.id], () => { findMode.value = null; findLocationError.value = ''; findingLocation.value = false })
watch(findMode, (_, previous) => {
  findGeneration++
  findLocationError.value = ''
  if (previous && findingLocation.value) { messageListRef.value?.cancelLocation(); findingLocation.value = false }
}, { flush: 'sync' })
async function locateResult(id: string) {
  if (findingLocation.value) return
  const channelId = serverStore.currentChannel?.id
  const userId = authStore.user?.id
  const generation = findGeneration
  findingLocation.value = true
  findLocationError.value = ''
  try {
    const found = await messageListRef.value?.locateMessage(id)
    if (generation !== findGeneration || channelId !== serverStore.currentChannel?.id || userId !== authStore.user?.id) return
    if (found) findMode.value = null
    else findLocationError.value = messageListRef.value?.getLocationError() || '消息不可用，无法定位，请刷新结果后重试'
  } finally { if (generation === findGeneration && channelId === serverStore.currentChannel?.id && userId === authStore.user?.id) findingLocation.value = false }
}
defineExpose({
  locateMessage: (id: string) => messageListRef.value?.locateMessage(id) || Promise.resolve(false),
  cancelLocation: () => messageListRef.value?.cancelLocation()
})
function toggleNotifications() {
  findMode.value = null
  closeMentionMenu()
  notificationStore.inboxOpen = !notificationStore.inboxOpen
}
let typingTimer: any = null
let typingUsersTimer: any = null
let restoringDraft = false
let activeContext: { userId: string; channelId: string; key: string } | null = null
const draftCache = new Map<string, ChatDraft>()
// Files remain in memory for this page; their Blob URLs never enter localStorage.
const attachmentCache = new Map<string, ComposerAttachment>()
const MAX_CACHED_ATTACHMENTS = 5
let attachmentAccountId: string | undefined
const draftVersions = new Map<string, number>()
const errors = new Map<string, string>()
const attemptCache = new Map<string, MessageAttempt>()
const attemptPersistence = new Map<string, boolean>()
const failureCodes = new Map<string, number>()
let accountGeneration = 0
let disposed = false
let draftStorage: DraftStorage | null = null
try { draftStorage = window.localStorage } catch {}

const announcementReadOnly = computed(() => serverStore.currentChannel?.type === 'announcement' && !serverStore.canPublishAnnouncements)
const canCompose = computed(() => !!authStore.user?.id && isMessageChannel(serverStore.currentChannel)
  && (serverStore.currentChannel.type !== 'announcement' || (serverStore.canPublishAnnouncements
    && serverStore.hasPermission('viewChannel') && serverStore.hasPermission('sendMessage') && !serverStore.members.find(member => member.userId === authStore.user?.id)?.muted)))
const canAttach = computed(() => canCompose.value && (serverStore.currentChannel?.type !== 'announcement' || serverStore.hasPermission('uploadFile')))
const canSend = computed(() => canCompose.value && (!attachment.value || canAttach.value) && !submitting.value && !terminalFailure.value && (!!messageInput.value.trim() || !!attachment.value))
watch(canCompose, allowed => { if (!allowed) { closeMentionMenu(); showEmojiPicker.value = false } })
const attachmentSize = computed(() => {
  const bytes = attachment.value?.size || 0
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`
})

function currentDraft(): ChatDraft {
  return { text: messageInput.value, replyTo: replyTo.value ? { ...replyTo.value } : null,
    ...(mentionSpans.value.length ? { mentionSpans: mentionSpans.value.map(span => ({ ...span })) } : {}) }
}

const canMentionEveryone = computed(() => {
  const server = serverStore.currentServer
  const userId = authStore.user?.id
  if (!server || !userId) return false
  if (server.ownerId === userId) return true
  const member = serverStore.members?.find(item => item.serverId === server.id && item.userId === userId)
  return !!member && !!serverStore.roles?.some(role => role.serverId === server.id
    && (role.isDefault || member.roles.includes(role.id)) && role.permissions?.mentionEveryone)
})
const mentionSuggestions = computed(() => {
  if (!mentionQuery.value || !canCompose.value || composingMention.value) return []
  const members = serverStore.members || []
  const users = members.filter(member => member.serverId === serverStore.currentServer?.id && member.user)
    .map(member => ({ id: member.userId, username: member.user!.username, nickname: member.user!.nickname }))
  return mentionChoices(users, mentionQuery.value.query, canMentionEveryone.value)
})
const mentionMenuOpen = computed(() => !!mentionQuery.value && !!mentionSuggestions.value.length && composerFocused.value && !composingMention.value)

function closeMentionMenu() { mentionQuery.value = null; mentionIndex.value = 0 }
function refreshMentionQuery(resetDismissed = false) {
  const input = textareaRef.value
  if (!input || !composerFocused.value || composingMention.value || !canCompose.value) return closeMentionMenu()
  if (resetDismissed) dismissedMention = ''
  const query = findMentionQuery(messageInput.value, input.selectionStart, input.selectionEnd, mentionSpans.value)
  const identity = query ? `${query.start}:${query.end}:${query.query}` : ''
  if (!query || identity === dismissedMention) return closeMentionMenu()
  if (mentionQuery.value?.start !== query.start || mentionQuery.value?.query !== query.query) mentionIndex.value = 0
  mentionQuery.value = query
  mentionIndex.value = Math.min(mentionIndex.value, Math.max(0, mentionSuggestions.value.length - 1))
}
function handleComposerFocus() { composerFocused.value = true; dismissedMention = ''; refreshMentionQuery() }
function handleComposerBlur() { composerFocused.value = false; pendingMentionEdit = null; closeMentionMenu() }
function recordMentionEdit(event: InputEvent) {
  const input = event.target as HTMLTextAreaElement
  pendingMentionEdit = { text: input.value, start: input.selectionStart, end: input.selectionEnd, inputType: event.inputType }
}
function handleComposerInput() {
  if (pendingMentionEdit && !composingMention.value) {
    mentionSpans.value = updateMentionSpans(messageInput.value, messageInput.value, mentionSpans.value, pendingMentionEdit)
    pendingMentionEdit = null
  }
  composerFocused.value = true; resizeInput(); refreshMentionQuery(true)
}
function handleCaretChange(e?: KeyboardEvent) {
  if (!e || !['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(e.key)) refreshMentionQuery()
}
function startMentionComposition() { composingMention.value = true; closeMentionMenu() }
function endMentionComposition() { composingMention.value = false; nextTick(() => refreshMentionQuery(true)) }
function applyMentionChoice(user: MentionUser | undefined) {
  const query = mentionQuery.value
  const input = textareaRef.value
  if (!user || !query || !input || !composerFocused.value || composingMention.value
    || input.selectionStart !== query.end || input.selectionEnd !== query.end
    || !mentionSuggestions.value.some(item => item.id === user.id)) return closeMentionMenu()
  const name = (user.nickname || '').replace(/\s+/g, ' ').trim() || user.username
  const label = user.id === 'everyone' ? '@everyone' : `@${name}`
  const text = messageInput.value.slice(0, query.start) + label + ' ' + messageInput.value.slice(query.end)
  if (text.length > MAX_DRAFT_LENGTH) return
  const nextSpans = updateMentionSpans(messageInput.value, text, mentionSpans.value,
    { text: messageInput.value, start: query.start, end: query.end, inputType: 'insertReplacementText' })
  nextSpans.push({ start: query.start, end: query.start + label.length, userId: user.id })
  restoringDraft = true
  messageInput.value = text
  mentionSpans.value = normalizeMentionSpans(text, nextSpans)
  restoringDraft = false
  if (activeContext) { invalidateAttempt(); draftVersions.set(activeContext.key, (draftVersions.get(activeContext.key) || 0) + 1); persistDraft() }
  closeMentionMenu()
  showEmojiPicker.value = false
  nextTick(() => { input.focus(); input.setSelectionRange(query.start + label.length + 1, query.start + label.length + 1); resizeInput() })
}

watch(messageInput, (text, previous) => {
  if (!restoringDraft) mentionSpans.value = updateMentionSpans(previous, text, mentionSpans.value, pendingMentionEdit)
  pendingMentionEdit = null
}, { flush: 'sync' })

function persistDraft(context = activeContext, draft = currentDraft()) {
  if (!context) return
  draftCache.set(context.key, draft)
  const persisted = saveChatDraft(draftStorage, context.userId, context.channelId, draft)
  if (context.key === activeContext?.key) draftPersisted.value = persisted
}

function invalidateAttempt() {
  if (!activeContext) return
  attemptCache.delete(activeContext.key)
  attemptPersistence.delete(activeContext.key)
  failureCodes.delete(activeContext.key)
  errors.delete(activeContext.key)
  clearMessageAttempt(draftStorage, activeContext.userId, activeContext.channelId)
  activeAttempt.value = null
  sendError.value = ''
  sendNotice.value = ''
  terminalFailure.value = false
}

function attachmentMetadata(value: ComposerAttachment | null): AttemptAttachment | null {
  return value?.uploadedUrl ? { kind: value.kind, url: value.uploadedUrl, name: value.name, size: value.size } : null
}

function buildPayload(channelId: string, draft: ChatDraft, value: ComposerAttachment | null): AttemptPayload {
  const serialized = serializeMentionText(draft.text, draft.mentionSpans)
  return {
    channelId,
    content: serialized.content,
    ...(serialized.mentions.length ? { mentions: serialized.mentions } : {}),
    ...(serialized.mentionEveryone ? { mentionEveryone: true } : {}),
    replyTo: draft.replyTo?.id || null,
    ...(value?.kind === 'image' && value.uploadedUrl ? { image: value.uploadedUrl } : {}),
    ...(value?.kind === 'file' && value.uploadedUrl ? { file: value.uploadedUrl, fileName: value.uploadedFileName || value.name } : {})
  }
}

watch([messageInput, replyTo, mentionSpans], () => {
  if (restoringDraft || !activeContext) return
  invalidateAttempt()
  draftVersions.set(activeContext.key, (draftVersions.get(activeContext.key) || 0) + 1)
  persistDraft()
}, { deep: true, flush: 'sync' })

watch(() => [authStore.user?.id, serverStore.currentChannel?.id] as const, ([userId, channelId]) => {
  pendingMentionEdit = null
  closeMentionMenu()
  composerFocused.value = false
  composingMention.value = false
  persistDraft()
  const accountChanged = attachmentAccountId !== userId
  attachmentAccountId = userId
  if (activeContext && attachment.value) cacheAttachment(activeContext.key, attachment.value)
  releaseAttachmentPreview(attachment.value)
  attachment.value = null
  if (accountChanged) {
    accountGeneration++
    attachmentCache.forEach(releaseAttachmentPreview)
    attachmentCache.clear()
    attemptCache.clear()
    attemptPersistence.clear()
    failureCodes.clear()
    errors.clear()
  }
  activeContext = userId && channelId ? { userId, channelId, key: chatDraftKey(userId, channelId) } : null
  const draft = activeContext ? draftCache.get(activeContext.key) || readChatDraft(draftStorage, userId!, channelId!) : { text: '', replyTo: null }
  restoringDraft = true
  messageInput.value = draft.text
  replyTo.value = draft.replyTo
  mentionSpans.value = normalizeMentionSpans(draft.text, draft.mentionSpans)
  restoringDraft = false
  sendError.value = activeContext ? errors.get(activeContext.key) || '' : ''
  sendNotice.value = ''
  draftPersisted.value = !!draftStorage
  persistDraft()
  let savedAttachment = activeContext ? attachmentCache.get(activeContext.key) : null
  let savedAttempt = activeContext ? attemptCache.get(activeContext.key) || readMessageAttempt(draftStorage, userId!, channelId!) : null
  if (savedAttempt && activeContext) {
    const draftMatches = savedAttempt.draft.text === draft.text && savedAttempt.draft.replyTo?.id === draft.replyTo?.id
      && JSON.stringify(savedAttempt.draft.mentionSpans || []) === JSON.stringify(draft.mentionSpans || [])
    if (draftMatches && !savedAttachment && savedAttempt.attachment) {
      const item = savedAttempt.attachment
      savedAttachment = { file: null, kind: item.kind, name: item.name, size: item.size, preview: null, uploadedUrl: item.url, uploadedFileName: savedAttempt.payload.fileName || item.name }
    }
    if (!draftMatches || !messageAttemptMatches(savedAttempt, buildPayload(activeContext.channelId, draft, savedAttachment || null), draft)) {
      attemptCache.delete(activeContext.key)
      clearMessageAttempt(draftStorage, activeContext.userId, activeContext.channelId)
      savedAttempt = null
    } else {
      attemptCache.set(activeContext.key, savedAttempt)
      if (!attemptPersistence.has(activeContext.key)) attemptPersistence.set(activeContext.key, true)
      if (!sendError.value) sendError.value = '上次发送结果未确认，可以重试，本次发送不会重复创建消息。'
    }
  }
  activeAttempt.value = savedAttempt || null
  attemptPersisted.value = activeContext ? attemptPersistence.get(activeContext.key) !== false : true
  terminalFailure.value = !!activeContext && !!savedAttempt && [409, 410].includes(failureCodes.get(activeContext.key) || 0)
  if (savedAttachment && activeContext) {
    cacheAttachment(activeContext.key, savedAttachment)
    if (savedAttachment.kind === 'image') savedAttachment.preview = savedAttachment.file ? URL.createObjectURL(savedAttachment.file) : savedAttachment.uploadedUrl || null
  }
  attachment.value = savedAttachment || null
  showEmojiPicker.value = false
  typingUsers.value.clear()
  clearTimeout(typingTimer)
  clearTimeout(typingUsersTimer)
  typingTimer = null
  nextTick(resizeInput)
}, { immediate: true, flush: 'sync' })

function resizeInput() {
  const input = textareaRef.value
  if (!input) return
  input.style.height = 'auto'
  input.style.height = `${input.scrollHeight}px`
}

async function sendMessage() {
  if (!canSend.value || !activeContext) return
  const context = { ...activeContext }
  const draft = currentDraft()
  const version = draftVersions.get(context.key) || 0
  const generation = accountGeneration
  const selectedAttachment = attachment.value
  const prepared = buildPayload(context.channelId, draft, selectedAttachment)
  if ((prepared.mentions?.length || 0) > 50) {
    sendError.value = '一条消息最多提及 50 位成员，请减少提及后发送。'
    return
  }
  if (prepared.content.length > MAX_DRAFT_LENGTH) {
    sendError.value = '包含成员提及后的消息过长，请缩短文字后发送。'
    return
  }
  closeMentionMenu()
  submitting.value = true
  sendError.value = ''
  sendNotice.value = ''
  errors.delete(context.key)
  let stage: 'upload' | 'send' = 'send'
  let submittedAttempt: MessageAttempt | null = null
  try {
    if (selectedAttachment && !selectedAttachment.uploadedUrl) {
      stage = 'upload'
      uploading.value = true
      if (!selectedAttachment.file) throw new Error('请重新选择附件')
      const res = selectedAttachment.kind === 'image'
        ? await api.uploadImage(selectedAttachment.file)
        : await api.uploadFile(selectedAttachment.file)
      if (!res || res.error || typeof res.url !== 'string' || !res.url) throw new Error(res?.error || '附件上传失败')
      selectedAttachment.uploadedUrl = res.url
      selectedAttachment.uploadedFileName = res.filename || selectedAttachment.file.name
      uploading.value = false
    }
    // Uploads may finish after a channel change, but must never use another account.
    if (disposed || generation !== accountGeneration || authStore.user?.id !== context.userId) return
    stage = 'send'
    const payload = buildPayload(context.channelId, draft, selectedAttachment)
    const previousAttempt = attemptCache.get(context.key)
    submittedAttempt = previousAttempt && messageAttemptMatches(previousAttempt, payload, draft)
      ? previousAttempt
      : createMessageAttempt(payload, draft, attachmentMetadata(selectedAttachment))
    if ((draftVersions.get(context.key) || 0) === version && (attachmentCache.get(context.key) || null) === selectedAttachment) {
      attemptCache.set(context.key, submittedAttempt)
      const persisted = saveMessageAttempt(draftStorage, context.userId, context.channelId, submittedAttempt)
      attemptPersistence.set(context.key, persisted)
      if (activeContext?.key === context.key) {
        activeAttempt.value = submittedAttempt
        attemptPersisted.value = persisted
      }
    }
    const response = await chatStore.sendMessage({ ...submittedAttempt.payload, clientMessageId: submittedAttempt.clientMessageId })
    const confirmed = response?.message
    if (typeof confirmed?.id !== 'string' || !confirmed.id.trim() || confirmed.id.length > 128
      || confirmed.clientMessageId !== submittedAttempt.clientMessageId || confirmed.channelId !== context.channelId
      || !Number.isSafeInteger(confirmed.sequence) || confirmed.sequence <= 0) throw new Error('服务器尚未确认消息')
    if (disposed || generation !== accountGeneration || authStore.user?.id !== context.userId) return
    chatStore.addMessage(response.message)
    if (chatStore.viewingContext && chatStore.currentChannelId === context.channelId) void chatStore.loadMessages(context.channelId).catch(() => {})
    const unchanged = (draftVersions.get(context.key) || 0) === version
    const currentAttempt = attemptCache.get(context.key)?.clientMessageId === submittedAttempt.clientMessageId
    if (unchanged && currentAttempt) {
      if (activeContext?.key === context.key) {
        restoringDraft = true
        messageInput.value = ''
        replyTo.value = null
        mentionSpans.value = []
        restoringDraft = false
        nextTick(resizeInput)
      }
      draftVersions.set(context.key, version + 1)
      persistDraft(context, { text: '', replyTo: null })
    }
    if (currentAttempt) {
      attemptCache.delete(context.key)
      attemptPersistence.delete(context.key)
      failureCodes.delete(context.key)
      errors.delete(context.key)
      clearMessageAttempt(draftStorage, context.userId, context.channelId, submittedAttempt.clientMessageId)
      if (activeContext?.key === context.key) {
        activeAttempt.value = null
        terminalFailure.value = false
        sendError.value = ''
      }
    }
    if (attachmentCache.get(context.key) === selectedAttachment) attachmentCache.delete(context.key)
    if (activeContext?.key === context.key && attachment.value === selectedAttachment) clearAttachment(true)
    else releaseAttachmentPreview(selectedAttachment)
    if (activeContext?.key === context.key) sendNotice.value = unchanged ? '消息已发送' : '消息已发送，编辑后的草稿已保留。'
  } catch (e: any) {
    if (disposed || generation !== accountGeneration || authStore.user?.id !== context.userId) return
    const detail = e?.message || '请检查网络连接'
    const retryable = !!submittedAttempt && attemptCache.get(context.key)?.clientMessageId === submittedAttempt.clientMessageId
    const terminal = retryable && [409, 410].includes(e?.status)
    if (terminal) failureCodes.set(context.key, e.status)
    const error = terminal
      ? `发送未完成：${detail}。请修改内容后作为新消息发送。`
      : stage === 'upload'
      ? `上传失败：${detail}。附件已保留，可以再次发送。`
      : retryable
        ? `发送未确认：${detail}。可以重试，本次发送不会重复创建消息。`
        : `原消息发送未确认：${detail}。当前草稿已修改，请先查看聊天记录。`
    errors.set(context.key, error)
    if (activeContext?.key === context.key) {
      sendError.value = error
      terminalFailure.value = terminal
    }
  } finally {
    uploading.value = false
    submitting.value = false
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (!canCompose.value) return
  if (e.isComposing || e.keyCode === 229 || composingMention.value) return
  if (mentionMenuOpen.value) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      mentionIndex.value = (mentionIndex.value + (e.key === 'ArrowDown' ? 1 : -1) + mentionSuggestions.value.length) % mentionSuggestions.value.length
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); applyMentionChoice(mentionSuggestions.value[mentionIndex.value]); return }
    if (e.key === 'Escape') { e.preventDefault(); const query = mentionQuery.value!; dismissedMention = `${query.start}:${query.end}:${query.query}`; closeMentionMenu(); return }
  }
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

function handleFileUpload(e: Event) {
  const input = e.target as HTMLInputElement
  if (canAttach.value && input.files?.length && activeContext) selectAttachment(input.files[0])
  input.value = ''
}

function handlePaste(e: ClipboardEvent) {
  if (!canAttach.value) return
  const items = e.clipboardData?.items
  if (!items) return
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault()
      const file = item.getAsFile()
      if (!file) return
      if (activeContext) selectAttachment(file)
      return
    }
  }
}

function selectAttachment(file: File) {
  clearAttachment()
  if (activeContext) {
    invalidateAttempt()
    draftVersions.set(activeContext.key, (draftVersions.get(activeContext.key) || 0) + 1)
  }
  attachment.value = { file, kind: file.type.startsWith('image/') ? 'image' : 'file', name: file.name, size: file.size, preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null }
  if (activeContext) cacheAttachment(activeContext.key, attachment.value)
}

function cacheAttachment(key: string, value: ComposerAttachment) {
  attachmentCache.delete(key)
  attachmentCache.set(key, value)
  if (attachmentCache.size > MAX_CACHED_ATTACHMENTS) {
    const oldestKey = attachmentCache.keys().next().value!
    releaseAttachmentPreview(attachmentCache.get(oldestKey) || null)
    attachmentCache.delete(oldestKey)
  }
}

function releaseAttachmentPreview(value: ComposerAttachment | null) {
  if (value?.preview) {
    if (value.preview.startsWith('blob:')) URL.revokeObjectURL(value.preview)
    value.preview = null
  }
}

function clearAttachment(preserveAttempt = false) {
  if (!preserveAttempt && attachment.value && activeContext) {
    invalidateAttempt()
    draftVersions.set(activeContext.key, (draftVersions.get(activeContext.key) || 0) + 1)
  }
  releaseAttachmentPreview(attachment.value)
  if (activeContext) attachmentCache.delete(activeContext.key)
  attachment.value = null
}

function setReply(message: any) {
  if (!canCompose.value) return
  replyTo.value = {
    id: message.id,
    content: messageContentText(message.content, message.mentionUsers || []).slice(0, 100),
    username: message.user?.username || 'Unknown'
  }
}

function cancelReply() {
  replyTo.value = null
}

function insertEmoji(emoji: string) {
  if (!canCompose.value) return
  if (messageInput.value.length + emoji.length > MAX_DRAFT_LENGTH) return
  pendingMentionEdit = { text: messageInput.value, start: messageInput.value.length, end: messageInput.value.length, inputType: 'insertText' }
  messageInput.value += emoji
  showEmojiPicker.value = false
  closeMentionMenu()
  nextTick(resizeInput)
}

const commonEmojis = ['😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','🥰','😘','🤗','🤩','👍','👎','👊','✊','🤝','🙏','💪','🔥','⭐','❤️','💔','💯','✅','❌','🎉','🎊','🎈','🚀','💡','📌','💬','🗨️']

onMounted(() => {
  ws.on('typing', handleTyping)
})

onUnmounted(() => {
  disposed = true
  persistDraft()
  clearAttachment(true)
  attachmentCache.forEach(releaseAttachmentPreview)
  attachmentCache.clear()
  clearTimeout(typingTimer)
  clearTimeout(typingUsersTimer)
  ws.off('typing', handleTyping)
})

function handleTyping(data: any) {
  if (data.channelId === serverStore.currentChannel?.id && data.userId !== authStore.user?.id) {
    typingUsers.value.add(data.username)
    clearTimeout(typingUsersTimer)
    typingUsersTimer = setTimeout(() => typingUsers.value.clear(), 3000)
  }
}
</script>

<template>
  <div class="chat-main-panel">
    <div class="chat-header">
      <button type="button" class="composer-action md:hidden mr-2" title="频道列表" aria-label="频道列表"
              @click="emit('toggle-channels')">
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
      <div class="flex items-center gap-2 min-w-0">
        <svg v-if="serverStore.currentChannel?.type === 'text'" class="w-5 h-5 text-discord-200" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
        </svg>
        <svg v-else-if="serverStore.currentChannel?.type === 'announcement'" class="w-5 h-5 text-discord-200 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m3 10 15-6v16L3 14v-4Zm4 5 1 5h3l-2-4M21 9v6" /></svg>
        <h3 class="chat-header-title truncate">{{ serverStore.currentChannel?.type === 'announcement' ? '公告 ·' : '#' }} {{ serverStore.currentChannel?.name }}</h3>
      </div>
      <div class="chat-header-actions ml-auto">
      <button type="button" class="composer-action notification-trigger" title="通知" aria-label="通知" :aria-expanded="notificationStore.inboxOpen" @click="toggleNotifications">
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 8a6 6 0 00-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>
        <span v-if="notificationStore.unreadCount" class="notification-trigger-count" aria-hidden="true">{{ notificationStore.unreadCount > 99 ? '99+' : notificationStore.unreadCount }}</span>
        <span v-if="notificationStore.unreadCount" class="sr-only">{{ notificationStore.unreadCount }} 条未读提醒</span>
      </button>
      <button type="button" class="composer-action" title="置顶消息" aria-label="置顶消息" :aria-expanded="findMode === 'pins'" @click="findMode = findMode === 'pins' ? null : 'pins'">
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m16 3 5 5-4 2-3 5-2-2-6 6m2-13 5-3 2-4M6 6l12 12" /></svg>
      </button>
      <button type="button" class="composer-action" title="搜索频道消息" aria-label="搜索频道消息" :aria-expanded="findMode === 'search'" @click="findMode = findMode === 'search' ? null : 'search'">
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" stroke-width="2"/><path d="m16 16 4 4" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
      <button type="button" class="composer-action" :title="membersVisible ? '收起成员列表' : '成员列表'" aria-label="成员列表" :aria-expanded="!!membersVisible" aria-controls="chat-members"
              @click="emit('toggle-members')">
        <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>
      </div>
    </div>

    <MessageList ref="messageListRef" :blocked="!!findMode || notificationStore.inboxOpen || !!notificationStore.pendingTarget" @reply="setReply" @open-user-profile="(id) => emit('open-user-profile', id)" />
    <MessageFindPanel v-if="findMode && serverStore.currentChannel" :mode="findMode" :channel-id="serverStore.currentChannel.id" :locate-error="findLocationError" :locating="findingLocation" @close="findMode = null" @locate="locateResult" />

    <div v-if="replyTo" class="composer-reply flex items-center gap-2 text-sm">
      <div class="w-0.5 h-8 bg-blurple rounded"></div>
      <div class="flex-1 min-w-0">
        <span class="text-blurple font-medium">回复 {{ replyTo.username }}</span>
        <p class="text-discord-200 truncate">{{ replyTo.content }}</p>
      </div>
      <button type="button" @click="cancelReply" class="composer-action" title="取消回复" aria-label="取消回复">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>

    <div v-if="typingUsers.size > 0" class="px-4 py-1 text-xs text-discord-200">
      {{ Array.from(typingUsers).join(', ') }} 正在输入...
    </div>

    <div class="chat-composer">
      <p v-if="announcementReadOnly" class="announcement-read-only" role="status">这是公告频道。社区所有者及拥有管理消息权限的成员可以发布；你可以阅读、搜索和添加回应。</p>
      <p v-else-if="serverStore.currentChannel?.type === 'announcement' && !canCompose" class="announcement-read-only" role="status">当前不能发布公告，请确认发送消息权限及禁言状态。</p>
      <div v-if="attachment" class="composer-attachment relative mb-2 max-w-sm overflow-hidden">
        <img v-if="attachment.preview" :src="attachment.preview" :alt="attachment.name"
             class="max-h-40 w-full object-contain bg-discord-900" />
        <div class="flex items-center gap-3 p-3 pr-10 min-w-0">
          <svg v-if="!attachment.preview" class="w-5 h-5 text-discord-200 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6M9 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V9l-6-6H9zm4 0v6h6" />
          </svg>
          <div class="min-w-0">
            <p class="text-sm text-discord-50 truncate">{{ attachment.name }}</p>
            <p class="text-xs text-discord-200 mt-0.5">{{ attachmentSize }} · {{ attachment.uploadedUrl ? '已上传，等待发送' : '点击发送后上传' }}</p>
            <p class="text-xs text-discord-200 mt-1">{{ attachment.uploadedUrl && activeAttempt && attemptPersisted ? '附件已保存，刷新后可以继续重试' : '附件暂存在当前页面，刷新后需重新选择' }}</p>
          </div>
        </div>
        <button @click="clearAttachment()"
                class="composer-action absolute top-2 right-2 bg-black/60 hover:bg-black/80 text-white rounded-full"
                title="移除附件" aria-label="移除附件">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div class="composer-surface flex items-end">
        <button type="button" @click="fileInputRef?.click()" :disabled="!canAttach" class="composer-action" title="添加附件" aria-label="添加附件">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
        </button>
        <input ref="fileInputRef" type="file" class="hidden" @change="handleFileUpload" />

        <div class="composer-input-wrap flex-1 min-w-0 mx-2 relative">
          <div v-if="mentionMenuOpen" id="composer-mention-options" class="composer-mention-menu" role="listbox" aria-label="选择要提及的成员">
            <p class="composer-mention-heading">提及成员</p>
            <button v-for="(user, index) in mentionSuggestions" :id="`composer-mention-${index}`" :key="user.id" type="button"
                    class="composer-mention-option" :class="{ active: mentionIndex === index }" role="option" :aria-selected="mentionIndex === index"
                    :data-mention-user-id="user.id" tabindex="-1" @pointerdown.prevent @mousedown.prevent @pointermove="mentionIndex = index" @click="applyMentionChoice(user)">
              <span class="composer-mention-avatar" aria-hidden="true">{{ user.id === 'everyone' ? '@' : (user.nickname || user.username).slice(0, 1) }}</span>
              <span class="min-w-0"><span class="composer-mention-name">{{ user.nickname || user.username }}</span><span class="composer-mention-username">{{ user.id === 'everyone' ? '提醒此服务器所有成员' : `@${user.username}` }}</span></span>
            </button>
          </div>
          <textarea ref="textareaRef" v-model="messageInput" @keydown="handleKeydown" @paste="handlePaste" @beforeinput="recordMentionEdit"
                    @focus="handleComposerFocus" @blur="handleComposerBlur" @select="handleCaretChange()" @click="handleCaretChange()" @keyup="handleCaretChange"
                    @compositionstart="startMentionComposition" @compositionend="endMentionComposition"
                    :disabled="!canCompose"
                    class="composer-textarea w-full bg-transparent resize-none outline-none max-h-40 py-1 disabled:cursor-wait"
                    :placeholder="announcementReadOnly ? '此公告频道只读' : `发送${serverStore.currentChannel?.type === 'announcement' ? '公告' : '消息'}到 ${serverStore.currentChannel?.name || ''}`" :rows="1"
                    :maxlength="MAX_DRAFT_LENGTH" :aria-label="`发送消息到 ${serverStore.currentChannel?.name || '频道'}`"
                    aria-describedby="composer-feedback" :aria-expanded="mentionMenuOpen" :aria-controls="mentionMenuOpen ? 'composer-mention-options' : undefined"
                    :aria-activedescendant="mentionMenuOpen ? `composer-mention-${mentionIndex}` : undefined" :aria-autocomplete="mentionMenuOpen ? 'list' : 'none'" @input="handleComposerInput">
          </textarea>
        </div>

        <div class="relative">
          <button type="button" @click="showEmojiPicker = !showEmojiPicker" :disabled="!canCompose" class="composer-action" title="表情" aria-label="选择表情" :aria-expanded="showEmojiPicker">
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
          <div v-if="showEmojiPicker"
               class="composer-emoji-panel absolute bottom-full right-0 mb-2 bg-discord-800 border border-discord-600 rounded-lg p-3 w-64 sm:w-72 shadow-xl animate-scale-in">
            <div class="grid grid-cols-8 gap-1">
              <button v-for="emoji in commonEmojis" :key="emoji"
                      @click="insertEmoji(emoji)"
                      class="w-8 h-8 hover:bg-discord-600 rounded text-lg flex items-center justify-center">
                {{ emoji }}
              </button>
            </div>
          </div>
        </div>

        <button type="button" @click="sendMessage" :disabled="!canSend"
                class="composer-action composer-send ml-1"
                :title="submitting ? '发送中' : (activeAttempt && sendError ? '重试发送' : '发送消息')" :aria-label="submitting ? '发送中' : '发送消息'">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19V5m0 0l-7 7m7-7l7 7" />
          </svg>
        </button>
      </div>
      <div id="composer-feedback" class="composer-feedback" aria-live="polite">
        <p v-if="!canCompose && !authStore.user?.id" class="text-discord-100">正在加载账号，请稍候…</p>
        <p v-else-if="!canCompose" class="text-discord-100">发送入口不可用，草稿仍保存在此浏览器。</p>
        <p v-else-if="submitting" class="text-discord-100">{{ uploading ? '正在上传附件…' : '正在发送…' }}</p>
        <div v-else-if="sendError" class="space-y-1">
          <p class="text-red" role="alert">{{ sendError }}</p>
          <button v-if="activeAttempt && !terminalFailure" @click="sendMessage" :disabled="!canSend"
                  class="text-blurple hover:underline disabled:opacity-40 disabled:cursor-not-allowed">重试发送</button>
          <p v-if="activeAttempt && !attemptPersisted" class="text-discord-100">发送编号仅保留在当前页面，刷新后请先核对聊天记录。</p>
        </div>
        <p v-else-if="sendNotice" class="text-green" role="status">{{ sendNotice }}</p>
        <div v-else class="flex items-center justify-between gap-3 text-discord-200">
          <span>{{ messageInput || replyTo ? (draftPersisted ? '草稿已保存在此浏览器' : '草稿暂存于当前页面') : 'Enter 发送 · Shift + Enter 换行' }}</span>
          <span v-if="messageInput.length > MAX_DRAFT_LENGTH * 0.8" class="shrink-0">{{ messageInput.length }} / {{ MAX_DRAFT_LENGTH }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
