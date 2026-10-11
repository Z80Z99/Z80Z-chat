import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const testRoot = path.join(projectRoot, '.test-data')
let testDir, db, initDB, server, app, baseUrl, notifyChannelReadStates
let fixtureNumber = 0
const previousEnvironment = { DATA_DIR: process.env.DATA_DIR, LOG_DIR: process.env.LOG_DIR }
const wss = { clients: new Set() }

before(async () => {
  fs.mkdirSync(testRoot, { recursive: true })
  testDir = fs.mkdtempSync(path.join(testRoot, 'read-state-test-'))
  process.env.DATA_DIR = testDir
  process.env.LOG_DIR = path.join(testDir, 'logs')
  ;({ initDB } = await import('../models/db.js'))
  ;({ notifyChannelReadStates } = await import('../utils/read-state.js'))
  const { default: router } = await import('../routes/read-state.js')
  db = initDB()
  app = express()
  app.locals.db = db
  app.locals.wss = wss
  app.use(express.json())
  app.use('/api/read-state', router)
  app.use((error, req, res, next) => res.status(500).json({ error: '阅读状态保存失败' }))
  server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  baseUrl = `http://127.0.0.1:${server.address().port}/api/read-state`
})

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve))
  db?.save()
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  if (testDir) {
    assert.ok(path.resolve(testDir).startsWith(testRoot + path.sep))
    fs.rmSync(testDir, { recursive: true, force: true })
  }
  try { fs.rmdirSync(testRoot) } catch {}
})

function fixture() {
  const prefix = `read-${++fixtureNumber}`
  const serverId = `${prefix}-server`
  const users = Object.fromEntries(['owner', 'reader', 'denied', 'outsider'].map(name => [name, `${prefix}-${name}`]))
  const tokens = {}
  for (const [name, userId] of Object.entries(users)) {
    db.createUser({ id: userId, username: userId })
    tokens[name] = `${userId}-token`
    db.createSession({ token: tokens[name], userId, createdAt: new Date().toISOString() })
  }
  db.createSession({ token: `${tokens.reader}-second`, userId: users.reader, createdAt: new Date().toISOString() })
  db.createServer({ id: serverId, ownerId: users.owner })
  const viewerRole = `${prefix}-viewer`
  db.createRole({ id: viewerRole, serverId, permissions: { viewChannel: true }, isDefault: false })
  for (const name of ['owner', 'reader', 'denied']) {
    db.createMember({ serverId, userId: users[name], roles: name === 'reader' ? [viewerRole] : [] })
  }
  const channels = { first: `${prefix}-first`, second: `${prefix}-second`, voice: `${prefix}-voice` }
  for (const [name, id] of Object.entries(channels)) db.createChannel({ id, serverId, type: name === 'voice' ? 'voice' : 'text' })
  let messageNumber = 0
  function createMessage(userId = users.owner, channelId = channels.first) {
    return db.createMessage({
      id: `${prefix}-message-${++messageNumber}`, userId, channelId,
      content: 'private message body', createdAt: new Date().toISOString(),
      editedAt: null, image: null, file: null, fileName: null, replyTo: null,
      mentions: [], mentionEveryone: false
    })
  }
  wss.clients.clear()
  db.save()
  return { serverId, users, tokens, channels, createMessage }
}

async function request(pathname, token, body) {
  const response = await fetch(baseUrl + pathname, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  return { status: response.status, data: await response.json() }
}

function socket(userId, options = {}) {
  const client = {
    userId, sessionToken: `${userId}-token`, readyState: 1, channelId: null, received: [],
    send(value) { this.received.push(JSON.parse(value)) },
    ...options
  }
  wss.clients.add(client)
  return client
}

const findState = (response, channelId) => response.data.states.find(state => state.channelId === channelId)

test('初次查询以现有消息为基线，仅返回文字频道并持久化初始化', async () => {
  const f = fixture()
  f.createMessage()
  const historical = f.createMessage()
  // Simulate imported historical messages whose reader has never had a persisted baseline.
  db.raw.readStates = db.raw.readStates.filter(item => item.userId !== f.users.reader)
  const result = await request(`/${f.serverId}`, f.tokens.reader)
  assert.equal(result.status, 200)
  assert.equal(result.data.serverId, f.serverId)
  assert.equal(result.data.states.length, 2)
  assert.ok(result.data.states.every(state => state.channelId !== f.channels.voice))
  const state = findState(result, f.channels.first)
  assert.equal(state.readSequence, historical.sequence)
  assert.equal(state.latestSequence, historical.sequence)
  assert.equal(state.unreadCount, 0)
  assert.equal(findState(result, f.channels.second).readSequence, 0)
  const persisted = JSON.parse(fs.readFileSync(path.join(testDir, 'db.json'), 'utf8'))
  assert.ok(persisted.readStates.some(item => item.userId === f.users.reader && item.channelId === f.channels.first && item.readSequence === historical.sequence))
})

test('未读只计算他人消息，自己的新消息不增加数量', async () => {
  const f = fixture()
  await request(`/${f.serverId}`, f.tokens.reader)
  const other = f.createMessage()
  let result = await request(`/${f.serverId}`, f.tokens.reader)
  assert.equal(findState(result, f.channels.first).unreadCount, 1)
  const own = f.createMessage(f.users.reader)
  result = await request(`/${f.serverId}`, f.tokens.reader)
  const state = findState(result, f.channels.first)
  assert.equal(state.unreadCount, 1)
  assert.equal(state.latestSequence, own.sequence)
  assert.ok(own.sequence > other.sequence)
})

test('阅读推进单调且使用真实消息序号，所有设备收到一致状态并在重启后保留', async () => {
  const f = fixture()
  const oldest = f.createMessage()
  await request(`/${f.serverId}`, f.tokens.reader)
  const newest = f.createMessage()
  const first = socket(f.users.reader)
  const second = socket(f.users.reader, { channelId: f.channels.second })
  const owner = socket(f.users.owner)
  const advanced = await request(`/${f.channels.first}`, f.tokens.reader, { messageId: newest.id, sequence: Number.MAX_SAFE_INTEGER })
  assert.equal(advanced.status, 200)
  assert.equal(advanced.data.state.readSequence, newest.sequence)
  assert.equal(advanced.data.state.unreadCount, 0)
  assert.deepEqual(first.received, [{ type: 'read-state', ...advanced.data }])
  assert.deepEqual(second.received, first.received)
  assert.deepEqual(owner.received, [])
  const stale = await request(`/${f.channels.first}`, `${f.tokens.reader}-second`, { messageId: oldest.id })
  assert.equal(stale.status, 200)
  assert.equal(stale.data.state.readSequence, newest.sequence)
  assert.equal(stale.data.state.revision, advanced.data.state.revision)
  db = initDB()
  app.locals.db = db
  const restarted = await request(`/${f.serverId}`, f.tokens.reader)
  assert.equal(findState(restarted, f.channels.first).readSequence, newest.sequence)
  assert.equal(findState(restarted, f.channels.first).unreadCount, 0)
})

test('删除更新未读和revision，阅读游标与消息序号不倒退', async () => {
  const f = fixture()
  await request(`/${f.serverId}`, f.tokens.reader)
  const first = f.createMessage()
  const second = f.createMessage()
  const beforeDelete = db.getChannelReadState(f.users.reader, f.channels.first)
  assert.equal(beforeDelete.unreadCount, 2)
  db.deleteMessage(first.id)
  notifyChannelReadStates(db, wss, f.channels.first)
  const afterDelete = db.getChannelReadState(f.users.reader, f.channels.first)
  assert.equal(afterDelete.unreadCount, 1)
  assert.ok(afterDelete.revision > beforeDelete.revision)
  const read = await request(`/${f.channels.first}`, f.tokens.reader, { messageId: second.id })
  db.deleteMessage(second.id)
  notifyChannelReadStates(db, wss, f.channels.first)
  const empty = db.getChannelReadState(f.users.reader, f.channels.first)
  assert.equal(empty.readSequence, read.data.state.readSequence)
  assert.equal(empty.unreadCount, 0)
  assert.ok(empty.revision > read.data.state.revision)
  assert.ok(f.createMessage().sequence > second.sequence)
})

test('拒绝跨频道或伪造游标、语音频道及无身份和无查看权限请求', async () => {
  const f = fixture()
  await request(`/${f.serverId}`, f.tokens.reader)
  const foreign = f.createMessage(f.users.owner, f.channels.second)
  const legitimate = f.createMessage()
  assert.equal((await request(`/${f.channels.first}`, f.tokens.reader, { messageId: foreign.id })).status, 400)
  assert.equal((await request(`/${f.channels.first}`, f.tokens.reader, { sequence: legitimate.sequence })).status, 400)
  assert.equal((await request(`/${f.channels.first}`, f.tokens.reader, { messageId: 'missing' })).status, 400)
  assert.equal((await request(`/${f.channels.voice}`, f.tokens.reader, { messageId: legitimate.id })).status, 400)
  assert.equal(db.getChannelReadState(f.users.reader, f.channels.first).readSequence, 0)
  for (const name of ['outsider', 'denied']) {
    assert.equal((await request(`/${f.serverId}`, f.tokens[name])).status, 403)
    assert.equal((await request(`/${f.channels.first}`, f.tokens[name], { messageId: legitimate.id })).status, 403)
  }
  assert.equal((await request(`/${f.serverId}`)).status, 401)
})

test('频道通知发往可查看成员的全部会话，跳过无权限/非成员且不包含正文', async () => {
  const f = fixture()
  // No preceding GET: the first message after membership must still become unread.
  const broken = socket(f.users.reader, { send() { throw new Error('closed transport') } })
  const first = socket(f.users.reader)
  const second = socket(f.users.reader, { channelId: f.channels.second })
  const owner = socket(f.users.owner)
  const denied = socket(f.users.denied)
  const outsider = socket(f.users.outsider)
  const closed = socket(f.users.reader, { readyState: 3 })
  const newMessage = f.createMessage()
  assert.doesNotThrow(() => notifyChannelReadStates(db, wss, f.channels.first))
  assert.equal(first.received.length, 1)
  assert.deepEqual(second.received, first.received)
  assert.equal(owner.received.length, 1)
  assert.equal(first.received[0].state.unreadCount, 1)
  assert.equal(owner.received[0].state.unreadCount, 0)
  assert.equal(first.received[0].state.latestSequence, newMessage.sequence)
  assert.deepEqual(Object.keys(first.received[0]).sort(), ['serverId', 'state', 'type'])
  assert.deepEqual(Object.keys(first.received[0].state).sort(), ['channelId', 'latestSequence', 'mentionCount', 'readSequence', 'revision', 'unreadCount'])
  for (const client of [broken, denied, outsider, closed]) assert.deepEqual(client.received, [])
  assert.ok(!JSON.stringify(first.received).includes('private message body'))
})

test('保存失败不返回阅读成功或推送，通知保存失败不破坏已落盘消息', async () => {
  const f = fixture()
  await request(`/${f.serverId}`, f.tokens.reader)
  const message = f.createMessage()
  db.save()
  const reader = socket(f.users.reader)
  const tmpPath = path.join(testDir, 'db.json.tmp')
  fs.mkdirSync(tmpPath)
  try {
    const response = await request(`/${f.channels.first}`, f.tokens.reader, { messageId: message.id })
    assert.equal(response.status, 500)
    assert.deepEqual(reader.received, [])
    assert.doesNotThrow(() => notifyChannelReadStates(db, wss, f.channels.first))
    assert.deepEqual(reader.received, [])
    const persisted = JSON.parse(fs.readFileSync(path.join(testDir, 'db.json'), 'utf8'))
    assert.ok(persisted.messages.some(item => item.id === message.id))
  } finally {
    fs.rmdirSync(tmpPath)
    db.save()
  }
  const recovered = await request(`/${f.channels.first}`, f.tokens.reader, { messageId: message.id })
  assert.equal(recovered.status, 200)
  assert.equal(reader.received.length, 1)
})
