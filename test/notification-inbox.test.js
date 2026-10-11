import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as Vue from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import * as channelTypes from '../frontend/src/utils/channel-type.ts'

const source = readFileSync(new URL('../frontend/src/components/NotificationInbox.vue', import.meta.url), 'utf8')
const script = compileScript(parse(source).descriptor, { id: 'notification-inbox-test' }).content
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
const escapeContext = { exports: {} }
vm.runInNewContext(compile(readFileSync(new URL('../frontend/src/utils/escape.ts', import.meta.url), 'utf8')), escapeContext)
const settle = async () => { await Vue.nextTick(); await new Promise(resolve => setImmediate(resolve)) }

function harness() {
  const listeners = new Set(), loads = [], preferenceLoads = [], routes = []
  const document = { activeElement: null,
    addEventListener(type, callback) { assert.equal(type, 'keydown'); listeners.add(callback) },
    removeEventListener(type, callback) { listeners.delete(callback) } }
  class Element { isConnected = true; hidden = false; focus() { document.activeElement = this } }
  const trigger = new Element(), first = new Element(), last = new Element()
  const panel = new Element()
  panel.querySelectorAll = () => [first, last]
  panel.contains = value => [panel, first, last].includes(value)
  document.activeElement = trigger
  const store = Vue.reactive({ inboxOpen: false, pendingTarget: null, navigationError: '',
    load: async () => { loads.push(true) }, loadPreference: async id => { preferenceLoads.push(id) },
    requestNavigation(item) { this.pendingTarget = item; this.inboxOpen = false; return true },
    finishNavigation(item, error) { if (this.pendingTarget === item) { this.pendingTarget = null; this.navigationError = error; this.inboxOpen = true } } })
  const server = Vue.reactive({ currentServer: { id: 'server' }, currentChannel: { id: 'channel', type: 'text', name: '聊天' }, channels: [], servers: [] })
  const dependencies = { vue: Vue, 'vue-router': { useRouter: () => ({ push: async route => { routes.push(route) } }) },
    '../stores/notifications': { useNotificationStore: () => store }, '../stores/server': { useServerStore: () => server }, '../utils/escape': escapeContext.exports, '../utils/channel-type': channelTypes }
  const context = { exports: {}, document, HTMLElement: Element, console, require(name) { assert.ok(dependencies[name], name); return dependencies[name] } }
  vm.runInNewContext(compile(script), context)
  const Component = context.exports.default
  let instance
  Component.render = function () { instance = Vue.getCurrentInstance(); return Vue.h('div') }
  const node = () => ({ children: [], parent: null })
  const renderer = Vue.createRenderer({ createElement: node, createText: node, createComment: node,
    insert(child, parent) { child.parent = parent; parent.children.push(child) },
    remove(child) { child.parent.children.splice(child.parent.children.indexOf(child), 1) },
    parentNode: child => child.parent, nextSibling: () => null, setText() {}, setElementText() {}, patchProp() {} })
  const app = renderer.createApp(Component)
  app.mount(node())
  instance.setupState.panelRef = panel
  const key = (value, shiftKey = false) => {
    let prevented = false
    for (const callback of listeners) callback({ key: value, shiftKey, preventDefault() { prevented = true }, stopPropagation() {} })
    return prevented
  }
  return { store, server, document, trigger, first, last, panel, listeners, loads, preferenceLoads, routes, key,
    get setup() { return instance.setupState }, cleanup() { app.unmount() } }
}

test('通知面板打开后加载提醒和当前频道偏好，焦点进入对话框并循环 Tab', async () => {
  const h = harness()
  try {
    h.store.inboxOpen = true
    await settle()
    assert.equal(h.loads.length, 1)
    assert.deepEqual(h.preferenceLoads, ['channel'])
    assert.equal(h.document.activeElement, h.first)
    h.last.focus()
    assert.equal(h.key('Tab'), true)
    assert.equal(h.document.activeElement, h.first)
    assert.equal(h.key('Tab', true), true)
    assert.equal(h.document.activeElement, h.last)
    h.trigger.focus()
    assert.equal(h.key('Tab'), true)
    assert.equal(h.document.activeElement, h.first)
  } finally { h.cleanup() }
})

test('公告频道展示并加载独立提醒偏好，语音频道不加载消息提醒偏好', async () => {
  const h = harness()
  try {
    h.server.currentChannel = { id: 'announcements', type: 'announcement', name: '公告' }
    h.store.inboxOpen = true
    await settle()
    assert.deepEqual(h.preferenceLoads, ['announcements'])
    assert.equal(h.setup.channelId, 'announcements')
    h.server.currentChannel = { id: 'voice', type: 'voice', name: '语音' }
    await settle()
    assert.equal(h.setup.channelId, null)
    assert.deepEqual(h.preferenceLoads, ['announcements'])
  } finally { h.cleanup() }
})

test('Escape 关闭并恢复触发器焦点，卸载清理键盘监听', async () => {
  const h = harness()
  h.store.inboxOpen = true
  await settle()
  assert.equal(h.key('Escape'), true)
  await settle()
  assert.equal(h.store.inboxOpen, false)
  assert.equal(h.document.activeElement, h.trigger)
  assert.equal(h.listeners.size, 0)
  h.store.inboxOpen = true
  await settle()
  h.cleanup()
  assert.equal(h.listeners.size, 0)
})

test('打开后马上卸载不执行迟到焦点切换，已移除触发器不被重新聚焦', async () => {
  const h = harness()
  h.store.inboxOpen = true
  await Vue.nextTick()
  h.cleanup()
  const focusedBefore = h.document.activeElement
  await settle()
  assert.equal(h.document.activeElement, focusedBefore)
  assert.equal(h.listeners.size, 0)
  const other = harness()
  try {
    other.store.inboxOpen = true
    await settle()
    other.trigger.isConnected = false
    other.store.inboxOpen = false
    await settle()
    assert.equal(other.document.activeElement, other.first)
  } finally { other.cleanup() }
})

test('通知摘要显示提及昵称，点击保存导航目标并切回 Home', async () => {
  const h = harness()
  try {
    const item = { message: { content: '你好 <@u-1>', mentionUsers: [{ id: 'u-1', nickname: '南风' }] } }
    assert.equal(h.setup.summary(item), '你好 @南风')
    await h.setup.openNotification(item)
    assert.equal(h.store.pendingTarget.message.content, '你好 <@u-1>')
    assert.deepEqual(h.routes, ['/'])
  } finally { h.cleanup() }
})
