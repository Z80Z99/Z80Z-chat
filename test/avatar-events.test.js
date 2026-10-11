import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as Vue from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import * as imageHelpers from '../frontend/src/utils/community-image.ts'

const codes = new Map(['Avatar', 'CommunityWelcome', 'CommunityProfileEditor'].map(name => {
  const source = readFileSync(new URL(`../frontend/src/components/${name}.vue`, import.meta.url), 'utf8')
  const script = compileScript(parse(source).descriptor, { id: `avatar-events-${name}`, inlineTemplate: true }).content
  return [name, ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText]
}))
const settle = async () => { await Vue.nextTick(); await new Promise(resolve => setImmediate(resolve)); await Vue.nextTick() }
const serverData = (id = 'community-a') => ({ id, name: '社区甲', description: '介绍', avatar: '/uploads/avatar.png', banner: '/uploads/banner.png',
  ownerId: 'owner', createdAt: '2026-10-11', profileRevision: 1, welcome: { title: '', message: '', rules: '', recommendedChannelIds: [] } })

function harness(t, name, initialProps) {
  const props = Vue.reactive(initialProps)
  const dependencies = {
    vue: Vue,
    '../stores/auth': { useAuthStore: () => ({ user: { id: 'owner' } }) },
    '../stores/server': { useServerStore: () => ({ currentServer: props.server }) },
    '../utils/api': { api: {} }, '../utils/community-image': imageHelpers,
    './CommunityImageCropper.vue': { default: { render: () => Vue.h('div') } }
  }
  const load = componentName => {
    const context = { exports: {}, console, localStorage: { getItem: () => 'token' }, URL,
      require(moduleName) { assert.ok(dependencies[moduleName], moduleName); return dependencies[moduleName] } }
    vm.runInNewContext(codes.get(componentName), context)
    return context.exports.default
  }
  const Avatar = load('Avatar')
  dependencies['./Avatar.vue'] = { default: Avatar }
  const Component = name === 'Avatar' ? Avatar : load(name)
  function node(tag = 'root', text = '') {
    return Vue.markRaw({ tag, text, children: [], parent: null, attrs: {},
      getAttribute(key) { return this.attrs[key] == null ? null : String(this.attrs[key]) },
      querySelector(selector) { return find(this, child => child.tag === selector)[0] || null }
    })
  }
  const find = (parent, predicate) => parent.children.flatMap(child => [...(predicate(child) ? [child] : []), ...find(child, predicate)])
  const body = node('body')
  const renderer = Vue.createRenderer({
    createElement: node, createText: text => node('text', text), createComment: text => node('comment', text),
    insert(child, parent, anchor = null) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
      child.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child)
    },
    remove(child) { if (child.parent) { child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null } },
    parentNode: child => child.parent, nextSibling: child => child.parent?.children[child.parent.children.indexOf(child) + 1] || null,
    setText(child, text) { child.text = text }, setElementText(child, text) { child.text = text; child.children = [] },
    patchProp(child, key, previous, value) { child.attrs[key] = value },
    querySelector: selector => selector === 'body' ? body : null
  })
  const root = node(), app = renderer.createApp({ render: () => Vue.h(Component, { ...props }) })
  app.mount(root)
  t.after(() => app.unmount())
  const image = src => find(root, child => child.tag === 'img' && child.attrs.src === src)[0]
  const error = element => {
    assert.equal(typeof element?.attrs.onError, 'function', 'image must have a real template error listener')
    const event = { type: 'error', target: element, currentTarget: element }
    element.attrs.onError(event)
    return event
  }
  return { props, root, image, error, all: predicate => find(root, predicate) }
}

test('Avatar emits its current image error once and ignores a removed source element', async t => {
  const events = []
  const h = harness(t, 'Avatar', { src: '/avatar-a.png', name: '甲', onError: event => events.push(event) })
  const first = h.image('/avatar-a.png'), firstEvent = h.error(first)
  assert.equal(events.length, 1)
  assert.equal(events[0], firstEvent)
  h.props.src = '/avatar-b.png'
  await settle()
  const current = h.image('/avatar-b.png')
  assert.notEqual(current, first, 'a new source owns a new image element')
  h.error(first)
  assert.equal(events.length, 1)
  h.error(current)
  assert.equal(events.length, 2)
})

for (const component of ['CommunityWelcome', 'CommunityProfileEditor']) {
  test(`${component}: real Avatar error shows the initial and a new source recovers the image`, async t => {
    const h = harness(t, component, { server: serverData(), channels: [], canManage: false })
    h.error(h.image('/uploads/avatar.png'))
    await settle()
    assert.equal(h.image('/uploads/avatar.png'), undefined)
    assert.ok(h.all(child => child.tag === 'span' && child.text === '社').length, 'parent avatarFailed must render the initial')
    h.props.server.avatar = '/uploads/recovered-avatar.png'
    await settle()
    assert.ok(h.image('/uploads/recovered-avatar.png'))
    assert.equal(h.all(child => child.tag === 'span' && child.text === '社').length, 0)
  })

  test(`${component}: old avatar/banner errors cannot hide a replacement source or another community`, async t => {
    const h = harness(t, component, { server: serverData(), channels: [], canManage: false })
    const oldAvatar = h.image('/uploads/avatar.png'), oldBanner = h.image('/uploads/banner.png')
    h.props.server.avatar = '/uploads/new-avatar.png'
    h.props.server.banner = '/uploads/new-banner.png'
    await settle()
    h.error(oldAvatar); h.error(oldBanner)
    await settle()
    const newAvatar = h.image('/uploads/new-avatar.png'), newBanner = h.image('/uploads/new-banner.png')
    assert.ok(newAvatar); assert.ok(newBanner)

    // An identical URL still belongs to a different community and DOM element.
    h.props.server = { ...serverData('community-b'), avatar: '/uploads/new-avatar.png', banner: '/uploads/new-banner.png' }
    await settle()
    const currentAvatar = h.image('/uploads/new-avatar.png'), currentBanner = h.image('/uploads/new-banner.png')
    assert.notEqual(currentAvatar, newAvatar); assert.notEqual(currentBanner, newBanner)
    h.error(newAvatar); h.error(newBanner)
    await settle()
    assert.equal(h.image('/uploads/new-avatar.png'), currentAvatar)
    assert.equal(h.image('/uploads/new-banner.png'), currentBanner)

    h.error(currentBanner)
    await settle()
    assert.equal(h.image('/uploads/new-banner.png'), undefined, 'current banner error must still fall back')
    h.props.server.banner = '/uploads/recovered-banner.png'
    await settle()
    assert.ok(h.image('/uploads/recovered-banner.png'))
  })
}
