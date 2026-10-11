import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.test-data')
const previous = { DATA_DIR: process.env.DATA_DIR, LOG_DIR: process.env.LOG_DIR }
const wss = { clients: new Set() }
let dir, db, server, baseUrl, number = 0
before(async () => {
  fs.mkdirSync(root, { recursive: true })
  dir = fs.mkdtempSync(path.join(root, 'broadcast-test-'))
  process.env.DATA_DIR = dir
  process.env.LOG_DIR = path.join(dir, 'logs')
  const { initDB } = await import('../models/db.js')
  const { default: router } = await import('../routes/messages.js')
  db = initDB()
  const app = express()
  app.locals.db = db
  app.locals.wss = wss
  app.use(express.json())
  app.use('/messages', router)
  server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  baseUrl = `http://127.0.0.1:${server.address().port}/messages`
})
after(async () => {
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
  const prefix = `broadcast-${++number}`
  const ownerId = `${prefix}-owner`, readerId = `${prefix}-reader`
  const serverId = `${prefix}-server`, channelId = `${prefix}-channel`, roleId = `${prefix}-viewer`
  for (const userId of [ownerId, readerId]) {
    db.createUser({ id: userId, username: userId })
    db.createSession({ token: `${userId}-token`, userId, createdAt: new Date().toISOString() })
  }
  db.createServer({ id: serverId, ownerId })
  db.createRole({ id: roleId, serverId, isDefault: false, permissions: { viewChannel: true } })
  db.createMember({ serverId, userId: ownerId, roles: [] })
  db.createMember({ serverId, userId: readerId, roles: [roleId] })
  db.createChannel({ id: channelId, serverId, type: 'text' })
  const socket = userId => ({ userId, sessionToken: `${userId}-token`, channelId, readyState: 1, events: [], send(raw) { this.events.push(JSON.parse(raw)) } })
  const owner = socket(ownerId), reader = socket(readerId)
  wss.clients.clear()
  wss.clients.add(owner)
  wss.clients.add(reader)
  db.save()
  return { ownerId, readerId, serverId, channelId, roleId, owner, reader }
}

async function request(f, pathname, method, body) {
  const response = await fetch(baseUrl + pathname, {
    method, headers: { Authorization: `Bearer ${f.ownerId}-token`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const data = await response.json()
  assert.equal(response.status, 200, JSON.stringify(data))
  return data
}

const revocations = {
  '移除查看权限': f => db.updateRole(f.roleId, { permissions: { viewChannel: false } }),
  '踢出成员': f => db.deleteMember(f.serverId, f.readerId),
  '注销会话': f => db.deleteSession(f.reader.sessionToken),
  '会话过期': f => { db.findSession(f.reader.sessionToken).createdAt = '2000-01-01T00:00:00.000Z' },
  '会话身份不匹配或缺失': f => {
    f.reader.sessionToken = f.owner.sessionToken
    wss.clients.add({ ...f.reader, sessionToken: undefined, events: [] })
  }
}
for (const [name, revoke] of Object.entries(revocations)) {
  test(`旧频道订阅${name}后不再收到新消息、编辑、删除及未读推送`, async () => {
    const f = fixture()
    await request(f, '/send', 'POST', { channelId: f.channelId, content: 'before', clientMessageId: `${number}-before` })
    assert.equal(f.reader.events.filter(event => event.type === 'message').length, 1)
    assert.equal(f.reader.events.filter(event => event.type === 'read-state').length, 1)
    revoke(f)
    for (const client of wss.clients) client.events.length = 0
    const sent = await request(f, '/send', 'POST', { channelId: f.channelId, content: 'after', clientMessageId: `${number}-after` })
    await request(f, `/${sent.message.id}`, 'PUT', { content: 'edited' })
    await request(f, `/${sent.message.id}`, 'DELETE')
    assert.deepEqual(f.owner.events.filter(event => ['message', 'message-updated', 'message-deleted'].includes(event.type)).map(event => event.type), ['message', 'message-updated', 'message-deleted'])
    for (const client of wss.clients) if (client !== f.owner) assert.deepEqual(client.events, [])
  })
}
