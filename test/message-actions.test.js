import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'
import * as layout from '../frontend/src/utils/message-layout.ts'
import { createMessagePress } from '../frontend/src/utils/message-press.ts'
import * as messageMentions from '../frontend/src/utils/message-mentions.ts'
import * as contentFormat from '../frontend/src/utils/escape.ts'
import * as drafts from '../frontend/src/utils/chat-draft.ts'
import * as channelTypes from '../frontend/src/utils/channel-type.ts'

function clock() {
  let time = 0
  let nextId = 0
  const timers = new Map()
  return {
    timers,
    now: () => time,
    schedule(callback, delay) { const id = ++nextId; timers.set(id, { callback, due: time + delay }); return id },
    clear(id) { timers.delete(id) },
    advance(duration) {
      const end = time + duration
      while (true) {
        const entry = [...timers].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0]
        if (!entry) break
        timers.delete(entry[0]); time = entry[1].due; entry[1].callback()
      }
      time = end
    }
  }
}
const point = (overrides = {}) => ({ pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 50, clientY: 100, ...overrides })

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test('静止主触摸500ms打开操作，长时间按住及松手后的合成点击均被阻止', () => {
  const timers = clock()
  const opened = []
  const press = createMessagePress(context => { opened.push(context.messageId); return true }, timers)
  press.begin(point(), { messageId: 'one' })
  timers.advance(499)
  assert.equal(opened.length, 0)
  timers.advance(1)
  assert.deepEqual(opened, ['one'])
  timers.advance(3000)
  assert.equal(press.suppressesClick(), true)
  press.end(point())
  timers.advance(899)
  assert.equal(press.suppressesClick(), true)
  timers.advance(1)
  assert.equal(press.suppressesClick(), false)
})

test('滑动、松手、取消或第二根手指取消长按，鼠标与笔不触发', () => {
  const timers = clock()
  let opened = 0
  const press = createMessagePress(() => { opened++; return true }, timers)
  for (const cancel of [() => press.move(point({ clientY: 111 })), () => press.end(point()), () => press.cancel(), () => press.begin(point({ pointerId: 2, isPrimary: false }), { messageId: 'two' })]) {
    press.begin(point(), { messageId: 'one' }); timers.advance(100); cancel(); timers.advance(500)
  }
  for (const pointerType of ['mouse', 'pen']) { press.begin(point({ pointerType }), { messageId: 'one' }); timers.advance(500) }
  assert.equal(opened, 0)
  assert.equal(timers.timers.size, 0)
  assert.equal(press.suppressesClick(), false)
})

test('失效消息不拦截正常点击，重置取消旧计时，原生触摸菜单也阻止链接误点', () => {
  const timers = clock()
  const press = createMessagePress(() => false, timers)
  press.begin(point(), { messageId: 'one' }); timers.advance(500)
  assert.equal(press.suppressesClick(), false)
  press.begin(point(), { messageId: 'two' }); press.reset(); timers.advance(500)
  assert.equal(press.suppressesClick(), false)
  press.begin(point(), { messageId: 'three' }); press.blockClick(); press.end(point())
  assert.equal(press.suppressesClick(), true)
  timers.advance(900)
  assert.equal(press.suppressesClick(), false)
})

test('浏览器PointerEvent原型上的坐标与ID正确保留，短点击不在松手后触发长按', () => {
  const timers = clock()
  let opened = 0
  const press = createMessagePress(() => { opened++; return true }, timers)
  const event = Object.create(point())
  assert.equal(Object.keys(event).length, 0)
  press.begin(event, { messageId: 'one' }); timers.advance(100); press.end(event); timers.advance(500)
  assert.equal(opened, 0)
  press.begin(event, { messageId: 'one' }); press.move(Object.create(point({ clientY: 105 }))); timers.advance(500)
  assert.equal(opened, 1, '小幅自然抖动不会误取消')
})

test('公告只读成员不能回复或编辑，发布者编辑失权保留内容且不提交', async t => {
  const list = createList(t)
  list.server.currentChannel.type = 'announcement'
  list.server.canPublishAnnouncements = false
  list.server.hasPermission = () => true
  list.replyToMessage(list.chat.messages[0])
  list.startEdit(list.chat.messages[0])
  assert.equal(list.emitted.length, 0)
  assert.equal(list.editingMessageId.value, null)
  list.server.canPublishAnnouncements = true
  list.startEdit(list.chat.messages[0])
  list.editContent.value = '保留编辑的公告'
  list.server.canPublishAnnouncements = false
  await list.saveEdit()
  assert.equal(list.edits.length, 0)
  assert.equal(list.editContent.value, '保留编辑的公告')
  assert.match(list.feedback.value, /没有发布或编辑公告/)
  list.server.canPublishAnnouncements = true
  await list.saveEdit()
  assert.equal(list.edits.length, 1)
})

const source = readFileSync(new URL('../frontend/src/components/MessageList.vue', import.meta.url), 'utf8')
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const code = ts.transpileModule(`${script}\nglobalThis.actions = { showMenu, menuPresentation, selectedMessage, editingMessageId, editContent, editMentionSpans, editComposing, recordEditIntent, handleEditInput, handleEditKeydown, savingEdit, saveEdit, containerRef, sheetRef, beginMessagePress, messagePress, finishMessagePress, handleMessageContextMenu, toggleMenu, closeMenuAndRestoreFocus, handleSheetKeydown, replyToMessage, startEdit, deleteMsg, canManage, handleScroll, visibleReadTarget, locateMessage, togglePin, pinningId, locating, highlightedId, reactionPickerId, openReactions, followingLatest, feedback, handleImageLoad };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText

function createList(t, options = {}) {
  const timers = clock()
  const mounted = []
  const unmounted = []
  const emitted = []
  const deleted = []
  const edits = []
  const pins = []
  const updates = []
  const locations = []
  const read = []
  const listeners = []
  const document = {
    activeElement: null, visibilityState: 'visible', hasFocus: () => true,
    addEventListener(type, callback, capture = false) { listeners.push({ surface: this, type, callback, capture }) },
    removeEventListener(type, callback, capture = false) { const index = listeners.findIndex(item => item.surface === this && item.type === type && item.callback === callback && item.capture === capture); if (index >= 0) listeners.splice(index, 1) },
    querySelector() { return null },
    fire(type, event) { for (const listener of [...listeners]) if (listener.surface === this && listener.type === type) listener.callback(event) }
  }
  const storage = { token: 'session-a', getItem() { return this.token } }
  const window = { ...document, innerWidth: options.width || 360, localStorage: storage }
  const props = vue.reactive({ blocked: !!options.blocked })
  class Element {
    isConnected = true
    dataset = {}
    children = []
    focusCount = 0
    constructor(kind) { this.kind = kind; vue.markRaw(this) }
    focus() { this.focusCount++; document.activeElement = this }
    matches(selector) { return this.kind === 'button' && selector === '.message-menu-button' }
    closest(selector) {
      if (selector.includes('button, input')) return this.kind === 'button' || this.kind === 'textarea' ? this : null
      if (selector === '[data-message-id]') return this.row || (this.kind === 'row' ? this : null)
      return null
    }
    querySelector(selector) { return selector === '.message-menu-button' ? this.trigger : selector === 'button' ? this.children[0] : selector.includes('textarea') ? this.editor : null }
    querySelectorAll(selector) { return selector.includes('button') ? this.children : this.rows || [] }
    contains(element) { return element === this || this.children.includes(element) }
    getBoundingClientRect() { return { left: 0, right: 100, top: 0, bottom: this.kind === 'container' ? 500 : 100, height: this.kind === 'container' ? 500 : 100 } }
  }
  const user = vue.reactive({ user: { id: 'me' } })
  const server = vue.reactive({ currentChannel: { id: 'channel-a', type: 'text' }, currentServer: { id: 'server-a', ownerId: 'me' }, members: [{ serverId: 'server-a', userId: 'me', roles: [] }], roles: [] })
  const messages = [
    { id: 'mine', userId: 'me', sequence: 1, channelId: 'channel-a', content: '我的消息', createdAt: '2026-10-09T01:00:00Z', user: { username: '我' } },
    { id: 'other', userId: 'other', sequence: 2, channelId: 'channel-a', content: '别人的链接 https://example.test', createdAt: '2026-10-09T01:01:00Z', user: { username: '别人' } }
  ]
  const chat = vue.reactive({
    messages, currentChannelId: 'channel-a', loading: false, hasMore: false, loadError: '', viewingContext: false,
    removeMessage(id) { deleted.push(id); this.messages = this.messages.filter(message => message.id !== id) },
    updateMessage(id, message) { updates.push([id, message]); this.messages = this.messages.map(item => item.id === id ? { ...item, ...message } : item) },
    locateMessage(channelId, messageId) { locations.push([channelId, messageId]); return options.locate ? options.locate(channelId, messageId) : Promise.resolve(this.messages.some(message => message.id === messageId)) },
    loadMore(channelId) { return options.loadMore ? options.loadMore(channelId) : Promise.resolve() }
  })
  const readStore = vue.reactive({ states: options.readState ? { 'channel-a': { readSequence: 0 } } : {}, readErrors: {}, markRead(...args) { read.push(args) } })
  const context = {
    exports: {}, console, document, window, localStorage: storage, Element, HTMLElement: Element, ResizeObserver: class { observe() {} disconnect() {} },
    confirm: () => options.confirm !== false,
    setTimeout: timers.schedule, clearTimeout: timers.clear,
    defineEmits: () => (...args) => emitted.push(args),
    defineProps: () => props,
    defineExpose: () => {},
    require(name) {
      if (name === 'vue') return { ...vue, onMounted: callback => mounted.push(callback), onUnmounted: callback => unmounted.push(callback) }
      if (name === '../stores/server') return { useServerStore: () => server }
      if (name === '../stores/chat') return { useChatStore: () => chat }
      if (name === '../stores/auth') return { useAuthStore: () => user }
      if (name === '../stores/read-state') return { useReadStateStore: () => readStore }
      if (name === '../utils/api') return { api: {
        deleteMessage: async id => ({ id }),
        editMessage(id, content) { edits.push([id, content]); return options.edit ? options.edit(id, content) : Promise.resolve({ message: { id, channelId: server.currentChannel.id, content } }) },
        setMessagePin(id, active) { pins.push([id, active]); return options.pin ? options.pin(id, active) : Promise.resolve({ message: { id, channelId: server.currentChannel.id, pin: active ? { userId: 'me', createdAt: '2026-10-09T01:00:00Z' } : null } }) }
      } }
      if (name === '../utils/escape') return contentFormat
      if (name === '../utils/channel-type') return channelTypes
      if (name === '../utils/message-mentions') return messageMentions
      if (name === '../utils/chat-draft') return drafts
      if (name === '../utils/message-layout') return layout
      if (name === '../utils/message-press') return { createMessagePress: callback => createMessagePress(callback, timers) }
      if (name.endsWith('.vue')) return {}
      throw new Error(`Unexpected dependency: ${name}`)
    }
  }
  const scope = vue.effectScope()
  scope.run(() => vm.runInNewContext(code, context, { filename: 'MessageList.vue' }))
  const row = new Element('row'); row.dataset.messageId = 'mine'; row.trigger = new Element('button'); row.editor = new Element('textarea')
  const content = new Element('link'); content.row = row
  const container = new Element('container'); container.rows = [row]; container.scrollTop = 400; container.scrollHeight = 900; container.clientHeight = 500
  container.querySelector = selector => selector.includes('textarea') ? row.editor : null
  context.actions.containerRef.value = container
  const sheet = new Element('sheet'); sheet.children = [new Element('reply'), new Element('edit'), new Element('delete'), new Element('cancel')]
  context.actions.sheetRef.value = sheet
  mounted.forEach(callback => callback())
  let stopped = false
  const dispose = () => { if (stopped) return; stopped = true; unmounted.forEach(callback => callback()); scope.stop() }
  t.after(dispose)
  return { ...context.actions, timers, row, content, container, sheet, document, window, server, user, chat, props, storage, emitted, deleted, edits, read, readStore, listeners, pins, updates, locations, dispose,
    touch(overrides = {}) { return { ...point(overrides), currentTarget: row, target: content } },
    click() { return { currentTarget: row.trigger, target: row.trigger } }
  }
}

test('移动按钮与长按进入底部面板，桌面按钮保留定位菜单；长按后链接点击被捕获取消', async t => {
  const list = createList(t)
  list.toggleMenu(list.chat.messages[0], list.click())
  await vue.nextTick()
  assert.equal(list.menuPresentation.value, 'sheet')
  assert.equal(list.document.activeElement, list.sheet.children[0])
  list.closeMenuAndRestoreFocus()
  list.beginMessagePress(list.chat.messages[0], list.touch())
  list.timers.advance(500)
  await vue.nextTick()
  assert.equal(list.showMenu.value, 'mine')
  const event = { target: list.content, detail: 1, prevented: false, stopped: false, preventDefault() { this.prevented = true }, stopImmediatePropagation() { this.stopped = true } }
  list.document.fire('click', event)
  assert.equal(event.prevented, true)
  assert.equal(event.stopped, true)
  list.handleMessageContextMenu(list.chat.messages[0], list.touch())
  assert.equal(list.showMenu.value, 'mine', '原生contextmenu不能关闭刚打开的面板')
  list.closeMenuAndRestoreFocus()
  list.window.innerWidth = 1200
  list.toggleMenu(list.chat.messages[0], list.click())
  assert.equal(list.menuPresentation.value, 'menu')
})

test('长按释放重定向到面板按钮的合成点击被取消，键盘和下一次独立触摸仍可操作', async t => {
  const list = createList(t)
  list.beginMessagePress(list.chat.messages[0], list.touch())
  list.timers.advance(500); await vue.nextTick()
  list.finishMessagePress(list.touch())
  const click = detail => ({ target: list.sheet.children[0], detail, prevented: false, stopped: false, preventDefault() { this.prevented = true }, stopImmediatePropagation() { this.stopped = true } })
  const releaseClick = click(1)
  list.document.fire('click', releaseClick)
  assert.equal(releaseClick.prevented, true)
  assert.equal(releaseClick.stopped, true)
  assert.equal(list.showMenu.value, 'mine')
  assert.equal(list.emitted.length, 0)
  const keyboardClick = click(0)
  list.document.fire('click', keyboardClick)
  assert.equal(keyboardClick.prevented, false)
  list.document.fire('pointerdown', point({ pointerId: 2 }))
  const intentionalClick = click(1)
  list.document.fire('click', intentionalClick)
  assert.equal(intentionalClick.prevented, false)
  assert.equal(intentionalClick.stopped, false)
  list.replyToMessage(list.chat.messages[0])
  assert.equal(list.emitted.at(-1)[0], 'reply')
})

test('面板焦点循环、Escape和取消恢复触发按钮，回复与编辑转交正确目标', async t => {
  const list = createList(t)
  list.toggleMenu(list.chat.messages[0], list.click()); await vue.nextTick()
  const event = key => ({ key, shiftKey: false, prevented: false, preventDefault() { this.prevented = true }, stopPropagation() {} })
  list.sheet.children.at(-1).focus()
  const tab = event('Tab'); list.handleSheetKeydown(tab)
  assert.equal(tab.prevented, true); assert.equal(list.document.activeElement, list.sheet.children[0])
  const backTab = { ...event('Tab'), shiftKey: true }; list.handleSheetKeydown(backTab)
  assert.equal(list.document.activeElement, list.sheet.children.at(-1))
  list.handleSheetKeydown(event('Escape'))
  assert.equal(list.showMenu.value, null); assert.equal(list.document.activeElement, list.row.trigger)
  list.toggleMenu(list.chat.messages[0], list.click()); list.replyToMessage(list.chat.messages[0])
  assert.equal(list.showMenu.value, null); assert.equal(list.emitted.at(-1)[0], 'reply'); assert.equal(list.emitted.at(-1)[1].id, 'mine')
  list.toggleMenu(list.chat.messages[0], list.click()); list.startEdit(list.chat.messages[0]); await vue.nextTick()
  assert.equal(list.editingMessageId.value, 'mine'); assert.equal(list.editContent.value, '我的消息'); assert.equal(list.document.activeElement, list.row.editor)
  assert.equal(list.canManage(list.chat.messages[0]), true); assert.equal(list.canManage(list.chat.messages[1]), false)
})

test('阅读计时在面板打开时取消，关闭后重新等待500ms才确认', async t => {
  const list = createList(t, { readState: true })
  await vue.nextTick()
  assert.ok(list.visibleReadTarget())
  list.toggleMenu(list.chat.messages[0], list.click())
  assert.equal(list.visibleReadTarget(), null)
  list.timers.advance(700)
  assert.equal(list.read.length, 0)
  list.closeMenuAndRestoreFocus(); await vue.nextTick()
  list.timers.advance(499); assert.equal(list.read.length, 0)
  list.timers.advance(1); assert.equal(list.read.length, 1)
  assert.deepEqual(list.read[0], ['channel-a', 'mine', 1])
})

test('滚动、隐藏、切频道与卸载取消待触摸，换频道和消息删除关闭旧面板', async t => {
  const list = createList(t)
  for (const [name, cancel] of [['scroll', () => list.handleScroll()], ['hidden', () => { list.document.visibilityState = 'hidden'; list.document.fire('visibilitychange') }], ['second touch', () => list.document.fire('pointerdown', point({ pointerId: 2, isPrimary: false }))]]) {
    list.document.visibilityState = 'visible'; list.beginMessagePress(list.chat.messages[0], list.touch()); cancel(); list.timers.advance(500)
    assert.equal(list.showMenu.value, null, name)
  }
  list.beginMessagePress(list.chat.messages[0], list.touch())
  list.server.currentChannel = { id: 'channel-b', type: 'text' }; await vue.nextTick(); list.timers.advance(500)
  assert.equal(list.showMenu.value, null, '换频道取消待触摸')
  list.server.currentChannel = { id: 'channel-a', type: 'text' }; await vue.nextTick()
  list.beginMessagePress(list.chat.messages[0], list.touch())
  list.user.user = { id: 'another-account' }; await vue.nextTick(); list.timers.advance(500)
  assert.equal(list.showMenu.value, null, '换账号取消待触摸')
  list.user.user = { id: 'me' }; await vue.nextTick()
  list.toggleMenu(list.chat.messages[0], list.click())
  list.chat.messages = list.chat.messages.filter(message => message.id !== 'mine'); await vue.nextTick()
  assert.equal(list.showMenu.value, null)
  list.toggleMenu(list.chat.messages[0], list.click())
  list.server.currentChannel = { id: 'channel-b', type: 'text' }; await vue.nextTick()
  assert.equal(list.showMenu.value, null)
  list.server.currentChannel = { id: 'channel-a', type: 'text' }; await vue.nextTick()
  list.beginMessagePress(list.chat.messages[0], list.touch()); list.dispose(); list.timers.advance(1000); await vue.nextTick()
  assert.equal(list.showMenu.value, null); assert.equal(list.listeners.length, 0); assert.equal(list.timers.timers.size, 0)
})

test('删除先关闭面板，取消确认不提交也不删除，确认后删除自己的消息', async t => {
  const canceled = createList(t, { confirm: false })
  canceled.toggleMenu(canceled.chat.messages[0], canceled.click()); await canceled.deleteMsg('mine')
  assert.equal(canceled.showMenu.value, null); assert.equal(canceled.deleted.length, 0)
  const confirmed = createList(t)
  confirmed.toggleMenu(confirmed.chat.messages[0], confirmed.click()); await confirmed.deleteMsg('mine')
  assert.equal(confirmed.showMenu.value, null); assert.deepEqual(confirmed.deleted, ['mine'])
})

test('置顶请求期间定位原消息不会锁死置顶按钮，重复点击不重复提交', async t => {
  const request = deferred()
  const list = createList(t, { pin: () => request.promise })
  await vue.nextTick()
  const sending = list.togglePin(list.chat.messages[0])
  assert.equal(list.pinningId.value, 'mine')
  await list.togglePin(list.chat.messages[1])
  assert.equal(list.pins.length, 1)
  assert.equal(await list.locateMessage('mine'), true)
  request.resolve({ message: { id: 'mine', channelId: 'channel-a', pin: { userId: 'me' } } })
  await sending
  assert.equal(list.pinningId.value, null)
  assert.equal(list.chat.messages[0].pin.userId, 'me')
})

test('切换频道及账号立即清空定位、回应和置顶状态，迟到请求不打断新的定位', async t => {
  for (const change of ['channel', 'account']) {
    const locateRequest = deferred()
    const pinRequest = deferred()
    let locationCount = 0
    const list = createList(t, { locate: () => ++locationCount === 1 ? locateRequest.promise : Promise.resolve(true), pin: () => pinRequest.promise })
    await vue.nextTick()
    list.openReactions(list.chat.messages[0])
    list.highlightedId.value = 'mine'
    const pinning = list.togglePin(list.chat.messages[0])
    const locating = list.locateMessage('mine')
    if (change === 'channel') {
      list.server.currentChannel = { id: 'channel-b', type: 'text' }
      list.chat.currentChannelId = 'channel-b'
      list.chat.messages = [{ ...list.chat.messages[0], channelId: 'channel-b' }]
    } else list.user.user = { id: 'other-account' }
    await vue.nextTick()
    assert.equal(list.locating.value, false, change)
    assert.equal(list.pinningId.value, null, change)
    assert.equal(list.reactionPickerId.value, null, change)
    assert.equal(list.highlightedId.value, null, change)
    assert.equal(await list.locateMessage('mine'), true, change)
    assert.equal(locationCount, 2, change)
    const focusedRow = list.document.activeElement
    locateRequest.resolve(true)
    pinRequest.resolve({ message: { id: 'mine', channelId: 'channel-a', pin: { userId: 'me' } } })
    assert.equal(await locating, false, change)
    await pinning
    assert.equal(list.updates.length, 0, change)
    assert.equal(list.document.activeElement, focusedRow, change)
    assert.equal(list.feedback.value, '', change)
  }
})

test('搜索或置顶遮挡消息时不确认已读，关闭后重新累计完整阅读时间', async t => {
  const list = createList(t, { readState: true })
  await vue.nextTick()
  list.timers.advance(400)
  list.props.blocked = true
  assert.equal(list.visibleReadTarget(), null)
  await vue.nextTick()
  list.timers.advance(1000)
  assert.equal(list.read.length, 0)
  list.props.blocked = false
  await vue.nextTick()
  list.timers.advance(499)
  assert.equal(list.read.length, 0)
  list.timers.advance(1)
  assert.equal(list.read.length, 1)
})

test('定位消息居中、给予焦点与短暂高亮，停止自动跟随后图片加载不挪走阅读位置', async t => {
  const list = createList(t)
  await vue.nextTick()
  list.container.scrollTop = 250
  assert.equal(await list.locateMessage('mine'), true)
  assert.equal(list.document.activeElement, list.row)
  assert.equal(list.highlightedId.value, 'mine')
  assert.equal(list.followingLatest.value, false)
  assert.equal(list.container.scrollTop, 50)
  list.handleImageLoad()
  assert.equal(list.container.scrollTop, 50)
  list.timers.advance(2999)
  assert.equal(list.highlightedId.value, 'mine')
  list.timers.advance(1)
  assert.equal(list.highlightedId.value, null)
})

test('旧历史分页晚于定位完成时，不再按旧阅读锚点覆盖已居中的消息位置', async t => {
  const history = deferred()
  const list = createList(t, { loadMore: () => history.promise })
  await vue.nextTick()
  const target = new list.row.constructor('row')
  target.dataset.messageId = 'other'
  list.container.rows = [list.row, target]
  list.container.scrollTop = 0
  list.container.scrollHeight = 1500
  list.chat.hasMore = true
  list.row.getBoundingClientRect = () => ({ top: 50 - list.container.scrollTop, bottom: 150 - list.container.scrollTop, height: 100 })
  target.getBoundingClientRect = () => ({ top: 800 - list.container.scrollTop, bottom: 900 - list.container.scrollTop, height: 100 })
  const paging = list.handleScroll()
  assert.equal(await list.locateMessage('other'), true)
  assert.equal(list.container.scrollTop, 600)
  assert.equal(list.document.activeElement, target)
  history.resolve()
  await paging
  assert.equal(list.container.scrollTop, 600)
  assert.equal(list.highlightedId.value, 'other')
})

test('编辑显示成员昵称，同昵称和已离开成员的提及在普通文字修改后保留各自身份', async t => {
  const list = createList(t)
  const original = { ...list.chat.messages[0], content: '<@alice> 与 <@bob> 找 <@departed>', mentions: ['alice', 'bob', 'departed'],
    mentionUsers: [{ id: 'alice', username: 'Alice', nickname: '小明' }, { id: 'bob', username: 'Bob', nickname: '小明' }] }
  list.chat.messages[0] = original
  list.startEdit(original)
  assert.equal(list.editContent.value, '@小明 与 @小明 找 @已离开的成员')
  assert.deepEqual(list.editMentionSpans.value.map(span => span.userId), ['alice', 'bob', 'departed'])
  list.recordEditIntent({ target: { value: list.editContent.value, selectionStart: 0, selectionEnd: 0 }, inputType: 'insertText' })
  list.editContent.value = '你好，' + list.editContent.value
  list.recordEditIntent({ target: { value: list.editContent.value, selectionStart: list.editContent.value.length, selectionEnd: list.editContent.value.length }, inputType: 'insertText' })
  list.editContent.value += '！'
  await list.saveEdit()
  assert.deepEqual(list.edits, [['mine', '你好，<@alice> 与 <@bob> 找 <@departed>！']])
  assert.equal(list.editingMessageId.value, null)
  assert.equal(list.chat.messages[0].content, '你好，<@alice> 与 <@bob> 找 <@departed>！')
})

test('编辑选中名字内文字取消该身份，保留未改动的另一同昵称提及', async t => {
  const list = createList(t)
  const original = { ...list.chat.messages[0], content: '<@alice> 与 <@bob>', mentions: ['alice', 'bob'],
    mentionUsers: [{ id: 'alice', username: 'Alice', nickname: '小明' }, { id: 'bob', username: 'Bob', nickname: '小明' }] }
  list.startEdit(original)
  list.recordEditIntent({ target: { value: list.editContent.value, selectionStart: 2, selectionEnd: 3 }, inputType: 'insertText' })
  list.editContent.value = '@小新 与 @小明'
  assert.deepEqual(list.editMentionSpans.value.map(span => span.userId), ['bob'])
  await list.saveEdit()
  assert.deepEqual(list.edits, [['mine', '@小新 与 <@bob>']])
})

test('编辑请求期间继续修改文字，旧确认不能关闭或清除新编辑', async t => {
  const request = deferred()
  const list = createList(t, { edit: () => request.promise })
  list.startEdit(list.chat.messages[0])
  list.editContent.value = '第一次修改'
  const saving = list.saveEdit()
  assert.equal(list.savingEdit.value, true)
  list.editContent.value = '第二次新编辑'
  request.resolve({ message: { id: 'mine', channelId: 'channel-a', content: '第一次修改' } })
  await saving
  assert.equal(list.editingMessageId.value, 'mine')
  assert.equal(list.editContent.value, '第二次新编辑')
  assert.equal(list.savingEdit.value, false)
})

test('删除首个同昵称提及后只保留第二位成员，不把文字相同误认成第一位', async t => {
  const list = createList(t)
  list.startEdit({ ...list.chat.messages[0], content: '<@alice> <@bob>', mentions: ['alice', 'bob'],
    mentionUsers: [{ id: 'alice', username: 'Alice', nickname: '小明' }, { id: 'bob', username: 'Bob', nickname: '小明' }] })
  list.recordEditIntent({ target: { value: list.editContent.value, selectionStart: 0, selectionEnd: 4 }, inputType: 'deleteContentBackward' })
  list.editContent.value = '@小明'
  assert.deepEqual(list.editMentionSpans.value.map(span => span.userId), ['bob'])
  await list.saveEdit()
  assert.deepEqual(list.edits, [['mine', '<@bob>']])
})

test('取消并重开同一消息编辑隔离旧确认，新请求不会被旧响应关闭', async t => {
  const oldRequest = deferred(), newRequest = deferred()
  let count = 0
  const list = createList(t, { edit: () => ++count === 1 ? oldRequest.promise : newRequest.promise })
  list.startEdit(list.chat.messages[0]); list.editContent.value = '相同文字'
  const oldSaving = list.saveEdit()
  list.editingMessageId.value = null
  list.startEdit(list.chat.messages[0]); list.editContent.value = '相同文字'
  const newSaving = list.saveEdit()
  assert.equal(list.edits.length, 2)
  oldRequest.resolve({ message: { id: 'mine', content: '相同文字' } })
  await oldSaving
  assert.equal(list.editingMessageId.value, 'mine')
  assert.equal(list.savingEdit.value, true)
  assert.equal(list.updates.length, 0)
  newRequest.resolve({ message: { id: 'mine', content: '相同文字' } })
  await newSaving
  assert.equal(list.editingMessageId.value, null)
})

test('编辑输入法组合期间Ctrl+Enter和Escape不操作，wire长度超限保留编辑', async t => {
  const list = createList(t)
  list.startEdit(list.chat.messages[0])
  const event = { key: 'Enter', ctrlKey: true, isComposing: true, preventDefault() { throw new Error('IME should not save') } }
  list.handleEditKeydown(event)
  list.editComposing.value = true
  list.handleEditKeydown({ ...event, key: 'Escape', isComposing: false })
  await list.saveEdit()
  assert.equal(list.edits.length, 0)
  assert.equal(list.editingMessageId.value, 'mine')
  list.editComposing.value = false
  list.editContent.value = '@a' + 'x'.repeat(drafts.MAX_DRAFT_LENGTH - 2)
  list.editMentionSpans.value = [{ start: 0, end: 2, userId: 'long-user-id' }]
  await list.saveEdit()
  assert.equal(list.edits.length, 0)
  assert.ok(list.feedback.value.includes('消息过长'))
})

test('切换频道或账号后旧编辑确认不能更新记录、清新编辑或解锁新请求', async t => {
  for (const change of ['channel', 'account']) {
    const oldRequest = deferred()
    const newRequest = deferred()
    let count = 0
    const list = createList(t, { edit: () => ++count === 1 ? oldRequest.promise : newRequest.promise })
    list.startEdit(list.chat.messages[0]); list.editContent.value = '旧频道提交'
    const oldSaving = list.saveEdit()
    if (change === 'channel') {
      list.server.currentChannel = { id: 'channel-b', type: 'text' }
      list.chat.currentChannelId = 'channel-b'
      list.chat.messages = [{ ...list.chat.messages[0], channelId: 'channel-b' }]
    } else {
      list.user.user = { id: 'new-account' }
      list.chat.messages = [{ ...list.chat.messages[0], id: 'new-account-message', userId: 'new-account' }]
    }
    const currentMessageId = list.chat.messages[0].id
    list.startEdit(list.chat.messages[0]); list.editContent.value = '新的编辑'
    const newSaving = list.saveEdit()
    assert.equal(list.edits.length, 2, change)
    oldRequest.resolve({ message: { id: 'mine', channelId: 'channel-a', content: '旧频道提交' } })
    await oldSaving
    assert.equal(list.updates.length, 0, change)
    assert.equal(list.editingMessageId.value, currentMessageId, change)
    assert.equal(list.editContent.value, '新的编辑', change)
    assert.equal(list.savingEdit.value, true, change)
    assert.equal(list.feedback.value, '', change)
    newRequest.resolve({ message: { id: currentMessageId, channelId: list.server.currentChannel.id, content: '新的编辑' } })
    await newSaving
    assert.equal(list.updates.length, 1, change)
    assert.equal(list.savingEdit.value, false, change)
    assert.equal(list.editingMessageId.value, null, change)
  }
})
