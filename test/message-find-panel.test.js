import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as Vue from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import * as contentFormat from '../frontend/src/utils/escape.ts'

const source = readFileSync(new URL('../frontend/src/components/MessageFindPanel.vue', import.meta.url), 'utf8')
const script = compileScript(parse(source).descriptor, { id: 'message-find-panel-test' }).content
const code = ts.transpileModule(script, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText
const settle = async () => { await Vue.nextTick(); await new Promise(resolve => setImmediate(resolve)); await Vue.nextTick() }
const message = (id, sequence, extra = {}) => ({
  id, sequence, channelId: 'text-a', userId: 'author-a', content: '会议记录', fileName: null,
  createdAt: '2026-10-09T01:00:00.000Z', user: { nickname: '蓝鲸' }, ...extra
})
const pin = (id, sequence, extra = {}) => message(id, sequence, {
  pin: { userId: 'author-a', createdAt: '2026-10-09T01:10:00.000Z' }, ...extra
})
const snapshot = value => JSON.parse(JSON.stringify(value))

function createHarness(mode = 'search') {
  const requests = []
  const subscriptions = new Map()
  const reconnectHandlers = new Set()
  const timers = new Map()
  const emitted = []
  let nextTimer = 0
  let token = 'token-a'
  const auth = Vue.reactive({ user: { id: 'account-a' } })
  const server = Vue.reactive({ currentChannel: { id: 'text-a', name: '综合讨论' }, members: [] })
  const props = Vue.reactive({ mode, channelId: 'text-a' })
  let document
  class FakeElement {
    isConnected = true
    hidden = false
    children = []
    constructor(name) { this.name = name; Vue.markRaw(this) }
    focus() { document.activeElement = this }
    contains(element) { return element === this || this.children.some(child => child.contains(element)) }
    getAttribute() { return null }
    querySelectorAll() { return this.children }
  }
  const opener = new FakeElement('opener')
  document = { activeElement: opener, body: new FakeElement('body') }
  const panel = new FakeElement('panel')
  const close = new FakeElement('close')
  const search = new FakeElement('search')
  const last = new FakeElement('last')
  panel.children = mode === 'search' ? [close, search, last] : [close, last]
  const request = (type, channelId, options) => new Promise((resolve, reject) => requests.push({ type, channelId, options: snapshot(options), resolve, reject }))
  const ws = {
    on(type, callback) {
      if (!subscriptions.has(type)) subscriptions.set(type, new Set())
      subscriptions.get(type).add(callback)
    },
    off(type, callback) { subscriptions.get(type)?.delete(callback) },
    onReconnect(callback) { reconnectHandlers.add(callback) },
    offReconnect(callback) { reconnectHandlers.delete(callback) }
  }
  const dependencies = {
    vue: Vue,
    '../stores/auth': { useAuthStore: () => auth },
    '../stores/server': { useServerStore: () => server },
    '../utils/api': { api: {
      getPinnedMessages: id => request('pins', id, {}),
      searchMessages: (id, options) => request('search', id, options)
    } },
    '../utils/ws': { ws },
    '../utils/escape': contentFormat,
    '../styles/message-find.css': {}
  }
  const globals = {
    exports: {}, console, document, HTMLElement: FakeElement,
    localStorage: { getItem: () => token },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    require(name) { assert.ok(dependencies[name], `Unexpected dependency ${name}`); return dependencies[name] }
  }
  vm.runInNewContext(`(function () {\n${code}\n})()`, globals)
  const Component = globals.exports.default
  Component.render = () => Vue.h('div')
  let instance
  const originalSetup = Component.setup
  Component.setup = (componentProps, context) => { instance = Vue.getCurrentInstance(); return originalSetup(componentProps, context) }
  const node = () => ({ children: [], parent: null })
  const renderer = Vue.createRenderer({
    createElement: node, createText: node, createComment: node,
    insert(child, parent) { child.parent = parent; parent.children.push(child) },
    remove(child) { child.parent.children.splice(child.parent.children.indexOf(child), 1) },
    parentNode: child => child.parent, nextSibling: () => null,
    setText() {}, setElementText() {}, patchProp() {}
  })
  const app = renderer.createApp({ render: () => Vue.h(Component, { ...props, onClose: () => emitted.push('close'), onLocate: id => emitted.push(id) }) })
  app.mount(node())
  const state = instance.setupState
  state.panelRef = panel
  state.closeRef = close
  state.searchRef = search
  return {
    state, props, auth, server, requests, subscriptions, reconnectHandlers, timers, document, opener, panel, close, search, last, emitted,
    setToken(value) { token = value },
    push(type, data) { for (const handler of subscriptions.get(type) || []) handler(data) },
    reconnect() { for (const handler of reconnectHandlers) handler() },
    runTimers() { for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback() } },
    unmount() { app.unmount() }
  }
}

test('搜索按提交时的查询分页，去重结果并拒绝重复游标', async () => {
  const h = createHarness()
  try {
    h.state.keyword = '  会议  '
    h.state.submitSearch()
    assert.deepEqual(h.requests[0].options, { q: '会议', authorId: '', limit: 20 })
    h.state.keyword = '尚未提交的修改'
    h.requests[0].resolve({ messages: [message('new', 20), message('old', 10)], hasMore: true, nextBefore: 'old' })
    await settle()
    assert.equal(h.state.messages.length, 2)
    const pagination = h.state.runSearch(true)
    assert.deepEqual(h.requests[1].options, { q: '会议', authorId: '', before: 'old', limit: 20 })
    h.requests[1].resolve({ messages: [message('old', 10), message('earlier', 5)], hasMore: true, nextBefore: 'old' })
    await pagination
    assert.deepEqual(snapshot(h.state.messages.map(item => item.id)), ['new', 'old', 'earlier'])
    assert.equal(h.state.hasMore, false)
  } finally { h.unmount() }
})

test('仅发送者筛选有效，空条件不会发送搜索请求', async () => {
  const h = createHarness()
  try {
    h.state.submitSearch()
    assert.equal(h.requests.length, 0)
    assert.match(h.state.error, /请输入关键词/)
    h.state.authorId = 'author-a'
    h.state.submitSearch()
    assert.deepEqual(h.requests[0].options, { q: '', authorId: 'author-a', limit: 20 })
    h.requests[0].resolve({ messages: [message('author', 1, { content: '任意内容' })], hasMore: false })
    await settle()
    assert.equal(h.state.messages.length, 1)
  } finally { h.unmount() }
})

test('后来提交的搜索覆盖旧请求，分页响应不能污染新的查询', async () => {
  const h = createHarness()
  try {
    h.state.keyword = '会议'
    h.state.submitSearch()
    h.requests[0].resolve({ messages: [message('old', 10)], hasMore: true, nextBefore: 'old' })
    await settle()
    const page = h.state.runSearch(true)
    h.state.keyword = '发布'
    h.state.submitSearch()
    h.requests[2].resolve({ messages: [message('release', 30, { content: '发布计划' })], hasMore: false })
    h.requests[1].resolve({ messages: [message('late-page', 5)], hasMore: false })
    await page
    await settle()
    assert.deepEqual(snapshot(h.state.messages.map(item => item.id)), ['release'])
    assert.equal(h.state.loading, false)
  } finally { h.unmount() }
})

test('频道及账号切换清空结果，并忽略原请求的响应与错误', async () => {
  const h = createHarness('pins')
  try {
    h.props.channelId = 'text-b'
    h.server.currentChannel = { id: 'text-b', name: '新频道' }
    await settle()
    assert.equal(h.requests[1].channelId, 'text-b')
    h.requests[0].resolve({ pins: [pin('previous-channel', 1)] })
    h.requests[1].resolve({ pins: [pin('current-channel', 2, { channelId: 'text-b' })] })
    await settle()
    assert.deepEqual(snapshot(h.state.messages.map(item => item.id)), ['current-channel'])
    h.state.loadPins()
    h.auth.user = null
    h.setToken(null)
    h.requests[2].reject(new Error('旧账号失败'))
    await settle()
    assert.deepEqual(snapshot(h.state.messages), [])
    assert.equal(h.state.error, '')
    assert.equal(h.state.loading, false)
  } finally { h.unmount() }
})

test('搜索中的编辑与删除推送覆盖迟到页面，其他频道被忽略', async () => {
  const h = createHarness()
  try {
    h.state.keyword = '会议'
    h.state.submitSearch()
    h.push('message-updated', { channelId: 'text-a', message: message('edited', 3, { content: '已编辑的会议内容' }) })
    h.push('message-deleted', { channelId: 'text-a', messageId: 'deleted' })
    h.push('message-deleted', { channelId: 'text-other', messageId: 'untouched' })
    h.requests[0].resolve({ messages: [message('deleted', 4), message('edited', 3), message('untouched', 2)], hasMore: false })
    await settle()
    assert.deepEqual(snapshot(h.state.messages.map(item => item.id)), ['edited', 'untouched'])
    assert.equal(h.state.messages[0].content, '已编辑的会议内容')
    h.push('message-updated', { channelId: 'text-a', message: message('edited', 3, { content: '不再匹配' }) })
    assert.deepEqual(snapshot(h.state.messages.map(item => item.id)), ['untouched'])
  } finally { h.unmount() }
})

test('置顶推送合并刷新且重连重新获取完整服务端状态', async () => {
  const h = createHarness('pins')
  try {
    h.requests[0].resolve({ pins: [pin('first', 3)] })
    await settle()
    h.push('message-updated', { channelId: 'text-a', message: pin('first', 3, { content: '推送的新内容' }) })
    h.push('message-updated', { channelId: 'text-a', message: pin('second', 4) })
    assert.equal(h.timers.size, 1)
    h.runTimers()
    assert.equal(h.requests.length, 2)
    h.push('message-updated', { channelId: 'text-a', message: pin('first', 3, { content: '推送的新内容' }) })
    h.requests[1].resolve({ pins: [pin('second', 4), pin('first', 3)] })
    await settle()
    assert.equal(h.state.messages.find(item => item.id === 'first').content, '推送的新内容')
    h.reconnect()
    h.requests[2].resolve({ pins: [pin('first', 3, { content: '断线期间的新内容' })] })
    await settle()
    assert.equal(h.state.messages[0].content, '断线期间的新内容')
  } finally { h.unmount() }
})

test('面板关闭时移除监听与计时器，迟到请求不恢复结果', async () => {
  const h = createHarness('pins')
  h.push('message-updated', { channelId: 'text-a', message: pin('updated', 1) })
  assert.equal(h.timers.size, 1)
  h.unmount()
  assert.ok([...h.subscriptions.values()].every(handlers => handlers.size === 0))
  assert.equal(h.reconnectHandlers.size, 0)
  assert.equal(h.timers.size, 0)
  h.requests[0].resolve({ pins: [pin('late', 1)] })
  await settle()
  assert.deepEqual(snapshot(h.state.messages), [])
})

test('初始焦点、Tab/Escape 与关闭恢复焦点生效，定位焦点不被覆盖', async () => {
  const h = createHarness()
  await settle()
  assert.equal(h.document.activeElement, h.search)
  let prevented = 0
  const key = (key, shiftKey = false) => h.state.handleKeydown({ key, shiftKey, preventDefault() { prevented++ }, stopPropagation() {} })
  h.close.focus()
  key('Tab', true)
  assert.equal(h.document.activeElement, h.last)
  key('Tab')
  assert.equal(h.document.activeElement, h.close)
  key('Escape')
  assert.deepEqual(h.emitted, ['close'])
  assert.equal(prevented, 3)
  h.unmount()
  await settle()
  assert.equal(h.document.activeElement, h.opener)

  const located = createHarness('pins')
  await settle()
  assert.equal(located.document.activeElement, located.close)
  located.unmount()
  // A parent may focus the located row as the panel is removed. The panel must not
  // take that focus back during its deferred restoration.
  located.last.focus()
  await settle()
  assert.equal(located.document.activeElement, located.last)
})

test('新 revision 胜过迟到推送，下一次刷新清除旧日志', async () => {
  const h = createHarness('pins')
  try {
    h.push('message-updated', { channelId: 'text-a', message: pin('versioned', 4, { revision: 2, content: '旧推送' }) })
    h.requests[0].resolve({ pins: [pin('versioned', 4, { revision: 3, content: '新快照' })] })
    await settle()
    assert.equal(h.state.messages[0].content, '新快照')
    h.push('message-updated', { channelId: 'text-a', message: pin('versioned', 4, { revision: 1, content: '迟到推送' }) })
    assert.equal(h.state.messages[0].content, '新快照')
    const refreshed = h.state.loadPins()
    h.requests[1].resolve({ pins: [pin('versioned', 4, { revision: 4, content: '再次刷新' })] })
    await refreshed
    assert.equal(h.state.messages[0].content, '再次刷新')
  } finally { h.unmount() }
})

test('token 改变后原请求不展示消息，重连使用已提交查询', async () => {
  const h = createHarness()
  try {
    h.state.keyword = '会议'
    h.state.submitSearch()
    h.setToken('token-b')
    h.requests[0].resolve({ messages: [message('old-session', 4)], hasMore: false })
    await settle()
    assert.deepEqual(snapshot(h.state.messages), [])
    h.state.keyword = '未提交草稿'
    h.reconnect()
    assert.equal(h.requests[1].options.q, '会议')
    h.requests[1].resolve({ messages: [message('new-session', 5)], hasMore: false })
    await settle()
    assert.deepEqual(snapshot(h.state.messages.map(item => item.id)), ['new-session'])
    assert.equal(h.state.loading, false)
  } finally { h.unmount() }
})

test('分页失败保留当前结果，显示错误并允许重试', async () => {
  const h = createHarness()
  try {
    h.state.keyword = '会议'
    h.state.submitSearch()
    h.requests[0].resolve({ messages: [message('visible', 4)], hasMore: true, nextBefore: 'visible' })
    await settle()
    const page = h.state.runSearch(true)
    h.requests[1].reject(new Error('离线'))
    await page
    assert.deepEqual(snapshot(h.state.messages.map(item => item.id)), ['visible'])
    assert.ok(h.state.error)
    assert.equal(h.state.loadingMore, false)
    const retry = h.state.runSearch(true)
    h.requests[2].resolve({ messages: [message('earlier', 2)], hasMore: false })
    await retry
    assert.deepEqual(snapshot(h.state.messages.map(item => item.id)), ['visible', 'earlier'])
    assert.equal(h.state.error, '')
  } finally { h.unmount() }
})

test('定位期间结果按钮失去焦点后聚焦关闭按钮，Escape 仍可关闭面板', async () => {
  const h = createHarness()
  try {
    await settle()
    h.document.activeElement = h.document.body
    h.props.locating = true
    await settle()
    assert.equal(h.document.activeElement, h.close)
    const event = { key: 'Escape', preventDefault() {}, stopPropagation() {} }
    h.state.handleKeydown(event)
    assert.deepEqual(h.emitted, ['close'])
  } finally { h.unmount() }
})
