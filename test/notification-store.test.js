import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as Vue from 'vue'
import * as Pinia from 'pinia'

const code = ts.transpileModule(readFileSync(new URL('../frontend/src/stores/notifications.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText
const settle = () => new Promise(resolve => setImmediate(resolve))
const ids = store => Array.from(store.notifications, value => value.message.id)
const item = (id, sequence = 1, options = {}) => ({
  serverId: 'server-a', channelId: 'channel-a', reason: 'mention',
  message: { id, sequence, channelId: 'channel-a', userId: 'writer', content: id, createdAt: new Date(sequence * 1000).toISOString(), revision: 0 }, ...options
})
const page = (notifications, options = {}) => ({ notifications, totalCount: notifications.length, hasMore: false, nextBefore: null, ...options })

function harness() {
  const auth = Vue.reactive({ user: { id: 'reader' } })
  const readState = Vue.reactive({ states: {} })
  let token = 'reader-token'
  const listeners = new Map(), reconnects = new Set(), requests = [], prefRequests = [], prefWrites = []
  const ws = {
    on(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback) },
    off(type, callback) { listeners.get(type)?.delete(callback) },
    onReconnect(callback) { reconnects.add(callback) }, offReconnect(callback) { reconnects.delete(callback) }
  }
  const deferred = (list, args) => new Promise((resolve, reject) => list.push({ args, resolve, reject }))
  const api = {
    getNotifications: (...args) => deferred(requests, args),
    getNotificationPreference: (...args) => deferred(prefRequests, args),
    setNotificationPreference: (...args) => deferred(prefWrites, args)
  }
  const dependencies = { vue: Vue, pinia: Pinia, '../utils/api': { api }, '../utils/ws': { ws },
    './auth': { useAuthStore: () => auth }, './read-state': { useReadStateStore: () => readState } }
  const context = { exports: {}, console, queueMicrotask, localStorage: { getItem: () => token }, require(name) { assert.ok(dependencies[name], name); return dependencies[name] } }
  vm.runInNewContext(code, context)
  const pinia = Pinia.createPinia()
  Pinia.setActivePinia(pinia)
  const store = context.exports.useNotificationStore()
  const emit = (type, data) => { for (const callback of listeners.get(type) || []) callback({ type, ...data }) }
  return { store, auth, readState, requests, prefRequests, prefWrites, listeners, reconnects, emit,
    setToken(value) { token = value }, cleanup() { store.deactivate(); Pinia.disposePinia(pinia) } }
}

test('认证后从全部社区加载，快照请求期间的推送保留且重复事件不重复计数', async () => {
  const h = harness()
  try {
    h.store.activate()
    assert.deepEqual(h.requests[0].args, [50, undefined])
    h.emit('mention-notification', item('new', 2))
    h.emit('mention-notification', item('new', 2))
    h.requests[0].resolve(page([item('old')]))
    await settle()
    assert.deepEqual(ids(h.store), ['new', 'old'])
    assert.equal(h.store.unreadCount, 2)
  } finally { h.cleanup() }
})

test('其他会话的阅读状态会移除提醒，迟到的旧快照不能复活已读消息', async () => {
  const h = harness()
  try {
    h.store.activate()
    h.emit('mention-notification', item('read', 3))
    h.emit('read-state', { serverId: 'server-a', state: { channelId: 'channel-a', readSequence: 3 } })
    await settle()
    h.requests[0].resolve(page([item('read', 3)]))
    h.requests[1].resolve(page([item('read', 3)]))
    await settle()
    assert.equal(h.store.notifications.length, 0)
    assert.equal(h.store.unreadCount, 0)
  } finally { h.cleanup() }
})

test('已在 read store 合并的启动阅读游标阻止认证前排队通知进入收件箱', async () => {
  const h = harness()
  try {
    h.readState.states['channel-a'] = { readSequence: 5 }
    h.store.activate()
    h.emit('mention-notification', item('seen', 4))
    h.requests[0].resolve(page([item('seen', 4), item('fresh', 6)]))
    await settle()
    assert.deepEqual(ids(h.store), ['fresh'])
    assert.equal(h.store.unreadCount, 1)
  } finally { h.cleanup() }
})

test('删除推送防止旧 HTTP 快照复活，同一消息后续推送也不会重新加入', async () => {
  const h = harness()
  try {
    h.store.activate()
    h.emit('message-deleted', { messageId: 'deleted', channelId: 'channel-a' })
    await settle()
    h.requests[0].resolve(page([item('deleted')]))
    h.requests[1].resolve(page([item('deleted')]))
    h.emit('mention-notification', item('deleted'))
    await settle()
    assert.equal(h.store.notifications.length, 0)
    assert.equal(h.store.unreadCount, 0)
  } finally { h.cleanup() }
})

test('编辑失效事件刷新内容，合法的新修订可回到收件箱而旧请求失效', async () => {
  const h = harness()
  try {
    h.store.activate()
    h.emit('mention-notification', item('edited'))
    h.emit('mention-invalidated', { messageId: 'edited', channelId: 'channel-a' })
    assert.equal(h.store.notifications.length, 0)
    await settle()
    h.requests[0].resolve(page([item('edited')]))
    const updated = item('edited'); updated.message.revision = 1; updated.message.content = 'updated'
    h.requests[1].resolve(page([updated]))
    await settle()
    assert.equal(h.store.notifications[0].message.content, 'updated')
  } finally { h.cleanup() }
})

test('偏好跨会话同步，旧偏好 HTTP 响应不覆盖实时静音，旧通知快照被过滤', async () => {
  const h = harness()
  try {
    h.store.activate()
    const preference = h.store.loadPreference('channel-a')
    h.emit('notification-preference', { channelId: 'channel-a', mode: 'mute' })
    h.prefRequests[0].resolve({ mode: 'all' })
    await preference
    await settle()
    h.requests[0].resolve(page([item('ignored')]))
    h.requests[1].resolve(page([item('ignored')]))
    await settle()
    assert.equal(h.store.preferences['channel-a'], 'mute')
    assert.equal(h.store.notifications.length, 0)
  } finally { h.cleanup() }
})

test('仅提及偏好过滤一般消息，保存后收到 WS 回声不回退至旧响应', async () => {
  const h = harness()
  try {
    h.store.activate()
    h.requests[0].resolve(page([]))
    await settle()
    const save = h.store.setPreference('channel-a', 'mentions')
    h.emit('notification-preference', { channelId: 'channel-a', mode: 'mentions' })
    h.prefWrites[0].resolve({ mode: 'all' })
    await save
    h.emit('mention-notification', item('normal', 1, { reason: 'message' }))
    h.emit('mention-notification', item('direct', 2))
    assert.equal(h.store.preferences['channel-a'], 'mentions')
    assert.deepEqual(ids(h.store), ['direct'])
  } finally { h.cleanup() }
})

test('同一账号更换 token 后旧请求也不能改动新会话，登出移除监听和全部状态', async () => {
  const h = harness()
  try {
    h.store.activate()
    h.store.inboxOpen = true
    h.setToken('new-reader-token')
    h.store.activate()
    h.requests[0].resolve(page([item('old-session')]))
    h.requests[1].resolve(page([item('new-session')]))
    await settle()
    assert.deepEqual(ids(h.store), ['new-session'])
    h.store.deactivate()
    assert.equal(h.store.unreadCount, 0)
    assert.equal(h.store.inboxOpen, false)
    assert.ok([...h.listeners.values()].every(callbacks => callbacks.size === 0))
    assert.equal(h.reconnects.size, 0)
    h.emit('mention-notification', item('after-logout'))
    assert.equal(h.store.notifications.length, 0)
  } finally { h.cleanup() }
})

test('分页去重并使用服务端游标，断线重连刷新全社区并收起旧分页', async () => {
  const h = harness()
  try {
    h.store.activate()
    h.requests[0].resolve(page([item('latest', 3)], { totalCount: 3, hasMore: true, nextBefore: 3 }))
    await settle()
    const more = h.store.load(true)
    assert.deepEqual(h.requests[1].args, [50, 3])
    h.requests[1].resolve(page([item('latest', 3), item('older', 2)], { totalCount: 3, hasMore: true, nextBefore: 2 }))
    await more
    assert.deepEqual(ids(h.store), ['latest', 'older'])
    for (const callback of h.reconnects) callback()
    h.requests[2].resolve(page([item('latest', 3)]))
    await settle()
    assert.deepEqual(ids(h.store), ['latest'])
    assert.equal(h.store.hasMore, false)
  } finally { h.cleanup() }
})

test('查看通知只保存导航目标，不自动清已读或清空提醒', async () => {
  const h = harness()
  try {
    h.store.activate()
    h.requests[0].resolve(page([item('target')]))
    await settle()
    h.store.inboxOpen = true
    const target = h.store.notifications[0]
    assert.equal(h.store.requestNavigation(target), true)
    assert.equal(h.store.inboxOpen, false)
    assert.equal(h.store.pendingTarget.message.id, 'target')
    assert.equal(h.store.unreadCount, 1)
    assert.deepEqual(Object.keys(h.readState.states), [])
    h.store.finishNavigation(target, '无法访问')
    assert.equal(h.store.pendingTarget, null)
    assert.equal(h.store.inboxOpen, true)
    assert.equal(h.store.navigationError, '无法访问')
  } finally { h.cleanup() }
})

test('分页失败保留已有通知、解除加载状态并允许重试', async () => {
  const h = harness()
  try {
    h.store.activate()
    h.requests[0].resolve(page([item('latest', 3)], { totalCount: 2, hasMore: true, nextBefore: 3 }))
    await settle()
    const more = h.store.load(true)
    h.requests[1].reject(new Error('网络中断'))
    await assert.rejects(more, /网络中断/)
    assert.equal(h.store.notifications[0].message.id, 'latest')
    assert.equal(h.store.loadingMore, false)
    assert.equal(h.store.error, '网络中断')
    const retry = h.store.load(true)
    h.requests[2].resolve(page([item('older', 2)], { totalCount: 2 }))
    await retry
    assert.equal(h.store.notifications.length, 2)
  } finally { h.cleanup() }
})

test('分页期间到达的消息已计入服务端总数时，重新校准计数而保留旧分页', async () => {
  const h = harness()
  try {
    h.store.activate()
    h.requests[0].resolve(page([item('latest', 3)], { totalCount: 2, hasMore: true, nextBefore: 3 }))
    await settle()
    const more = h.store.load(true)
    h.emit('mention-notification', item('arrival', 4))
    h.requests[1].resolve(page([item('older', 2)], { totalCount: 3 }))
    await more
    assert.deepEqual(h.requests[2].args, [1])
    h.requests[2].resolve(page([item('arrival', 4)], { totalCount: 3 }))
    await settle()
    assert.equal(h.store.unreadCount, 3)
    assert.deepEqual(ids(h.store), ['arrival', 'latest', 'older'])
  } finally { h.cleanup() }
})

test('导航中的消息编辑保持定位目标，真正删除则取消并在通知面板报告', async () => {
  const h = harness()
  try {
    h.store.activate()
    h.requests[0].resolve(page([item('target')]))
    await settle()
    const target = h.store.notifications[0]
    h.store.requestNavigation(target)
    h.emit('mention-invalidated', { messageId: 'target', channelId: 'channel-a' })
    assert.equal(h.store.pendingTarget.message.id, 'target')
    h.emit('message-deleted', { messageId: 'target', channelId: 'channel-a' })
    assert.equal(h.store.pendingTarget, null)
    assert.equal(h.store.inboxOpen, true)
    assert.equal(h.store.navigationError, '这条消息已被删除')
  } finally { h.cleanup() }
})

test('全部提醒已读后丢弃迟到计数校准，相同阅读游标和后续空快照不触发刷新循环', async () => {
  const h = harness()
  try {
    h.store.activate()
    h.requests[0].resolve(page([item('latest', 3)], { totalCount: 2, hasMore: true, nextBefore: 3 }))
    await settle()
    h.emit('read-state', { state: { channelId: 'channel-a', readSequence: 0 } })
    await settle()
    assert.equal(h.requests.length, 1)
    const more = h.store.load(true)
    h.emit('mention-notification', item('arrival', 4))
    h.requests[1].resolve(page([item('older', 2)], { totalCount: 3 }))
    await more
    assert.equal(h.requests.length, 3)
    h.emit('read-state', { state: { channelId: 'channel-a', readSequence: 4 } })
    await settle()
    assert.equal(h.requests.length, 4)
    h.requests[2].resolve(page([item('arrival', 4)], { totalCount: 3 }))
    h.requests[3].resolve(page([]))
    await settle()
    assert.equal(h.store.unreadCount, 0)
    assert.equal(h.store.notifications.length, 0)
    h.emit('read-state', { state: { channelId: 'channel-a', readSequence: 4 } })
    await settle()
    await settle()
    assert.equal(h.requests.length, 4)
    assert.equal(h.store.unreadCount, 0)
  } finally { h.cleanup() }
})

test('删除通知立即阻止在途计数校准回写，刷新后仍只保留未删提醒', async () => {
  const h = harness()
  try {
    h.store.activate()
    h.requests[0].resolve(page([item('latest', 3)], { totalCount: 2, hasMore: true, nextBefore: 3 }))
    await settle()
    const more = h.store.load(true)
    h.emit('mention-notification', item('arrival', 4))
    h.requests[1].resolve(page([item('older', 2)], { totalCount: 3 }))
    await more
    h.emit('message-deleted', { messageId: 'arrival', channelId: 'channel-a' })
    const countAfterDelete = h.store.unreadCount
    h.requests[2].resolve(page([item('arrival', 4)], { totalCount: 30 }))
    await settle()
    assert.equal(h.store.unreadCount, countAfterDelete)
    h.requests[3].resolve(page([item('latest', 3), item('older', 2)]))
    await settle()
    assert.equal(h.store.unreadCount, 2)
    assert.deepEqual(ids(h.store), ['latest', 'older'])
  } finally { h.cleanup() }
})
