import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'

const component = readFileSync(new URL('../frontend/src/components/MessageReactions.vue', import.meta.url), 'utf8')
const script = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const compiled = ts.transpileModule(`${script}\nglobalThis.reactions = { props, reactions, pending, error, failedAction, canReact, selectedEmoji, participantNames, rootRef, membersButtonRef, toggleReaction, retryReaction, setReaction, showMembers, closeMembers, closePicker, handleKeydown, hasReacted };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function createReactions(t, options = {}) {
  const message = { id: 'message-a', channelId: 'channel-a', userId: 'me', content: '测试', revision: 1, reactions: [{ emoji: '👍', userIds: ['other'], users: [{ id: 'other', username: '旧名字' }] }] }
  const props = vue.reactive({ message, pickerOpen: true })
  const auth = vue.reactive({ user: { id: 'me' } })
  const server = vue.reactive({
    currentServer: { id: 'server-a', ownerId: 'owner' },
    currentChannel: { id: 'channel-a', serverId: 'server-a' },
    members: [{ serverId: 'server-a', userId: 'me', roles: ['writer'], muted: false }, { serverId: 'server-a', userId: 'other', roles: [], user: { id: 'other', nickname: '南风', username: 'other' } }],
    roles: [{ id: 'everyone', serverId: 'server-a', isDefault: true, permissions: { viewChannel: true, sendMessage: false } }, { id: 'writer', serverId: 'server-a', permissions: { sendMessage: true } }]
  })
  const updates = []
  const chat = vue.reactive({
    currentChannelId: 'channel-a', messages: [message],
    updateMessage(id, result) {
      const index = this.messages.findIndex(item => item.id === id)
      if (index < 0 || result.revision < this.messages[index].revision) return
      updates.push(result)
      this.messages[index] = { ...this.messages[index], ...result }
      props.message = this.messages[index]
    }
  })
  const requests = []
  const emitted = []
  const hooks = []
  const storage = { value: 'session-a', getItem() { return this.value } }
  const context = {
    exports: {}, console,
    defineProps: () => props,
    defineEmits: () => (...args) => emitted.push(args),
    window: { localStorage: storage },
    require(name) {
      if (name === 'vue') return { ...vue, onUnmounted: hook => hooks.push(hook) }
      if (name === '../stores/auth') return { useAuthStore: () => auth }
      if (name === '../stores/chat') return { useChatStore: () => chat }
      if (name === '../stores/server') return { useServerStore: () => server }
      if (name === '../utils/api') return { api: { async setMessageReaction(...args) { requests.push(args); return options.request ? options.request(...args) : { message: { ...props.message, revision: props.message.revision + 1 } } } } }
      throw new Error(`Unexpected import ${name}`)
    }
  }
  const scope = vue.effectScope()
  scope.run(() => vm.runInNewContext(compiled, context, { filename: 'MessageReactions.vue' }))
  let disposed = false
  const dispose = () => { if (disposed) return; disposed = true; hooks.forEach(hook => hook()); scope.stop() }
  t.after(dispose)
  return { ...context.reactions, auth, chat, server, storage, requests, updates, emitted, dispose }
}

test('回应在服务端确认前保持计数，重复点击只发一次；旧版本回执不能覆盖较新的推送', async t => {
  const request = deferred()
  const ui = createReactions(t, { request: () => request.promise })
  const sending = ui.toggleReaction('👍')
  assert.equal(ui.pending.value, true)
  assert.equal(ui.reactions.value[0].userIds.length, 1)
  await ui.toggleReaction('❤️')
  assert.deepEqual(ui.requests, [['message-a', '👍', true]])
  ui.chat.updateMessage('message-a', { ...ui.props.message, revision: 3, reactions: [{ emoji: '👍', userIds: ['other', 'third'] }] })
  request.resolve({ message: { ...ui.props.message, revision: 2, reactions: [{ emoji: '👍', userIds: ['other', 'me'] }] } })
  await sending
  assert.equal(ui.props.message.revision, 3)
  assert.deepEqual(Array.from(ui.reactions.value[0].userIds), ['other', 'third'])
  assert.equal(ui.pending.value, false)
  assert.deepEqual(ui.emitted, [['close-picker']])
})

test('失败保留服务端计数，重试发送原目标状态，期间收到推送也不会反向切换', async t => {
  let count = 0
  const ui = createReactions(t, { request: async () => { if (++count === 1) throw new Error('暂时无法连接'); return { message: { ...ui.props.message, revision: 3 } } } })
  await ui.toggleReaction('👍')
  assert.equal(ui.error.value, '暂时无法连接')
  assert.equal(ui.failedAction.value.active, true)
  assert.equal(ui.reactions.value[0].userIds.length, 1)
  ui.chat.updateMessage('message-a', { ...ui.props.message, revision: 2, reactions: [{ emoji: '👍', userIds: ['other', 'me'] }] })
  await ui.retryReaction()
  assert.deepEqual(ui.requests, [['message-a', '👍', true], ['message-a', '👍', true]])
  assert.equal(ui.error.value, '')
  assert.equal(ui.failedAction.value, null)
  assert.equal(ui.pending.value, false)
})

test('切换账号或只更换登录 token 后，迟到的回应回执和失败信息不进入当前会话', async t => {
  for (const kind of ['account', 'token']) {
    const request = deferred()
    const ui = createReactions(t, { request: () => request.promise })
    const sending = ui.toggleReaction('👍')
    if (kind === 'account') ui.auth.user = { id: 'another' }
    else ui.storage.value = 'session-b'
    request.resolve({ message: { ...ui.props.message, revision: 2 } })
    await sending
    assert.equal(ui.updates.length, 0, kind)
    assert.equal(ui.error.value, '', kind)
    assert.equal(ui.emitted.length, 0, kind)
  }
  const request = deferred()
  const ui = createReactions(t, { request: () => request.promise })
  const sending = ui.toggleReaction('👍')
  ui.auth.user = { id: 'another' }
  request.reject(new Error('旧会话错误'))
  await sending
  assert.equal(ui.error.value, '')
  assert.equal(ui.failedAction.value, null)
})

test('切频道再返回、复用组件到另一条消息、删除消息及卸载均丢弃在途请求', async t => {
  for (const kind of ['channel-roundtrip', 'message', 'delete', 'unmount']) {
    const request = deferred()
    const ui = createReactions(t, { request: () => request.promise })
    const original = { ...ui.props.message }
    const sending = ui.toggleReaction('👍')
    if (kind === 'channel-roundtrip') {
      ui.server.currentChannel = { id: 'channel-b', serverId: 'server-a' }
      ui.server.currentChannel = { id: 'channel-a', serverId: 'server-a' }
    } else if (kind === 'message') ui.props.message = { ...original, id: 'message-b' }
    else if (kind === 'delete') ui.chat.messages = []
    else ui.dispose()
    request.resolve({ message: { ...original, revision: 2 } })
    await sending
    assert.equal(ui.updates.length, 0, kind)
    assert.equal(ui.emitted.length, 0, kind)
  }
})

test('按默认角色与成员角色取权限并集，禁言或离开成员列表立即阻止回应', async t => {
  const ui = createReactions(t)
  assert.equal(ui.canReact.value, true)
  ui.server.members[0].muted = true
  assert.equal(ui.canReact.value, false)
  await ui.toggleReaction('👍')
  assert.equal(ui.requests.length, 0)
  ui.server.members[0].muted = false
  ui.server.roles[0].permissions.viewChannel = false
  assert.equal(ui.canReact.value, false)
  ui.server.currentServer.ownerId = 'me'
  assert.equal(ui.canReact.value, true)
  ui.server.members = ui.server.members.filter(member => member.userId !== 'me')
  assert.equal(ui.canReact.value, false)
})

test('成员名单使用最新昵称、公开回应用户作兜底，重复用户只计一次', async t => {
  const ui = createReactions(t)
  ui.props.message.reactions = [{ emoji: '👍', userIds: ['other', 'other', 'departed', 'missing'], users: [{ id: 'other', username: '旧名字' }, { id: 'departed', nickname: '已离开的朋友' }] }]
  ui.showMembers()
  assert.equal(ui.reactions.value[0].userIds.length, 3)
  assert.deepEqual(Array.from(ui.participantNames.value, user => user.name), ['南风', '已离开的朋友', '已离开的成员'])
  ui.props.message.reactions = []
  await vue.nextTick()
  assert.equal(ui.selectedEmoji.value, null)
})

test('Escape 关闭选择器或成员名单并恢复可用焦点', async t => {
  const ui = createReactions(t)
  let focused = ''
  ui.rootRef.value = { closest: () => ({ querySelector: () => ({ focus: () => { focused = 'message' } }) }), querySelector: () => null }
  ui.membersButtonRef.value = { focus: () => { focused = 'members' } }
  const event = () => ({ key: 'Escape', prevented: false, stopped: false, preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true } })
  const pickerEvent = event()
  ui.handleKeydown(pickerEvent)
  await vue.nextTick()
  assert.equal(pickerEvent.prevented, true)
  assert.equal(pickerEvent.stopped, true)
  assert.deepEqual(ui.emitted, [['close-picker']])
  assert.equal(focused, 'message')
  ui.props.pickerOpen = false
  ui.showMembers()
  ui.handleKeydown(event())
  await vue.nextTick()
  assert.equal(ui.selectedEmoji.value, null)
  assert.equal(focused, 'members')
})

test('不相关的消息回执显示可重试错误，且不会更新任何消息', async t => {
  const ui = createReactions(t, { request: async () => ({ message: { id: 'wrong', channelId: 'channel-b', revision: 2 } }) })
  await ui.toggleReaction('👍')
  assert.equal(ui.updates.length, 0)
  assert.equal(ui.error.value, '回应结果无效，请重试')
  assert.equal(ui.failedAction.value.emoji, '👍')
  assert.equal(ui.pending.value, false)
})
