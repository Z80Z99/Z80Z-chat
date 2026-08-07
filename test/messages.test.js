import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, stopServer, restartServer, api, register, createTestServer, inviteAndJoin, readDB, writeDB, waitForDB } from './helpers.js'

let owner, member, server, textChannel

before(async () => {
  await startServer()
  owner = await register('msg_owner')
  member = await register('msg_member')
  const ctx = await createTestServer(owner.token)
  server = ctx.server
  textChannel = ctx.textChannel
  await inviteAndJoin(owner.token, member.token, server.id)
})

after(stopServer)

test('发送消息成功', async () => {
  const r = await api('/messages/send', { method: 'POST', body: { channelId: textChannel.id, content: 'hello' }, token: owner.token })
  assert.equal(r.status, 200)
  assert.equal(r.data.message.content, 'hello')
  assert.ok(r.data.message.user)
})

test('消息列表返回每个消息的正确作者（多用户）', async () => {
  await api('/messages/send', { method: 'POST', body: { channelId: textChannel.id, content: 'by owner' }, token: owner.token })
  await api('/messages/send', { method: 'POST', body: { channelId: textChannel.id, content: 'by member' }, token: member.token })
  const list = await api('/messages/list/' + textChannel.id, { token: owner.token })
  assert.equal(list.status, 200)
  const msgs = list.data.messages
  const ownerMsg = msgs.find(m => m.content === 'by owner')
  const memberMsg = msgs.find(m => m.content === 'by member')
  assert.ok(ownerMsg, 'owner 消息应在列表中')
  assert.ok(memberMsg, 'member 消息应在列表中')
  assert.equal(ownerMsg.user.username, 'msg_owner')
  assert.equal(memberMsg.user.username, 'msg_member')
})

test('空消息被拒绝', async () => {
  const r = await api('/messages/send', { method: 'POST', body: { channelId: textChannel.id, content: '' }, token: owner.token })
  assert.equal(r.status, 400)
})

test('非成员发送消息被拒绝', async () => {
  const outsider = await register('msg_outsider')
  const r = await api('/messages/send', { method: 'POST', body: { channelId: textChannel.id, content: 'x' }, token: outsider.token })
  assert.equal(r.status, 403)
})

test('被禁言成员无法发送消息', async () => {
  const mute = await api('/members/mute', { method: 'POST', body: { serverId: server.id, userId: member.user.id, muted: true }, token: owner.token })
  assert.equal(mute.status, 200)

  const r = await api('/messages/send', { method: 'POST', body: { channelId: textChannel.id, content: 'muted' }, token: member.token })
  assert.equal(r.status, 403)

  await api('/members/mute', { method: 'POST', body: { serverId: server.id, userId: member.user.id, muted: false }, token: owner.token })
})

test('无 sendMessage 权限的成员无法发送消息', async () => {
  // @everyone.sendMessage = false，member 无角色 → 无发送权限
  // 等待防抖落盘后再读取（读到的须包含服务器创建时写入的 @everyone 角色）
  const db = await waitForDB(d => d.roles.some(r => r.serverId === server.id && r.isDefault))
  const everyone = db.roles.find(r => r.serverId === server.id && r.isDefault)
  everyone.permissions.sendMessage = false
  writeDB(db)
  await restartServer()

  const denied = await api('/messages/send', { method: 'POST', body: { channelId: textChannel.id, content: 'no perm' }, token: member.token })
  assert.equal(denied.status, 403)

  // owner 豁免
  const ok = await api('/messages/send', { method: 'POST', body: { channelId: textChannel.id, content: 'owner ok' }, token: owner.token })
  assert.equal(ok.status, 200)
})

test('编辑消息：作者可编辑，他人被拒绝', async () => {
  const sent = await api('/messages/send', { method: 'POST', body: { channelId: textChannel.id, content: 'before' }, token: owner.token })
  const mid = sent.data.message.id

  const edited = await api('/messages/' + mid, { method: 'PUT', body: { content: 'after' }, token: owner.token })
  assert.equal(edited.status, 200)
  assert.equal(edited.data.message.content, 'after')
  assert.ok(edited.data.message.editedAt)

  const denied = await api('/messages/' + mid, { method: 'PUT', body: { content: 'hack' }, token: member.token })
  assert.equal(denied.status, 403)
})

test('删除消息：作者可删除，他人被拒绝', async () => {
  const sent = await api('/messages/send', { method: 'POST', body: { channelId: textChannel.id, content: 'to delete' }, token: owner.token })
  const mid = sent.data.message.id

  const denied = await api('/messages/' + mid, { method: 'DELETE', token: member.token })
  assert.equal(denied.status, 403)

  const ok = await api('/messages/' + mid, { method: 'DELETE', token: owner.token })
  assert.equal(ok.status, 200)
})

test('mentionEveryone：普通成员被拒绝，owner 成功', async () => {
  const denied = await api('/messages/send', { method: 'POST', body: { channelId: textChannel.id, content: 'x', mentionEveryone: true }, token: member.token })
  assert.equal(denied.status, 403)

  const ok = await api('/messages/send', { method: 'POST', body: { channelId: textChannel.id, content: 'x', mentionEveryone: true }, token: owner.token })
  assert.equal(ok.status, 200)
  assert.equal(ok.data.message.mentionEveryone, true)
})
