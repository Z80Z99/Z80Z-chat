import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as Vue from 'vue'
import * as channelTypes from '../frontend/src/utils/channel-type.ts'

const source = readFileSync(new URL('../frontend/src/components/ChannelList.vue', import.meta.url), 'utf8')
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const code = ts.transpileModule(`${script}\nglobalThis.nav = { openWelcome, handleBannerError, bannerFailed, canManageChannels, channelLabel, selectChannel, joinVoiceChannel };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText

function harness(t) {
  const events = [], joins = [], selection = []
  const server = Vue.reactive({ currentServer: { id: 'community', banner: '/uploads/banner.png' }, currentChannel: { id: 'voice', type: 'voice' },
    members: [], hasPermission: () => false, setCurrentChannel(channel) { this.currentChannel = channel; selection.push(channel) } })
  const voice = Vue.reactive({ currentRoom: 'voice', voiceRoomMembers: {}, joinRoom(id) { joins.push(id) } })
  const read = Vue.reactive({ states: { announcement: { unreadCount: 3, mentionCount: 1 } } })
  const context = { exports: {}, localStorage: { getItem: () => null, setItem() {} }, defineEmits: () => (...args) => events.push(args), defineProps: () => ({}),
    require(name) {
      if (name === 'vue') return Vue
      if (name === '../stores/server') return { useServerStore: () => server }
      if (name === '../stores/voice') return { useVoiceStore: () => voice }
      if (name === '../stores/read-state') return { useReadStateStore: () => read }
      if (name === '../utils/channel-type') return channelTypes
      if (name === './Avatar.vue') return {}
      throw new Error(name)
    } }
  const scope = Vue.effectScope()
  scope.run(() => vm.runInNewContext(code, context))
  t.after(() => scope.stop())
  return { ...context.nav, events, joins, selection, server, voice }
}

test('欢迎入口清除频道选择并关闭移动导航，不离开正在连接的语音；公告选择沿消息路径', t => {
  const h = harness(t)
  h.openWelcome()
  assert.equal(h.server.currentChannel, null)
  assert.equal(h.voice.currentRoom, 'voice')
  assert.deepEqual(h.events, [['close']])
  const announcement = { id: 'announcement', type: 'announcement', name: '社区公告' }
  h.selectChannel(announcement)
  assert.equal(h.server.currentChannel.id, 'announcement')
  assert.equal(h.joins.length, 0)
  assert.match(h.channelLabel(announcement), /公告频道.*3 条未读消息.*1 条提及/)
  assert.equal(h.canManageChannels(), false)
  h.server.hasPermission = key => key === 'manageChannels'
  assert.equal(h.canManageChannels(), true)
})

test('社区横幅只接受当前连接图片的失败，换社区或图片后清除回退状态', async t => {
  const h = harness(t)
  const error = (src, isConnected = true) => ({ target: { isConnected, getAttribute: () => src } })
  h.handleBannerError(error('/uploads/old.png'))
  h.handleBannerError(error('/uploads/banner.png', false))
  assert.equal(h.bannerFailed.value, false)
  h.handleBannerError(error('/uploads/banner.png'))
  assert.equal(h.bannerFailed.value, true)
  h.server.currentServer.banner = '/uploads/new.png'
  await Vue.nextTick()
  assert.equal(h.bannerFailed.value, false)
  h.handleBannerError(error('/uploads/banner.png'))
  assert.equal(h.bannerFailed.value, false)
  h.handleBannerError(error('/uploads/new.png'))
  h.server.currentServer = { id: 'other-community', banner: '/uploads/new.png' }
  await Vue.nextTick()
  assert.equal(h.bannerFailed.value, false)
})
