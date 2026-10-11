import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'
import * as pushToTalk from '../frontend/src/utils/push-to-talk.ts'

const source = readFileSync(new URL('../frontend/src/components/VoiceAudioSettings.vue', import.meta.url), 'utf8')
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const code = ts.transpileModule(`${script}\nglobalThis.controls = { startKeyCapture, captureKey, capturingKey, keyError, toggleExpanded, expanded, transmissionLabel };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText
const buttonSource = readFileSync(new URL('../frontend/src/components/VoicePushToTalkButton.vue', import.meta.url), 'utf8')
const buttonScript = buttonSource.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const buttonCode = ts.transpileModule(`${buttonScript}\nglobalThis.button = { hold, pointerEnded, releasePointer, canHold };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText

class Surface {
  listeners = new Map()
  visibilityState = 'visible'
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(callback)
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback) }
  dispatch(type, event = {}) { for (const callback of this.listeners.get(type) || []) callback(event) }
}
function harness(t, options = {}) {
  const presses = [], settings = [], mounted = [], unmounted = []
  const win = new Surface(), doc = new Surface()
  const props = vue.reactive({ stopKey: 'account:room' })
  const voice = vue.reactive({
    currentRoom: 'room', voiceMode: 'push-to-talk', pushToTalkKey: 'Space', micAvailable: true,
    isMuted: false, isDeafened: false, isTransmitting: false, pushToTalkPressed: false,
    setPushToTalkPressed(active) { presses.push(active); this.pushToTalkPressed = active },
    releasePushToTalk() { presses.push(false); this.pushToTalkPressed = false },
    setPushToTalkKey(code) { settings.push(code); this.pushToTalkKey = code },
    refreshDevices() {}
  })
  const context = {
    exports: {}, window: win, document: doc,
    defineProps: () => props,
    withDefaults: value => value,
    require(name) {
      if (name === 'vue') return { ...vue, onMounted: callback => mounted.push(callback), onBeforeUnmount: callback => unmounted.push(callback) }
      if (name === '../stores/voice') return { useVoiceStore: () => voice }
      if (name === '../utils/push-to-talk') return pushToTalk
      if (name.endsWith('.vue') || name.endsWith('.css')) return {}
      throw new Error(`Unexpected import ${name}`)
    }
  }
  const buttonContext = { ...context, exports: {} }
  const scope = vue.effectScope()
  scope.run(() => {
    if (options.settings !== false) vm.runInNewContext(code, context)
    vm.runInNewContext(buttonCode, buttonContext)
  })
  mounted.forEach(callback => callback())
  const captured = new Set()
  const button = {
    setPointerCapture(id) { captured.add(id) },
    hasPointerCapture(id) { return captured.has(id) },
    releasePointerCapture(id) { captured.delete(id) }
  }
  const pointer = (id = 1, update = {}) => ({ pointerId: id, button: 0, isPrimary: true, currentTarget: button, preventDefault() {}, ...update })
  const key = update => ({ code: 'KeyV', key: 'v', preventDefault() {}, stopPropagation() {}, ...update })
  let disposed = false
  const dispose = () => { if (disposed) return; disposed = true; unmounted.forEach(callback => callback()); scope.stop() }
  t.after(dispose)
  return { ...context.controls, ...buttonContext.button, voice, props, presses, settings, win, doc, captured, pointer, key, dispose }
}

test('按住说话只处理主指针，松开或失去捕获立即停止，其他指针不影响', t => {
  const h = harness(t)
  h.hold(h.pointer(2, { isPrimary: false })); h.hold(h.pointer(3, { button: 2 }))
  assert.deepEqual(h.presses, [])
  h.hold(h.pointer())
  assert.deepEqual(h.presses, [true])
  assert.equal(h.captured.has(1), true)
  h.hold(h.pointer(2))
  h.pointerEnded(h.pointer(2))
  assert.deepEqual(h.presses, [true])
  h.pointerEnded(h.pointer())
  assert.equal(h.presses.at(-1), false)
  assert.equal(h.captured.size, 0)
  h.hold(h.pointer(5))
  h.win.dispatch('pointercancel', h.pointer(5))
  assert.equal(h.presses.at(-1), false)
})

test('静音、耳机静音、麦克风不可用和未入房时不能通过按住按钮绕过', t => {
  const h = harness(t)
  for (const [property, value] of [['isMuted', true], ['isDeafened', true], ['micAvailable', false], ['currentRoom', null], ['voiceMode', 'open']]) {
    const previous = h.voice[property]
    h.voice[property] = value
    const count = h.presses.length
    h.hold(h.pointer())
    assert.equal(h.presses.length, count)
    assert.equal(h.canHold.value, false)
    h.voice[property] = previous
  }
})

test('切换房间、账号、模式或静音时中断当前指针发言', t => {
  const h = harness(t)
  for (const mutate of [
    () => { h.props.stopKey = 'new-account:room' },
    () => { h.voice.currentRoom = 'new-room' },
    () => { h.voice.voiceMode = 'open' },
    () => { h.voice.isMuted = true }
  ]) {
    h.voice.voiceMode = 'push-to-talk'; h.voice.isMuted = false
    h.hold(h.pointer())
    assert.equal(h.presses.at(-1), true)
    mutate()
    assert.equal(h.presses.at(-1), false)
    assert.equal(h.captured.size, 0)
  }
})

test('按键设置排除组合键、输入法与未知键，正确保存单个物理按键', t => {
  const h = harness(t)
  h.startKeyCapture()
  assert.equal(h.capturingKey.value, true)
  for (const update of [{ ctrlKey: true }, { shiftKey: true }, { isComposing: true }, { keyCode: 229 }, { code: 'ShiftLeft' }, { code: 'UnknownCode' }]) h.captureKey(h.key(update))
  assert.deepEqual(h.settings, [])
  assert.match(h.keyError.value, /不带组合键/)
  h.captureKey(h.key({}))
  assert.deepEqual(h.settings, ['KeyV'])
  assert.equal(h.capturingKey.value, false)
  assert.equal(h.keyError.value, '')
  h.startKeyCapture(); h.captureKey(h.key({ code: 'Escape', key: 'Escape' }))
  assert.equal(h.capturingKey.value, false)
  assert.deepEqual(h.settings, ['KeyV'])
})

test('失焦、后台、设置收起和组件卸载均释放发言，卸载清除事件', t => {
  const h = harness(t)
  for (const cancel of [
    () => h.win.dispatch('blur'),
    () => { h.doc.visibilityState = 'hidden'; h.doc.dispatch('visibilitychange'); h.doc.visibilityState = 'visible' },
    () => h.toggleExpanded()
  ]) {
    h.hold(h.pointer())
    assert.equal(h.presses.at(-1), true)
    cancel()
    assert.equal(h.presses.at(-1), false)
  }
  h.hold(h.pointer()); h.dispose()
  assert.equal(h.presses.at(-1), false)
  assert.ok([...h.win.listeners.values(), ...h.doc.listeners.values()].every(listeners => listeners.size === 0))
})

test('影院独立按住按钮在核心释放发言后清除捕获，无需挂载音频设置', t => {
  const h = harness(t, { settings: false })
  h.hold(h.pointer())
  assert.equal(h.voice.pushToTalkPressed, true)
  assert.equal(h.captured.has(1), true)
  // Disconnection or account changes can release the core before pointerup arrives.
  h.voice.releasePushToTalk()
  assert.equal(h.voice.pushToTalkPressed, false)
  assert.equal(h.captured.size, 0)
  h.hold(h.pointer(2))
  assert.equal(h.voice.pushToTalkPressed, true)
  h.dispose()
  assert.equal(h.voice.pushToTalkPressed, false)
  assert.equal(h.captured.size, 0)
})
