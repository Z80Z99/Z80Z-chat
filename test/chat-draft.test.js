import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'
import * as drafts from '../frontend/src/utils/chat-draft.ts'
import * as attempts from '../frontend/src/utils/message-attempt.ts'
import * as mentions from '../frontend/src/utils/message-mentions.ts'
import * as contentFormat from '../frontend/src/utils/escape.ts'
import * as channelTypes from '../frontend/src/utils/channel-type.ts'

class MemoryStorage {
  entries = new Map()
  getItem(key) { return this.entries.get(key) ?? null }
  setItem(key, value) { this.entries.set(key, value) }
  removeItem(key) { this.entries.delete(key) }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const componentSource = readFileSync(new URL('../frontend/src/components/ChatBox.vue', import.meta.url), 'utf8')
const script = componentSource.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const componentScript = ts.transpileModule(`${script}\nglobalThis.composer = { messageInput, mentionSpans, mentionQuery, mentionSuggestions, mentionMenuOpen, mentionIndex, textareaRef, composerFocused, composingMention, handleComposerFocus, handleComposerBlur, handleComposerInput, recordMentionEdit, handleCaretChange, startMentionComposition, endMentionComposition, applyMentionChoice, replyTo, attachment, submitting, sendError, sendNotice, activeAttempt, attemptPersisted, terminalFailure, draftPersisted, canCompose, canSend, sendMessage, setReply, handleFileUpload, handleKeydown, clearAttachment };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText

function createComposer(t, options = {}) {
  const storage = options.storage || new MemoryStorage()
  const serverStore = vue.reactive({ currentChannel: { id: 'channel-a', type: 'text', name: '聊天' }, currentServer: { id: 'server', ownerId: 'user-a' }, roles: [], members: [
    { serverId: 'server', userId: 'user-a', roles: [], user: { username: 'Alice', nickname: '小明' } },
    { serverId: 'server', userId: 'user-b', roles: [], user: { username: 'Bob', nickname: '小明' } },
    { serverId: 'elsewhere', userId: 'outsider', roles: [], user: { username: 'Elsewhere', nickname: '小明' } }
  ] })
  const authStore = vue.reactive({ user: options.user === undefined ? { id: 'user-a' } : options.user })
  const requests = []
  const acknowledgements = []
  const revoked = []
  const hooks = []
  const scope = vue.effectScope()
  let nextBlob = 0
  const api = {
    uploadImage: options.uploadImage || (async () => ({ url: '/uploads/image.png', filename: 'image.png' })),
    uploadFile: options.uploadFile || (async () => ({ url: '/uploads/file.txt', filename: 'file.txt' }))
  }
  const chatStore = {
    async sendMessage(data) {
      requests.push(JSON.parse(JSON.stringify(data)))
      const response = options.send ? await options.send(data) : { message: { id: 'ack', channelId: data.channelId } }
      if (options.rawResponse || !response?.message) return response
      return { ...response, message: { sequence: 1, clientMessageId: data.clientMessageId, ...response.message } }
    },
    addMessage(message) { acknowledgements.push(message) }
  }
  const context = {
    exports: {},
    defineEmits: () => () => {},
    defineProps: () => ({ membersVisible: false }),
    defineExpose: () => {},
    window: { localStorage: storage },
    URL: { createObjectURL: () => `blob:${++nextBlob}`, revokeObjectURL: url => revoked.push(url) },
    setTimeout: () => 1,
    clearTimeout: () => {},
    console,
    require(path) {
      if (path === 'vue') return { ...vue, onMounted: callback => callback(), onUnmounted: callback => hooks.push(callback) }
      if (path === '../stores/server') return { useServerStore: () => serverStore }
      if (path === '../stores/auth') return { useAuthStore: () => authStore }
      if (path === '../stores/notifications') return { useNotificationStore: () => vue.reactive({ inboxOpen: false, unreadCount: 0 }) }
      if (path === '../stores/chat') return { useChatStore: () => chatStore }
      if (path === '../utils/ws') return { ws: { on() {}, off() {}, send() {} } }
      if (path === '../utils/api') return { api }
      if (path === '../utils/chat-draft') return drafts
      if (path === '../utils/message-attempt') return attempts
      if (path === '../utils/message-mentions') return mentions
      if (path === '../utils/escape') return contentFormat
      if (path === '../utils/channel-type') return channelTypes
      if (path === './MessageList.vue' || path === './MessageFindPanel.vue') return {}
      throw new Error(`Unexpected import: ${path}`)
    }
  }
  scope.run(() => vm.runInNewContext(componentScript, context, { filename: 'ChatBox.vue' }))
  let stopped = false
  function dispose() {
    if (stopped) return
    stopped = true
    hooks.forEach(hook => hook())
    scope.stop()
  }
  t.after(dispose)
  return { ...context.composer, storage, serverStore, authStore, requests, acknowledgements, revoked, dispose }
}

test('草稿按账号和频道隔离，保留回复而不存储附件数据', () => {
  const storage = new MemoryStorage()
  const draft = { text: '你好', replyTo: { id: 'message-1', username: '小明', content: '原消息' }, attachment: { preview: 'blob:private' } }
  assert.equal(drafts.saveChatDraft(storage, 'user-a', 'channel-a', draft), true)
  assert.deepEqual(drafts.readChatDraft(storage, 'user-a', 'channel-a'), { text: '你好', replyTo: draft.replyTo })
  assert.deepEqual(drafts.readChatDraft(storage, 'user-b', 'channel-a'), { text: '', replyTo: null })
  assert.deepEqual(drafts.readChatDraft(storage, 'user-a', 'channel-b'), { text: '', replyTo: null })
  assert.ok(!storage.getItem(drafts.chatDraftKey('user-a', 'channel-a')).includes('blob:'))
  assert.notEqual(drafts.chatDraftKey('a:b', 'c'), drafts.chatDraftKey('a', 'b:c'))
})

test('公告只读成员不能发送、回复或选附件，已有草稿保留并在恢复发布权限后可发送', async t => {
  const composer = createComposer(t)
  composer.messageInput.value = '保留的公告草稿'
  composer.serverStore.hasPermission = () => true
  composer.serverStore.canPublishAnnouncements = false
  composer.serverStore.currentChannel.type = 'announcement'
  await vue.nextTick()
  assert.equal(composer.canCompose.value, false)
  assert.equal(composer.canSend.value, false)
  composer.setReply({ id: 'original', content: '公告' })
  composer.handleFileUpload({ target: { files: [{ name: 'file.txt', type: 'text/plain', size: 1 }], value: 'file' } })
  await composer.sendMessage()
  assert.equal(composer.replyTo.value, null)
  assert.equal(composer.attachment.value, null)
  assert.equal(composer.requests.length, 0)
  assert.equal(composer.messageInput.value, '保留的公告草稿')
  composer.serverStore.canPublishAnnouncements = true
  await composer.sendMessage()
  assert.equal(composer.requests.length, 1)
  assert.equal(composer.requests[0].content, '保留的公告草稿')
})

test('公告已失败发送的同标识重试在失权时被拦截，恢复权限后保留原发送标识', async t => {
  let attempts = 0
  const composer = createComposer(t, { send: async () => { if (++attempts === 1) throw new Error('连接中断'); return { message: { id: 'accepted', sequence: 2, channelId: 'channel-a' } } } })
  composer.serverStore.hasPermission = () => true
  composer.serverStore.canPublishAnnouncements = true
  composer.serverStore.currentChannel.type = 'announcement'
  composer.messageInput.value = '待重试公告'
  await composer.sendMessage()
  const originalId = composer.requests[0].clientMessageId
  composer.serverStore.canPublishAnnouncements = false
  await composer.sendMessage()
  assert.equal(composer.requests.length, 1)
  assert.equal(composer.messageInput.value, '待重试公告')
  assert.equal(composer.activeAttempt.value.clientMessageId, originalId)
  composer.serverStore.canPublishAnnouncements = true
  await composer.sendMessage()
  assert.equal(composer.requests[1].clientMessageId, originalId)
})

test('公告发布者仍受发送权限、禁言与上传权限限制', async t => {
  const composer = createComposer(t)
  const permissions = vue.reactive({ viewChannel: true, sendMessage: false, uploadFile: false })
  composer.serverStore.hasPermission = key => permissions[key] === true
  composer.serverStore.canPublishAnnouncements = true
  composer.serverStore.currentChannel.type = 'announcement'
  assert.equal(composer.canCompose.value, false)
  permissions.sendMessage = true
  assert.equal(composer.canCompose.value, true)
  composer.handleFileUpload({ target: { files: [{ name: 'a.txt', type: 'text/plain', size: 1 }], value: 'file' } })
  assert.equal(composer.attachment.value, null)
  permissions.uploadFile = true
  composer.handleFileUpload({ target: { files: [{ name: 'a.txt', type: 'text/plain', size: 1 }], value: 'file' } })
  assert.ok(composer.attachment.value)
  permissions.uploadFile = false
  assert.equal(composer.canSend.value, false)
  composer.serverStore.members[0].muted = true
  assert.equal(composer.canCompose.value, false)
  await composer.sendMessage()
  assert.equal(composer.requests.length, 0)
})

test('草稿长度有界、空草稿删除，损坏或不可用存储不影响输入', () => {
  const storage = new MemoryStorage()
  const key = drafts.chatDraftKey('user', 'channel')
  drafts.saveChatDraft(storage, 'user', 'channel', { text: 'x'.repeat(drafts.MAX_DRAFT_LENGTH + 100), replyTo: null })
  assert.equal(drafts.readChatDraft(storage, 'user', 'channel').text.length, drafts.MAX_DRAFT_LENGTH)
  drafts.saveChatDraft(storage, 'user', 'channel', { text: '', replyTo: null })
  assert.equal(storage.getItem(key), null)
  storage.setItem(key, '{broken json')
  assert.deepEqual(drafts.readChatDraft(storage, 'user', 'channel'), { text: '', replyTo: null })
  storage.setItem(key, JSON.stringify({ text: 123, replyTo: { id: 'id', username: {} } }))
  assert.deepEqual(drafts.readChatDraft(storage, 'user', 'channel'), { text: '', replyTo: null })
  const unavailable = { getItem() { throw new Error('denied') }, setItem() { throw new Error('quota') }, removeItem() { throw new Error('denied') } }
  assert.deepEqual(drafts.readChatDraft(unavailable, 'user', 'channel'), { text: '', replyTo: null })
  assert.equal(drafts.saveChatDraft(unavailable, 'user', 'channel', { text: 'still editable', replyTo: null }), false)
  assert.equal(drafts.saveChatDraft(null, 'user', 'channel', { text: 'still editable', replyTo: null }), false)
})

test('输入框切频道和账号分别恢复文字与回复草稿', t => {
  const composer = createComposer(t)
  composer.messageInput.value = '频道 A 草稿'
  composer.setReply({ id: 'reply-a', content: '要回复的内容', user: { username: 'Alice' } })
  composer.serverStore.currentChannel = { type: 'text', id: 'channel-b', name: '其他频道' }
  assert.equal(composer.messageInput.value, '')
  assert.equal(composer.replyTo.value, null)
  composer.messageInput.value = '频道 B 草稿'
  composer.serverStore.currentChannel = { type: 'text', id: 'channel-a', name: '聊天' }
  assert.equal(composer.messageInput.value, '频道 A 草稿')
  assert.equal(composer.replyTo.value.id, 'reply-a')
  composer.authStore.user = { id: 'user-b' }
  assert.equal(composer.messageInput.value, '')
  composer.authStore.user = { id: 'user-a' }
  assert.equal(composer.messageInput.value, '频道 A 草稿')
})

test('账号尚未加载时不能编辑或回复，确认身份后恢复对应频道草稿', async t => {
  const storage = new MemoryStorage()
  drafts.saveChatDraft(storage, 'user-a', 'channel-a', { text: '账号 A 的已保存草稿', replyTo: null })
  const composer = createComposer(t, { storage, user: null })
  assert.equal(composer.canCompose.value, false)
  assert.equal(composer.canSend.value, false)
  assert.equal(composer.messageInput.value, '')
  composer.setReply({ id: 'reply', content: '早到的消息', user: { username: 'Alice' } })
  assert.equal(composer.replyTo.value, null)
  await composer.sendMessage()
  assert.equal(composer.requests.length, 0)

  composer.authStore.user = { id: 'user-a' }
  assert.equal(composer.canCompose.value, true)
  assert.equal(composer.messageInput.value, '账号 A 的已保存草稿')
  composer.messageInput.value = '账号确认后的频道 A 草稿'
  composer.serverStore.currentChannel = { type: 'text', id: 'channel-b', name: 'B' }
  composer.messageInput.value = '频道 B 草稿'
  composer.serverStore.currentChannel = { type: 'text', id: 'channel-a', name: 'A' }
  assert.equal(composer.messageInput.value, '账号确认后的频道 A 草稿')
})

test('发送失败保留文字和回复，等待期间不能重复提交', async t => {
  const request = deferred()
  const composer = createComposer(t, { send: () => request.promise })
  composer.messageInput.value = '不能丢失'
  composer.setReply({ id: 'reply', content: '原文', user: { username: 'Alice' } })
  const sending = composer.sendMessage()
  await composer.sendMessage()
  assert.equal(composer.requests.length, 1)
  assert.equal(composer.messageInput.value, '不能丢失')
  assert.equal(composer.submitting.value, true)
  request.reject(new Error('网络中断'))
  await sending
  assert.equal(composer.messageInput.value, '不能丢失')
  assert.equal(composer.replyTo.value.id, 'reply')
  assert.ok(composer.sendError.value.includes('网络中断'))
  assert.equal(composer.submitting.value, false)
  assert.equal(drafts.readChatDraft(composer.storage, 'user-a', 'channel-a').text, '不能丢失')
})

test('发送成功加入确认消息，未修改的草稿才清空', async t => {
  const request = deferred()
  const composer = createComposer(t, { send: () => request.promise })
  composer.messageInput.value = '原消息'
  const sending = composer.sendMessage()
  composer.messageInput.value = '发送时新写的内容'
  request.resolve({ message: { id: 'sent', channelId: 'channel-a' } })
  await sending
  assert.equal(composer.messageInput.value, '发送时新写的内容')
  assert.equal(composer.acknowledgements.length, 1)

  await composer.sendMessage()
  assert.equal(composer.messageInput.value, '')
  assert.equal(composer.storage.getItem(drafts.chatDraftKey('user-a', 'channel-a')), null)
})

test('原频道请求成功不会清空新频道草稿，返回原频道没有已发送草稿', async t => {
  const request = deferred()
  const composer = createComposer(t, { send: () => request.promise })
  composer.messageInput.value = '发到 A'
  const sending = composer.sendMessage()
  composer.serverStore.currentChannel = { type: 'text', id: 'channel-b', name: 'B' }
  composer.messageInput.value = 'B 新草稿'
  request.resolve({ message: { id: 'sent', channelId: 'channel-a' } })
  await sending
  assert.equal(composer.requests[0].channelId, 'channel-a')
  assert.equal(composer.messageInput.value, 'B 新草稿')
  composer.serverStore.currentChannel = { type: 'text', id: 'channel-a', name: 'A' }
  assert.equal(composer.messageInput.value, '')
})

test('文件选择先预览，上传后即使切频道仍发送到原频道', async t => {
  const upload = deferred()
  const composer = createComposer(t, { uploadFile: () => upload.promise })
  const input = { files: [{ name: 'notes.txt', type: 'text/plain', size: 2048 }], value: 'notes.txt' }
  composer.handleFileUpload({ target: input })
  assert.equal(composer.requests.length, 0)
  assert.equal(composer.attachment.value.file.name, 'notes.txt')
  assert.equal(input.value, '')
  const sending = composer.sendMessage()
  composer.serverStore.currentChannel = { type: 'text', id: 'channel-b', name: 'B' }
  composer.messageInput.value = 'B 草稿'
  upload.resolve({ url: '/uploads/notes.txt', filename: 'notes.txt' })
  await sending
  assert.equal(composer.requests[0].channelId, 'channel-a')
  assert.equal(composer.requests[0].fileName, 'notes.txt')
  assert.equal(composer.messageInput.value, 'B 草稿')
})

test('图片上传成功但消息失败后保留预览，手动重发复用已上传附件', async t => {
  let uploads = 0, sends = 0
  const composer = createComposer(t, {
    uploadImage: async () => { uploads++; return { url: '/uploads/cached.png', filename: 'picture.png' } },
    send: async () => { if (++sends === 1) throw new Error('连接中断'); return { message: { id: 'ok', channelId: 'channel-a' } } }
  })
  composer.handleFileUpload({ target: { files: [{ name: 'picture.png', type: 'image/png', size: 1024 }], value: '' } })
  composer.messageInput.value = '图说明'
  await composer.sendMessage()
  assert.equal(uploads, 1)
  assert.equal(sends, 1, '失败后不会自动重试')
  assert.equal(composer.attachment.value.uploadedUrl, '/uploads/cached.png')
  assert.equal(composer.messageInput.value, '图说明')
  assert.ok(!composer.storage.getItem(drafts.chatDraftKey('user-a', 'channel-a')).includes('blob:'))
  await composer.sendMessage()
  assert.equal(uploads, 1)
  assert.equal(sends, 2)
  assert.equal(composer.attachment.value, null)
  assert.deepEqual(composer.revoked, ['blob:1'])
})

test('上传过程中切换账号不会用新账号发送旧附件', async t => {
  const upload = deferred()
  const composer = createComposer(t, { uploadImage: () => upload.promise })
  composer.handleFileUpload({ target: { files: [{ name: 'picture.png', type: 'image/png', size: 1024 }], value: '' } })
  const sending = composer.sendMessage()
  composer.authStore.user = { id: 'user-b' }
  upload.resolve({ url: '/uploads/picture.png' })
  await sending
  assert.equal(composer.requests.length, 0)
  assert.equal(composer.submitting.value, false)
})

test('附件发送失败后跨频道返回可恢复，并复用已完成的上传', async t => {
  const upload = deferred()
  let uploads = 0, sends = 0
  const composer = createComposer(t, {
    uploadImage: () => { uploads++; return upload.promise },
    send: async () => { if (++sends === 1) throw new Error('网络中断'); return { message: { id: 'ok', channelId: 'channel-a' } } }
  })
  composer.handleFileUpload({ target: { files: [{ name: 'picture.png', type: 'image/png', size: 1024 }], value: '' } })
  const sending = composer.sendMessage()
  composer.serverStore.currentChannel = { type: 'text', id: 'channel-b', name: 'B' }
  assert.equal(composer.attachment.value, null)
  upload.resolve({ url: '/uploads/picture.png' })
  await sending
  composer.serverStore.currentChannel = { type: 'text', id: 'channel-a', name: 'A' }
  assert.equal(composer.attachment.value.file.name, 'picture.png')
  assert.equal(composer.attachment.value.preview, 'blob:2')
  assert.ok(composer.sendError.value.includes('网络中断'))
  await composer.sendMessage()
  assert.equal(uploads, 1)
  assert.equal(sends, 2)
  assert.equal(composer.attachment.value, null)
  assert.deepEqual(composer.revoked, ['blob:1', 'blob:2'])
})

test('附件缓存最多保留五个频道，切换账号释放全部附件', t => {
  const composer = createComposer(t)
  for (let i = 0; i < 6; i++) {
    composer.serverStore.currentChannel = { type: 'text', id: `channel-${i}`, name: `${i}` }
    composer.handleFileUpload({ target: { files: [{ name: `${i}.png`, type: 'image/png', size: 1024 }], value: '' } })
  }
  composer.serverStore.currentChannel = { type: 'text', id: 'channel-0', name: '0' }
  assert.equal(composer.attachment.value, null, '最早的附件已释放')
  composer.serverStore.currentChannel = { type: 'text', id: 'channel-1', name: '1' }
  assert.equal(composer.attachment.value.file.name, '1.png')
  composer.authStore.user = { id: 'user-b' }
  assert.equal(composer.attachment.value, null)
  composer.authStore.user = { id: 'user-a' }
  assert.equal(composer.attachment.value, null, '上一账号的附件不能再次恢复')
  assert.equal(composer.revoked.length, 7)
})

test('未选择频道时切换账号也释放上一账号的附件缓存', t => {
  const composer = createComposer(t)
  composer.handleFileUpload({ target: { files: [{ name: 'private.png', type: 'image/png', size: 1024 }], value: '' } })
  composer.serverStore.currentChannel = null
  composer.authStore.user = { id: 'user-b' }
  composer.authStore.user = { id: 'user-a' }
  composer.serverStore.currentChannel = { type: 'text', id: 'channel-a', name: 'A' }
  assert.equal(composer.attachment.value, null)
  assert.deepEqual(composer.revoked, ['blob:1'])
})

test('中文输入法确认 Enter 不发送消息', t => {
  const composer = createComposer(t)
  composer.messageInput.value = '输入中的中文'
  let prevented = 0
  composer.handleKeydown({ key: 'Enter', isComposing: true, preventDefault() { prevented++ } })
  composer.handleKeydown({ key: 'Enter', keyCode: 229, preventDefault() { prevented++ } })
  assert.equal(composer.requests.length, 0)
  assert.equal(prevented, 0)
})

test('浏览器存储写入失败时，频道草稿仍可在页面内切换恢复', t => {
  const storage = { getItem() { throw new Error('denied') }, setItem() { throw new Error('quota') }, removeItem() { throw new Error('denied') } }
  const composer = createComposer(t, { storage })
  composer.messageInput.value = '页面内草稿'
  assert.equal(composer.draftPersisted.value, false)
  composer.serverStore.currentChannel = { type: 'text', id: 'channel-b', name: 'B' }
  composer.serverStore.currentChannel = { type: 'text', id: 'channel-a', name: 'A' }
  assert.equal(composer.messageInput.value, '页面内草稿')
  assert.equal(composer.draftPersisted.value, false)
})

test('服务器已创建消息但响应丢失，手动重试沿用提交编号且只创建一次', async t => {
  const records = new Map()
  let created = 0
  const composer = createComposer(t, {
    send: async data => {
      if (!records.has(data.clientMessageId)) {
        records.set(data.clientMessageId, { id: `sent-${++created}`, channelId: data.channelId, clientMessageId: data.clientMessageId })
        throw new Error('响应丢失')
      }
      return { message: records.get(data.clientMessageId) }
    }
  })
  composer.messageInput.value = '不能重复创建'
  await composer.sendMessage()
  const firstId = composer.requests[0].clientMessageId
  assert.ok(composer.sendError.value.includes('可以重试'))
  assert.equal(composer.messageInput.value, '不能重复创建')
  await composer.sendMessage()
  assert.equal(composer.requests[1].clientMessageId, firstId)
  assert.equal(created, 1)
  assert.equal(composer.messageInput.value, '')
  assert.equal(composer.sendNotice.value, '消息已发送')
  assert.equal(attempts.readMessageAttempt(composer.storage, 'user-a', 'channel-a'), null)
})

test('文字或回复变化后创建新提交编号，不把旧编号用于新 payload', async t => {
  const composer = createComposer(t, { send: async () => { throw new Error('timeout') } })
  composer.messageInput.value = 'first'
  await composer.sendMessage()
  const firstId = composer.requests[0].clientMessageId
  composer.messageInput.value = 'edited'
  assert.equal(composer.activeAttempt.value, null)
  await composer.sendMessage()
  const secondId = composer.requests[1].clientMessageId
  assert.notEqual(secondId, firstId)
  composer.setReply({ id: 'reply', content: '原文', user: { username: 'Alice' } })
  await composer.sendMessage()
  assert.notEqual(composer.requests[2].clientMessageId, secondId)
  assert.equal(composer.requests[2].replyTo, 'reply')
})

test('附件替换或移除后重新建立编号，未变化的附件重试复用上传 URL', async t => {
  let uploads = 0
  const composer = createComposer(t, {
    uploadImage: async () => ({ url: `/uploads/${++uploads}.png`, filename: 'image.png' }),
    send: async () => { throw new Error('offline') }
  })
  composer.messageInput.value = '图说明'
  composer.handleFileUpload({ target: { files: [{ name: 'one.png', type: 'image/png', size: 1024 }], value: '' } })
  await composer.sendMessage()
  await composer.sendMessage()
  assert.equal(composer.requests[0].clientMessageId, composer.requests[1].clientMessageId)
  assert.equal(uploads, 1)
  composer.handleFileUpload({ target: { files: [{ name: 'two.png', type: 'image/png', size: 1024 }], value: '' } })
  await composer.sendMessage()
  assert.notEqual(composer.requests[2].clientMessageId, composer.requests[1].clientMessageId)
  assert.equal(uploads, 2)
  composer.clearAttachment()
  await composer.sendMessage()
  assert.notEqual(composer.requests[3].clientMessageId, composer.requests[2].clientMessageId)
  assert.equal(composer.requests[3].image, undefined)
})

test('跨频道失败尝试各自保留编号，返回原频道重试不影响其他草稿', async t => {
  const composer = createComposer(t, { send: async () => { throw new Error('offline') } })
  composer.messageInput.value = 'A 原文'
  await composer.sendMessage()
  const idA = composer.requests[0].clientMessageId
  composer.serverStore.currentChannel = { type: 'text', id: 'channel-b', name: 'B' }
  composer.messageInput.value = 'B 原文'
  await composer.sendMessage()
  const idB = composer.requests[1].clientMessageId
  assert.notEqual(idA, idB)
  composer.serverStore.currentChannel = { type: 'text', id: 'channel-a', name: 'A' }
  await composer.sendMessage()
  assert.equal(composer.requests[2].clientMessageId, idA)
  assert.equal(composer.requests[2].channelId, 'channel-a')
  composer.serverStore.currentChannel = { type: 'text', id: 'channel-b', name: 'B' }
  assert.equal(composer.messageInput.value, 'B 原文')
  assert.equal(composer.activeAttempt.value.clientMessageId, idB)
})

test('刷新恢复文字未确认编号，重新发送不会创建第二条消息', async t => {
  const storage = new MemoryStorage()
  const records = new Map()
  let created = 0
  async function send(data) {
    if (!records.has(data.clientMessageId)) {
      records.set(data.clientMessageId, { id: `sent-${++created}`, channelId: data.channelId })
      throw new Error('请求结果未知')
    }
    return { message: records.get(data.clientMessageId) }
  }
  const before = createComposer(t, { storage, send })
  before.messageInput.value = '刷新后也不能重复'
  await before.sendMessage()
  const id = before.requests[0].clientMessageId
  before.dispose()
  const after = createComposer(t, { storage, send })
  assert.equal(after.messageInput.value, '刷新后也不能重复')
  assert.equal(after.activeAttempt.value.clientMessageId, id)
  await after.sendMessage()
  assert.equal(after.requests[0].clientMessageId, id)
  assert.equal(created, 1)
  assert.equal(after.messageInput.value, '')
})

test('刷新后的已上传附件用 URL 恢复，同编号重试无需原 File 或重复上传', async t => {
  const storage = new MemoryStorage()
  let uploads = 0
  const before = createComposer(t, {
    storage,
    uploadImage: async () => { uploads++; return { url: '/uploads/ready.png', filename: 'ready.png' } },
    send: async () => { throw new Error('响应中断') }
  })
  before.handleFileUpload({ target: { files: [{ name: 'ready.png', type: 'image/png', size: 1024 }], value: '' } })
  before.messageInput.value = '已上传附件'
  await before.sendMessage()
  const id = before.requests[0].clientMessageId
  before.dispose()
  const after = createComposer(t, {
    storage,
    uploadImage: async () => { uploads++; throw new Error('不应该重新上传') }
  })
  assert.equal(after.attachment.value.file, null)
  assert.equal(after.attachment.value.name, 'ready.png')
  assert.equal(after.attachment.value.preview, '/uploads/ready.png')
  assert.equal(after.activeAttempt.value.clientMessageId, id)
  await after.sendMessage()
  assert.equal(after.requests[0].clientMessageId, id)
  assert.equal(after.requests[0].image, '/uploads/ready.png')
  assert.equal(uploads, 1)
  assert.equal(after.attachment.value, null)
  assert.deepEqual(after.revoked, [], '服务器 URL 不作为 Blob URL 撤销')
})

test('存储失败仍在当前页面沿用编号，界面暴露无法跨刷新保留的状态', async t => {
  const storage = { getItem() { throw new Error('denied') }, setItem() { throw new Error('quota') }, removeItem() { throw new Error('denied') } }
  const composer = createComposer(t, { storage, send: async () => { throw new Error('offline') } })
  composer.messageInput.value = '页面内重试'
  await composer.sendMessage()
  assert.equal(composer.attemptPersisted.value, false)
  await composer.sendMessage()
  assert.equal(composer.requests[0].clientMessageId, composer.requests[1].clientMessageId)
  composer.serverStore.currentChannel = { type: 'text', id: 'channel-b', name: 'B' }
  composer.serverStore.currentChannel = { type: 'text', id: 'channel-a', name: 'A' }
  assert.equal(composer.attemptPersisted.value, false)
  assert.equal(composer.activeAttempt.value.clientMessageId, composer.requests[0].clientMessageId)
})

test('409 或 410 不自动换编号重发，用户修改内容后才建立新尝试', async t => {
  for (const status of [409, 410]) {
    const composer = createComposer(t, { send: async () => { throw Object.assign(new Error('原提交已不可用'), { status }) } })
    composer.messageInput.value = '原消息'
    await composer.sendMessage()
    const firstId = composer.requests[0].clientMessageId
    assert.equal(composer.terminalFailure.value, true)
    assert.equal(composer.canSend.value, false)
    await composer.sendMessage()
    assert.equal(composer.requests.length, 1)
    composer.messageInput.value = '新的消息'
    assert.equal(composer.terminalFailure.value, false)
    assert.equal(composer.canSend.value, true)
    await composer.sendMessage()
    assert.notEqual(composer.requests[1].clientMessageId, firstId)
  }
})

test('发送等待时编辑的草稿使用新编号，旧确认结果不能清空它', async t => {
  const request = deferred()
  let sends = 0
  const composer = createComposer(t, { send: data => ++sends === 1 ? request.promise : Promise.resolve({ message: { id: 'new', channelId: data.channelId } }) })
  composer.messageInput.value = '原文'
  const sending = composer.sendMessage()
  const id = composer.requests[0].clientMessageId
  composer.messageInput.value = '新草稿'
  request.resolve({ message: { id: 'old', channelId: 'channel-a' } })
  await sending
  assert.equal(composer.messageInput.value, '新草稿')
  await composer.sendMessage()
  assert.notEqual(composer.requests[1].clientMessageId, id)
})

test('组件销毁后的迟到确认不能清除重挂组件中新编辑的草稿', async t => {
  const storage = new MemoryStorage()
  const request = deferred()
  const before = createComposer(t, { storage, send: () => request.promise })
  before.messageInput.value = '原消息'
  const sending = before.sendMessage()
  before.dispose()
  const after = createComposer(t, { storage })
  after.messageInput.value = '新组件的新草稿'
  request.resolve({ message: { id: 'old', channelId: 'channel-a' } })
  await sending
  assert.equal(after.messageInput.value, '新组件的新草稿')
  assert.equal(drafts.readChatDraft(storage, 'user-a', 'channel-a').text, '新组件的新草稿')
})

test('上传等待期间退出再登录同账号，也不会用新会话发送旧任务', async t => {
  const upload = deferred()
  const composer = createComposer(t, { uploadImage: () => upload.promise })
  composer.handleFileUpload({ target: { files: [{ name: 'old.png', type: 'image/png', size: 1024 }], value: '' } })
  const sending = composer.sendMessage()
  composer.authStore.user = null
  composer.authStore.user = { id: 'user-a' }
  upload.resolve({ url: '/uploads/old.png' })
  await sending
  assert.equal(composer.requests.length, 0)
  assert.equal(composer.activeAttempt.value, null)
})

test('HTTP 成功但确认对象缺失、提交编号不匹配或序号无效时保留原编号', async t => {
  const invalidResponses = [
    () => ({}),
    () => ({ message: null }),
    () => ({ message: {} }),
    data => ({ message: { id: ' ', channelId: data.channelId, clientMessageId: data.clientMessageId, sequence: 1 } }),
    data => ({ message: { id: 'ack', channelId: data.channelId, clientMessageId: 'another-attempt', sequence: 1 } }),
    data => ({ message: { id: 'ack', channelId: 'other-channel', clientMessageId: data.clientMessageId, sequence: 1 } }),
    data => ({ message: { id: 'ack', channelId: data.channelId, clientMessageId: data.clientMessageId, sequence: 0 } }),
    data => ({ message: { id: 'ack', channelId: data.channelId, clientMessageId: data.clientMessageId, sequence: 1.5 } })
  ]
  for (const invalid of invalidResponses) {
    let sends = 0
    const composer = createComposer(t, {
      rawResponse: true,
      send: async data => ++sends === 1 ? invalid(data) : { message: { id: 'ok', channelId: data.channelId, clientMessageId: data.clientMessageId, sequence: 1 } }
    })
    composer.messageInput.value = '需要有效确认'
    await composer.sendMessage()
    assert.equal(composer.messageInput.value, '需要有效确认')
    assert.equal(composer.acknowledgements.length, 0)
    assert.equal(composer.sendNotice.value, '')
    assert.ok(composer.sendError.value.includes('服务器尚未确认消息'))
    const id = composer.requests[0].clientMessageId
    await composer.sendMessage()
    assert.equal(composer.requests[1].clientMessageId, id)
    assert.equal(composer.messageInput.value, '')
    assert.equal(composer.acknowledgements.length, 1)
  }
})

function focusMentionInput(composer, text, start = text.length, end = start) {
  composer.messageInput.value = text
  composer.textareaRef.value = { selectionStart: start, selectionEnd: end, style: {}, scrollHeight: 24,
    focus() {}, setSelectionRange(nextStart, nextEnd) { this.selectionStart = nextStart; this.selectionEnd = nextEnd } }
  composer.handleComposerFocus()
}

test('候选Enter只选择实际成员不发送，同昵称通过用户名区分且不会列出其他服务器', async t => {
  const composer = createComposer(t)
  focusMentionInput(composer, '@小')
  assert.deepEqual(composer.mentionSuggestions.value.map(user => user.id), ['user-a', 'user-b'])
  let prevented = 0
  composer.handleKeydown({ key: 'ArrowDown', preventDefault() { prevented++ } })
  composer.handleKeydown({ key: 'Enter', preventDefault() { prevented++ } })
  assert.equal(prevented, 2)
  assert.equal(composer.requests.length, 0)
  assert.equal(composer.messageInput.value, '@小明 ')
  assert.deepEqual(JSON.parse(JSON.stringify(composer.mentionSpans.value)), [{ start: 0, end: 3, userId: 'user-b' }])
  await composer.sendMessage()
  assert.equal(composer.requests[0].content, '<@user-b>')
  assert.deepEqual(composer.requests[0].mentions, ['user-b'])
})

test('提及菜单Escape、选区、失焦和IME组合输入不会错误选择或发送', async t => {
  const composer = createComposer(t)
  focusMentionInput(composer, '@小')
  composer.handleKeydown({ key: 'Escape', preventDefault() {} })
  assert.equal(composer.mentionMenuOpen.value, false)
  composer.handleCaretChange()
  assert.equal(composer.mentionMenuOpen.value, false)
  composer.handleComposerInput()
  assert.equal(composer.mentionMenuOpen.value, true)
  composer.startMentionComposition()
  composer.handleKeydown({ key: 'Enter', isComposing: false, preventDefault() { throw new Error('IME must not select') } })
  assert.equal(composer.requests.length, 0)
  assert.equal(composer.mentionMenuOpen.value, false)
  composer.endMentionComposition()
  await vue.nextTick()
  assert.equal(composer.mentionMenuOpen.value, true)
  composer.textareaRef.value.selectionStart = 0
  composer.handleCaretChange()
  assert.equal(composer.mentionMenuOpen.value, false)
  composer.textareaRef.value.selectionStart = 2
  composer.handleComposerFocus()
  composer.handleComposerBlur()
  composer.applyMentionChoice({ id: 'user-b', username: 'Bob', nickname: '小明' })
  assert.equal(composer.messageInput.value, '@小')
})

test('所有人候选受成员角色权限控制，手写独立token仍送服务器检查', async t => {
  const composer = createComposer(t)
  composer.serverStore.currentServer.ownerId = 'else'
  focusMentionInput(composer, '@every')
  assert.equal(composer.mentionSuggestions.value.length, 0)
  composer.serverStore.roles.push({ id: 'default', serverId: 'server', isDefault: true, permissions: { mentionEveryone: true } })
  assert.equal(composer.mentionSuggestions.value[0].id, 'everyone')
  composer.messageInput.value = '你好，@everyone。'
  await composer.sendMessage()
  assert.equal(composer.requests[0].mentionEveryone, true)
})

test('选择成员后刷新继续同编号重试，修改同昵称身份也不能被迟到确认清空', async t => {
  const storage = new MemoryStorage()
  const before = createComposer(t, { storage, send: async () => { throw new Error('offline') } })
  focusMentionInput(before, '@小')
  before.applyMentionChoice(before.mentionSuggestions.value[1])
  await before.sendMessage()
  const id = before.requests[0].clientMessageId
  before.dispose()
  const request = deferred()
  const after = createComposer(t, { storage, send: () => request.promise })
  assert.equal(after.activeAttempt.value.clientMessageId, id)
  assert.equal(after.mentionSpans.value[0].userId, 'user-b')
  const sending = after.sendMessage()
  assert.equal(after.requests[0].clientMessageId, id)
  after.mentionSpans.value = [{ start: 0, end: 3, userId: 'user-a' }]
  request.resolve({ message: { id: 'old', channelId: 'channel-a' } })
  await sending
  assert.equal(after.messageInput.value, '@小明 ')
  assert.equal(after.mentionSpans.value[0].userId, 'user-a')
  assert.equal(drafts.readChatDraft(storage, 'user-a', 'channel-a').mentionSpans[0].userId, 'user-a')
})

test('成员ID替换后的wire长度过长时保留草稿并明确阻止发送', async t => {
  const composer = createComposer(t)
  composer.messageInput.value = '@a' + 'x'.repeat(drafts.MAX_DRAFT_LENGTH - 2)
  composer.mentionSpans.value = [{ start: 0, end: 2, userId: 'long-user-id' }]
  await composer.sendMessage()
  assert.equal(composer.requests.length, 0)
  assert.equal(composer.messageInput.value.length, drafts.MAX_DRAFT_LENGTH)
  assert.ok(composer.sendError.value.includes('消息过长'))
})

test('精确输入选区删除第一个同名标签后仍发送第二人的身份', async t => {
  const composer = createComposer(t)
  composer.messageInput.value = '@小明 @小明'
  composer.mentionSpans.value = [{ start: 0, end: 3, userId: 'user-a' }, { start: 4, end: 7, userId: 'user-b' }]
  composer.recordMentionEdit({ target: { value: composer.messageInput.value, selectionStart: 0, selectionEnd: 4 }, inputType: 'deleteContentForward' })
  composer.messageInput.value = '@小明'
  await composer.sendMessage()
  assert.equal(composer.requests[0].content, '<@user-b>')
  assert.deepEqual(composer.requests[0].mentions, ['user-b'])
})

test('粘贴相同名字覆盖选中标签仍取消原身份，不能靠文字不变保留提醒', async t => {
  const composer = createComposer(t)
  composer.messageInput.value = '@小明'
  composer.mentionSpans.value = [{ start: 0, end: 3, userId: 'user-b' }]
  composer.recordMentionEdit({ target: { value: composer.messageInput.value, selectionStart: 0, selectionEnd: 3 }, inputType: 'insertFromPaste' })
  composer.handleComposerInput()
  await composer.sendMessage()
  assert.equal(composer.requests[0].content, '@小明')
  assert.equal(composer.requests[0].mentions, undefined)
})

test('成员实时离开后的空候选不会误选，空白昵称回退到用户名', async t => {
  const composer = createComposer(t)
  focusMentionInput(composer, '@B')
  composer.applyMentionChoice(undefined)
  assert.equal(composer.messageInput.value, '@B')
  composer.serverStore.members[1].user.nickname = '   '
  focusMentionInput(composer, '@B')
  composer.applyMentionChoice(composer.mentionSuggestions.value[0])
  assert.equal(composer.messageInput.value, '@Bob ')
  await composer.sendMessage()
  assert.equal(composer.requests[0].content, '<@user-b>')
})

test('回复摘要显示提及昵称而不暴露wire标记', t => {
  const composer = createComposer(t)
  composer.setReply({ id: 'mentioned', content: '请 <@user-b> 看看', user: { username: 'Alice' }, mentionUsers: [{ id: 'user-b', username: 'Bob', nickname: '小明' }] })
  assert.equal(composer.replyTo.value.content, '请 @小明 看看')
})
