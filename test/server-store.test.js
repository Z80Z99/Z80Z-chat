import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as Vue from 'vue'
import * as Pinia from 'pinia'

const code = ts.transpileModule(readFileSync(new URL('../frontend/src/stores/server.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText
const server = (id, revision = 0, name = id) => ({ id, name, avatar: 'default', description: '', ownerId: 'owner', createdAt: '', profileRevision: revision })
const channel = (id, serverId = 'a', revision = 1, name = id) => ({ id, serverId, categoryId: null, type: 'text', name, position: 0, permissions: {}, revision })
const details = (id, channels = []) => ({ server: server(id), channels, categories: [], roles: [], members: [] })
function harness() {
  const auth = Vue.reactive({ user: { id: 'owner' } })
  const tokens = new Map([['token', 'token-a']]), requests = []
  const api = new Proxy({}, { get: (_, method) => (...args) => new Promise((resolve, reject) => requests.push({ method, args, resolve, reject })) })
  const dependencies = { vue: Vue, pinia: Pinia, '../utils/api': { api }, './auth': { useAuthStore: () => auth } }
  const context = { exports: {}, localStorage: { getItem: key => tokens.get(key) || null }, require: name => dependencies[name] }
  vm.runInNewContext(code, context)
  Pinia.setActivePinia(Pinia.createPinia())
  const store = context.exports.useServerStore()
  return { store, requests, auth, tokens }
}

test('社区详情快速切换只提交最新请求，换社区进入欢迎页且不保留旧频道', async () => {
  const h = harness()
  try {
    h.store.currentServer = server('old'); h.store.currentChannel = channel('old-channel', 'old')
    const first = h.store.fetchServer('a'), second = h.store.fetchServer('b')
    h.requests[1].resolve(details('b', [channel('b-text', 'b')])); await second
    assert.equal(h.store.currentServer.id, 'b'); assert.equal(h.store.currentChannel, null)
    h.requests[0].resolve(details('a')); await first
    assert.equal(h.store.currentServer.id, 'b')
  } finally { h.store.$dispose() }
})

test('返回首页或选择现有频道使尚未完成的社区导航失效', async () => {
  const h = harness()
  try {
    h.store.currentServer = server('a'); h.store.channels = [channel('text')]
    const pending = h.store.fetchServer('b')
    h.store.setCurrentChannel(h.store.channels[0])
    h.requests[0].resolve(details('b')); await pending
    assert.equal(h.store.currentServer.id, 'a'); assert.equal(h.store.currentChannel.id, 'text')
    const another = h.store.fetchServer('b'); h.store.clearSelection()
    h.requests[1].resolve(details('b')); await another
    assert.equal(h.store.currentServer, null)
    h.store.currentServer = server('a'); h.store.setCurrentChannel(channel('foreign', 'b'))
    assert.equal(h.store.currentChannel, null)
  } finally { h.store.$dispose() }
})

test('换账号清理全部社区状态，旧列表和资料保存响应不能污染新会话', async () => {
  const h = harness()
  try {
    h.store.currentServer = server('a'); h.store.servers = [server('a')]
    const list = h.store.fetchServers(), saved = h.store.updateServerProfile({ name: 'old' })
    h.auth.user = { id: 'other' }; h.tokens.set('token', 'token-b')
    assert.equal(h.store.currentServer, null); assert.equal(h.store.servers.length, 0)
    h.store.servers = [server('new')]
    h.requests[0].resolve({ servers: [server('a')] }); h.requests[1].resolve({ server: server('a', 3) })
    await Promise.all([list, saved])
    assert.equal(h.store.servers[0].id, 'new')
    const late = h.store.fetchServers(); h.tokens.set('token', 'rotated')
    h.requests[2].resolve({ servers: [server('wrong')] }); await late
    assert.equal(h.store.servers[0].id, 'new')
  } finally { h.store.$dispose() }
})

test('资料保存捕获原社区，较旧回执和列表不能倒退实时更新或替换当前另一社区', async () => {
  const h = harness()
  try {
    h.store.servers = [server('a'), server('b')]; h.store.currentServer = server('a')
    const save = h.store.updateServerProfile({ name: 'first' })
    assert.equal(h.requests[0].args[0], 'a')
    h.store.handleServerUpdated({ serverId: 'a', server: server('a', 2, 'latest') })
    h.store.currentServer = server('b')
    h.requests[0].resolve({ server: server('a', 1, 'first') }); await save
    assert.equal(h.store.currentServer.id, 'b'); assert.equal(h.store.servers[0].name, 'latest')
    const list = h.store.fetchServers()
    h.requests[1].resolve({ servers: [server('a', 0, 'stale'), server('b')] }); await list
    assert.equal(h.store.servers[0].name, 'latest')
    h.store.handleServerUpdated({ serverId: 'x', server: server('x', 5) })
    assert.equal(h.store.servers.length, 2)
  } finally { h.store.$dispose() }
})

test('详情请求期间的频道新增、更新与删除在旧快照提交后重放，不恢复已删除频道', async () => {
  const h = harness()
  try {
    h.store.currentServer = server('a'); h.store.servers = [server('a')]
    h.store.channels = [channel('rename'), channel('removed')]; h.store.currentChannel = h.store.channels[1]
    const pending = h.store.fetchServer('a')
    h.store.handleChannelEvent({ serverId: 'a', channel: channel('rename', 'a', 2, 'new-name') })
    h.store.handleChannelEvent({ serverId: 'a', channelId: 'removed' })
    h.store.handleChannelEvent({ serverId: 'a', channel: channel('new') })
    h.requests[0].resolve(details('a', [channel('rename'), channel('removed')])); await pending
    assert.deepEqual(h.store.channels.map(value => value.id), ['rename', 'new'])
    assert.equal(h.store.channels[0].name, 'new-name'); assert.equal(h.store.currentChannel, null)
    h.store.handleChannelEvent({ serverId: 'a', channel: channel('removed', 'a', 1) })
    h.store.handleChannelEvent({ serverId: 'a', channel: channel('rename', 'a', 1, 'stale') })
    assert.deepEqual(h.store.channels.map(value => value.id), ['rename', 'new']); assert.equal(h.store.channels[0].name, 'new-name')
  } finally { h.store.$dispose() }
})

test('删除社区不被旧详情、旧列表和迟到推送恢复', async () => {
  const h = harness()
  try {
    h.store.currentServer = server('a'); h.store.servers = [server('a')]
    const detail = h.store.fetchServer('a'), list = h.store.fetchServers()
    h.store.handleServerDeleted('a')
    h.requests[0].resolve(details('a')); h.requests[1].resolve({ servers: [server('a')] })
    await Promise.all([detail, list])
    h.store.handleServerUpdated({ serverId: 'a', server: server('a', 9) })
    assert.equal(h.store.currentServer, null); assert.equal(h.store.servers.length, 0)
  } finally { h.store.$dispose() }
})

test('通知和语音恢复使用的外部快照保留实时新版资料与频道删除，撤销社区后不能提交', () => {
  const h = harness()
  try {
    h.store.currentServer = server('a'); h.store.servers = [server('a')]; h.store.channels = [channel('deleted')]
    const context = h.store.captureServerSnapshot('a')
    h.store.handleServerUpdated({ serverId: 'a', server: server('a', 3, 'new-profile') })
    h.store.handleChannelEvent({ serverId: 'a', channelId: 'deleted' })
    assert.equal(h.store.commitServerSnapshot(details('a', [channel('deleted')]), context), true)
    assert.equal(h.store.currentServer.name, 'new-profile'); assert.equal(h.store.channels.length, 0)
    h.store.setCurrentChannel(channel('deleted')); assert.equal(h.store.currentChannel, null)
    const removed = h.store.captureServerSnapshot('a'); h.store.handleServerDeleted('a')
    assert.equal(h.store.commitServerSnapshot(details('a'), removed), false); assert.equal(h.store.currentServer, null)
  } finally { h.store.$dispose() }
})

test('迟到成员请求隔离社区与账号，较新同服刷新和详情快照不被旧成员覆盖', async () => {
  const h = harness()
  try {
    h.store.currentServer = server('a'); h.store.members = [{ serverId: 'a', userId: 'original' }]
    const first = h.store.refreshMembers('a'); h.store.currentServer = server('b'); h.store.members = [{ serverId: 'b', userId: 'b' }]
    h.requests[0].resolve({ members: [{ serverId: 'a', userId: 'late' }] }); await first
    assert.equal(h.store.members[0].userId, 'b')
    const old = h.store.refreshMembers('b'), latest = h.store.refreshMembers('b')
    h.requests[2].resolve({ members: [{ serverId: 'b', userId: 'latest' }] }); await latest
    h.requests[1].resolve({ members: [{ serverId: 'b', userId: 'old' }] }); await old
    assert.equal(h.store.members[0].userId, 'latest')
    const stale = h.store.refreshMembers('b'), context = h.store.captureServerSnapshot('b')
    const snapshot = details('b'); snapshot.members = [{ serverId: 'b', userId: 'from-detail' }]
    h.store.commitServerSnapshot(snapshot, context)
    h.requests[3].resolve({ members: [{ serverId: 'b', userId: 'stale-refresh' }] }); await stale
    assert.equal(h.store.members[0].userId, 'from-detail')
    const priorAccount = h.store.refreshMembers('b'); h.auth.user = { id: 'new-account' }
    h.requests[4].resolve({ members: [{ serverId: 'b', userId: 'old-account' }] }); await priorAccount
    assert.equal(h.store.members.length, 0)
  } finally { h.store.$dispose() }
})

test('管理社区与发布公告分别使用当前成员角色，普通成员与非成员不会获得权限', () => {
  const h = harness()
  try {
    h.store.currentServer = server('a')
    assert.equal(h.store.canManageServer, true); assert.equal(h.store.canPublishAnnouncements, true)
    h.auth.user = { id: 'member' }; h.store.currentServer = server('a')
    h.store.members = [{ serverId: 'a', userId: 'member', roles: ['manager'] }]
    h.store.roles = [{ id: 'everyone', serverId: 'a', isDefault: true, permissions: { viewChannel: true } }, { id: 'manager', serverId: 'a', permissions: { manageServer: true, manageMessages: false } }]
    assert.equal(h.store.canManageServer, true); assert.equal(h.store.canPublishAnnouncements, false)
    h.store.roles[1].permissions.manageMessages = true
    assert.equal(h.store.canPublishAnnouncements, true)
    h.store.members = []
    assert.equal(h.store.canManageServer, false); assert.equal(h.store.canPublishAnnouncements, false)
  } finally { h.store.$dispose() }
})
