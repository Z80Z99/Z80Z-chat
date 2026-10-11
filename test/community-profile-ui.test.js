import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as Vue from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import * as imageHelpers from '../frontend/src/utils/community-image.ts'

const compile = (name, inline = false) => ts.transpileModule(compileScript(parse(readFileSync(new URL(`../frontend/src/components/${name}.vue`, import.meta.url), 'utf8')).descriptor, {
  id: `community-${name}`, inlineTemplate: inline
}).content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
const editorCode = compile('CommunityProfileEditor'), welcomeCode = compile('CommunityWelcome', true), cropCode = compile('CommunityImageCropper')
const settle = async () => { await Vue.nextTick(); await new Promise(resolve => setImmediate(resolve)); await Vue.nextTick() }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const serverData = (id = 'server-a') => ({ id, name: '社区甲', description: '简介', avatar: '', banner: '', ownerId: 'owner', createdAt: '2026-10-10', profileRevision: 2,
  welcome: { title: '', message: '', rules: '', recommendedChannelIds: [] } })
const channelData = (id, type = 'text', serverId = 'server-a', position = 0) => ({ id, serverId, name: id, type, position })

function mount(code, props, dependencies, globals = {}, renderScript = false) {
  const context = { exports: {}, console, ...globals, require(name) { if (name === 'vue') return Vue; assert.ok(dependencies[name], name); return dependencies[name] } }
  vm.runInNewContext(code, context)
  const Component = context.exports.default
  if (!renderScript) Component.render = () => Vue.h('div')
  let instance
  const setup = Component.setup
  Component.setup = (values, setupContext) => { instance = Vue.getCurrentInstance(); return setup(values, setupContext) }
  const node = (tag = 'root', text = '') => ({ tag, text, children: [], parent: null, attrs: {}, style: {} })
  const renderer = Vue.createRenderer({
    createElement: node, createText: text => node('text', text), createComment: text => node('comment', text),
    insert(child, parent, anchor = null) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
      child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child)
    },
    remove(child) { if (child.parent) { child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null } },
    parentNode: child => child.parent, nextSibling: child => child.parent?.children[child.parent.children.indexOf(child) + 1] || null,
    setText(child, text) { child.text = text }, setElementText(child, text) { child.text = text; child.children = [] },
    patchProp(child, key, previous, value) { child.attrs[key] = value }
  })
  const root = node(), app = renderer.createApp({ render: () => Vue.h(Component, { ...props }) })
  app.mount(root)
  const all = (predicate, parent = root) => parent.children.flatMap(child => [...(predicate(child) ? [child] : []), ...all(predicate, child)])
  let cleaned = false
  return { state: instance.setupState, root, all, cleanup: () => { if (!cleaned) { cleaned = true; app.unmount() } } }
}

function editorHarness(t) {
  const events = [], uploads = [], saves = [], revoked = []
  let token = 'token-owner', urls = 0, uploadHandler = null, saveHandler = null, getHandler = null
  const props = Vue.reactive({ server: serverData(), channels: [channelData('text'), channelData('voice', 'voice'), channelData('ann', 'announcement')], canManage: true })
  const auth = Vue.reactive({ user: { id: 'owner', nickname: '群主' } })
  const store = Vue.reactive({ currentServer: props.server,
    async updateServerProfile(data, serverId) {
      saves.push({ data, serverId })
      if (saveHandler) return saveHandler(data, serverId)
      const server = { ...store.currentServer, ...data, profileRevision: (store.currentServer.profileRevision || 0) + 1 }
      props.server = server; store.currentServer = props.server
      return { server }
    },
    handleServerUpdated({ server }) { props.server = server; store.currentServer = props.server }
  })
  const api = { async uploadCommunityImage(serverId, kind, file) {
    uploads.push({ serverId, kind, file }); return uploadHandler ? uploadHandler(serverId, kind, file) : { url: `/uploads/${kind}.webp` }
  }, async getServer(serverId) { return getHandler ? getHandler(serverId) : { server: store.currentServer } } }
  const connected = mount(editorCode, Object.defineProperties({ 'onCropper-active': active => events.push(active) }, {
    server: { enumerable: true, get: () => props.server }, channels: { enumerable: true, get: () => props.channels }, canManage: { enumerable: true, get: () => props.canManage }
  }), {
    '../stores/auth': { useAuthStore: () => auth }, '../stores/server': { useServerStore: () => store }, '../utils/api': { api },
    '../utils/community-image': imageHelpers, './Avatar.vue': { default: {} }, './CommunityImageCropper.vue': { default: {} }
  }, { localStorage: { getItem: () => token }, URL: { createObjectURL: () => `blob:preview-${++urls}`, revokeObjectURL: url => revoked.push(url) } })
  events.length = 0
  t.after(connected.cleanup)
  const selectFile = (kind, file = new File(['image'], `${kind}.png`, { type: 'image/png' })) => {
    const input = { files: [file], value: 'path' }
    connected.state.chooseImage({ target: input }, kind)
    assert.equal(input.value, '')
    return file
  }
  const acceptFile = kind => { selectFile(kind); const cropped = new File(['cropped'], `${kind}.webp`, { type: 'image/webp' }); connected.state.acceptCrop(cropped); return cropped }
  return { ...connected, props, auth, store, events, uploads, saves, revoked, selectFile, acceptFile,
    set token(value) { token = value }, set uploadHandler(value) { uploadHandler = value }, set saveHandler(value) { saveHandler = value }, set getHandler(value) { getHandler = value } }
}

test('社区图片选中和取消不上传，确认只暂存预览，保存统一提交欢迎字段和图片', async t => {
  const h = editorHarness(t)
  h.selectFile('avatar')
  assert.equal(h.state.cropKind, 'avatar')
  assert.equal(h.uploads.length, 0)
  h.state.closeCropper()
  assert.equal(h.state.pendingAvatar, null)
  const avatar = h.acceptFile('avatar'), banner = h.acceptFile('banner')
  assert.equal(h.state.avatarPreview, 'blob:preview-1')
  assert.equal(h.state.bannerPreview, 'blob:preview-2')
  assert.equal(h.uploads.length, 0)
  h.state.welcomeTitle = '欢迎'; h.state.welcomeRules = '一\n二'
  h.state.toggleRecommended('voice', true); h.state.toggleRecommended('not-a-channel', true)
  await h.state.saveProfile(); await settle()
  assert.deepEqual(h.uploads.map(value => [value.serverId, value.kind, value.file]), [['server-a', 'avatar', avatar], ['server-a', 'banner', banner]])
  assert.equal(h.saves.length, 1)
  assert.equal(h.saves[0].data.expectedRevision, 2)
  assert.equal(h.saves[0].data.welcome.title, '欢迎')
  assert.equal(h.saves[0].data.welcome.rules, '一\n二')
  assert.deepEqual(Array.from(h.saves[0].data.welcome.recommendedChannelIds), ['voice'])
  assert.equal(h.saves[0].data.avatar, '/uploads/avatar.webp')
  assert.equal(h.saves[0].data.banner, '/uploads/banner.webp')
  assert.deepEqual(h.revoked, ['blob:preview-1', 'blob:preview-2'])
  assert.equal(h.state.status, '社区资料已保存')
})

test('图片或资料保存失败保留草稿，同一图片已上传URL在重试时复用', async t => {
  const h = editorHarness(t)
  h.acceptFile('avatar'); h.acceptFile('banner'); h.state.description = '新草稿'
  let fail = true
  h.uploadHandler = async (id, kind) => { if (kind === 'banner' && fail) throw new Error('横幅上传失败'); return { url: `/uploads/${kind}.png` } }
  await h.state.saveProfile()
  assert.equal(h.saves.length, 0)
  assert.equal(h.state.description, '新草稿')
  assert.equal(h.state.pendingAvatar.uploadedUrl, '/uploads/avatar.png')
  assert.equal(h.state.pendingBanner.uploadedUrl, null)
  assert.deepEqual(h.revoked, [])
  fail = false
  h.saveHandler = async () => { throw new Error('保存失败') }
  await h.state.saveProfile()
  assert.equal(h.state.pendingBanner.uploadedUrl, '/uploads/banner.png')
  assert.equal(h.state.saveError, '保存失败')
  h.saveHandler = null
  await h.state.saveProfile()
  assert.deepEqual(h.uploads.map(value => value.kind), ['avatar', 'banner', 'banner'])
  assert.equal(h.saves.length, 2)
  assert.equal(h.state.pendingAvatar, null)
})

test('切换社区/账号和token后拒绝旧裁切及上传完成，旧预览在重选重置卸载时清理', async t => {
  const h = editorHarness(t)
  h.acceptFile('avatar'); h.acceptFile('avatar')
  assert.deepEqual(h.revoked, ['blob:preview-1'])
  const pending = deferred(); h.uploadHandler = () => pending.promise
  const save = h.state.saveProfile()
  h.props.server = serverData('server-b'); h.store.currentServer = h.props.server
  await settle()
  assert.equal(h.state.name, '社区甲')
  assert.equal(h.state.pendingAvatar, null)
  pending.resolve({ url: '/uploads/late.webp' }); await save
  assert.equal(h.saves.length, 0)
  assert.deepEqual(h.revoked, ['blob:preview-1', 'blob:preview-2'])
  h.selectFile('banner'); h.token = 'different-token'
  h.state.acceptCrop(new File(['crop'], 'b.webp', { type: 'image/webp' }))
  assert.equal(h.state.pendingBanner, null)
  h.acceptFile('banner'); h.auth.user = { id: 'another-account' }
  await settle()
  assert.equal(h.state.pendingBanner, null)
  assert.equal(h.revoked.at(-1), 'blob:preview-3')
})

test('同账号资料刷新和WS版本更新不覆盖未保存草稿，409主动重新加载清理预览并更新base版本', async t => {
  const h = editorHarness(t)
  h.state.name = '我的草稿'; h.acceptFile('avatar')
  h.auth.user = { id: 'owner', nickname: '新昵称' }
  h.props.server = { ...h.props.server, name: '另一管理者新名称', profileRevision: 3 }
  h.store.currentServer = h.props.server
  await settle()
  assert.equal(h.state.name, '我的草稿')
  assert.equal(h.state.baseRevision, 2)
  h.saveHandler = async () => { throw Object.assign(new Error('资料已更新，请重新加载后再保存'), { status: 409 }) }
  await h.state.saveProfile()
  assert.equal(h.saves[0].data.expectedRevision, 2)
  assert.equal(h.state.needsReload, true)
  assert.equal(h.state.pendingAvatar.uploadedUrl, '/uploads/avatar.webp')
  assert.deepEqual(h.revoked, [])
  await h.state.reloadProfile(); await settle()
  assert.equal(h.state.name, '另一管理者新名称')
  assert.equal(h.state.baseRevision, 3)
  assert.equal(h.state.needsReload, false)
  assert.equal(h.state.pendingAvatar, null)
  assert.deepEqual(h.revoked, ['blob:preview-1'])
})

test('资料未修改头像保留旧GIF，移除使用API标记且失败可重试，权限撤销清理图片', async t => {
  const h = editorHarness(t)
  h.props.server = { ...h.props.server, avatar: '/uploads/legacy.gif', banner: '/uploads/legacy-banner.png' }; h.store.currentServer = h.props.server
  await settle(); await h.state.saveProfile()
  assert.equal('avatar' in h.saves[0].data, false)
  assert.equal('banner' in h.saves[0].data, false)
  h.acceptFile('avatar'); h.acceptFile('banner')
  h.state.removeImage('avatar'); h.state.removeImage('banner')
  assert.equal(h.state.pendingAvatar, null)
  assert.equal(h.state.pendingBanner, null)
  assert.equal(h.state.avatarPreview, '')
  assert.equal(h.state.bannerPreview, '')
  assert.deepEqual(h.revoked, ['blob:preview-1', 'blob:preview-2'])
  h.saveHandler = async () => { throw new Error('保存失败') }
  await h.state.saveProfile()
  assert.equal(h.saves[1].data.avatar, 'default')
  assert.equal(h.saves[1].data.banner, '')
  assert.equal(h.state.avatarRemoved, true)
  assert.equal(h.state.bannerRemoved, true)
  assert.equal(h.state.saveError, '保存失败')
  h.saveHandler = null
  await h.state.saveProfile(); await settle()
  assert.equal(h.saves[2].data.avatar, 'default')
  assert.equal(h.saves[2].data.banner, '')
  assert.equal(h.uploads.length, 0)
  assert.equal(h.store.currentServer.avatar, 'default')
  assert.equal(h.store.currentServer.banner, '')
  assert.equal(h.state.avatarRemoved, false)
  assert.equal(h.state.bannerRemoved, false)
  h.acceptFile('banner')
  h.props.canManage = false; await settle()
  assert.equal(h.state.pendingBanner, null)
  const saved = h.saves.length
  h.selectFile('avatar'); h.state.removeImage('banner'); await h.state.saveProfile()
  assert.equal(h.state.cropFile, null)
  assert.equal(h.saves.length, saved)
})

test('推荐频道限制为6个真实同社区频道，删除频道后自动移除推荐', async t => {
  const h = editorHarness(t)
  h.props.channels = Array.from({ length: 8 }, (_, index) => channelData(`c${index}`))
  h.props.channels.push(channelData('foreign', 'text', 'other-server'))
  await settle()
  for (const channel of h.props.channels) h.state.toggleRecommended(channel.id, true)
  assert.equal(h.state.recommendedIds.length, 6)
  assert.equal(h.state.recommendedIds.includes('foreign'), false)
  h.props.channels = h.props.channels.filter(channel => channel.id !== 'c0'); await settle()
  assert.equal(h.state.recommendedIds.includes('c0'), false)
  h.state.toggleRecommended('c6', true)
  assert.equal(h.state.recommendedIds.length, 6)
})

test('欢迎页旧配置回退，推荐校验真实频道，普通文本不作为HTML注入', async t => {
  const selected = [], events = []
  const props = Vue.reactive({ server: serverData(), channels: [channelData('voice', 'voice', 'server-a', 3), channelData('text', 'text', 'server-a', 1), channelData('foreign', 'text', 'foreign', 0)], canManage: true,
    'onSelect-channel': channel => selected.push(channel), 'onOpen-settings': () => events.push('settings') })
  const h = mount(welcomeCode, props, { './Avatar.vue': { default: Vue.defineComponent({ render: () => Vue.h('div') }) } }, {}, true)
  t.after(h.cleanup)
  assert.equal(h.all(node => node.tag === 'h1')[0].text, '欢迎来到 社区甲')
  const channelButtons = () => h.all(node => node.tag === 'button' && node.attrs.class === 'community-channel-button')
  assert.equal(channelButtons().length, 2)
  channelButtons()[1].attrs.onClick()
  assert.equal(selected[0].id, 'voice')
  h.all(node => node.tag === 'button' && String(node.attrs.class).includes('community-edit-button'))[0].attrs.onClick()
  assert.deepEqual(events, ['settings'])
  props.server = { ...props.server, welcome: { title: '<script>alert(1)</script>', message: '<b>介绍</b>', rules: '一\n<img src=x onerror=alert(1)>', recommendedChannelIds: ['voice', 'voice', 'missing', 'foreign'] } }
  await settle()
  assert.equal(h.all(node => node.tag === 'h1')[0].text, '<script>alert(1)</script>')
  assert.equal(h.all(node => node.attrs.innerHTML !== undefined).length, 0)
  assert.equal(channelButtons().length, 1)
  props.channels = []; await settle()
  assert.equal(channelButtons().length, 0)
  assert.equal(h.all(node => node.tag === 'p').some(node => node.text === '暂无可推荐的频道。'), true)
})

function cropHarness(t, decode, exportFile = async () => new File(['crop'], 'crop.webp', { type: 'image/webp' })) {
  const emitted = [], draws = []
  const document = { activeElement: null }
  class Element {
    constructor(name) { this.name = name; this.isConnected = true; this.hidden = false; this.children = []; Vue.markRaw(this) }
    focus() { document.activeElement = this }
    hasAttribute() { return false }
    querySelectorAll() { return this.children }
    contains(element) { return element === this || this.children.includes(element) }
  }
  const opener = new Element('opener'), dialog = new Element('dialog'), cancel = new Element('cancel'), slider = new Element('slider'), confirm = new Element('confirm')
  dialog.children = [cancel, slider, confirm]; document.activeElement = opener
  const props = Vue.reactive({ file: new File(['image'], 'a.png', { type: 'image/png' }), kind: 'avatar', sessionKey: 'server-a:owner', onClose: () => emitted.push(['close']), onConfirm: file => emitted.push(['confirm', file]) })
  const h = mount(cropCode, props, { '../utils/community-image': { decodeCommunityImage: decode, drawCommunityImage: (...args) => draws.push(args), exportCommunityImage: exportFile } }, { document, HTMLElement: Element, AbortController })
  h.state.dialogRef = dialog; h.state.cancelRef = cancel; h.state.canvasRef = Vue.markRaw({})
  t.after(h.cleanup)
  return { ...h, props, emitted, draws, document, opener, dialog, cancel, slider, confirm }
}

test('裁切异步旧解码在换图和卸载后释放，不覆盖新图；预览缩放不上传', async t => {
  const first = deferred(), second = deferred(), disposed = []
  let decodes = 0
  const image = id => ({ source: {}, width: 1000, height: 600, dispose() { disposed.push(id) } })
  const h = cropHarness(t, () => ++decodes === 1 ? first.promise : second.promise)
  h.props.file = new File(['second'], 'b.png', { type: 'image/png' }); await settle()
  second.resolve(image('second')); await settle()
  assert.equal(h.state.image.width, 1000)
  first.resolve(image('first')); await settle()
  assert.deepEqual(disposed, ['first'])
  h.state.zoom = 2; await settle()
  assert.equal(h.draws.at(-1)[3], 2)
  assert.deepEqual(h.emitted, [])
  h.cleanup(); await settle()
  assert.deepEqual(disposed, ['first', 'second'])
})

test('裁切确认延迟跨session被忽略，错误可重试，取消恢复焦点并约束Tab和Escape', async t => {
  const output = deferred()
  const image = { source: {}, width: 20, height: 20, dispose() {} }
  let shouldFail = false
  const h = cropHarness(t, async () => image, async () => { if (shouldFail) throw new Error('裁切失败'); return output.promise })
  await settle()
  assert.equal(h.document.activeElement, h.cancel)
  h.document.activeElement = h.confirm
  let prevented = 0, stopped = 0
  h.state.handleKeydown({ key: 'Tab', shiftKey: false, preventDefault() { prevented++ } })
  assert.equal(h.document.activeElement, h.cancel)
  h.state.handleKeydown({ key: 'Tab', shiftKey: true, preventDefault() { prevented++ } })
  assert.equal(h.document.activeElement, h.confirm)
  h.state.handleKeydown({ key: 'Escape', isComposing: true, preventDefault() { assert.fail('IME must remain') } })
  assert.deepEqual(h.emitted, [])
  const saving = h.state.confirmCrop()
  h.props.sessionKey = 'server-b:owner'; await settle()
  output.resolve(new File(['crop'], 'old.webp', { type: 'image/webp' })); await saving
  assert.deepEqual(h.emitted, [])
  shouldFail = true; await h.state.confirmCrop()
  assert.equal(h.state.error, '裁切失败')
  shouldFail = false; await h.state.confirmCrop()
  assert.equal(h.emitted[0][0], 'confirm')
  h.state.handleKeydown({ key: 'Escape', preventDefault() { prevented++ }, stopPropagation() { stopped++ } })
  assert.equal(h.emitted.at(-1)[0], 'close')
  assert.equal(prevented, 3); assert.equal(stopped, 1)
  h.cleanup(); await settle()
  assert.equal(h.document.activeElement, h.opener)
})
