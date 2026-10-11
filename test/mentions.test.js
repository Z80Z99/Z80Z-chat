import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import crypto from 'node:crypto'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.test-data')
const previous = { DATA_DIR: process.env.DATA_DIR, LOG_DIR: process.env.LOG_DIR }
const wss = { clients: new Set() }
let dir, db, server, baseUrl, submitMessage, number = 0
before(async () => {
  fs.mkdirSync(root, { recursive: true })
  dir = fs.mkdtempSync(path.join(root, 'mentions-'))
  process.env.DATA_DIR = dir
  process.env.LOG_DIR = path.join(dir, 'logs')
  const { initDB } = await import('../models/db.js')
  const { default: mentionsRouter } = await import('../routes/mentions.js')
  const { default: messagesRouter } = await import('../routes/messages.js')
  ;({ submitMessage } = await import('../utils/message.js'))
  db = initDB()
  const app = express()
  app.locals.db = db; app.locals.wss = wss
  app.use(express.json())
  app.use('/mentions', mentionsRouter)
  app.use('/messages', messagesRouter)
  server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  db?.save()
  if (server) await new Promise(resolve => server.close(resolve))
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value
  }
  if (dir) { assert.ok(path.resolve(dir).startsWith(root + path.sep)); fs.rmSync(dir, { recursive: true, force: true }) }
  try { fs.rmdirSync(root) } catch {}
})

function fixture() {
  const prefix = `mention-${++number}`, ownerId = `${prefix}-owner`, memberId = `${prefix}-member`, outsiderId = `${prefix}-outsider`
  const serverId = `${prefix}-server`, channelId = `${prefix}-text`, otherId = `${prefix}-other`, roleId = `${prefix}-role`
  for (const id of [ownerId, memberId, outsiderId]) {
    db.createUser({ id, username: id, nickname: `昵称 ${id}`, avatar: '/avatar.png', password: 'private', token: 'private' })
    db.createSession({ token: `${id}-token`, userId: id, createdAt: new Date().toISOString() })
  }
  db.createServer({ id: serverId, ownerId })
  db.createRole({ id: roleId, serverId, permissions: { viewChannel: true, sendMessage: true } })
  db.createMember({ serverId, userId: ownerId, roles: [] })
  db.createMember({ serverId, userId: memberId, roles: [roleId] })
  db.createChannel({ id: channelId, serverId, type: 'text' })
  db.createChannel({ id: otherId, serverId, type: 'text' })
  const socket = (id, token = `${id}-token`) => ({ userId: id, sessionToken: token, channelId: otherId,
    readyState: 1, events: [], send(raw) {
      const event = JSON.parse(raw)
      if (event.type === 'mention-notification') {
        const durable = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).messages
        assert.ok(durable.some(message => message.id === event.message.id), 'notify only after durable save')
      }
      this.events.push(event)
    } })
  const owner = socket(ownerId), member = socket(memberId), second = socket(memberId), outsider = socket(outsiderId)
  wss.clients.clear()
  for (const client of [owner, member, second, outsider]) wss.clients.add(client)
  db.save()
  return { ownerId, memberId, outsiderId, serverId, channelId, otherId, roleId, owner, member, second, outsider }
}
function send(f, content, extra = {}, userId = f.ownerId) {
  return submitMessage(db, wss, db.findUser(userId), { channelId: f.channelId, content, ...extra })
}
async function request(f, pathname = '/mentions', { method = 'GET', body, userId = f.memberId, token = `${userId}-token` } = {}) {
  const response = await fetch(baseUrl + pathname, { method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, data: await response.json() }
}
const setMode = (f, mode, userId) => request(f, `/mentions/preferences/${f.channelId}`, { method: 'PUT', body: { mode }, userId })
const alerts = socket => socket.events.filter(event => event.type === 'mention-notification')

test('正文 ID 去重并解析公开成员，跨频道所有会话只提醒收件人', async () => {
  const f = fixture()
  const result = send(f, `你好 <@${f.memberId}> <@${f.memberId}> <@${f.ownerId}>`)
  assert.equal(result.status, 200)
  assert.deepEqual(result.message.mentions, [f.memberId, f.ownerId])
  assert.deepEqual(result.message.mentionUsers.map(user => user.id), [f.memberId, f.ownerId])
  assert.ok(result.message.mentionUsers.every(user => user.password === undefined && user.token === undefined))
  assert.equal(alerts(f.owner).length, 0); assert.equal(alerts(f.outsider).length, 0)
  for (const socket of [f.member, f.second]) {
    assert.equal(alerts(socket).length, 1)
    assert.equal(alerts(socket)[0].reason, 'mention')
    assert.equal(alerts(socket)[0].message.id, result.message.id)
  }
  assert.equal(db.getChannelReadState(f.memberId, f.channelId).mentionCount, 1)
  assert.equal(db.getChannelReadState(f.ownerId, f.channelId).mentionCount, 0)
})

test('拒绝隐藏或不一致 mentions、错误类型、离服对象和超过 50 位成员', () => {
  const f = fixture()
  for (const mentions of [null, 'id', [3], ['bad id'], [f.memberId]]) {
    assert.equal(send(f, '没有提及标签', { mentions }).status, 400)
  }
  assert.equal(send(f, `<@${f.outsiderId}>`).status, 400)
  assert.equal(send(f, '<@invalid id>').status, 400)
  assert.equal(send(f, '<@unclosed').status, 400)
  assert.equal(send(f, Array.from({ length: 51 }, (_, index) => `<@target-${index}>`).join(' ')).status, 400)
  db.updateRole(f.roleId, { permissions: { viewChannel: false, sendMessage: true } })
  assert.equal(send(f, `<@${f.memberId}>`).status, 400)
  assert.equal(alerts(f.member).length, 0)
})

test('@everyone 文字和 legacy flag 均校验权限，非布尔伪造不能绕过', () => {
  const f = fixture()
  for (const mentionEveryone of ['false', 'true', 1, null, [], {}]) assert.equal(send(f, 'message', { mentionEveryone }).status, 400)
  assert.equal(send(f, '@everyone hello', { mentionEveryone: false }, f.memberId).status, 403)
  assert.equal(send(f, 'legacy', { mentionEveryone: true }, f.memberId).status, 403)
  assert.equal(send(f, 'a@everyone.com', {}, f.memberId).message.mentionEveryone, false)
  const result = send(f, '通知：@everyone，请查看')
  assert.equal(result.status, 200)
  assert.equal(result.message.mentionEveryone, true)
  assert.equal(alerts(f.member).at(-1).reason, 'everyone')
  assert.equal(send(f, 'legacy', { mentionEveryone: true }).status, 200)
})

test('偏好默认 mentions，all 包含普通消息，mute 排除提醒并持久化到用户和频道', async () => {
  const f = fixture()
  const original = fs.readFileSync(path.join(dir, 'db.json'), 'utf8')
  assert.equal((await request(f, `/mentions/preferences/${f.channelId}`)).data.mode, 'mentions')
  assert.equal(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'), original)
  send(f, 'default ordinary')
  assert.equal((await request(f)).data.totalCount, 0)
  assert.equal((await setMode(f, 'all')).status, 200)
  assert.equal((await request(f)).data.totalCount, 1)
  send(f, 'all ordinary')
  assert.equal(alerts(f.member).at(-1).reason, 'message')
  assert.equal((await request(f)).data.totalCount, 2)
  assert.equal((await setMode(f, 'mute')).status, 200)
  send(f, `<@${f.memberId}> @everyone`)
  assert.equal((await request(f)).data.totalCount, 0)
  assert.equal(db.getChannelReadState(f.memberId, f.channelId).unreadCount, 3)
  assert.equal(db.getChannelReadState(f.memberId, f.channelId).mentionCount, 0)
  assert.equal(db.getNotificationPreference(f.ownerId, f.channelId), 'mentions')
  assert.equal(db.getNotificationPreference(f.memberId, f.otherId), 'mentions')
  const durable = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'))
  assert.equal(durable.notificationPreferences.find(item => item.userId === f.memberId && item.channelId === f.channelId).mode, 'mute')
  for (const socket of [f.member, f.second]) assert.equal(socket.events.filter(event => event.type === 'notification-preference').at(-1).mode, 'mute')
  assert.equal(f.owner.events.filter(event => event.type === 'notification-preference').length, 0)
})

test('离线提醒使用持久阅读游标，全局 sequence 倒序分页，已读后移除且自身消息不入列表', async () => {
  const f = fixture(); wss.clients.clear()
  const first = send(f, `<@${f.memberId}> first`).message
  send(f, `<@${f.memberId}> self`, {}, f.memberId)
  const second = send(f, `<@${f.memberId}> second`, { channelId: f.otherId }).message
  const third = send(f, '@everyone third').message
  const page = await request(f, '/mentions?limit=2')
  assert.equal(page.status, 200); assert.equal(page.data.totalCount, 3); assert.equal(page.data.hasMore, true)
  assert.deepEqual(page.data.notifications.map(item => item.message.id), [third.id, second.id])
  assert.equal(page.data.nextBefore, second.sequence)
  const next = await request(f, `/mentions?limit=2&before=${page.data.nextBefore}`)
  assert.deepEqual(next.data.notifications.map(item => item.message.id), [first.id])
  assert.equal(next.data.hasMore, false)
  db.advanceReadState(f.memberId, f.channelId, third.sequence); db.save()
  assert.deepEqual((await request(f)).data.notifications.map(item => item.message.id), [second.id])
  for (const query of ['limit=51', 'limit=0', 'limit=1.5', 'before=NaN', 'before=0', 'before=9007199254740992']) {
    assert.equal((await request(f, `/mentions?${query}`)).status, 400)
  }
})

test('每次定向推送重查 active session、当前成员和查看权限，feed 也过滤权限', async () => {
  const f = fixture()
  db.deleteSession(`${f.memberId}-token`)
  send(f, '@everyone inactive')
  assert.equal(alerts(f.member).length, 0); assert.equal(alerts(f.second).length, 0)
  db.createSession({ token: `${f.memberId}-token`, userId: f.memberId, createdAt: new Date().toISOString() })
  db.updateRole(f.roleId, { permissions: { viewChannel: false, sendMessage: true } })
  send(f, '@everyone hidden')
  assert.equal(alerts(f.member).length, 0)
  assert.equal((await request(f)).data.totalCount, 0)
  assert.equal((await request(f, `/mentions/preferences/${f.channelId}`)).status, 403)
  db.updateRole(f.roleId, { permissions: { viewChannel: true, sendMessage: true } })
  db.deleteMember(f.serverId, f.memberId)
  send(f, '@everyone kicked')
  assert.equal(alerts(f.member).length, 0)
  assert.equal((await request(f)).data.totalCount, 0)
  assert.equal((await request(f, `/mentions/preferences/${f.channelId}`, { userId: f.outsiderId })).status, 403)
})

test('相同 clientMessageId 重放和落盘失败不重复提醒，恢复保存后仅提醒一次', () => {
  const f = fixture(), extra = { clientMessageId: 'directed-once' }
  const save = db.save
  db.save = () => { throw new Error('disk failure') }
  try {
    assert.equal(send(f, `<@${f.memberId}>`, extra).status, 500)
    assert.equal(alerts(f.member).length, 0)
  } finally { db.save = save }
  const result = send(f, `<@${f.memberId}>`, extra)
  assert.equal(result.status, 200)
  assert.equal(alerts(f.member).length, 1)
  assert.equal(send(f, `<@${f.memberId}>`, extra).message.id, result.message.id)
  assert.equal(alerts(f.member).length, 1)
})

test('编辑重新计算 mentions 和计数，通知旧收件人刷新但不重新 alert，删除移除提醒', async () => {
  const f = fixture(), message = send(f, `<@${f.memberId}> original`).message
  const count = alerts(f.member).length
  const edit = await request(f, `/messages/${message.id}`, { method: 'PUT', body: { content: 'removed' }, userId: f.ownerId })
  assert.equal(edit.status, 200); assert.deepEqual(edit.data.message.mentions, [])
  assert.equal(db.getChannelReadState(f.memberId, f.channelId).mentionCount, 0)
  assert.equal((await request(f)).data.totalCount, 0)
  assert.equal(alerts(f.member).length, count)
  assert.ok(f.member.events.some(event => event.type === 'mention-invalidated' && event.messageId === message.id))
  assert.equal((await request(f, `/messages/${message.id}`, { method: 'PUT', body: { content: `<@${f.memberId}> added` }, userId: f.ownerId })).status, 200)
  assert.equal(db.getChannelReadState(f.memberId, f.channelId).mentionCount, 1)
  assert.equal(alerts(f.member).length, count)
  assert.equal((await request(f, `/messages/${message.id}`, { method: 'DELETE', userId: f.ownerId })).status, 200)
  assert.equal((await request(f)).data.totalCount, 0)
  assert.equal(db.getChannelReadState(f.memberId, f.channelId).mentionCount, 0)
})

test('编辑旧提及对象已离服时可保留 ID，读取旧记录不改写数据且不泄露用户凭据', async () => {
  const f = fixture(), message = send(f, `<@${f.memberId}> original`).message
  db.deleteMember(f.serverId, f.memberId); db.save()
  const result = await request(f, `/messages/${message.id}`, { method: 'PUT', body: { content: `<@${f.memberId}> edited` }, userId: f.ownerId })
  assert.equal(result.status, 200)
  assert.equal(result.data.message.mentionUsers[0].password, undefined)
  const stored = db.findMessage(message.id)
  delete stored.mentions; delete stored.mentionEveryone; db.save()
  const original = fs.readFileSync(path.join(dir, 'db.json'), 'utf8')
  const listed = await request(f, `/messages/list/${f.channelId}`, { userId: f.ownerId })
  assert.deepEqual(listed.data.messages[0].mentions, [f.memberId])
  assert.equal(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'), original)
})

test('偏好权限和格式严格校验，保存失败恢复旧模式且不广播', async () => {
  const f = fixture()
  for (const mode of ['bad', null, 3, false]) assert.equal((await setMode(f, mode)).status, 400)
  assert.equal((await setMode(f, 'all', f.outsiderId)).status, 403)
  const save = db.save
  db.save = () => { throw new Error('disk failure') }
  try { assert.equal((await setMode(f, 'all')).status, 500) } finally { db.save = save }
  assert.equal(db.getNotificationPreference(f.memberId, f.channelId), 'mentions')
  assert.equal(f.member.events.filter(event => event.type === 'notification-preference').length, 0)
  db.save()
  assert.equal((await setMode(f, 'all')).status, 200)
})

test('偏好与离线未读提醒重载数据库仍保留，缺省设置读取不创建迁移备份', async () => {
  const f = fixture()
  await setMode(f, 'all')
  const message = send(f, 'offline ordinary').message
  const before = fs.readdirSync(dir).filter(name => name.endsWith('.bak'))
  const { initDB } = await import('../models/db.js')
  const reloaded = initDB()
  assert.equal(reloaded.getNotificationPreference(f.memberId, f.channelId), 'all')
  assert.equal(reloaded.getNotificationPreference(f.ownerId, f.channelId), 'mentions')
  assert.deepEqual((await request(f)).data.notifications.map(item => item.message.id), [message.id])
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.bak')), before)
})

test('推送循环中撤销成员权限，后续同用户会话不会收到旧提醒', () => {
  const f = fixture()
  const originalSend = f.member.send
  f.member.send = function(raw) {
    originalSend.call(this, raw)
    if (JSON.parse(raw).type === 'mention-notification') db.deleteMember(f.serverId, f.memberId)
  }
  send(f, `<@${f.memberId}>`)
  assert.equal(alerts(f.member).length, 1)
  assert.equal(alerts(f.second).length, 0)
})

test('已成功 receipt 重试允许收件人离服或撤权，不重报；改变原正文仍拒绝', () => {
  const f = fixture(), content = `<@${f.memberId}> delivered`, extra = { clientMessageId: 'recipient-left' }
  const first = send(f, content, extra)
  assert.equal(first.status, 200)
  db.deleteMember(f.serverId, f.memberId); db.save()
  assert.equal(send(f, content, extra).message.id, first.message.id)
  assert.equal(alerts(f.member).length, 1)
  assert.equal(send(f, content + ' changed', extra).status, 409)
  assert.equal(send(f, content, { clientMessageId: 'new-recipient-left' }).status, 400)
  db.createMember({ serverId: f.serverId, userId: f.memberId, roles: [f.roleId] })
  db.updateRole(f.roleId, { permissions: { viewChannel: false, sendMessage: true } }); db.save()
  assert.equal(send(f, content, extra).message.id, first.message.id)
  assert.equal(alerts(f.member).length, 1)
})

test('旧版字面 @everyone 且 false receipt 可重试，保留既有消息而不补发提醒', () => {
  const f = fixture(), content = '@everyone historical literal', clientMessageId = 'legacy-literal'
  const message = db.createMessage({ id: `${f.channelId}-old`, channelId: f.channelId, userId: f.memberId,
    content, mentions: [], mentionEveryone: false, clientMessageId, createdAt: '2026-10-09T00:00:00.000Z' })
  const original = { channelId: f.channelId, content, image: null, file: null, fileName: null, replyTo: null,
    mentions: [], mentionEveryone: false }
  db.createMessageReceipt({ userId: f.memberId, clientMessageId, channelId: f.channelId, messageId: message.id,
    fingerprint: crypto.createHash('sha256').update(JSON.stringify(original)).digest('hex'), createdAt: message.createdAt })
  db.save()
  const replay = send(f, content, { clientMessageId }, f.memberId)
  assert.equal(replay.status, 200)
  assert.equal(replay.message.id, message.id)
  assert.equal(replay.message.mentionEveryone, false)
  assert.equal(alerts(f.owner).length, 0)
  assert.equal(send(f, content + ' changed', { clientMessageId }, f.memberId).status, 409)
  assert.equal(send(f, content, { clientMessageId: 'new-literal' }, f.memberId).status, 403)
})

test('搜索可读提及昵称并跟随改名，数据库仍保存 stable IDs 和原 wire 正文', async () => {
  const f = fixture()
  db.updateUser(f.memberId, { nickname: '旅行猫咪' })
  const message = send(f, `<@${f.memberId}> 请查看`).message
  const search = await request(f, `/messages/search/${f.channelId}?q=${encodeURIComponent('@旅行猫咪')}`)
  assert.equal(search.status, 200)
  assert.deepEqual(search.data.messages.map(item => item.id), [message.id])
  db.updateUser(f.memberId, { nickname: '新猫咪' }); db.save()
  const renamed = await request(f, `/messages/search/${f.channelId}?q=${encodeURIComponent('@新猫咪')}`)
  assert.deepEqual(renamed.data.messages.map(item => item.id), [message.id])
  assert.equal(db.findMessage(message.id).content, `<@${f.memberId}> 请查看`)
  assert.deepEqual(db.findMessage(message.id).mentions, [f.memberId])
})
