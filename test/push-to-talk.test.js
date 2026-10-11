import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installPushToTalk, isPushToTalkKey, pushToTalkKeyLabel } from '../frontend/src/utils/push-to-talk.ts'

class Surface {
  listeners = new Map()
  visibilityState = 'visible'
  focused = true
  hasFocus() { return this.focused }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(callback)
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback) }
  dispatch(type, options = {}) {
    const event = { code: 'Space', key: ' ', preventDefault() { this.defaultPrevented = true }, ...options }
    for (const callback of this.listeners.get(type) || []) callback(event)
    return event
  }
}
function harness(t) {
  const win = new Surface(), doc = new Surface(), presses = []
  const state = { enabled: true, code: 'Space' }
  const listener = installPushToTalk(win, doc, { enabled: () => state.enabled, code: () => state.code, setPressed: value => presses.push(value) })
  t.after(() => listener.dispose())
  return { win, doc, presses, state, listener }
}

test('按键发言只按住一次，忽略自动重复，松开后可再次发言', t => {
  const h = harness(t)
  assert.equal(h.win.dispatch('keydown').defaultPrevented, true)
  h.win.dispatch('keydown', { repeat: true })
  h.win.dispatch('keydown')
  assert.deepEqual(h.presses, [true])
  h.win.dispatch('keyup')
  assert.deepEqual(h.presses, [true, false])
  h.win.dispatch('keydown')
  assert.deepEqual(h.presses, [true, false, true])
})

test('未入房、后台网页、失焦、组合键与输入法选字均不打开按键发言', t => {
  const h = harness(t)
  h.state.enabled = false; h.win.dispatch('keydown'); h.state.enabled = true
  h.doc.visibilityState = 'hidden'; h.win.dispatch('keydown'); h.doc.visibilityState = 'visible'
  h.doc.focused = false; h.win.dispatch('keydown'); h.doc.focused = true
  for (const blocked of ['repeat', 'ctrlKey', 'altKey', 'metaKey', 'shiftKey', 'isComposing', 'defaultPrevented']) h.win.dispatch('keydown', { [blocked]: true })
  h.win.dispatch('keydown', { keyCode: 229 })
  h.win.dispatch('keydown', { key: 'Process' })
  h.win.dispatch('keydown', { code: 'KeyV' })
  assert.deepEqual(h.presses, [])
})

test('表单、可编辑区域及 Shadow DOM 输入目标不截获快捷键', t => {
  const h = harness(t)
  for (const target of [
    { closest: () => ({ tagName: 'INPUT' }) },
    { isContentEditable: true },
    { closest: () => ({ role: 'textbox' }) }
  ]) h.win.dispatch('keydown', { target })
  h.win.dispatch('keydown', { target: { closest: () => null }, composedPath: () => [{ closest: () => ({ tagName: 'TEXTAREA' }) }, h.win] })
  assert.deepEqual(h.presses, [])
  h.win.dispatch('keydown', { target: { closest: () => null } })
  assert.deepEqual(h.presses, [true])
})

test('松开按键时进入文字输入或输入法状态，仍必须关闭发言', t => {
  const h = harness(t)
  h.win.dispatch('keydown')
  h.win.dispatch('keyup', { isComposing: true, ctrlKey: true, target: { isContentEditable: true } })
  assert.deepEqual(h.presses, [true, false])
  h.win.dispatch('keydown')
  h.win.dispatch('keyup', { code: 'KeyV' })
  assert.equal(h.presses.at(-1), true)
  h.win.dispatch('keyup')
  assert.equal(h.presses.at(-1), false)
})

test('失焦、进入后台和模式变更主动释放，不会恢复旧按住状态', t => {
  const h = harness(t)
  h.win.dispatch('keydown'); h.win.dispatch('blur')
  assert.equal(h.presses.at(-1), false)
  h.win.dispatch('keydown'); h.doc.visibilityState = 'hidden'; h.doc.dispatch('visibilitychange')
  assert.equal(h.presses.at(-1), false)
  h.doc.visibilityState = 'visible'; h.doc.dispatch('visibilitychange')
  assert.equal(h.presses.at(-1), false)
  h.win.dispatch('keydown'); h.state.code = 'KeyV'; h.listener.release()
  h.win.dispatch('keyup')
  assert.equal(h.presses.at(-1), false)
  h.win.dispatch('keydown', { code: 'KeyV' })
  assert.equal(h.presses.at(-1), true)
})

test('卸载按键发言监听释放麦克风并移除全部监听', t => {
  const h = harness(t)
  h.win.dispatch('keydown')
  h.listener.dispose()
  assert.equal(h.presses.at(-1), false)
  assert.ok([...h.win.listeners.values(), ...h.doc.listeners.values()].every(listeners => listeners.size === 0))
  const count = h.presses.length
  h.win.dispatch('keydown'); h.win.dispatch('keyup'); h.win.dispatch('blur')
  h.listener.dispose()
  assert.equal(h.presses.length, count)
})

test('快捷键只保存可用物理按键，修饰键和未知值不能配置', () => {
  for (const code of ['Space', 'KeyV', 'Digit9', 'F24', 'NumpadEnter', 'ArrowUp', 'IntlYen']) assert.equal(isPushToTalkKey(code), true)
  for (const code of [null, 9, '', 'ShiftLeft', 'Shift', 'ControlRight', 'Escape', 'Tab', 'CapsLock', 'Process', 'Unidentified', 'unknownCode', 'F25', 'keyV']) assert.equal(isPushToTalkKey(code), false)
  assert.equal(pushToTalkKeyLabel('Space'), '空格')
  assert.equal(pushToTalkKeyLabel('KeyV'), 'V')
  assert.equal(pushToTalkKeyLabel('Digit9'), '9')
})
