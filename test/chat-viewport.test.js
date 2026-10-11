import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const code = ts.transpileModule(readFileSync(new URL('../frontend/src/utils/chat-viewport.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText
const globals = { exports: {} }
vm.runInNewContext(code, globals)
const { observeChatViewport } = globals.exports

class Target extends EventTarget {
  listeners = new Set()
  addEventListener(type, callback) { this.listeners.add(callback); super.addEventListener(type, callback) }
  removeEventListener(type, callback) { super.removeEventListener(type, callback); this.listeners.delete(callback) }
  fire(type) { this.dispatchEvent(new Event(type)) }
}
function fixture() {
  const browser = new Target(), document = new Target(), viewport = new Target()
  Object.assign(browser, { innerWidth: 390, innerHeight: 800, document, visualViewport: viewport })
  Object.assign(viewport, { height: 800, offsetTop: 0, scale: 1 })
  document.activeElement = null
  const frames = new Map(), states = []
  let number = 0
  browser.requestAnimationFrame = callback => { const id = ++number; frames.set(id, callback); return id }
  browser.cancelAnimationFrame = id => frames.delete(id)
  const stop = observeChatViewport(browser, value => states.push(JSON.parse(JSON.stringify(value))))
  const flush = () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback() } }
  const focus = (readonly = false) => { document.activeElement = { matches: () => true, hasAttribute: name => name === 'readonly' && readonly }; document.fire('focusin') }
  return { browser, document, viewport, frames, states, stop, flush, focus, state: () => states.at(-1) }
}

test('仅可见视口缩小并平移时，输入区跟随键盘且隐藏底部导航', () => {
  const f = fixture()
  f.focus()
  Object.assign(f.viewport, { height: 420, offsetTop: 70 })
  f.viewport.fire('resize')
  f.viewport.fire('scroll')
  assert.equal(f.frames.size, 1, '同一帧内的多个事件合并')
  f.flush()
  assert.deepEqual(f.state(), { isMobile: true, keyboardOpen: true, style: { '--chat-viewport-height': '420px', '--chat-viewport-top': '70px' } })
  f.viewport.height = 800
  f.viewport.offsetTop = 0
  f.viewport.fire('resize')
  f.flush()
  assert.equal(f.state().keyboardOpen, false)
  f.stop()
})

test('浏览器同时缩小布局与可见视口时保留聚焦前基线，桌面和旋转清理旧偏移', () => {
  const f = fixture()
  f.focus()
  f.browser.innerHeight = 420
  f.viewport.height = 420
  f.browser.fire('resize')
  f.flush()
  assert.equal(f.state().keyboardOpen, true)
  f.browser.innerWidth = 900
  f.browser.innerHeight = 390
  f.viewport.height = 390
  f.browser.fire('orientationchange')
  f.flush()
  assert.deepEqual(f.state(), { isMobile: false, keyboardOpen: false, style: {} })
  f.stop()
})

test('地址栏变化、只读输入与缩放不误判软键盘，失焦恢复导航', () => {
  const f = fixture()
  f.viewport.height = 620
  f.viewport.fire('resize')
  f.flush()
  assert.equal(f.state().keyboardOpen, false)
  f.focus(true)
  f.viewport.height = 400
  f.viewport.fire('resize')
  f.flush()
  assert.equal(f.state().keyboardOpen, false)
  f.focus()
  f.viewport.scale = 1.5
  f.viewport.offsetTop = 90
  f.viewport.fire('resize')
  f.flush()
  assert.equal(f.state().keyboardOpen, false)
  assert.equal(f.state().style['--chat-viewport-height'], '800px')
  assert.equal(f.state().style['--chat-viewport-top'], '0px')
  f.document.activeElement = null
  f.document.fire('focusout')
  f.flush()
  assert.equal(f.state().keyboardOpen, false)
  f.stop()
})

test('离开主页释放窗口、文档与视口监听，迟到的动画帧不再修改页面', () => {
  const f = fixture()
  f.viewport.fire('resize')
  const late = [...f.frames.values()][0]
  const count = f.states.length
  f.stop()
  assert.equal(f.frames.size, 0)
  for (const target of [f.browser, f.document, f.viewport]) assert.equal(target.listeners.size, 0)
  late()
  f.browser.fire('resize')
  assert.equal(f.states.length, count)
})
