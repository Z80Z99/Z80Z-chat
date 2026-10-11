import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import WebSocket, { WebSocketServer } from 'ws'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.test-data')
const previous = { DATA_DIR: process.env.DATA_DIR, LOG_DIR: process.env.LOG_DIR }
const wss = { clients: new Set() }
let dir, db, server, baseUrl, realWss, websocketHeartbeat, number = 0

before(async () => {
  fs.mkdirSync(root, { recursive: true })
  dir = fs.mkdtempSync(path.join(root, 'announcement-channels-'))
  process.env.DATA_DIR = dir
  process.env.LOG_DIR = path.join(dir, 'logs')
  const { initDB } = await import('../models/db.js')
  db = initDB()
  const app = express()
  app.locals.db = db
  app.locals.wss = wss
  app.use(express.json())
  for (const [name, file] of [['channels', 'channels'], ['messages', 'messages'], ['read-state', 'read-state'], ['mentions', 'mentions']]) {
    const { default: router } = await import(`../routes/${file}.js`)
    app.use(`/${name}`, router)
  }
  app.use((error, req, res, next) => res.status(500).json({ error: error.message }))
  server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  baseUrl = `http://127.0.0.1:${server.address().port}`
  realWss = new WebSocketServer({ server })
  const { handleWebSocket } = await import('../websocket/index.js')
  const originalInterval = globalThis.setInterval
  globalThis.setInterval = (...args) => { websocketHeartbeat = originalInterval(...args); return websocketHeartbeat }
  try { handleWebSocket(realWss, db) } finally { globalThis.setInterval = originalInterval }
})

after(async () => {
  clearInterval(websocketHeartbeat)
  for (const client of realWss?.clients || []) client.terminate()
  if (realWss) await new Promise(resolve => realWss.close(resolve))
  if (server) await new Promise(resolve => server.close(resolve))
  db?.save()
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  if (dir) {
    assert.ok(path.resolve(dir).startsWith(root + path.sep))
    fs.rmSync(dir, { recursive: true, force: true })
  }
  try { fs.rmdirSync(root) } catch {}
})

function fixture() {
  const prefix = `announcement-${++number}`
  const serverId = `${prefix}-server`, otherServerId = `${prefix}-other-server`
  const users = Object.fromEntries(['owner', 'publisher', 'reader', 'denied', 'outsider'].map(name => [name, `${prefix}-${name}`]))
  const tokens = {}
  for (const [name, userId] of Object.entries(users)) {
    db.createUser({ id: userId, username: userId })
    tokens[name] = `${userId}-token`
    db.createSession({ token: tokens[name], userId, createdAt: new Date().toISOString() })
  }
  db.createServer({ id: serverId, ownerId: users.owner })
  db.createServer({ id: otherServerId, ownerId: users.owner })
  const roles = { reader: `${prefix}-reader-role`, publisher: `${prefix}-publisher-role` }
  db.createRole({ id: roles.reader, serverId, permissions: { viewChannel: true, sendMessage: true } })
  db.createRole({ id: roles.publisher, serverId, permissions: { viewChannel: true, sendMessage: true, manageMessages: true, uploadFile: true } })
  for (const name of ['owner', 'publisher', 'reader', 'denied']) db.createMember({ serverId, userId: users[name], roles: roles[name] ? [roles[name]] : [], muted: false })
  const categories = { own: `${prefix}-category`, other: `${prefix}-other-category` }
  db.createCategory({ id: categories.own, serverId, name: '公告分组' })
  db.createCategory({ id: categories.other, serverId: otherServerId, name: '其他社区' })
  const channelId = `${prefix}-announcements`, textId = `${prefix}-text`, voiceId = `${prefix}-voice`
  db.createChannel({ id: channelId, serverId, categoryId: null, name: '公告', type: 'announcement' })
  db.createChannel({ id: textId, serverId, categoryId: null, name: '聊天', type: 'text' })
  db.createChannel({ id: voiceId, serverId, categoryId: null, name: '语音', type: 'voice' })
  wss.clients.clear()
  const socket = (name, extra = {}) => {
    const client = { userId: users[name], sessionToken: tokens[name], channelId, readyState: 1, events: [],
      send(raw) { this.events.push(JSON.parse(raw)) }, ...extra }
    wss.clients.add(client)
    return client
  }
  db.save()
  return { serverId, users, tokens, roles, categories, channelId, textId, voiceId, socket }
}

async function request(pathname, token, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(baseUrl + pathname, { method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, data: await response.json() }
}
const send = (f, name, content = '社区公告', extra = {}) => request('/messages/send', f.tokens[name], { channelId: f.channelId, content, ...extra })
const edit = (f, name, id, content = '已编辑公告') => request(`/messages/${id}`, f.tokens[name], { content }, 'PUT')

test('频道创建白名单、1至50字符名称、同服分类校验，公告类型持久化', async () => {
  const f = fixture()
  for (const type of ['text', 'voice', 'announcement']) {
    const result = await request('/channels/create', f.tokens.owner, { serverId: f.serverId, type, name: '  New Channel  ', categoryId: f.categories.own })
    assert.equal(result.status, 200)
    assert.equal(result.data.channel.type, type)
    assert.equal(result.data.channel.name, 'new-channel')
    assert.equal(result.data.channel.revision, 1)
    const durable = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'))
    assert.equal(durable.channels.find(channel => channel.id === result.data.channel.id).type, type)
  }
  for (const type of ['', null, 'unknown', {}, ['text']]) assert.equal((await request('/channels/create', f.tokens.owner, { serverId: f.serverId, name: 'invalid', type })).status, 400)
  for (const name of ['', '   ', 12, {}, '长'.repeat(51)]) assert.equal((await request('/channels/create', f.tokens.owner, { serverId: f.serverId, name })).status, 400)
  for (const categoryId of ['', 'missing', f.categories.other, 1]) assert.equal((await request('/channels/create', f.tokens.owner, { serverId: f.serverId, name: 'invalid', categoryId })).status, 400)
  assert.equal((await request('/channels/create', f.tokens.reader, { serverId: f.serverId, name: 'forbidden', type: 'announcement' })).status, 403)
})

test('现有文字、语音、公告频道不能转换类型，同类型设置从旧版本0递增', async () => {
  const f = fixture()
  for (const [id, current] of [[f.channelId, 'announcement'], [f.textId, 'text'], [f.voiceId, 'voice']]) {
    for (const type of ['text', 'voice', 'announcement'].filter(type => type !== current)) {
      assert.equal((await request(`/channels/${id}`, f.tokens.owner, { type }, 'PUT')).status, 400)
      assert.equal(db.findChannel(id).type, current)
    }
    const updated = await request(`/channels/${id}`, f.tokens.owner, { type: current, name: '  Renamed Channel ' }, 'PUT')
    assert.equal(updated.status, 200)
    assert.equal(updated.data.channel.revision, 1)
    assert.equal(updated.data.channel.name, 'renamed-channel')
    assert.equal((await request(`/channels/${id}`, f.tokens.owner, { categoryId: f.categories.other }, 'PUT')).status, 400)
    assert.equal((await request(`/channels/${id}`, f.tokens.owner, { name: '  ' }, 'PUT')).status, 400)
    assert.equal(db.findChannel(id).revision, 1)
  }
})

test('普通成员不能发布或回复公告，可读、搜索及添加回应，普通文字发送不变', async () => {
  const f = fixture()
  const published = await send(f, 'owner', '可搜索的社区公告')
  assert.equal(published.status, 200)
  assert.equal((await send(f, 'reader')).status, 403)
  assert.equal((await send(f, 'reader', '回复公告', { replyTo: published.data.message.id })).status, 403)
  assert.equal((await request('/messages/send', f.tokens.reader, { channelId: f.textId, content: '普通聊天' })).status, 200)
  assert.equal((await request(`/messages/list/${f.channelId}`, f.tokens.reader)).status, 200)
  const search = await request(`/messages/search/${f.channelId}?q=${encodeURIComponent('社区公告')}`, f.tokens.reader)
  assert.equal(search.status, 200)
  assert.equal(search.data.messages[0].id, published.data.message.id)
  const reacted = await request(`/messages/${published.data.message.id}/reactions`, f.tokens.reader, { emoji: '👍', active: true }, 'PUT')
  assert.equal(reacted.status, 200)
  assert.deepEqual(reacted.data.message.reactions[0].userIds, [f.users.reader])
  assert.equal((await request(`/messages/${published.data.message.id}/pin`, f.tokens.reader, { pinned: true }, 'PUT')).status, 403)
})

test('拥有管理消息权限的成员可发布、编辑自己的公告、置顶，不可编辑他人公告', async () => {
  const f = fixture()
  const published = await send(f, 'publisher')
  assert.equal(published.status, 200)
  assert.equal((await edit(f, 'publisher', published.data.message.id)).status, 200)
  const other = await send(f, 'owner')
  assert.equal((await edit(f, 'publisher', other.data.message.id)).status, 403)
  assert.equal((await request(`/messages/${published.data.message.id}/pin`, f.tokens.publisher, { pinned: true }, 'PUT')).status, 200)
  const pins = await request(`/messages/pins/${f.channelId}`, f.tokens.reader)
  assert.equal(pins.data.pins[0].id, published.data.message.id)
})

test('公告发布者仍受禁言、sendMessage、viewChannel及uploadFile限制', async () => {
  const f = fixture()
  const role = db.findRole(f.roles.publisher)
  const message = await send(f, 'publisher', '原公告')
  for (const permission of ['sendMessage', 'viewChannel', 'manageMessages']) {
    role.permissions[permission] = false
    assert.equal((await send(f, 'publisher')).status, 403, permission)
    assert.equal((await edit(f, 'publisher', message.data.message.id)).status, 403, permission)
    role.permissions[permission] = true
  }
  db.findMember(f.serverId, f.users.publisher).muted = true
  assert.equal((await send(f, 'publisher')).status, 403)
  assert.equal((await edit(f, 'publisher', message.data.message.id)).status, 403)
  db.findMember(f.serverId, f.users.publisher).muted = false
  role.permissions.uploadFile = false
  assert.equal((await send(f, 'publisher', '附件', { file: '/uploads/test.txt', fileName: 'test.txt' })).status, 403)
  assert.equal((await send(f, 'publisher', '', { image: '/uploads/test.png' })).status, 403)
  assert.equal((await send(f, 'publisher', '仍可发布文字')).status, 200)
  assert.equal((await send(f, 'outsider')).status, 403)
})

test('公告失去发布或附件权限后，已确认消息的同标识重试也拒绝，不重复创建', async () => {
  const f = fixture()
  const payload = { clientMessageId: 'durable-announcement', file: '/uploads/example.txt' }
  const first = await send(f, 'publisher', '持久化公告', payload)
  assert.equal(first.status, 200)
  const role = db.findRole(f.roles.publisher)
  for (const permission of ['manageMessages', 'uploadFile']) {
    role.permissions[permission] = false
    assert.equal((await send(f, 'publisher', '持久化公告', payload)).status, 403)
    role.permissions[permission] = true
  }
  const retry = await send(f, 'publisher', '持久化公告', payload)
  assert.equal(retry.status, 200)
  assert.equal(retry.data.message.id, first.data.message.id)
  assert.equal(db.raw.messages.filter(message => message.channelId === f.channelId).length, 1)
})

test('公告未读、提及、提醒模式与跨会话阅读同步沿用消息体系', async () => {
  const f = fixture(), reader = f.socket('reader')
  const mode = await request(`/mentions/preferences/${f.channelId}`, f.tokens.reader, { mode: 'all' }, 'PUT')
  assert.equal(mode.status, 200)
  const first = await send(f, 'owner', '没有提及的公告')
  const second = await send(f, 'owner', `提及 <@${f.users.reader}>`)
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.ok(reader.events.some(event => event.type === 'mention-notification' && event.reason === 'message'))
  assert.ok(reader.events.some(event => event.type === 'mention-notification' && event.reason === 'mention'))
  const states = await request(`/read-state/${f.serverId}`, f.tokens.reader)
  const state = states.data.states.find(state => state.channelId === f.channelId)
  assert.equal(state.unreadCount, 2)
  assert.equal(state.mentionCount, 1)
  const inbox = await request('/mentions', f.tokens.reader)
  assert.equal(inbox.data.notifications.filter(item => item.channelId === f.channelId).length, 2)
  const marked = await request(`/read-state/${f.channelId}`, f.tokens.reader, { messageId: second.data.message.id })
  assert.equal(marked.status, 200)
  assert.equal(marked.data.state.unreadCount, 0)
  assert.ok(reader.events.some(event => event.type === 'read-state' && event.state.readSequence === second.data.message.sequence))
  const after = await request('/mentions', f.tokens.reader)
  assert.equal(after.data.notifications.filter(item => item.channelId === f.channelId).length, 0)
  assert.equal((await request(`/mentions/preferences/${f.channelId}`, f.tokens.reader)).data.mode, 'all')
})

test('公告消息定位、编辑提醒失效事件可用，语音频道不接受消息或阅读标记', async () => {
  const f = fixture(), reader = f.socket('reader')
  const published = await send(f, 'owner', `<@${f.users.reader}> 变更公告`)
  const context = await request(`/messages/context/${f.channelId}/${published.data.message.id}`, f.tokens.reader)
  assert.equal(context.status, 200)
  assert.ok(context.data.messages.some(message => message.id === published.data.message.id))
  assert.equal((await edit(f, 'owner', published.data.message.id, '移除提及')).status, 200)
  assert.ok(reader.events.some(event => event.type === 'mention-invalidated' && event.messageId === published.data.message.id))
  assert.equal((await request('/messages/send', f.tokens.owner, { channelId: f.voiceId, content: 'invalid' })).status, 400)
  assert.equal((await request(`/read-state/${f.voiceId}`, f.tokens.owner, { messageId: published.data.message.id })).status, 400)
})

test('频道事件只在成功落盘后发送至同服可查看且会话有效的成员，各设备均可接收', async () => {
  const f = fixture()
  const owner = f.socket('owner'), reader = f.socket('reader'), otherDevice = f.socket('reader', { channelId: null })
  const denied = f.socket('denied'), outsider = f.socket('outsider')
  const expired = f.socket('reader', { sessionToken: `${f.tokens.reader}-expired` })
  db.createSession({ token: expired.sessionToken, userId: f.users.reader, createdAt: '2000-01-01T00:00:00Z' })
  const revoked = f.socket('reader', { sessionToken: 'revoked-session' })
  const closed = f.socket('reader', { readyState: 3 })
  reader.send = function (raw) {
    const event = JSON.parse(raw)
    if (event.channel) {
      const durable = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).channels.find(channel => channel.id === event.channel.id)
      assert.equal(durable.revision, event.channel.revision)
    }
    this.events.push(event)
  }
  const created = await request('/channels/create', f.tokens.owner, { serverId: f.serverId, name: '活动公告', type: 'announcement' })
  assert.equal(created.status, 200)
  const id = created.data.channel.id
  assert.equal((await request(`/channels/${id}`, f.tokens.owner, { name: '更新的公告' }, 'PUT')).status, 200)
  assert.equal((await request(`/channels/${id}`, f.tokens.owner, undefined, 'DELETE')).status, 200)
  for (const client of [owner, reader, otherDevice]) {
    assert.deepEqual(client.events.map(event => event.type), ['channel-created', 'channel-updated', 'channel-deleted'])
    assert.equal(client.events[0].channel.revision, 1)
    assert.equal(client.events[1].channel.revision, 2)
    assert.equal(client.events[2].channelId, id)
  }
  for (const client of [denied, outsider, expired, revoked, closed]) assert.equal(client.events.length, 0)
})

test('频道创建和更新落盘失败回滚名称、版本与列表，禁止发出事件；恢复后可重试', async () => {
  const f = fixture(), reader = f.socket('reader')
  const originalSave = db.save
  const before = JSON.stringify(db.raw.channels)
  db.save = () => { throw new Error('disk unavailable') }
  try {
    assert.equal((await request('/channels/create', f.tokens.owner, { serverId: f.serverId, name: '失败公告', type: 'announcement' })).status, 500)
    assert.equal(JSON.stringify(db.raw.channels), before)
    assert.equal((await request(`/channels/${f.channelId}`, f.tokens.owner, { name: '失败重命名' }, 'PUT')).status, 500)
    assert.equal(JSON.stringify(db.raw.channels), before)
    assert.equal(reader.events.length, 0)
  } finally { db.save = originalSave; db.save() }
  assert.equal((await request(`/channels/${f.channelId}`, f.tokens.owner, { name: '恢复重命名' }, 'PUT')).status, 200)
  assert.equal(reader.events.length, 1)
  assert.equal(reader.events[0].channel.revision, 1)
})

test('频道删除落盘失败恢复消息、阅读状态、偏好及版本，恢复后删除可用', async () => {
  const f = fixture()
  await request(`/mentions/preferences/${f.channelId}`, f.tokens.reader, { mode: 'all' }, 'PUT')
  const published = await send(f, 'owner')
  const reader = f.socket('reader')
  const fields = ['channels', 'messages', 'readStates', 'notificationPreferences', 'readStateRevision']
  const before = Object.fromEntries(fields.map(field => [field, JSON.stringify(db.raw[field])]))
  const originalSave = db.save
  db.save = () => { throw new Error('disk unavailable') }
  try {
    assert.equal((await request(`/channels/${f.channelId}`, f.tokens.owner, undefined, 'DELETE')).status, 500)
    for (const field of fields) assert.equal(JSON.stringify(db.raw[field]), before[field], field)
    assert.ok(db.findMessage(published.data.message.id))
    assert.equal(reader.events.length, 0)
  } finally { db.save = originalSave; db.save() }
  assert.equal((await request(`/channels/${f.channelId}`, f.tokens.owner, undefined, 'DELETE')).status, 200)
  assert.equal(db.findMessage(published.data.message.id), undefined)
  assert.equal(reader.events[0].type, 'channel-deleted')
})

function connect(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl.replace('http:', 'ws:') + `/?token=${token}`)
    ws.once('open', () => resolve(ws)); ws.once('error', reject)
  })
}
function sendSocket(ws, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMessage); reject(new Error('socket response timed out')) }, 5000)
    const onMessage = raw => {
      const event = JSON.parse(raw.toString())
      if (event.clientMessageId !== payload.clientMessageId || !['message-ack', 'message-error'].includes(event.type)) return
      clearTimeout(timer); ws.off('message', onMessage); resolve(event)
    }
    ws.on('message', onMessage); ws.send(JSON.stringify({ type: 'message', ...payload }))
  })
}

test('真实 WebSocket 公告发送与 REST 共用发布检查，失权同标识重试不复活消息', async () => {
  const f = fixture(), reader = await connect(f.tokens.reader), publisher = await connect(f.tokens.publisher)
  try {
    const denied = await sendSocket(reader, { channelId: f.channelId, content: '普通成员公告', clientMessageId: 'reader-denied' })
    assert.equal(denied.type, 'message-error')
    assert.equal(denied.status, 403)
    const payload = { channelId: f.channelId, content: 'WS管理成员公告', clientMessageId: 'publisher-socket' }
    const accepted = await sendSocket(publisher, payload)
    assert.equal(accepted.type, 'message-ack')
    assert.equal(accepted.status, 200)
    db.findRole(f.roles.publisher).permissions.manageMessages = false
    const revoked = await sendSocket(publisher, payload)
    assert.equal(revoked.type, 'message-error')
    assert.equal(revoked.status, 403)
    const rest = await request('/messages/send', f.tokens.publisher, payload)
    assert.equal(rest.status, 403)
    assert.equal(db.raw.messages.filter(message => message.channelId === f.channelId).length, 1)
  } finally { reader.terminate(); publisher.terminate() }
})
