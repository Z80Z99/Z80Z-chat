import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as Vue from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'

const source = readFileSync(new URL('../frontend/src/components/ScreenShareStage.vue', import.meta.url), 'utf8')
const script = compileScript(parse(source).descriptor, { id: 'screen-share-stage-test', inlineTemplate: true }).content
const code = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
const settle = () => Vue.nextTick()

function harness(t, initial = {}) {
  const players = [], events = []
  let tracksStopped = 0
  const stream = id => Vue.markRaw({ id, getTracks: () => [{ stop() { tracksStopped++ } }] })
  const entry = (userId, name = userId, extra = {}) => ({ userId, name, ts: 1, stream: stream(userId), ...extra })
  const props = Vue.reactive({ entries: [entry('a', '小明'), entry('b', '小明')], cinema: false, ...initial })
  const Player = Vue.defineComponent({
    props: ['userId', 'stream', 'local', 'active', 'name'], emits: ['refresh', 'playback'],
    setup(playerProps, { emit }) {
      const record = { props: playerProps, emit, unmounted: false }
      players.push(record)
      Vue.onUnmounted(() => { record.unmounted = true })
      return () => Vue.h('video', { 'data-screen': playerProps.userId })
    }
  })
  const context = { exports: {}, console, require(name) {
    if (name === 'vue') return Vue
    if (name === './ScreenShareVideo.vue') return { default: Player }
    throw new Error(`Unexpected import ${name}`)
  } }
  vm.runInNewContext(code, context)
  const Component = context.exports.default
  const node = (tag = 'root', text = '') => ({ tag, text, children: [], parent: null, attrs: {}, style: { display: '' } })
  const renderer = Vue.createRenderer({
    createElement: node, createText: text => node('text', text), createComment: text => node('comment', text),
    insert(child, parent, anchor = null) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
      child.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child)
    },
    remove(child) { if (child.parent) { child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null } },
    parentNode: child => child.parent,
    nextSibling: child => child.parent?.children[child.parent.children.indexOf(child) + 1] || null,
    setText(child, text) { child.text = text },
    setElementText(child, text) { child.text = text; child.children = [] },
    patchProp(child, name, previous, value) { child.attrs[name] = value }
  })
  const root = node()
  const app = renderer.createApp({ render: () => Vue.h(Component, {
    entries: props.entries, cinema: props.cinema,
    'onUpdate:cinema': value => events.push(['cinema', value]),
    onRefresh: id => events.push(['refresh', id]),
    onPlayback: (...args) => events.push(['playback', ...args])
  }) })
  app.mount(root)
  const all = (predicate, parent = root) => parent.children.flatMap(child => [...(predicate(child) ? [child] : []), ...all(predicate, child)])
  const byTag = tag => all(child => child.tag === tag)
  const select = async id => { byTag('select')[0].attrs.onChange({ target: { value: id } }); await settle() }
  const visibleIds = () => byTag('article').filter(child => child.style.display !== 'none').map(child => child.attrs['data-screen-stage-user'])
  t.after(() => app.unmount())
  return { props, players, events, stream, entry, select, visibleIds, byTag, get tracksStopped() { return tracksStopped } }
}

test('画面选择按成员 ID 区分重名成员，v-show 保留播放器和传入轨道', async t => {
  const h = harness(t)
  assert.deepEqual(h.visibleIds(), ['a', 'b'])
  assert.equal(h.players.length, 2)
  assert.deepEqual(h.byTag('option').map(option => option.attrs.value), ['', 'a', 'b'])
  await h.select('b')
  assert.deepEqual(h.visibleIds(), ['b'])
  assert.equal(h.players[0].props.active, false)
  assert.equal(h.players[1].props.active, true)
  assert.equal(h.players.length, 2)
  assert.equal(h.players.some(player => player.unmounted), false)
  await h.select('')
  assert.deepEqual(h.visibleIds(), ['a', 'b'])
  assert.equal(h.players[0].props.active, true)
  assert.equal(h.tracksStopped, 0)
})

test('影院默认显示第一画面，明确选择在昵称修改、排序和模式切换后保持', async t => {
  const h = harness(t)
  h.props.cinema = true; await settle()
  assert.deepEqual(h.visibleIds(), ['a'])
  await h.select('b')
  h.props.entries = [{ ...h.props.entries[1], name: '新昵称' }, h.props.entries[0]]
  await settle()
  assert.deepEqual(h.visibleIds(), ['b'])
  assert.equal(h.byTag('select')[0].attrs.value, 'b')
  assert.equal(h.players.length, 2)
  h.props.cinema = false; await settle()
  h.props.cinema = true; await settle()
  assert.deepEqual(h.visibleIds(), ['b'])
  await h.select('')
  h.props.cinema = false; await settle()
  h.props.cinema = true; await settle()
  assert.deepEqual(h.visibleIds(), ['b', 'a'])
})

test('所选成员停止投屏时安全回退，全部画面结束时请求退出影院', async t => {
  const h = harness(t, { cinema: true })
  await h.select('b')
  h.props.entries = [h.props.entries[0]]; await settle()
  assert.deepEqual(h.visibleIds(), ['a'])
  h.props.entries = []; await settle()
  assert.deepEqual(h.events, [['cinema', false]])
  assert.equal(h.byTag('p').some(child => child.attrs.role === 'status' && child.text.includes('没有投屏画面')), true)
  h.props.entries = []; await settle()
  assert.deepEqual(h.events, [['cinema', false]])
  assert.equal(h.tracksStopped, 0)
})

test('影院按钮通过父级切换，不重建播放器；返回按钮具有明确标签', async t => {
  const h = harness(t)
  const toggle = () => h.byTag('button')[0]
  assert.equal(toggle().attrs['aria-label'], '进入影院模式')
  toggle().attrs.onClick()
  assert.deepEqual(h.events, [['cinema', true]])
  h.props.cinema = true; await settle()
  assert.equal(toggle().attrs['aria-label'], '退出影院模式')
  toggle().attrs.onClick()
  assert.deepEqual(h.events, [['cinema', true], ['cinema', false]])
  assert.equal(h.players.length, 2)
  assert.equal(h.players.some(player => player.unmounted), false)
})

test('仅为当前可见远端转发刷新，播放状态携带所属原始 stream，迟到旧事件被拒绝', async t => {
  const h = harness(t)
  const local = h.entry('me', '我', { local: true })
  h.props.entries.push(local); await settle()
  const state = { status: 'playing', paused: false, width: 1920, height: 1080, fps: 30, framesPresented: 1, currentTime: 1 }
  h.players[2].emit('refresh')
  assert.deepEqual(h.events, [])
  await h.select('b')
  h.players[0].emit('refresh')
  h.players[1].emit('refresh')
  assert.deepEqual(h.events, [['refresh', 'b']])
  h.players[1].emit('playback', state)
  assert.equal(h.events[1][0], 'playback')
  assert.equal(h.events[1][1], 'b')
  assert.equal(h.events[1][2], state)
  assert.equal(h.events[1][3], h.props.entries[1].stream)
  const old = h.players[1], next = { ...h.props.entries[1], ts: 2, stream: h.stream('replacement') }
  h.props.entries[1] = next; await settle()
  assert.equal(old.unmounted, true)
  assert.equal(h.players.length, 4)
  const count = h.events.length
  old.emit('playback', state); old.emit('refresh')
  assert.equal(h.events.length, count)
  h.players[3].emit('playback', state)
  assert.equal(h.events.at(-1)[3], next.stream)
  assert.equal(h.tracksStopped, 0)
})
