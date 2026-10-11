import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as Vue from 'vue'
import * as Pinia from 'pinia'
import { parse, compileScript } from '@vue/compiler-sfc'

const appSource = readFileSync(new URL('../frontend/src/App.vue', import.meta.url), 'utf8')
const script = compileScript(parse(appSource).descriptor, { id: 'bootstrap-test' }).content
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText
const appCode = compile(script)
const wsCode = compile(readFileSync(new URL('../frontend/src/utils/ws.ts', import.meta.url), 'utf8'))
const authCode = compile(readFileSync(new URL('../frontend/src/stores/auth.ts', import.meta.url), 'utf8'))
const settle = () => new Promise(resolve => setImmediate(resolve))

function mountApp() {
  const tokens = new Map([['token', 'bootstrap-token']])
  const localStorage = {
    getItem: key => tokens.get(key) ?? null,
    setItem: (key, value) => tokens.set(key, value),
    removeItem: key => tokens.delete(key)
  }
  const sockets = []
  const redirects = []
  const intervals = new Map()
  let resolveMe, rejectMe
  const me = new Promise((resolve, reject) => { resolveMe = resolve; rejectMe = reject })

  class FakeWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 3
    readyState = FakeWebSocket.CONNECTING
    sent = []
    constructor(url) { this.url = url; sockets.push(this) }
    send(data) { this.sent.push(JSON.parse(data)) }
    close() { this.readyState = FakeWebSocket.CLOSED; this.onclose?.() }
    open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.() }
  }

  const globals = {
    exports: {}, console, localStorage, WebSocket: FakeWebSocket,
    window: {
      location: { protocol: 'https:', host: 'chat.example.test' },
      addEventListener() {}, removeEventListener() {}
    },
    fetch: async () => ({ json: async () => ({ version: 1 }) }),
    setTimeout, clearTimeout,
    setInterval(callback, delay) { intervals.set(1, { callback, delay }); return 1 },
    clearInterval(id) { intervals.delete(id) }
  }
  vm.runInNewContext(`(function () {\n${wsCode}\n})()`, globals)
  const ws = globals.exports.ws
  const authDependencies = {
    vue: Vue, pinia: Pinia,
    '../utils/ws': { ws },
    '../utils/api': { api: { me: () => me } }
  }
  globals.exports = {}
  globals.require = name => {
    assert.ok(authDependencies[name], `Unexpected auth dependency: ${name}`)
    return authDependencies[name]
  }
  vm.runInNewContext(`(function () {\n${authCode}\n})()`, globals)
  Pinia.setActivePinia(Pinia.createPinia())
  const auth = globals.exports.useAuthStore()
  const dependencies = {
    vue: Vue,
    'vue-router': { useRouter: () => ({ replace: route => redirects.push(route) }) },
    './stores/auth': { useAuthStore: () => auth },
    './stores/site': { useSiteStore: () => ({ init() {} }) },
    './stores/server': { useServerStore: () => ({ currentServer: null }) },
    './stores/voice': { useVoiceStore: () => ({ saveVoiceState() {} }) },
    './stores/read-state': { useReadStateStore: () => ({ mergeState() {}, loadServer: async () => {} }) },
    './stores/notifications': { useNotificationStore: () => ({ activate() {}, deactivate() {} }) },
    './components/NotificationInbox.vue': { default: { render: () => null } },
    './utils/ws': { ws }
  }
  globals.exports = {}
  globals.require = name => {
    assert.ok(dependencies[name], `Unexpected dependency: ${name}`)
    return dependencies[name]
  }
  vm.runInNewContext(`(function () {\n${appCode}\n})()`, globals)
  const App = globals.exports.default
  const Child = {
    setup() {
      Vue.onMounted(() => {
        ws.send({ type: 'join-channel', channelId: 'text' })
        ws.send({ type: 'voice-join', roomId: 'voice' })
      })
      return () => Vue.h('span')
    }
  }
  App.render = () => Vue.h(Child)

  const node = () => ({ children: [], parent: null })
  const renderer = Vue.createRenderer({
    createElement: node, createText: node, createComment: node,
    insert(child, parent) { child.parent = parent; parent.children.push(child) },
    remove(child) { child.parent.children.splice(child.parent.children.indexOf(child), 1) },
    parentNode: child => child.parent, nextSibling: () => null,
    setText() {}, setElementText() {}, patchProp() {}
  })
  const app = renderer.createApp(App)
  app.mount(node())
  return {
    ws, auth, localStorage, sockets, redirects, intervals, resolveMe, rejectMe,
    cleanup() { app.unmount(); ws.disconnect() }
  }
}

test('父 setup 激活连接，子 mounted 订阅可排队，版本检查不等待认证', async () => {
  const h = mountApp()
  try {
    assert.equal(h.sockets.length, 1)
    assert.equal(h.intervals.get(1).delay, 10000)
    h.sockets[0].open()
    assert.deepEqual(h.sockets[0].sent, [
      { type: 'join-channel', channelId: 'text' },
      { type: 'voice-join', roomId: 'voice' }
    ])
    h.resolveMe({ user: { id: 'bootstrap-user' } })
    await settle()
    assert.equal(h.auth.user.id, 'bootstrap-user')
  } finally { h.cleanup() }
})

test('启动认证失败清理登录态并停止连接', async () => {
  const h = mountApp()
  try {
    h.rejectMe(new Error('Expired token'))
    await settle()
    assert.equal(h.sockets[0].readyState, 3)
    assert.equal(h.localStorage.getItem('token'), null)
    assert.equal(h.auth.user, null)
    assert.deepEqual(h.redirects, ['/login'])
  } finally { h.cleanup() }
})

for (const outcome of ['success', 'failure']) {
  test(`迟到的启动认证 ${outcome} 不覆盖后续登录`, async () => {
    const h = mountApp()
    try {
      h.localStorage.setItem('token', 'new-token')
      h.auth.user = { id: 'new-user' }
      h.ws.connect('new-token')
      if (outcome === 'success') h.resolveMe({ user: { id: 'old-user' } })
      else h.rejectMe(new Error('Old token expired'))
      await settle()
      assert.equal(h.localStorage.getItem('token'), 'new-token')
      assert.equal(h.auth.user.id, 'new-user')
      assert.equal(h.sockets[1].readyState, 0)
      assert.deepEqual(h.redirects, [])
    } finally { h.cleanup() }
  })
}
