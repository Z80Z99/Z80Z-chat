import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as Vue from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'

const homeSource = readFileSync(new URL('../frontend/src/views/Home.vue', import.meta.url), 'utf8')
const homeScript = compileScript(parse(homeSource).descriptor, { id: 'home-subscription-test' }).content
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText
const homeCode = compile(homeScript)
const wsCode = compile(readFileSync(new URL('../frontend/src/utils/ws.ts', import.meta.url), 'utf8'))
const settle = () => new Promise(resolve => setImmediate(resolve))
const snapshot = value => JSON.parse(JSON.stringify(value))

function createHomeHarness(options = {}) {
  const sockets = []
  const timers = new Map()
  const documentListeners = new Set()
  const documentEvents = new Map()
  const focused = []
  const screenRefreshes = [], cleanedScreens = [], screenPlayback = []
  const subscriptions = new Map()
  const reconnectHandlers = new Set()
  const loads = []
  const added = []
  const updated = []
  const deleted = []
  const voiceJoins = []
  const restoredVoiceJoins = []
  const serverRequests = []
  const located = []
  const navigationResults = []
  let pttInstalled = 0, pttReleased = 0, pttDisposed = 0
  let pttOptions
  const auth = Vue.reactive({ user: { id: 'home-user' } })
  const notifications = Vue.reactive({ pendingTarget: null, navigationError: '',
    finishNavigation(item, failure = '') {
      if (this.pendingTarget !== item) return
      navigationResults.push({ id: item.message.id, failure })
      this.pendingTarget = null; this.navigationError = failure
    } })
  let homeInstance = null
  let locationCancellations = 0
  let nextTimer = 0
  let resolveServers
  const serversReady = new Promise(resolve => { resolveServers = resolve })

  class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 3
    readyState = FakeWebSocket.CONNECTING
    sent = []
    constructor(url) { this.url = url; sockets.push(this) }
    send(data) {
      assert.equal(this.readyState, FakeWebSocket.OPEN)
      this.sent.push(JSON.parse(data))
    }
    open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.() }
    close() { this.readyState = FakeWebSocket.CLOSED; this.onclose?.() }
    message(data) { this.onmessage?.({ data: JSON.stringify(data) }) }
  }

  const globals = {
    exports: {}, console, WebSocket: FakeWebSocket,
    localStorage: { getItem: key => key === 'token' ? 'home-token' : null },
    window: { innerWidth: 1200, location: { protocol: 'https:', host: 'chat.example.test' } },
    document: {
      activeElement: { isConnected: true, focus() { focused.push('trigger') } },
      fullscreenElement: null,
      querySelector(selector) { return { focus() { focused.push(selector) } } },
      addEventListener(type, callback) {
        documentListeners.add(callback)
        if (!documentEvents.has(type)) documentEvents.set(type, new Set())
        documentEvents.get(type).add(callback)
      },
      removeEventListener(type, callback) { documentListeners.delete(callback); documentEvents.get(type)?.delete(callback) }
    },
    setTimeout(callback, delay) {
      const id = nextTimer++
      timers.set(id, { callback, delay })
      return id
    },
    clearTimeout(id) { timers.delete(id) }
  }
  vm.runInNewContext(`(function () {\n${wsCode}\n})()`, globals)
  const ws = globals.exports.ws
  // Observe the public registration API while retaining the real client's dispatch/reconnect behavior.
  const homeWs = {
    send: data => ws.send(data),
    on(type, callback) {
      if (!subscriptions.has(type)) subscriptions.set(type, new Set())
      subscriptions.get(type).add(callback)
      ws.on(type, callback)
    },
    off(type, callback) {
      subscriptions.get(type)?.delete(callback)
      ws.off(type, callback)
    },
    onReconnect(callback) { reconnectHandlers.add(callback); ws.onReconnect(callback) },
    offReconnect(callback) { reconnectHandlers.delete(callback); ws.offReconnect(callback) }
  }

  const server = Vue.reactive({
    currentServer: { id: 'server-a' },
    currentChannel: { id: 'text-a', type: 'text', name: 'General' },
    channels: [], members: [],
    fetchServers: () => serversReady,
    setCurrentChannel(channel) { this.currentChannel = channel },
    cancelServerNavigation() {},
    captureServerSnapshot(serverId) { return { serverId } },
    commitServerSnapshot(data) {
      if (options.rejectSnapshot) return false
      this.currentServer = data.server; this.channels = data.channels; this.categories = data.categories; this.members = data.members; this.roles = data.roles
      return true
    }
  })
  const chat = Vue.reactive({
    messages: [],
    clearMessages() { this.messages = [] },
    async loadMessages(channelId) { loads.push(channelId) },
    addMessage(message) { added.push(snapshot(message)); this.messages.push(message) },
    updateMessage(id, message) {
      updated.push(id)
      const index = this.messages.findIndex(item => item.id === id)
      if (index !== -1) this.messages[index] = { ...this.messages[index], ...message }
    },
    removeMessage(id) { deleted.push(id); this.messages = this.messages.filter(item => item.id !== id) }
  })
  const voice = Vue.reactive({
    currentRoom: null, isScreenSharing: false, screenStream: null,
    remoteScreens: [], participants: [], peerConnections: new Map(),
    voiceMode: 'open', pushToTalkKey: 'Space', micAvailable: true,
    isMuted: false, isDeafened: false,
    releasePushToTalk() {}, setPushToTalkPressed() {}, cleanupPeer() {},
    cleanupRemoteScreen(id) { cleanedScreens.push(id); this.remoteScreens = this.remoteScreens.filter(entry => entry.userId !== id) },
    requestScreenRefresh(id) { screenRefreshes.push(id) },
    reportScreenPlayback(...args) { screenPlayback.push(args) },
    loadVoiceState: () => options.savedVoice || null,
    clearVoiceState() {},
    async joinRoom(roomId, state) { restoredVoiceJoins.push({ roomId, state: snapshot(state) }); this.currentRoom = roomId },
    async rejoinRoom(roomId) { voiceJoins.push(roomId) }
  })
  const dependencies = {
    vue: Vue,
    'vue-router': { useRoute: () => ({ params: {} }), useRouter: () => ({ replace() {} }) },
    '../stores/server': { useServerStore: () => server },
    '../stores/chat': { useChatStore: () => chat },
    '../stores/auth': { useAuthStore: () => auth },
    '../stores/voice': { useVoiceStore: () => voice },
    '../stores/site': { useSiteStore: () => ({ siteName: 'Test chat' }) },
    '../stores/notifications': { useNotificationStore: () => notifications },
    '../utils/api': { api: { getServer: id => new Promise((resolve, reject) => serverRequests.push({ id, resolve, reject })) } },
    '../utils/ws': { ws: homeWs },
    '../utils/channel-type': { isMessageChannel: channel => channel?.type === 'text' || channel?.type === 'announcement' },
    '../utils/push-to-talk': { installPushToTalk: (_window, _document, options) => {
      pttOptions = options
      pttInstalled++
      return { release() { pttReleased++ }, dispose() { pttDisposed++ } }
    } },
    '../utils/chat-viewport': { observeChatViewport: () => () => {} }
  }
  globals.exports = {}
  globals.require = name => {
    if (name.endsWith('.vue')) return { default: { render: () => null } }
    assert.ok(dependencies[name], `Unexpected Home dependency: ${name}`)
    return dependencies[name]
  }
  vm.runInNewContext(`(function () {\n${homeCode}\n})()`, globals)
  const Home = globals.exports.default
  // Exercise real setup/mounted/watch/unmounted hooks; child presentation is outside this test.
  Home.render = () => { homeInstance = Vue.getCurrentInstance(); return Vue.h('div') }
  const node = () => ({ children: [], parent: null })
  const renderer = Vue.createRenderer({
    createElement: node, createText: node, createComment: node,
    insert(child, parent) { child.parent = parent; parent.children.push(child) },
    remove(child) { child.parent.children.splice(child.parent.children.indexOf(child), 1) },
    parentNode: child => child.parent, nextSibling: () => null,
    setText() {}, setElementText() {}, patchProp() {}
  })
  let app = null
  const mount = () => {
    assert.equal(app, null)
    app = renderer.createApp(Home)
    app.mount(node())
    homeInstance.setupState.chatBoxRef = { async locateMessage(id) { located.push(id); return true }, cancelLocation() { locationCancellations++ } }
  }
  const unmount = () => { app?.unmount(); app = null }
  const reconnect = () => {
    sockets.at(-1).close()
    assert.equal(timers.size, 1)
    const [id, timer] = timers.entries().next().value
    timers.delete(id)
    timer.callback()
    sockets.at(-1).open()
  }
  ws.connect('home-token')
  sockets[0].open()
  return {
    server, chat, voice, sockets, subscriptions, reconnectHandlers, documentListeners,
    loads, added, updated, deleted, voiceJoins, resolveServers, mount, unmount, reconnect,
    auth, notifications, serverRequests, located, navigationResults, restoredVoiceJoins,
    focused, screenRefreshes, cleanedScreens, screenPlayback,
    get state() { return homeInstance.setupState },
    document: globals.document,
    dispatchDocument(type, event) { for (const callback of documentEvents.get(type) || []) callback(event) },
    get screenTimers() { return [...timers.entries()].filter(([, timer]) => timer.delay === 2000) },
    runTimer(id) { const timer = timers.get(id); timers.delete(id); timer?.callback() },
    get locationCancellations() { return locationCancellations },
    get pttLifecycle() { return { installed: pttInstalled, released: pttReleased, disposed: pttDisposed } },
    get pttEnabled() { return pttOptions?.enabled() },
    async cleanup() { unmount(); resolveServers(); await settle(); ws.disconnect() }
  }
}

test('进入 Home 时已有文字频道立即订阅，不等待服务器列表加载', async () => {
  const h = createHomeHarness()
  try {
    h.mount()
    assert.deepEqual(h.sockets[0].sent, [{ type: 'join-channel', channelId: 'text-a' }])
    assert.deepEqual(h.loads, ['text-a'])
    assert.equal(h.subscriptions.get('message').size, 1)
    assert.equal(h.reconnectHandlers.size, 1)
    h.resolveServers()
    await settle()
    assert.deepEqual(h.loads, ['text-a'])
  } finally { await h.cleanup() }
})

test('列表请求尚未完成时已处理消息、新编辑及删除，只接收当前频道', async () => {
  const h = createHomeHarness()
  try {
    h.mount()
    const socket = h.sockets[0]
    socket.message({ type: 'message', channelId: 'text-a', message: { id: 'message-a', content: 'original' } })
    assert.equal(h.chat.messages[0].content, 'original')
    socket.message({ type: 'message-updated', channelId: 'text-a', message: { id: 'message-a', content: 'edited' } })
    assert.equal(h.chat.messages[0].content, 'edited')
    socket.message({ type: 'message', channelId: 'other-channel', message: { id: 'ignored' } })
    socket.message({ type: 'message-updated', channelId: 'other-channel', message: { id: 'message-a', content: 'ignored' } })
    socket.message({ type: 'message-deleted', channelId: 'other-channel', messageId: 'message-a' })
    assert.equal(h.chat.messages.length, 1)
    assert.equal(h.chat.messages[0].content, 'edited')
    socket.message({ type: 'message-deleted', channelId: 'text-a', messageId: 'message-a' })
    assert.equal(h.chat.messages.length, 0)
    assert.equal(h.added.length, 1)
    assert.deepEqual(h.updated, ['message-a'])
    assert.deepEqual(h.deleted, ['message-a'])
  } finally { await h.cleanup() }
})

test('卸载 Home 移除全部事件与重连监听，迟到推送不再改动消息', async () => {
  const h = createHomeHarness()
  try {
    h.mount()
    h.resolveServers()
    await settle()
    h.unmount()
    assert.ok([...h.subscriptions.values()].every(callbacks => callbacks.size === 0))
    assert.equal(h.reconnectHandlers.size, 0)
    assert.equal(h.documentListeners.size, 0)
    assert.deepEqual(h.pttLifecycle, { installed: 1, released: 0, disposed: 1 })
    h.sockets[0].message({ type: 'message', channelId: 'text-a', message: { id: 'late-message' } })
    h.sockets[0].message({ type: 'message-updated', channelId: 'text-a', message: { id: 'late-message' } })
    h.sockets[0].message({ type: 'message-deleted', channelId: 'text-a', messageId: 'late-message' })
    assert.equal(h.added.length, 0)
    assert.equal(h.updated.length, 0)
    assert.equal(h.deleted.length, 0)
    h.reconnect()
    assert.deepEqual(h.sockets[1].sent, [])
    assert.deepEqual(h.loads, ['text-a'])
  } finally { await h.cleanup() }
})

test('主页发言方式、快捷键和房间变化释放旧按键状态，卸载只解绑一次', async () => {
  const h = createHomeHarness()
  try {
    h.mount(); h.resolveServers(); await settle()
    h.voice.currentRoom = 'voice-room'
    await Vue.nextTick()
    h.voice.voiceMode = 'push-to-talk'
    await Vue.nextTick()
    h.voice.pushToTalkKey = 'KeyV'
    await Vue.nextTick()
    assert.equal(h.pttLifecycle.installed, 1)
    assert.equal(h.pttLifecycle.released, 3)
    h.unmount()
    assert.equal(h.pttLifecycle.disposed, 1)
  } finally { await h.cleanup() }
})

test('离开期间断线，返回同一频道会重新订阅，后续重连只有一个处理器', async () => {
  const h = createHomeHarness()
  try {
    h.mount()
    h.resolveServers()
    await settle()
    h.unmount()
    h.voice.currentRoom = 'voice-a'
    h.reconnect()
    assert.deepEqual(h.voiceJoins, [])
    h.mount()
    await settle()
    assert.deepEqual(h.sockets[1].sent, [{ type: 'join-channel', channelId: 'text-a' }])
    assert.deepEqual(h.loads, ['text-a', 'text-a'])
    h.sockets[1].message({ type: 'message', channelId: 'text-a', message: { id: 'returned-message' } })
    assert.equal(h.added.length, 1)
    h.reconnect()
    assert.deepEqual(h.sockets[2].sent, [{ type: 'join-channel', channelId: 'text-a' }])
    assert.deepEqual(h.loads, ['text-a', 'text-a', 'text-a'])
    assert.deepEqual(h.voiceJoins, ['voice-a'])
    assert.equal(h.reconnectHandlers.size, 1)
  } finally { await h.cleanup() }
})

test('频道 ID 改变才重新加载，切换到语音频道时退出文字订阅', async () => {
  const h = createHomeHarness()
  try {
    h.mount()
    h.resolveServers()
    await settle()
    h.server.currentChannel = { id: 'text-a', type: 'text', name: 'Renamed' }
    await Vue.nextTick()
    assert.deepEqual(h.loads, ['text-a'])
    h.server.currentChannel = { id: 'text-b', type: 'text', name: 'Second' }
    await Vue.nextTick()
    assert.deepEqual(h.loads, ['text-a', 'text-b'])
    h.server.currentChannel = { id: 'voice-a', type: 'voice', name: 'Voice' }
    await Vue.nextTick()
    assert.deepEqual(h.sockets[0].sent, [
      { type: 'join-channel', channelId: 'text-a' },
      { type: 'join-channel', channelId: 'text-b' },
      { type: 'leave-channel' }
    ])
  } finally { await h.cleanup() }
})

const target = (id = 'notification-message', channelId = 'text-target', serverId = 'server-target') => ({
  serverId, channelId, reason: 'mention', message: { id, channelId, sequence: 2 }
})
const destination = item => ({
  server: { id: item.serverId }, channels: [{ id: item.channelId, name: '提醒频道', type: 'text' }],
  categories: [], members: [{ userId: 'home-user' }], roles: []
})

test('跨社区通知等待认证与页面加载，切换目标频道后加载并定位原消息', async () => {
  const h = createHomeHarness()
  try {
    h.notifications.pendingTarget = target()
    h.mount()
    assert.equal(h.serverRequests.length, 0)
    h.resolveServers()
    await settle()
    assert.equal(h.serverRequests[0].id, 'server-target')
    h.serverRequests[0].resolve(destination(h.notifications.pendingTarget))
    await settle()
    assert.equal(h.server.currentServer.id, 'server-target')
    assert.equal(h.server.currentChannel.id, 'text-target')
    assert.deepEqual(h.located, ['notification-message'])
    assert.deepEqual(h.loads, ['text-a', 'text-target'])
    assert.deepEqual(h.navigationResults, [{ id: 'notification-message', failure: '' }])
  } finally { await h.cleanup() }
})

test('公告频道在主页与文字频道共用订阅和重连，欢迎页退出消息订阅', async () => {
  const h = createHomeHarness()
  try {
    h.server.currentChannel = { id: 'announcement', type: 'announcement' }
    h.mount(); h.resolveServers(); await settle()
    assert.deepEqual(h.loads, ['announcement'])
    assert.deepEqual(h.sockets[0].sent, [{ type: 'join-channel', channelId: 'announcement' }])
    h.reconnect(); await settle()
    assert.deepEqual(h.loads, ['announcement', 'announcement'])
    h.server.setCurrentChannel(null); await settle()
    assert.equal(h.sockets.at(-1).sent.at(-1).type, 'leave-channel')
  } finally { await h.cleanup() }
})

test('公告通知能跨社区加载并定位，仍检查成员身份', async () => {
  const h = createHomeHarness()
  try {
    h.mount(); h.resolveServers(); await settle()
    const item = target('notice', 'announcement-target')
    h.notifications.pendingTarget = item; await settle()
    const data = destination(item); data.channels[0].type = 'announcement'
    h.serverRequests[0].resolve(data); await settle()
    assert.equal(h.server.currentChannel.type, 'announcement')
    assert.deepEqual(h.located, ['notice'])
  } finally { await h.cleanup() }
})

test('通知详情快照被社区删除或新导航拒绝时保留当前频道并提示，不定位旧消息', async () => {
  const h = createHomeHarness({ rejectSnapshot: true })
  try {
    h.mount(); h.resolveServers(); await settle()
    const item = target(); h.notifications.pendingTarget = item; await settle()
    h.serverRequests[0].resolve(destination(item)); await settle()
    assert.equal(h.server.currentServer.id, 'server-a'); assert.deepEqual(h.located, [])
    assert.match(h.navigationResults[0].failure, /社区选择或访问权限已变化/)
  } finally { await h.cleanup() }
})

test('保存语音的社区快照被拒绝后不覆盖当前页或重新开麦', async () => {
  const h = createHomeHarness({ rejectSnapshot: true, savedVoice: { serverId: 'server-saved', roomId: 'voice-saved', isMuted: true, isDeafened: false } })
  try {
    h.mount(); h.resolveServers(); await settle()
    h.serverRequests[0].resolve({ ...destination(target('saved', 'voice-saved', 'server-saved')), channels: [{ id: 'voice-saved', type: 'voice' }] })
    await settle()
    assert.equal(h.server.currentServer.id, 'server-a'); assert.equal(h.server.currentChannel.id, 'text-a')
    assert.deepEqual(h.restoredVoiceJoins, [])
  } finally { await h.cleanup() }
})

test('社区资料设置打开时禁止按键发言、释放按住状态，换社区关闭旧设置', async () => {
  const h = createHomeHarness()
  try {
    h.voice.currentRoom = 'room'; h.voice.voiceMode = 'push-to-talk'
    h.mount(); h.resolveServers(); await settle()
    assert.equal(h.pttEnabled, true)
    const released = h.pttLifecycle.released
    h.state.showServerSettings = true; await settle()
    assert.equal(h.pttEnabled, false); assert.ok(h.pttLifecycle.released > released)
    h.server.currentServer = { id: 'another' }; await settle()
    assert.equal(h.state.showServerSettings, false); assert.equal(h.pttEnabled, true)
  } finally { await h.cleanup() }
})

test('通知请求期间手动切换频道，旧服务器响应不会覆盖用户选择', async () => {
  const h = createHomeHarness()
  try {
    h.mount(); h.resolveServers(); await settle()
    const item = target()
    h.notifications.pendingTarget = item
    await settle()
    h.server.setCurrentChannel({ id: 'manual-channel', type: 'text' })
    await Vue.nextTick()
    h.serverRequests[0].resolve(destination(item))
    await settle()
    assert.equal(h.server.currentServer.id, 'server-a')
    assert.equal(h.server.currentChannel.id, 'manual-channel')
    assert.deepEqual(h.located, [])
    assert.equal(h.notifications.pendingTarget, null)
  } finally { await h.cleanup() }
})

test('连续选择两个通知，旧请求和旧定位被取消，只有最新目标提交', async () => {
  const h = createHomeHarness()
  try {
    h.mount(); h.resolveServers(); await settle()
    const first = target('first'), second = target('second', 'text-second', 'server-second')
    h.notifications.pendingTarget = first
    await settle()
    h.notifications.pendingTarget = second
    await settle()
    assert.ok(h.locationCancellations > 0)
    h.serverRequests[0].resolve(destination(first))
    await settle()
    assert.equal(h.server.currentServer.id, 'server-a')
    h.serverRequests[1].resolve(destination(second))
    await settle()
    assert.equal(h.server.currentServer.id, 'server-second')
    assert.deepEqual(h.located, ['second'])
  } finally { await h.cleanup() }
})

test('通知所在社区已退出时保留当前频道并报告无法访问，卸载后忽略请求', async () => {
  const h = createHomeHarness()
  try {
    h.mount(); h.resolveServers(); await settle()
    const item = target()
    h.notifications.pendingTarget = item
    await settle()
    const unavailable = destination(item); unavailable.members = []
    h.serverRequests[0].resolve(unavailable)
    await settle()
    assert.equal(h.server.currentServer.id, 'server-a')
    assert.match(h.notifications.navigationError, /无法访问/)
    h.notifications.pendingTarget = target('late')
    await settle()
    h.unmount()
    h.serverRequests[1].resolve(destination(target('late')))
    await settle()
    assert.equal(h.server.currentServer.id, 'server-a')
    assert.deepEqual(h.located, [])
  } finally { await h.cleanup() }
})

test('刷新恢复语音在加入前传入静音与耳机静音初态，不先开麦再切换', async () => {
  const h = createHomeHarness({ savedVoice: { serverId: 'saved-server', roomId: 'saved-room', isMuted: true, isDeafened: true } })
  try {
    h.mount(); h.resolveServers(); await settle()
    assert.equal(h.serverRequests[0].id, 'saved-server')
    h.serverRequests[0].resolve({ server: { id: 'saved-server' }, channels: [{ id: 'saved-room', type: 'voice' }], categories: [], members: [{ userId: 'home-user' }], roles: [] })
    await settle()
    assert.deepEqual(h.restoredVoiceJoins, [{ roomId: 'saved-room', state: { isMuted: true, isDeafened: true } }])
  } finally { await h.cleanup() }
})

test('恢复语音等待期间手动换频道或更换账号，旧返回不能提交社区或重新入房', async () => {
  for (const change of [h => h.server.setCurrentChannel({ id: 'manual', type: 'text' }), h => { h.auth.user = { id: 'other-user' } }]) {
    const h = createHomeHarness({ savedVoice: { serverId: 'saved-server', roomId: 'saved-room', isMuted: true, isDeafened: false } })
    try {
      h.mount(); h.resolveServers(); await settle()
      change(h); await Vue.nextTick()
      h.serverRequests[0].resolve({ server: { id: 'saved-server' }, channels: [{ id: 'saved-room', type: 'voice' }], categories: [], members: [{ userId: 'home-user' }, { userId: 'other-user' }], roles: [] })
      await settle()
      assert.equal(h.server.currentServer.id, 'server-a')
      assert.deepEqual(h.restoredVoiceJoins, [])
    } finally { await h.cleanup() }
  }
})

function enterSharedRoom(h) {
  h.server.currentChannel = { id: 'voice-a', type: 'voice' }
  h.voice.currentRoom = 'voice-a'
  h.voice.remoteScreens = [{ userId: 'screen-user', stream: { id: 'screen-stream' }, ts: 1 }]
}

test('影院需当前语音画面，进入退出恢复焦点且不离房，最后画面停止自动退出', async () => {
  const h = createHomeHarness()
  try {
    h.mount(); h.resolveServers(); await settle()
    h.state.setCinemaMode(true)
    assert.equal(h.state.cinemaMode, false)
    enterSharedRoom(h)
    h.state.setCinemaMode(true); await Vue.nextTick()
    assert.equal(h.state.cinemaMode, true)
    assert.ok(h.focused.includes('[aria-label="退出影院模式"]'))
    h.state.setCinemaMode(false); await Vue.nextTick()
    assert.equal(h.focused.at(-1), 'trigger')
    assert.equal(h.voice.currentRoom, 'voice-a')
    h.state.setCinemaMode(true)
    h.voice.remoteScreens = []
    assert.equal(h.state.cinemaMode, false)
    assert.equal(h.voice.currentRoom, 'voice-a')
  } finally { await h.cleanup() }
})

test('影院 Escape 先关闭诊断，原生全屏或已处理事件不误退布局，换频道清理界面', async () => {
  const h = createHomeHarness()
  const escape = (extra = {}) => ({ key: 'Escape', defaultPrevented: false, isComposing: false, preventDefault() { this.defaultPrevented = true }, ...extra })
  try {
    h.mount(); h.resolveServers(); await settle(); enterSharedRoom(h)
    h.state.setCinemaMode(true); h.state.diagnosticsOpen = true
    h.dispatchDocument('keydown', escape())
    assert.equal(h.state.diagnosticsOpen, false)
    assert.equal(h.state.cinemaMode, true)
    h.document.fullscreenElement = {}
    h.dispatchDocument('keydown', escape())
    assert.equal(h.state.cinemaMode, true)
    h.document.fullscreenElement = null
    h.dispatchDocument('keydown', escape({ defaultPrevented: true }))
    assert.equal(h.state.cinemaMode, true)
    h.dispatchDocument('keydown', escape())
    assert.equal(h.state.cinemaMode, false)
    h.state.setCinemaMode(true); h.state.diagnosticsOpen = true
    h.server.currentChannel = { id: 'text-other', type: 'text' }
    assert.equal(h.state.cinemaMode, false)
    assert.equal(h.state.diagnosticsOpen, false)
  } finally { await h.cleanup() }
})

test('共享刷新延时按房间与成员隔离，停止、换房、换账号或卸载取消旧任务', async () => {
  for (const finish of [
    h => h.sockets[0].message({ type: 'screen-share-stop', roomId: 'voice-a', userId: 'screen-user' }),
    h => { h.voice.currentRoom = 'voice-other' },
    h => { h.auth.user = { id: 'other-user' } },
    h => h.unmount()
  ]) {
    const h = createHomeHarness()
    try {
      h.mount(); h.resolveServers(); await settle(); enterSharedRoom(h)
      h.voice.remoteScreens = []
      h.sockets[0].message({ type: 'screen-share-start', roomId: 'foreign-room', userId: 'screen-user' })
      assert.equal(h.screenTimers.length, 0)
      h.sockets[0].message({ type: 'screen-share-start', roomId: 'voice-a', userId: 'screen-user' })
      const [, scheduled] = h.screenTimers[0]
      finish(h)
      scheduled.callback()
      assert.equal(h.screenTimers.length, 0)
      assert.deepEqual(h.screenRefreshes, [])
    } finally { await h.cleanup() }
  }
})

test('只刷新尚未收到的当前成员画面，其他房间停止不移除现有画面', async () => {
  const h = createHomeHarness()
  try {
    h.mount(); h.resolveServers(); await settle(); enterSharedRoom(h)
    h.sockets[0].message({ type: 'screen-share-stop', roomId: 'foreign-room', userId: 'screen-user' })
    assert.equal(h.voice.remoteScreens.length, 1)
    h.sockets[0].message({ type: 'screen-share-start', roomId: 'voice-a', userId: 'screen-user' })
    h.runTimer(h.screenTimers[0][0])
    assert.deepEqual(h.screenRefreshes, [])
    h.voice.remoteScreens = []
    h.sockets[0].message({ type: 'screen-share-start', roomId: 'voice-a', userId: 'screen-user' })
    h.runTimer(h.screenTimers[0][0])
    assert.deepEqual(h.screenRefreshes, ['screen-user'])
    h.state.reportScreenPlayback('home-user', { status: 'playing' }, { id: 'local' })
    assert.deepEqual(h.screenPlayback, [])
    h.state.reportScreenPlayback('screen-user', { status: 'paused' }, { id: 'remote' })
    assert.equal(h.screenPlayback.length, 1)
  } finally { await h.cleanup() }
})

test('打开连接诊断禁用快捷键发言并释放已按住状态，关闭恢复当前房间设置', async () => {
  const h = createHomeHarness()
  try {
    h.mount(); h.resolveServers(); await settle(); enterSharedRoom(h)
    h.voice.voiceMode = 'push-to-talk'
    assert.equal(h.pttEnabled, true)
    const releases = h.pttLifecycle.released
    h.state.diagnosticsOpen = true
    assert.equal(h.pttEnabled, false)
    assert.ok(h.pttLifecycle.released > releases)
    h.state.closeDiagnostics(); await Vue.nextTick()
    assert.equal(h.pttEnabled, true)
    assert.equal(h.focused.at(-1), '[data-voice-diagnostics-trigger]')
  } finally { await h.cleanup() }
})

test('离开观看页面清除播放器上报，旧画面迟到状态不会重新写入', async () => {
  const h = createHomeHarness()
  try {
    h.mount(); h.resolveServers(); await settle(); enterSharedRoom(h)
    const stream = h.voice.remoteScreens[0].stream
    h.state.reportScreenPlayback('screen-user', { status: 'playing' }, stream)
    h.server.currentChannel = { id: 'text-other', type: 'text' }
    assert.equal(h.screenPlayback.at(-1)[0], 'screen-user')
    assert.equal(h.screenPlayback.at(-1)[1], null)
    assert.equal(h.screenPlayback.at(-1)[2], stream)
    const count = h.screenPlayback.length
    h.state.reportScreenPlayback('screen-user', { status: 'playing' }, stream)
    assert.equal(h.screenPlayback.length, count)
  } finally { await h.cleanup() }
})
