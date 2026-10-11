import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as Vue from 'vue'
import * as Pinia from 'pinia'

const source = readFileSync(new URL('../frontend/src/stores/read-state.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText
const settle = () => new Promise(resolve => setImmediate(resolve))

function createStore() {
  const gets = []
  const posts = []
  const auth = Vue.reactive({ user: { id: 'account-a' } })
  const api = {
    getReadStates(serverId) {
      return new Promise((resolve, reject) => gets.push({ serverId, resolve, reject }))
    },
    markChannelRead(channelId, messageId) {
      return new Promise((resolve, reject) => posts.push({ channelId, messageId, resolve, reject }))
    }
  }
  const dependencies = { vue: Vue, pinia: Pinia, '../utils/api': { api }, './auth': { useAuthStore: () => auth } }
  const context = {
    exports: {},
    require(name) {
      assert.ok(dependencies[name], `Unexpected dependency: ${name}`)
      return dependencies[name]
    }
  }
  vm.runInNewContext(compiled, context)
  Pinia.setActivePinia(Pinia.createPinia())
  return { store: context.exports.useReadStateStore(), auth, gets, posts }
}

const state = (channelId = 'a', changes = {}) => ({
  channelId, readSequence: 0, latestSequence: 10, unreadCount: 10, revision: 1, ...changes
})
const plain = value => JSON.parse(JSON.stringify(value))

async function loaded(h, serverId, states) {
  const request = h.store.loadServer(serverId)
  h.gets.at(-1).resolve({ serverId, states })
  await request
}

test('metadata乱序不降低revision或已阅读游标，并拒绝非法数值', () => {
  const { store } = createStore()
  const newest = state('a', { readSequence: 4, latestSequence: 10, unreadCount: 6, revision: 10 })
  store.mergeState(newest)
  store.mergeState(state('a', { readSequence: 5, revision: 9 }))
  assert.deepEqual(plain(store.states.a), newest)
  store.mergeState(state('a', { readSequence: 3, revision: 11 }))
  assert.deepEqual(plain(store.states.a), newest)
  const next = state('a', { readSequence: 4, latestSequence: 11, unreadCount: 7, revision: 12 })
  store.mergeState(next)
  assert.deepEqual(plain(store.states.a), next)
  for (const invalid of [{ unreadCount: -1 }, { revision: 1.5 }, { latestSequence: Infinity }]) {
    store.mergeState(state('invalid', invalid))
  }
  assert.equal(store.states.invalid, undefined)
})

test('同服务器GET复用请求，飞行期间较新WS状态优先于旧HTTP快照', async () => {
  const h = createStore()
  const first = h.store.loadServer('server')
  const second = h.store.loadServer('server')
  assert.equal(h.gets.length, 1)
  const pushed = state('a', { readSequence: 3, unreadCount: 7, revision: 9 })
  h.store.mergeState(pushed)
  h.gets[0].resolve({ serverId: 'server', states: [state('a', { revision: 8 })] })
  await Promise.all([first, second])
  assert.deepEqual(plain(h.store.states.a), pushed)
  const next = h.store.loadServer('server')
  assert.equal(h.gets.length, 2, '已完成请求不能继续被缓存')
  h.gets[1].resolve({ serverId: 'server', states: [pushed] })
  await next
})

test('频道消失及403清理对应服务器缓存，并保留其他服务器状态', async () => {
  const h = createStore()
  await loaded(h, 'first', [state('a'), state('b')])
  await loaded(h, 'second', [state('c')])
  await loaded(h, 'first', [state('b', { revision: 2 })])
  assert.equal(h.store.states.a, undefined)
  assert.ok(h.store.states.b)
  assert.ok(h.store.states.c)
  const failed = h.store.loadServer('first')
  const rejected = assert.rejects(failed, /forbidden/)
  h.gets.at(-1).reject(Object.assign(new Error('forbidden'), { status: 403 }))
  await rejected
  assert.equal(h.store.states.b, undefined)
  assert.ok(h.store.states.c)
  assert.equal(h.store.serverErrors.first, 'forbidden')
  await loaded(h, 'first', [state('b', { revision: 3 })])
  assert.equal(h.store.serverErrors.first, undefined)
  assert.ok(h.store.states.b)
})

test('账号切换同步清理所有缓存，旧GET/POST结果不能污染新账号或删除新请求', async () => {
  const h = createStore()
  await loaded(h, 'server', [state('a')])
  const errorLoad = h.store.loadServer('error-server')
  const rejected = assert.rejects(errorLoad, /load failed/)
  h.gets.at(-1).reject(new Error('load failed'))
  await rejected
  const errorRead = h.store.markRead('a', 'failed-id', 1)
  h.posts[0].reject(new Error('read failed'))
  await errorRead
  assert.equal(h.store.serverErrors['error-server'], 'load failed')
  assert.equal(h.store.readErrors.a, 'read failed')
  const oldGet = h.store.loadServer('server')
  const oldPost = h.store.markRead('a', 'old-id', 2)
  h.auth.user = { id: 'account-b' }
  assert.deepEqual(plain(h.store.states), {})
  assert.deepEqual(plain(h.store.serverErrors), {})
  assert.deepEqual(plain(h.store.readErrors), {})
  const freshGet = h.store.loadServer('server')
  const getCount = h.gets.length
  h.gets[getCount - 2].resolve({ serverId: 'server', states: [state('a', { revision: 90 })] })
  h.posts[1].resolve({ state: state('a', { readSequence: 2, revision: 91 }) })
  await Promise.all([oldGet, oldPost])
  assert.deepEqual(plain(h.store.states), {})
  const repeatedFresh = h.store.loadServer('server')
  assert.equal(h.gets.length, getCount, '旧GET finally不能移除新账号请求')
  h.gets.at(-1).resolve({ serverId: 'server', states: [state('a', { revision: 3 })] })
  await Promise.all([freshGet, repeatedFresh])
  assert.equal(h.store.states.a.revision, 3)
  const freshPost = h.store.markRead('a', 'fresh-id', 4)
  assert.equal(h.posts.length, 3, '新账号不能复用旧账号POST')
  h.posts[2].resolve({ state: state('a', { readSequence: 4, revision: 4 }) })
  await freshPost
  assert.equal(h.store.states.a.readSequence, 4)
})

test('退出后旧失败不写入错误，重新登录同ID也不能恢复旧代际状态', async () => {
  const h = createStore()
  h.store.mergeState(state())
  const oldGet = h.store.loadServer('server')
  const oldPost = h.store.markRead('a', 'old-id', 2)
  h.auth.user = null
  assert.deepEqual(plain(h.store.states), {})
  h.auth.user = { id: 'account-a' }
  h.gets[0].reject(Object.assign(new Error('old forbidden'), { status: 403 }))
  h.posts[0].reject(new Error('old read failed'))
  await Promise.all([oldGet, oldPost])
  assert.deepEqual(plain(h.store.states), {})
  assert.deepEqual(plain(h.store.serverErrors), {})
  assert.deepEqual(plain(h.store.readErrors), {})
})

test('同频道阅读请求串行，并只发送排队目标中的最高序号', async () => {
  const h = createStore()
  h.store.mergeState(state())
  const first = h.store.markRead('a', 'three', 3)
  const second = h.store.markRead('a', 'six', 6)
  const third = h.store.markRead('a', 'eight', 8)
  const lower = h.store.markRead('a', 'four', 4)
  assert.equal(h.posts.length, 1)
  assert.strictEqual(second, first)
  assert.strictEqual(third, first)
  assert.strictEqual(lower, first)
  assert.equal(h.posts[0].messageId, 'three')
  h.posts[0].resolve({ state: state('a', { readSequence: 3, unreadCount: 7, revision: 2 }) })
  await settle()
  assert.equal(h.posts.length, 2)
  assert.equal(h.posts[1].messageId, 'eight')
  h.posts[1].resolve({ state: state('a', { readSequence: 8, unreadCount: 2, revision: 3 }) })
  await Promise.all([first, second, third, lower])
  assert.equal(h.store.states.a.readSequence, 8)
  assert.equal(h.store.readErrors.a, undefined)
  await h.store.markRead('a', 'already-read', 7)
  assert.equal(h.posts.length, 2)
})

test('不同频道可并行推进，较新WS确认可跳过已排队但已读的目标', async () => {
  const h = createStore()
  h.store.mergeState(state('a'))
  h.store.mergeState(state('b'))
  const first = h.store.markRead('a', 'a-three', 3)
  const queued = h.store.markRead('a', 'a-five', 5)
  const other = h.store.markRead('b', 'b-four', 4)
  assert.equal(h.posts.length, 2)
  h.store.mergeState(state('a', { readSequence: 6, unreadCount: 4, revision: 5 }))
  h.posts[0].resolve({ state: state('a', { readSequence: 3, revision: 2 }) })
  h.posts[1].resolve({ state: state('b', { readSequence: 4, revision: 3 }) })
  await Promise.all([first, queued, other])
  assert.equal(h.posts.length, 2)
  assert.equal(h.store.states.a.readSequence, 6)
  assert.equal(h.store.states.b.readSequence, 4)
})

test('推进失败保留已确认游标和未读数量，可使用相同目标重新尝试', async () => {
  const h = createStore()
  const original = state('a', { readSequence: 2, unreadCount: 8 })
  h.store.mergeState(original)
  const failed = h.store.markRead('a', 'eight', 8)
  h.posts[0].reject(new Error('offline'))
  await failed
  assert.deepEqual(plain(h.store.states.a), original)
  assert.equal(h.store.readErrors.a, 'offline')
  const retry = h.store.markRead('a', 'eight', 8)
  assert.equal(h.posts.length, 2)
  h.posts[1].resolve({ state: state('a', { readSequence: 8, unreadCount: 2, revision: 2 }) })
  await retry
  assert.equal(h.store.states.a.readSequence, 8)
  assert.equal(h.store.readErrors.a, undefined)
})

test('403移除频道后，迟到阅读ACK不能重新创建无权查看的缓存', async () => {
  const h = createStore()
  await loaded(h, 'server', [state('a')])
  const read = h.store.markRead('a', 'three', 3)
  const refresh = h.store.loadServer('server')
  const rejected = assert.rejects(refresh, /forbidden/)
  h.gets.at(-1).reject(Object.assign(new Error('forbidden'), { status: 403 }))
  await rejected
  assert.equal(h.store.states.a, undefined)
  h.posts[0].resolve({ state: state('a', { readSequence: 3, revision: 2 }) })
  await read
  assert.equal(h.store.states.a, undefined)
})

test('先到WS登记服务器归属，403清缓存并阻止迟到推送，重新授权GET后恢复', async () => {
  const h = createStore()
  h.store.mergeState(state('a'), 'server')
  const refresh = h.store.loadServer('server')
  const rejected = assert.rejects(refresh, /forbidden/)
  h.gets[0].reject(Object.assign(new Error('forbidden'), { status: 403 }))
  await rejected
  assert.equal(h.store.states.a, undefined)
  h.store.mergeState(state('a', { revision: 20 }), 'server')
  h.store.mergeState(state('b', { revision: 21 }), 'server')
  assert.deepEqual(plain(h.store.states), {})
  await loaded(h, 'server', [state('a', { revision: 22 })])
  h.store.mergeState(state('a', { revision: 23 }), 'server')
  assert.equal(h.store.states.a.revision, 23)
})

test('频道从GET消失会取消阅读队列并阻止旧ACK和WS复活，GET重新返回后可读', async () => {
  const h = createStore()
  await loaded(h, 'server', [state('a')])
  const read = h.store.markRead('a', 'three', 3)
  const queued = h.store.markRead('a', 'eight', 8)
  await loaded(h, 'server', [])
  h.store.mergeState(state('a', { readSequence: 3, revision: 3 }), 'server')
  assert.equal(h.store.states.a, undefined)
  h.posts[0].resolve({ serverId: 'server', state: state('a', { readSequence: 3, revision: 2 }) })
  await Promise.all([read, queued])
  assert.equal(h.store.states.a, undefined)
  assert.equal(h.posts.length, 1, '被移除频道不能继续发送已排队的阅读目标')
  await loaded(h, 'server', [state('a', { revision: 4 })])
  const fresh = h.store.markRead('a', 'eight', 8)
  assert.equal(h.posts.length, 2)
  h.posts[1].resolve({ serverId: 'server', state: state('a', { readSequence: 8, revision: 5 }) })
  await fresh
  assert.equal(h.store.states.a.readSequence, 8)
})

test('移除后重新授权频道，旧阅读失败不能污染新阅读成功状态', async () => {
  const h = createStore()
  await loaded(h, 'server', [state('a')])
  const oldRead = h.store.markRead('a', 'old-three', 3)
  await loaded(h, 'server', [])
  await loaded(h, 'server', [state('a', { revision: 4 })])
  const fresh = h.store.markRead('a', 'fresh-five', 5)
  h.posts[1].resolve({ serverId: 'server', state: state('a', { readSequence: 5, revision: 5 }) })
  await fresh
  h.posts[0].reject(new Error('old read failed'))
  await oldRead
  assert.equal(h.store.states.a.readSequence, 5)
  assert.equal(h.store.readErrors.a, undefined)
})

test('账号变化清除拒绝服务器和已移除频道记录，新账号可正常接受推送', async () => {
  const h = createStore()
  h.store.mergeState(state('a'), 'server')
  const denied = h.store.loadServer('server')
  const rejected = assert.rejects(denied, /forbidden/)
  h.gets[0].reject(Object.assign(new Error('forbidden'), { status: 403 }))
  await rejected
  h.auth.user = { id: 'account-b' }
  h.store.mergeState(state('a'), 'server')
  assert.equal(h.store.states.a.revision, 1)
  assert.deepEqual(plain(h.store.serverErrors), {})
})

test('暂时性GET失败保留原有缓存并可重试，不阻止实时推送', async () => {
  const h = createStore()
  await loaded(h, 'server', [state('a')])
  const failed = h.store.loadServer('server')
  const rejected = assert.rejects(failed, /temporarily unavailable/)
  h.gets.at(-1).reject(Object.assign(new Error('temporarily unavailable'), { status: 500 }))
  await rejected
  assert.equal(h.store.states.a.revision, 1)
  h.store.mergeState(state('a', { revision: 2 }), 'server')
  assert.equal(h.store.states.a.revision, 2)
  const retry = h.store.loadServer('server')
  assert.equal(h.store.serverErrors.server, undefined)
  h.gets.at(-1).resolve({ serverId: 'server', states: [state('a', { revision: 3 })] })
  await retry
  assert.equal(h.store.states.a.revision, 3)
})

test('旧GET缺少飞行期间新WS频道时保留推送，下次GET仍能正确清理该频道', async () => {
  const h = createStore()
  await loaded(h, 'server', [state('a')])
  const snapshot = h.store.loadServer('server')
  const pushed = state('b', { readSequence: 2, unreadCount: 8, revision: 10 })
  h.store.mergeState(pushed, 'server')
  h.gets.at(-1).resolve({ serverId: 'server', states: [state('a', { revision: 9 })] })
  await snapshot
  assert.deepEqual(plain(h.store.states.b), pushed)
  h.store.mergeState(state('b', { readSequence: 2, unreadCount: 9, latestSequence: 11, revision: 11 }), 'server')
  assert.equal(h.store.states.b.revision, 11, '旧HTTP不能将新频道标记为removed')
  await loaded(h, 'server', [state('a', { revision: 12 })])
  assert.equal(h.store.states.b, undefined, '新推送的服务器归属必须保留供下一次GET清理')
  h.store.mergeState(state('b', { revision: 13 }), 'server')
  assert.equal(h.store.states.b, undefined)
})
