import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as Vue from 'vue'
import * as Pinia from 'pinia'

const source = readFileSync(new URL('../frontend/src/stores/chat.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText

function createStore() {
  const requests = []
  const api = {
    getMessages(channelId, limit, before) {
      return new Promise((resolve, reject) => requests.push({ channelId, limit, before, resolve, reject }))
    },
    getMessageContext(channelId, messageId) {
      return new Promise((resolve, reject) => requests.push({ channelId, messageId, context: true, resolve, reject }))
    }
  }
  const dependencies = { vue: Vue, pinia: Pinia, '../utils/api': { api } }
  const context = {
    exports: {},
    require(name) {
      assert.ok(dependencies[name], `Unexpected dependency: ${name}`)
      return dependencies[name]
    }
  }
  vm.runInNewContext(compiled, context)
  Pinia.setActivePinia(Pinia.createPinia())
  return { store: context.exports.useChatStore(), requests }
}

function message(number, channelId = 'a', content = `message-${number}`) {
  return {
    id: String(number), channelId, content, userId: 'author',
    createdAt: new Date(number * 1000).toISOString(), editedAt: null,
    image: null, file: null, fileName: null, replyTo: null,
    mentions: [], mentionEveryone: false
  }
}

const ids = store => Array.from(store.messages, item => item.id)

test('定位旧消息使用连续上下文，期间的新消息不跨缺口插入，回到最新重新加载', async () => {
  const { store, requests } = createStore()
  const initial = store.loadMessages('a', 2)
  requests[0].resolve({ messages: [message(20), message(21)] }); await initial
  const context = store.locateMessage('a', '5')
  store.addMessage(message(22))
  store.updateMessage('5', { content: 'updated during locate', revision: 2 })
  requests[1].resolve({ messages: [message(4), message(5), message(6)], hasMoreBefore: true, hasMoreAfter: true })
  assert.equal(await context, true)
  assert.deepEqual(ids(store), ['4', '5', '6'])
  assert.equal(store.messages[1].content, 'updated during locate')
  assert.equal(store.viewingContext, true)
  assert.equal(store.hasNewer, true)
  assert.equal(store.contextNewMessageIds.size, 1)
  store.addMessage(message(23)); store.addMessage(message(23))
  assert.deepEqual(ids(store), ['4', '5', '6'])
  assert.equal(store.contextNewMessageIds.size, 2)
  const history = store.loadMore('a', 2)
  store.addMessage(message(24))
  requests[2].resolve({ messages: [message(2), message(3)] }); await history
  assert.deepEqual(ids(store), ['2', '3', '4', '5', '6'])
  const latest = store.loadMessages('a', 2)
  requests[3].resolve({ messages: [message(23), message(24)] }); await latest
  assert.equal(store.viewingContext, false)
  assert.equal(store.hasNewer, false)
  assert.equal(store.contextNewMessageIds.size, 0)
  assert.deepEqual(ids(store), ['23', '24'])
})

test('定位失败保留当前记录，定位期间删除不复活，旧频道和账号响应丢弃', async () => {
  const { store, requests } = createStore()
  const initial = store.loadMessages('a'); requests[0].resolve({ messages: [message(20)] }); await initial
  const missing = store.locateMessage('a', '5')
  store.removeMessage('5')
  requests[1].resolve({ messages: [message(5)], hasMoreBefore: false, hasMoreAfter: true })
  await assert.rejects(missing, /原消息已被删除/)
  assert.deepEqual(ids(store), ['20'])
  assert.equal(store.viewingContext, false)
  const stale = store.locateMessage('a', '5')
  store.clearMessages()
  const next = store.loadMessages('b')
  requests[2].resolve({ messages: [message(5)], hasMoreBefore: false, hasMoreAfter: false })
  assert.equal(await stale, false)
  requests[3].resolve({ messages: [message(30, 'b')] }); await next
  assert.deepEqual(ids(store), ['30'])
  assert.equal(store.currentChannelId, 'b')
  assert.equal(store.loading, false)
})

test('迟到修改确认不能倒退消息revision，刷新快照高于期间低版本事件时保留快照', async () => {
  const { store, requests } = createStore()
  const initial = store.loadMessages('a')
  requests[0].resolve({ messages: [{ ...message(1), revision: 3, reactions: [{ emoji: '👍', userIds: ['a', 'b'] }] }] }); await initial
  store.updateMessage('1', { revision: 2, reactions: [] })
  assert.equal(store.messages[0].reactions[0].userIds.length, 2)
  const refresh = store.loadMessages('a')
  store.updateMessage('1', { revision: 4, content: 'event4' })
  requests[1].resolve({ messages: [{ ...message(1), revision: 5, content: 'snapshot5' }] }); await refresh
  assert.equal(store.messages[0].revision, 5)
  assert.equal(store.messages[0].content, 'snapshot5')
  store.addMessage({ ...message(1), revision: 1, content: 'stale send receipt' })
  assert.equal(store.messages[0].content, 'snapshot5')
})

test('最新窗口定位失败恢复期间到达的消息、修改和删除，不留下旧上下文计数', async () => {
  const { store, requests } = createStore()
  const initial = store.loadMessages('a')
  requests[0].resolve({ messages: [message(20), message(21)] }); await initial
  const locating = store.locateMessage('a', '5')
  store.addMessage({ ...message(22), revision: 2 })
  store.updateMessage('22', { revision: 4, content: 'latest arrival' })
  store.updateMessage('22', { revision: 3, content: 'late older receipt' })
  store.updateMessage('21', { revision: 3, pin: { userId: 'manager' } })
  store.removeMessage('20')
  store.addMessage(message(23)); store.removeMessage('23')
  requests[1].reject(new Error('lookup failed'))
  await assert.rejects(locating, /lookup failed/)
  assert.deepEqual(ids(store), ['21', '22'])
  assert.equal(store.messages[0].pin.userId, 'manager')
  assert.equal(store.messages[1].revision, 4)
  assert.equal(store.messages[1].content, 'latest arrival')
  assert.equal(store.viewingContext, false)
  assert.equal(store.contextMessageId, null)
  assert.equal(store.hasNewer, false)
  assert.equal(store.contextNewMessageIds.size, 0)
  assert.equal(store.loading, false)
})

test('已经查看旧消息时再次定位失败保持连续旧窗口，期间最新消息仅增加提示计数', async () => {
  const { store, requests } = createStore()
  const initial = store.loadMessages('a'); requests[0].resolve({ messages: [message(20)] }); await initial
  const first = store.locateMessage('a', '5')
  requests[1].resolve({ messages: [message(4), message(5), message(6)], hasMoreBefore: true, hasMoreAfter: true }); await first
  store.addMessage(message(21))
  const second = store.locateMessage('a', '2')
  store.addMessage(message(22))
  store.updateMessage('5', { revision: 2, content: 'live edit in old window' })
  requests[2].reject(new Error('lookup failed'))
  await assert.rejects(second, /lookup failed/)
  assert.deepEqual(ids(store), ['4', '5', '6'])
  assert.equal(store.messages[1].content, 'live edit in old window')
  assert.equal(store.viewingContext, true)
  assert.equal(store.contextMessageId, '5')
  assert.equal(store.hasNewer, true)
  assert.equal(store.contextNewMessageIds.size, 2)
  assert.equal(store.loading, false)
})

test('离开旧上下文的刷新期间，未入窗口的新增推送不会被较早修改回执降级', async () => {
  const { store, requests } = createStore()
  const initial = store.loadMessages('a'); requests[0].resolve({ messages: [message(20)] }); await initial
  const locating = store.locateMessage('a', '5')
  requests[1].resolve({ messages: [message(4), message(5), message(6)], hasMoreBefore: true, hasMoreAfter: true }); await locating
  const refresh = store.loadMessages('a')
  store.addMessage({ ...message(22), revision: 5, content: 'newest push' })
  assert.deepEqual(ids(store), ['4', '5', '6'])
  store.updateMessage('22', { revision: 3, content: 'old mutation receipt' })
  requests[2].resolve({ messages: [message(21), { ...message(22), revision: 2, content: 'older refresh snapshot' }] }); await refresh
  assert.deepEqual(ids(store), ['21', '22'])
  assert.equal(store.messages[1].revision, 5)
  assert.equal(store.messages[1].content, 'newest push')
  assert.equal(store.viewingContext, false)
})

test('取消历史定位保留期间实时消息，释放 loading，迟到上下文不覆盖原窗口', async () => {
  const { store, requests } = createStore()
  const initial = store.loadMessages('a'); requests[0].resolve({ messages: [message(20)] }); await initial
  const locate = store.locateMessage('a', '5')
  store.addMessage(message(21))
  store.cancelContextLookup()
  assert.equal(store.loading, false)
  assert.equal(store.viewingContext, false)
  assert.deepEqual(ids(store), ['20', '21'])
  requests[1].resolve({ messages: [message(5)], hasMoreBefore: true, hasMoreAfter: true })
  assert.equal(await locate, false)
  assert.deepEqual(ids(store), ['20', '21'])
})

test('刷新过程中定位缓存里的旧消息取得新上下文，迟到刷新不会覆盖定位窗口', async () => {
  const { store, requests } = createStore()
  const initial = store.loadMessages('a'); requests[0].resolve({ messages: [message(20)] }); await initial
  const firstLocation = store.locateMessage('a', '5')
  requests[1].resolve({ messages: [message(4), message(5), message(6)], hasMoreBefore: true, hasMoreAfter: true }); await firstLocation
  const refreshing = store.loadMessages('a')
  const locating = store.locateMessage('a', '5')
  assert.equal(requests.length, 4, '在途刷新存在时不能直接以缓存定位成功')
  assert.equal(requests[3].context, true)
  requests[3].resolve({ messages: [message(4), message(5), message(6)], hasMoreBefore: true, hasMoreAfter: true })
  assert.equal(await locating, true)
  requests[2].resolve({ messages: [message(20), message(21)] }); await refreshing
  assert.deepEqual(ids(store), ['4', '5', '6'])
  assert.equal(store.viewingContext, true)
  assert.equal(store.contextMessageId, '5')
  assert.equal(store.loading, false)
})

test('频道切换丢弃旧请求、旧实时事件，旧失败不覆盖新请求 loading 或错误状态', async () => {
  const { store, requests } = createStore()
  const first = store.loadMessages('a')
  store.addMessage(message(1))
  const second = store.loadMessages('b')
  assert.deepEqual(ids(store), [])
  store.addMessage(message(2, 'a'))
  const rejectedFirst = assert.rejects(first, /old channel failed/)
  requests[0].reject(new Error('old channel failed'))
  await rejectedFirst
  assert.equal(store.loading, true)
  assert.equal(store.loadError, '')
  assert.deepEqual(ids(store), [])
  requests[1].resolve({ messages: [message(3, 'b')] })
  await second
  assert.equal(store.currentChannelId, 'b')
  assert.deepEqual(ids(store), ['3'])
  assert.equal(store.loading, false)
  assert.equal(store.loadError, '')
})

test('同频道重叠刷新仅采用最后请求结果', async () => {
  const { store, requests } = createStore()
  const first = store.loadMessages('a')
  const second = store.loadMessages('a')
  requests[1].resolve({ messages: [message(2)] })
  await second
  requests[0].resolve({ messages: [message(1)] })
  await first
  assert.deepEqual(ids(store), ['2'])
  assert.equal(store.loading, false)
  assert.equal(store.loadError, '')
})

test('重连刷新采用最新完整窗口，离线编辑删除同步且中间缺口可向前分页', async () => {
  const { store, requests } = createStore()
  const initial = store.loadMessages('a', 3)
  requests[0].resolve({ messages: [message(1), message(2), message(3)] })
  await initial
  const refresh = store.loadMessages('a', 3)
  assert.deepEqual(ids(store), ['1', '2', '3'], '请求期间继续展示原消息')
  requests[1].resolve({ messages: [message(3, 'a', 'edited offline'), message(5), message(6)] })
  await refresh
  assert.deepEqual(ids(store), ['3', '5', '6'])
  assert.equal(store.messages[0].content, 'edited offline')
  const history = store.loadMore('a', 3)
  assert.equal(requests[2].before, '3')
  requests[2].resolve({ messages: [message(1)] })
  await history
  assert.deepEqual(ids(store), ['1', '3', '5', '6'], '删除的消息2不再出现')
})

test('刷新窗口不拼接旧缓存，长断线后的遗漏区间可继续向前分页', async () => {
  const { store, requests } = createStore()
  const initial = store.loadMessages('a', 2)
  requests[0].resolve({ messages: [message(1), message(2)] })
  await initial
  const refresh = store.loadMessages('a', 2)
  requests[1].resolve({ messages: [message(5), message(6)] })
  await refresh
  assert.deepEqual(ids(store), ['5', '6'])
  const history = store.loadMore('a', 2)
  assert.equal(requests[2].before, '5')
  requests[2].resolve({ messages: [message(3), message(4)] })
  await history
  assert.deepEqual(ids(store), ['3', '4', '5', '6'])
})

test('历史请求期间新增、编辑、删除覆盖 REST 快照，删除消息不会复活', async () => {
  const { store, requests } = createStore()
  const load = store.loadMessages('a', 2)
  store.addMessage(message(3))
  store.updateMessage('3', { content: 'live edited' })
  store.updateMessage('1', { content: 'edited before history loaded' })
  store.removeMessage('2')
  store.addMessage(message(2)) // 迟到的发送响应不能覆盖本次请求中的删除。
  requests[0].resolve({ messages: [message(1), message(2)] })
  await load
  assert.deepEqual(ids(store), ['1', '3'])
  assert.equal(store.messages[0].content, 'edited before history loaded')
  assert.equal(store.messages[1].content, 'live edited')
})

test('向前分页去重，并保留请求期间新增、未知记录编辑和删除', async () => {
  const { store, requests } = createStore()
  const initial = store.loadMessages('a', 2)
  requests[0].resolve({ messages: [message(3), message(4)] })
  await initial
  const history = store.loadMore('a', 2)
  assert.equal(requests[1].before, '3')
  store.addMessage(message(5))
  store.updateMessage('1', { content: 'older message edited' })
  store.removeMessage('2')
  store.removeMessage('4')
  requests[1].resolve({ messages: [message(1), message(2), message(3)] })
  await history
  assert.deepEqual(ids(store), ['1', '3', '5'])
  assert.equal(store.messages[0].content, 'older message edited')
})

test('刷新或分页 API 失败保留当前消息和实时变化，之后仍可重新加载', async () => {
  const { store, requests } = createStore()
  const initial = store.loadMessages('a', 2)
  requests[0].resolve({ messages: [message(1), message(2)] })
  await initial
  const refresh = store.loadMessages('a', 2)
  const rejectedRefresh = assert.rejects(refresh, /refresh failed/)
  store.addMessage(message(3))
  requests[1].reject(new Error('refresh failed'))
  await rejectedRefresh
  assert.deepEqual(ids(store), ['1', '2', '3'])
  assert.equal(store.loading, false)
  assert.equal(store.hasMore, true)
  assert.equal(store.loadError, 'refresh failed')
  const history = store.loadMore('a', 2)
  assert.equal(store.loadError, '')
  const rejectedHistory = assert.rejects(history, /history failed/)
  store.removeMessage('2')
  requests[2].reject(new Error('history failed'))
  await rejectedHistory
  assert.deepEqual(ids(store), ['1', '3'])
  assert.equal(store.loading, false)
  assert.equal(store.loadError, 'history failed')
  const retry = store.loadMessages('a', 2)
  assert.equal(store.loadError, '')
  requests[3].resolve({ messages: [message(3), message(4)] })
  await retry
  assert.deepEqual(ids(store), ['3', '4'])
  assert.equal(store.loadError, '')
  const failedRetry = store.loadMessages('a')
  const rejectedRetry = assert.rejects(failedRetry)
  requests[4].reject(new Error(''))
  await rejectedRetry
  assert.equal(store.loadError, '加载消息失败，请重试')
  store.clearMessages()
  assert.equal(store.loadError, '')
})

test('清空频道使进行中的分页和事件日志失效', async () => {
  const { store, requests } = createStore()
  const initial = store.loadMessages('a', 1)
  requests[0].resolve({ messages: [message(2)] })
  await initial
  const history = store.loadMore('a', 1)
  store.removeMessage('1')
  store.clearMessages()
  const next = store.loadMessages('b', 1)
  requests[1].resolve({ messages: [message(1)] })
  await history
  assert.equal(store.loading, true)
  requests[2].resolve({ messages: [message(1, 'b')] })
  await next
  assert.deepEqual(ids(store), ['1'])
  assert.equal(store.messages[0].channelId, 'b')
})
