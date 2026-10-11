import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as Vue from 'vue'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as diagnostics from '../frontend/src/utils/voice-diagnostics.ts'

const source = readFileSync(new URL('../frontend/src/components/VoiceDiagnostics.vue', import.meta.url), 'utf8')
const code = ts.transpileModule(compileScript(parse(source).descriptor, { id: 'voice-diagnostics-test' }).content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText
const settle = async () => { await Vue.nextTick(); await new Promise(resolve => setImmediate(resolve)); await Vue.nextTick() }

function harness() {
  const enabled = [], emitted = []
  const voice = Vue.reactive({ currentRoom: 'room-a', peerDiagnostics: {}, pressed: true,
    setDiagnosticsEnabled(value) { enabled.push(value) }, releasePushToTalk() { this.pressed = false } })
  const props = Vue.reactive({ names: { peer: '小鲸' } })
  const document = { activeElement: null }
  class Element {
    constructor(name) { this.name = name; this.isConnected = true; this.hidden = false; this.children = []; Vue.markRaw(this) }
    focus() { document.activeElement = this }
    querySelectorAll() { return this.children }
    getAttribute() { return null }
  }
  const opener = new Element('opener'), panel = new Element('panel'), close = new Element('close')
  panel.children = [close]; document.activeElement = opener
  const dependencies = { vue: Vue, '../stores/voice': { useVoiceStore: () => voice }, '../utils/voice-diagnostics': diagnostics }
  const context = { exports: {}, document, console, require(name) { assert.ok(dependencies[name], name); return dependencies[name] } }
  vm.runInNewContext(code, context)
  const Component = context.exports.default
  Component.render = () => Vue.h('div')
  let instance
  const setup = Component.setup
  Component.setup = (values, setupContext) => { instance = Vue.getCurrentInstance(); return setup(values, setupContext) }
  const node = () => ({ children: [], parent: null })
  const renderer = Vue.createRenderer({
    createElement: node, createText: node, createComment: node,
    insert(child, parent) { child.parent = parent; parent.children.push(child) },
    remove(child) { child.parent?.children.splice(child.parent.children.indexOf(child), 1) },
    parentNode: child => child.parent, nextSibling: () => null, setText() {}, setElementText() {}, patchProp() {}
  })
  const app = renderer.createApp({ render: () => Vue.h(Component, { names: props.names, onClose: () => emitted.push('close') }) })
  app.mount(node())
  const state = instance.setupState
  state.panelRef = panel; state.closeRef = close
  return { state, voice, props, enabled, emitted, document, opener, close, panel, cleanup: () => app.unmount() }
}

test('面板mount才启用诊断并释放PTT，关闭清采集且恢复打开按钮焦点', async () => {
  const h = harness()
  await settle()
  assert.deepEqual(h.enabled, [true])
  assert.equal(h.voice.pressed, false)
  assert.equal(h.document.activeElement, h.close)
  h.cleanup()
  assert.deepEqual(h.enabled, [true, false])
  assert.equal(h.document.activeElement, h.opener)
})

test('Escape关闭对话框且阻止传播，Tab和Shift+Tab留在面板控件', async () => {
  const h = harness()
  try {
    await settle()
    let prevented = 0, stopped = 0
    h.state.handleKeydown({ key: 'Tab', shiftKey: false, preventDefault() { prevented++ } })
    assert.equal(h.document.activeElement, h.close)
    h.state.handleKeydown({ key: 'Tab', shiftKey: true, preventDefault() { prevented++ } })
    assert.equal(h.document.activeElement, h.close)
    h.state.handleKeydown({ key: 'Escape', preventDefault() { prevented++ }, stopPropagation() { stopped++ } })
    assert.equal(prevented, 3)
    assert.equal(stopped, 1)
    assert.deepEqual(h.emitted, ['close'])
  } finally { h.cleanup() }
})

test('逐成员显示数据响应更新，昵称来自公开映射，未知统计不显示为0', async () => {
  const h = harness()
  try {
    h.voice.peerDiagnostics.peer = diagnostics.emptyPeerDiagnostics('peer', { connectionState: 'connecting', iceConnectionState: 'checking' })
    await settle()
    assert.equal(h.state.peers.length, 1)
    assert.equal(h.state.peers[0].videoIn.framesDecoded, null)
    assert.equal(h.state.memberName('peer'), '小鲸')
    assert.equal(h.state.memberName('missing'), '语音成员')
    assert.equal(h.state.resolution(null, 720), '未提供')
    assert.equal(h.state.candidateType('relay'), '中继')
    assert.equal(h.state.candidateType('constructor'), '未提供')
    h.voice.peerDiagnostics = {}
    await settle()
    assert.equal(h.state.peers.length, 0)
  } finally { h.cleanup() }
})

test('输入法取消组合与已处理的Escape不会关闭诊断面板', async () => {
  const h = harness()
  try {
    await settle()
    for (const extra of [{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }]) {
      h.state.handleKeydown({ key: 'Escape', ...extra, preventDefault() { assert.fail('must preserve input event') }, stopPropagation() { assert.fail('must preserve input event') } })
    }
    assert.deepEqual(h.emitted, [])
  } finally { h.cleanup() }
})

test('同一tick卸载不迟到抢焦点，已移除的打开按钮不重新聚焦', async () => {
  const h = harness()
  h.opener.isConnected = false
  const next = { focus() {} }
  h.document.activeElement = next
  h.cleanup()
  await settle()
  assert.equal(h.document.activeElement, next)
  assert.deepEqual(h.enabled, [true, false])
})
