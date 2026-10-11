import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { createMessageSearchRateLimiter } from '../utils/message-search-rate.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.test-data')
const previous = { DATA_DIR: process.env.DATA_DIR, LOG_DIR: process.env.LOG_DIR }
const wss = { clients: new Set() }
let dir, db, server, baseUrl, number = 0
before(async () => {
  fs.mkdirSync(root, { recursive: true })
  dir = fs.mkdtempSync(path.join(root, 'message-interactions-'))
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
  app.use((error, req, res, next) => res.status(error.type === 'entity.parse.failed' ? 400 : 500).json({ error: error.message }))
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
  const prefix = `interaction-${++number}`
  const ownerId = `${prefix}-owner`, memberId = `${prefix}-member`, outsiderId = `${prefix}-outsider`
  const serverId = `${prefix}-server`, channelId = `${prefix}-channel`, roleId = `${prefix}-member-role`
  for (const userId of [ownerId, memberId, outsiderId]) {
    db.createUser({ id: userId, username: userId, password: 'secret', nickname: userId + ' nickname' })
    db.createSession({ token: `${userId}-token`, userId, createdAt: new Date().toISOString() })
  }
  db.createServer({ id: serverId, ownerId })
  db.createRole({ id: roleId, serverId, isDefault: false, permissions: { viewChannel: true, sendMessage: true, manageMessages: false } })
  db.createMember({ serverId, userId: ownerId, roles: [] })
  db.createMember({ serverId, userId: memberId, roles: [roleId] })
  db.createChannel({ id: channelId, serverId, type: 'text' })
  const socket = userId => ({ userId, sessionToken: `${userId}-token`, channelId, readyState: 1, events: [], send(raw) {
    const event = JSON.parse(raw)
    if (event.type === 'message-updated') {
      const durable = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).messages.find(message => message.id === event.message.id)
      assert.equal(durable.revision, event.message.revision, 'broadcast must follow durable save')
    }
    this.events.push(event)
  } })
  const owner = socket(ownerId), member = socket(memberId)
  wss.clients.clear()
  wss.clients.add(owner)
  wss.clients.add(member)
  db.save()
  return { ownerId, memberId, outsiderId, serverId, channelId, roleId, owner, member }
}

function create(f, content = 'message', userId = f.ownerId) {
  const message = db.createMessage({ id: `${f.channelId}-message-${db.raw.lastMessageSequence + 1}`, channelId: f.channelId, userId, content, createdAt: '2026-10-09T00:00:00.000Z' })
  db.save()
  return message
}
async function request(f, pathname, { method = 'GET', body, userId = f.ownerId, token = `${userId}-token` } = {}) {
  const response = await fetch(baseUrl + pathname, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  })
  return { status: response.status, data: await response.json(), headers: response.headers }
}
const react = (f, id, emoji = '👍', active = true, userId) => request(f, `/${id}/reactions`, { method: 'PUT', body: { emoji, active }, userId })
const pin = (f, id, pinned = true, userId) => request(f, `/${id}/pin`, { method: 'PUT', body: { pinned }, userId })

test('旧消息只在响应补齐空字段，发送及编辑返回公开作者和版本', async () => {
  const f = fixture(), message = create(f)
  delete message.reactions
  delete message.pin
  delete message.revision
  db.updateUser(f.ownerId, { nickname: 'old author' })
  db.save()
  const durableBefore = fs.readFileSync(path.join(dir, 'db.json'), 'utf8')
  const list = await request(f, `/list/${f.channelId}`)
  assert.equal(list.status, 200)
  assert.deepEqual(list.data.messages[0].reactions, [])
  assert.equal(list.data.messages[0].pin, null)
  assert.equal(list.data.messages[0].revision, 0)
  assert.equal(list.data.messages[0].user.nickname, 'old author')
  assert.equal(list.data.messages[0].user.password, undefined)
  assert.equal(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'), durableBefore)
  const send = await request(f, '/send', { method: 'POST', body: { channelId: f.channelId, content: 'sent' } })
  assert.equal(send.status, 200)
  assert.deepEqual(send.data.message.reactions, [])
  assert.equal(send.data.message.pin, null)
  assert.equal(send.data.message.revision, 0)
  const edit = await request(f, `/${message.id}`, { method: 'PUT', body: { content: 'edited' } })
  assert.equal(edit.status, 200)
  assert.equal(edit.data.message.revision, 1)
  assert.equal(edit.data.message.user.id, f.ownerId)
})

test('并发重复回应幂等，同表情用户唯一，移除不影响其他用户', async () => {
  const f = fixture(), message = create(f)
  const responses = await Promise.all(Array.from({ length: 10 }, () => react(f, message.id)))
  assert.ok(responses.every(response => response.status === 200 && response.data.message.revision === 1))
  assert.deepEqual(message.reactions, [{ emoji: '👍', userIds: [f.ownerId] }])
  assert.equal(f.member.events.filter(event => event.type === 'message-updated').length, 1)
  assert.equal((await react(f, message.id, '👍', true, f.memberId)).status, 200)
  assert.equal(message.revision, 2)
  assert.deepEqual(message.reactions[0].userIds, [f.ownerId, f.memberId])
  const response = await request(f, `/list/${f.channelId}`)
  assert.deepEqual(response.data.messages[0].reactions[0].users.map(user => user.id), [f.ownerId, f.memberId])
  assert.ok(response.data.messages[0].reactions[0].users.every(user => user.password === undefined && user.token === undefined))
  assert.equal((await react(f, message.id, '👍', false)).status, 200)
  assert.equal(message.revision, 3)
  assert.deepEqual(message.reactions[0].userIds, [f.memberId])
  assert.equal((await react(f, message.id, '👍', false)).data.message.revision, 3)
  db.raw.users = db.raw.users.filter(user => user.id !== f.memberId)
  assert.deepEqual((await request(f, `/list/${f.channelId}`)).data.messages[0].reactions[0].users, [])
  db.createUser({ id: f.memberId, username: f.memberId })
  assert.equal((await react(f, message.id, '👍', false, f.memberId)).status, 200)
  assert.deepEqual(message.reactions, [])
})

test('固定六种回应，拒绝不支持表情及非布尔 active', async () => {
  const f = fixture(), message = create(f)
  for (const emoji of ['👍', '❤️', '😂', '🎉', '😮', '😢']) assert.equal((await react(f, message.id, emoji)).status, 200)
  for (const body of [{ emoji: '🚀', active: true }, { emoji: '👍', active: 1 }, { emoji: '👍', active: 'false' }, { active: true }, null]) {
    assert.equal((await request(f, `/${message.id}/reactions`, { method: 'PUT', body })).status, 400)
  }
  assert.equal(message.revision, 6)
})

test('回应加入及撤销均检查当前成员、禁言、发送和查看权限', async () => {
  const f = fixture(), message = create(f)
  assert.equal((await react(f, message.id, '👍', true, f.memberId)).status, 200)
  const permission = { ...db.findRole(f.roleId).permissions }
  for (const deny of [
    () => db.updateMember(f.serverId, f.memberId, { muted: true }),
    () => db.updateRole(f.roleId, { permissions: { ...permission, sendMessage: false } }),
    () => db.updateRole(f.roleId, { permissions: { ...permission, viewChannel: false } }),
    () => db.deleteMember(f.serverId, f.memberId)
  ]) {
    deny()
    for (const active of [true, false]) assert.equal((await react(f, message.id, '👍', active, f.memberId)).status, 403)
    db.updateRole(f.roleId, { permissions: permission })
    if (!db.findMember(f.serverId, f.memberId)) db.createMember({ serverId: f.serverId, userId: f.memberId, roles: [f.roleId] })
    db.updateMember(f.serverId, f.memberId, { muted: false })
  }
  assert.equal((await react(f, message.id, '👍', true, f.outsiderId)).status, 403)
  assert.equal((await request(f, `/${message.id}/reactions`, { method: 'PUT', body: { emoji: '👍', active: true }, token: 'invalid' })).status, 401)
})

test('置顶需要管理消息权限，重放保留原操作者和时间，删除自动清除置顶', async () => {
  const f = fixture(), first = create(f, 'first'), second = create(f, 'second')
  assert.equal((await pin(f, first.id, true, f.memberId)).status, 403)
  assert.equal((await request(f, `/${first.id}/pin`, { method: 'PUT', body: { pinned: 'true' } })).status, 400)
  const pinned = await pin(f, first.id)
  assert.equal(pinned.status, 200)
  assert.equal(pinned.data.message.pin.user.id, f.ownerId)
  assert.equal(pinned.data.message.pin.user.password, undefined)
  db.updateRole(f.roleId, { permissions: { viewChannel: true, manageMessages: true } })
  assert.deepEqual((await pin(f, first.id, true, f.memberId)).data.message.pin, pinned.data.message.pin)
  assert.equal(first.revision, 1)
  first.pin.createdAt = '2026-10-09T00:00:00.000Z'
  await pin(f, second.id)
  const pins = await request(f, `/pins/${f.channelId}`)
  assert.deepEqual(pins.data.pins.map(message => message.id), [second.id, first.id])
  assert.equal((await pin(f, second.id, false, f.memberId)).status, 200)
  assert.equal((await pin(f, second.id, false)).data.message.revision, 2)
  assert.equal((await request(f, `/${first.id}`, { method: 'DELETE' })).status, 200)
  assert.deepEqual((await request(f, `/pins/${f.channelId}`)).data.pins, [])
})

test('回应、置顶和编辑落盘失败回滚内存及版本，不广播，重试才确认', async () => {
  const f = fixture(), message = create(f)
  const originalSave = db.save
  for (const operation of [
    () => react(f, message.id), () => pin(f, message.id),
    () => request(f, `/${message.id}`, { method: 'PUT', body: { content: 'edited' } })
  ]) {
    const before = structuredClone(message)
    const durable = fs.readFileSync(path.join(dir, 'db.json'), 'utf8')
    f.owner.events.length = 0
    f.member.events.length = 0
    db.save = () => { throw new Error('simulated disk full') }
    try {
      const result = await operation()
      assert.equal(result.status, 500)
      assert.deepEqual(message, before)
      assert.equal(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'), durable)
      assert.deepEqual(f.member.events, [])
    } finally { db.save = originalSave }
    assert.equal((await operation()).status, 200)
    assert.equal(message.revision, before.revision + 1)
    assert.equal(f.member.events.filter(event => event.type === 'message-updated').length, 1)
  }
})

test('真实临时文件写入故障保留旧消息，恢复后同一回应及置顶可重试', async () => {
  const f = fixture(), message = create(f)
  const temporaryPath = path.join(dir, 'db.json.tmp')
  assert.ok(path.resolve(temporaryPath).startsWith(root + path.sep))
  for (const operation of [() => react(f, message.id), () => pin(f, message.id)]) {
    const before = structuredClone(message)
    const durableBefore = fs.readFileSync(path.join(dir, 'db.json'), 'utf8')
    f.member.events.length = 0
    fs.mkdirSync(temporaryPath)
    try {
      assert.equal((await operation()).status, 500)
      assert.deepEqual(message, before)
      assert.equal(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'), durableBefore)
      assert.deepEqual(f.member.events, [])
    } finally { fs.rmdirSync(temporaryPath) }
    assert.equal((await operation()).status, 200)
    assert.equal(message.revision, before.revision + 1)
    assert.equal(f.member.events.filter(event => event.type === 'message-updated').length, 1)
  }
})

test('已有作者失去成员或查看权限后也不能编辑、删除自己的消息', async () => {
  const f = fixture(), message = create(f, 'member authored', f.memberId)
  db.updateRole(f.roleId, { permissions: { sendMessage: true, viewChannel: false, manageMessages: true } })
  for (const method of ['PUT', 'DELETE']) assert.equal((await request(f, `/${message.id}`, { method, body: method === 'PUT' ? { content: 'changed' } : undefined, userId: f.memberId })).status, 403)
  db.deleteMember(f.serverId, f.memberId)
  db.updateRole(f.roleId, { permissions: { sendMessage: true, viewChannel: true, manageMessages: true } })
  for (const method of ['PUT', 'DELETE']) assert.equal((await request(f, `/${message.id}`, { method, body: method === 'PUT' ? { content: 'changed' } : undefined, userId: f.memberId })).status, 403)
  assert.equal(db.findMessage(message.id).content, 'member authored')
})

test('回应和置顶广播重新过滤撤权、离服和失效会话的旧订阅', async () => {
  for (const revoke of [
    f => db.updateRole(f.roleId, { permissions: { viewChannel: false } }),
    f => db.deleteMember(f.serverId, f.memberId),
    f => db.deleteSession(f.member.sessionToken),
    f => { db.findSession(f.member.sessionToken).createdAt = '2000-01-01T00:00:00.000Z' },
    f => { f.member.sessionToken = f.owner.sessionToken },
    f => { f.member.channelId = 'different' }
  ]) {
    const f = fixture(), message = create(f)
    revoke(f)
    await react(f, message.id)
    await pin(f, message.id)
    assert.equal(f.owner.events.filter(event => event.type === 'message-updated').length, 2)
    assert.deepEqual(f.member.events, [])
  }
})

test('搜索使用文字字面量及稳定顺序游标，新增消息不会重复旧分页', async () => {
  const f = fixture(), expected = []
  for (let i = 0; i < 7; i++) expected.push(create(f, i === 2 ? 'hello literal .* marker' : `HeLLo item ${i}`, i % 2 ? f.memberId : f.ownerId))
  const first = await request(f, `/search/${f.channelId}?q=HELLO&limit=3`)
  assert.equal(first.status, 200)
  assert.deepEqual(first.data.messages.map(message => message.id), expected.slice(-3).reverse().map(message => message.id))
  assert.equal(first.data.hasMore, true)
  assert.equal(first.data.nextBefore, expected[4].id)
  create(f, 'hello inserted between pages')
  const second = await request(f, `/search/${f.channelId}?q=hello&limit=3&before=${first.data.nextBefore}`)
  const third = await request(f, `/search/${f.channelId}?q=hello&limit=3&before=${second.data.nextBefore}`)
  assert.deepEqual([...first.data.messages, ...second.data.messages, ...third.data.messages].map(message => message.id), expected.slice().reverse().map(message => message.id))
  assert.equal(third.data.hasMore, false)
  assert.equal(third.data.nextBefore, null)
  assert.deepEqual((await request(f, `/search/${f.channelId}?q=${encodeURIComponent('.*')}`)).data.messages.map(message => message.id), [expected[2].id])
  const authorOnly = await request(f, `/search/${f.channelId}?authorId=${f.memberId}`)
  assert.deepEqual(authorOnly.data.messages.map(message => message.id), expected.filter(message => message.userId === f.memberId).reverse().map(message => message.id))
  const fileMessage = create(f, 'attachment')
  db.updateMessage(fileMessage.id, { file: '/uploads/report.txt', fileName: 'Planning REPORT.txt' })
  assert.deepEqual((await request(f, `/search/${f.channelId}?q=planning+report`)).data.messages.map(message => message.id), [fileMessage.id])
})

test('搜索拒绝空筛选、错误类型、超长文字、作者及跨频道或已删除游标', async () => {
  const f = fixture(), message = create(f, '👍'.repeat(100))
  const other = fixture(), foreign = create(other)
  for (const query of ['', 'q=++', 'q[]=text', 'q[a]=text', `q=${'a'.repeat(101)}`, 'q=x&authorId=missing', 'q=x&authorId[]=id', 'q=x&before=', 'q=x&before[]=id', `q=x&before=${foreign.id}`, 'q=x&before=deleted', 'q=x&limit=51', 'q=x&limit=0', 'q=x&limit=1.5', 'q=x&limit[]=2']) {
    assert.equal((await request(f, `/search/${f.channelId}?${query}`)).status, 400, query)
  }
  assert.equal((await request(f, `/search/${f.channelId}?q=${encodeURIComponent('👍'.repeat(100))}`)).status, 200)
  db.deleteMessage(message.id)
  assert.equal((await request(f, `/search/${f.channelId}?q=x&before=${message.id}`)).status, 400)
})

test('上下文最多 50 条，按旧到新排列并提供两端边界，不改变原顺序', async () => {
  const f = fixture(), messages = []
  for (let i = 0; i < 110; i++) messages.push(db.createMessage({ id: `${f.channelId}-${i}`, channelId: f.channelId, userId: f.ownerId, content: `item ${i}`, createdAt: '2026-10-09T00:00:00.000Z' }))
  db.save()
  const ids = db.raw.messages.map(message => message.id)
  const middle = await request(f, `/context/${f.channelId}/${messages[55].id}`)
  assert.equal(middle.status, 200)
  assert.equal(middle.data.messages.length, 50)
  assert.deepEqual(middle.data.messages.map(message => message.id), messages.slice(31, 81).map(message => message.id))
  assert.equal(middle.data.hasMoreBefore, true)
  assert.equal(middle.data.hasMoreAfter, true)
  const start = await request(f, `/context/${f.channelId}/${messages[0].id}`)
  assert.equal(start.data.hasMoreBefore, false)
  assert.equal(start.data.hasMoreAfter, true)
  const end = await request(f, `/context/${f.channelId}/${messages.at(-1).id}`)
  assert.equal(end.data.hasMoreBefore, true)
  assert.equal(end.data.hasMoreAfter, false)
  assert.deepEqual(db.raw.messages.map(message => message.id), ids)
  assert.equal((await request(f, `/context/${f.channelId}/${messages[55].id}?limit=1`)).data.messages[0].id, messages[55].id)
  assert.equal((await request(f, `/context/${f.channelId}/${messages[55].id}?limit=51`)).status, 400)
  db.deleteMessage(messages[55].id)
  assert.equal((await request(f, `/context/${f.channelId}/${messages[55].id}`)).status, 404)
})

test('搜索、置顶列表和上下文均要求查看权限及当前成员', async () => {
  const f = fixture(), message = create(f)
  for (const userId of [f.memberId, f.outsiderId]) {
    if (userId === f.memberId) db.updateRole(f.roleId, { permissions: { viewChannel: false, manageMessages: true } })
    for (const pathname of [`/search/${f.channelId}?q=message`, `/pins/${f.channelId}`, `/context/${f.channelId}/${message.id}`]) {
      const result = await request(f, pathname, { userId })
      assert.equal(result.status, 403)
      assert.equal(result.data.messages, undefined)
      assert.equal(result.data.pins, undefined)
    }
    assert.equal((await pin(f, message.id, true, userId)).status, 403)
  }
})

test('搜索接口按账号限制频率，返回 Retry-After 且不牵连另一账号', async () => {
  const f = fixture()
  create(f)
  for (let i = 0; i < 20; i++) assert.equal((await request(f, `/search/${f.channelId}?q=message`)).status, 200)
  const limited = await request(f, `/search/${f.channelId}?q=message`)
  assert.equal(limited.status, 429)
  assert.ok(Number(limited.headers.get('retry-after')) > 0)
  assert.equal((await request(f, `/search/${f.channelId}?q=message`, { userId: f.memberId })).status, 200)
})

test('搜索频率计数按窗口恢复并清理过期账号，保留项数量有界', () => {
  let time = 0
  const limit = createMessageSearchRateLimiter({ windowMs: 1000, maxQueries: 2, maxUsers: 2, clock: () => time })
  assert.equal(limit('a').allowed, true)
  assert.equal(limit('a').allowed, true)
  assert.deepEqual(limit('a'), { allowed: false, retryAfter: 1 })
  assert.equal(limit('b').allowed, true)
  time = 1000
  assert.equal(limit('a').allowed, true)
  assert.equal(limit('a').allowed, true)
  assert.equal(limit('c').allowed, true)
  assert.equal(limit('a').allowed, false, 'expired b is removed before active a')
  assert.equal(limit('d').allowed, true)
  assert.equal(limit('c').allowed, true)
  assert.equal(limit('c').allowed, true)
  assert.equal(limit('c').allowed, false)
})
