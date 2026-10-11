import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  startServer, stopServer, restartServer, api, register, createTestServer,
  inviteAndJoin, wsConnect, getDataDir, readDB, writeDB, waitForDB
} from './helpers.js'

let owner, member, outsider, server, textChannel, secondChannel
const send = (payload, token = owner.token) => api('/messages/send', { method: 'POST', body: payload, token })
const payload = (clientMessageId, extra = {}) => ({ channelId: textChannel.id, content: clientMessageId, clientMessageId, ...extra })

before(async () => {
  await startServer()
  owner = await register('receipt_owner')
  member = await register('receipt_member')
  outsider = await register('receipt_outsider')
  const context = await createTestServer(owner.token)
  server = context.server
  textChannel = context.textChannel
  await inviteAndJoin(owner.token, member.token, server.id)
  const second = await api('/channels/create', {
    method: 'POST', body: { serverId: server.id, name: 'second', type: 'text' }, token: owner.token
  })
  assert.equal(second.status, 200)
  secondChannel = second.data.channel
})
after(stopServer)

async function flushSocket(socket) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket pong timeout')), 3000)
    socket.once('pong', () => { clearTimeout(timer); resolve() })
    socket.ping()
  })
}

async function observe(token = owner.token, subscribe = true) {
  const socket = await wsConnect(token)
  const events = []
  socket.on('message', raw => events.push(JSON.parse(raw.toString())))
  if (subscribe) socket.send(JSON.stringify({ type: 'join-channel', channelId: textChannel.id }))
  await flushSocket(socket)
  return { socket, events }
}

async function closeSocket(socket) {
  if (socket.readyState === 3) return
  await new Promise(resolve => { socket.once('close', resolve); socket.close() })
}

function sendWS(socket, data) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', listener); reject(new Error('Message ACK timeout')) }, 3000)
    function listener(raw) {
      const event = JSON.parse(raw.toString())
      if (!['message-ack', 'message-error'].includes(event.type) || event.clientMessageId !== data.clientMessageId) return
      clearTimeout(timer)
      socket.off('message', listener)
      resolve(event)
    }
    socket.on('message', listener)
    socket.send(JSON.stringify({ type: 'message', ...data }))
  })
}

test('相同 ID 重放返回同一消息及 sequence，不重复广播或未读通知', async () => {
  const observer = await observe(member.token)
  try {
    const body = payload('rest-repeat')
    const first = await send(body)
    assert.equal(first.status, 200)
    assert.ok(Number.isSafeInteger(first.data.message.sequence) && first.data.message.sequence > 0)
    assert.equal(first.data.message.clientMessageId, body.clientMessageId)
    await flushSocket(observer.socket)
    const readNotifications = observer.events.filter(event => event.type === 'read-state').length
    assert.ok(readNotifications >= 1)
    const second = await send(body)
    await flushSocket(observer.socket)
    assert.equal(second.status, 200)
    assert.equal(second.data.message.id, first.data.message.id)
    assert.equal(second.data.message.sequence, first.data.message.sequence)
    assert.equal(observer.events.filter(event => event.type === 'message').length, 1)
    assert.equal(observer.events.filter(event => event.type === 'read-state').length, readNotifications)
    assert.equal(readDB().messageReceipts.filter(receipt => receipt.clientMessageId === body.clientMessageId).length, 1)
  } finally { await closeSocket(observer.socket) }
})

test('并发重复请求只插入一条消息且只广播一次', async () => {
  const observer = await observe(member.token)
  try {
    const body = payload('parallel-repeat')
    const responses = await Promise.all(Array.from({ length: 10 }, () => send(body)))
    assert.ok(responses.every(response => response.status === 200))
    assert.equal(new Set(responses.map(response => response.data.message.id)).size, 1)
    assert.equal(new Set(responses.map(response => response.data.message.sequence)).size, 1)
    await flushSocket(observer.socket)
    assert.equal(observer.events.filter(event => event.type === 'message').length, 1)
    assert.equal(readDB().messages.filter(message => message.clientMessageId === body.clientMessageId).length, 1)
  } finally { await closeSocket(observer.socket) }
})

test('同 ID 更换频道、正文或其它发送字段返回 409', async () => {
  const body = payload('payload-conflict')
  assert.equal((await send(body)).status, 200)
  for (const change of [
    { channelId: secondChannel.id }, { content: 'changed' },
    { replyTo: 'different-reply' }, { fileName: 'changed.txt' },
    { content: `payload-conflict <@${member.user.id}>`, mentions: [member.user.id] }
  ]) {
    const response = await send({ ...body, ...change })
    assert.equal(response.status, 409)
    assert.equal(response.data.clientMessageId, body.clientMessageId)
  }
  // Mention IDs hidden from the body fail payload validation before receipt replay.
  assert.equal((await send({ ...body, mentions: [member.user.id] })).status, 400)
})

test('附件签名 query 改变仍为同一发送，文件路径变化则冲突', async () => {
  const body = payload('attachment-retry', { file: '/uploads/original.txt?expires=1&sig=old', fileName: 'original.txt' })
  const first = await send(body)
  assert.equal(first.status, 200)
  const retry = await send({ ...body, file: '/uploads/original.txt?expires=9999999999&sig=new#preview' })
  assert.equal(retry.status, 200)
  assert.equal(retry.data.message.id, first.data.message.id)
  assert.equal((await send({ ...body, file: '/uploads/different.txt' })).status, 409)
})

test('编辑之后按原发送内容重放返回当前正文，不创建第二条', async () => {
  const body = payload('edited-retry')
  const first = await send(body)
  const edit = await api('/messages/' + first.data.message.id, { method: 'PUT', body: { content: 'edited current text' }, token: owner.token })
  assert.equal(edit.status, 200)
  const retry = await send(body)
  assert.equal(retry.status, 200)
  assert.equal(retry.data.message.id, first.data.message.id)
  assert.equal(retry.data.message.content, 'edited current text')
  assert.equal((await send({ ...body, content: 'edited current text' })).status, 409)
})

test('跨用户使用相同 clientMessageId 独立创建', async () => {
  const body = payload('shared-client-id')
  const ownerMessage = await send(body)
  const memberMessage = await send(body, member.token)
  assert.equal(ownerMessage.status, 200)
  assert.equal(memberMessage.status, 200)
  assert.notEqual(ownerMessage.data.message.id, memberMessage.data.message.id)
  assert.notEqual(ownerMessage.data.message.sequence, memberMessage.data.message.sequence)
})

test('校验 ID 格式，未携带 ID 的旧客户端仍可发送', async () => {
  for (const clientMessageId of ['', 'bad id', 'bad/segment', 'a'.repeat(129), 123, null]) {
    assert.equal((await send(payload(clientMessageId, { content: 'valid content' }))).status, 400)
  }
  assert.equal((await send(payload('a'.repeat(128)))).status, 200)
  const legacy = { channelId: textChannel.id, content: 'legacy client' }
  const first = await send(legacy)
  const second = await send(legacy)
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.notEqual(first.data.message.id, second.data.message.id)
  assert.ok(Number.isSafeInteger(first.data.message.sequence))
})

test('REST 与 WebSocket 共享 receipt，未订阅的原 socket 也收到 ACK', async () => {
  const observer = await observe(member.token)
  const sender = await observe(owner.token, false)
  try {
    const body = payload('rest-then-ws')
    const first = await send(body)
    const acknowledgement = await sendWS(sender.socket, body)
    assert.equal(acknowledgement.type, 'message-ack')
    assert.equal(acknowledgement.status, 200)
    assert.equal(acknowledgement.message.id, first.data.message.id)
    assert.equal(acknowledgement.message.sequence, first.data.message.sequence)

    const wsFirst = await sendWS(sender.socket, payload('ws-then-rest'))
    const restReplay = await send(payload('ws-then-rest'))
    assert.equal(wsFirst.type, 'message-ack')
    assert.equal(restReplay.status, 200)
    assert.equal(restReplay.data.message.id, wsFirst.message.id)
    await flushSocket(observer.socket)
    assert.equal(observer.events.filter(event => event.type === 'message').length, 2)
    assert.equal(sender.events.filter(event => event.type === 'message').length, 0)
    const conflict = await sendWS(sender.socket, payload('rest-then-ws', { content: 'conflict' }))
    assert.equal(conflict.type, 'message-error')
    assert.equal(conflict.status, 409)
    assert.ok(conflict.error)
    const invalid = await sendWS(sender.socket, payload('invalid id'))
    assert.equal(invalid.status, 400)
  } finally { await closeSocket(observer.socket); await closeSocket(sender.socket) }
})

test('重放仍检查当前成员和禁言', async () => {
  const body = payload('permission-retry')
  assert.equal((await send(body, member.token)).status, 200)
  const sender = await observe(member.token, false)
  try {
    const muted = await api('/members/mute', {
      method: 'POST', body: { serverId: server.id, userId: member.user.id, muted: true }, token: owner.token
    })
    assert.equal(muted.status, 200)
    assert.equal((await send(body, member.token)).status, 403)
    const failure = await sendWS(sender.socket, body)
    assert.equal(failure.type, 'message-error')
    assert.equal(failure.status, 403)
    assert.equal((await send(body, outsider.token)).status, 403)
  } finally {
    await api('/members/mute', {
      method: 'POST', body: { serverId: server.id, userId: member.user.id, muted: false }, token: owner.token
    })
    await closeSocket(sender.socket)
  }
})

test('失去发送或查看权限后，重放仍被拒绝且不泄露原正文', async () => {
  const body = payload('role-permission-retry')
  const sent = await send(body, member.token)
  assert.equal(sent.status, 200)
  const saved = await waitForDB(data => data.messageReceipts.some(receipt => receipt.messageId === sent.data.message.id))
  const role = saved.roles.find(item => item.serverId === server.id && item.isDefault)
  const originalPermissions = { ...role.permissions }
  try {
    for (const permission of ['sendMessage', 'viewChannel']) {
      const data = readDB()
      data.roles.find(item => item.id === role.id).permissions = { ...originalPermissions, [permission]: false }
      writeDB(data)
      await restartServer()
      const replay = await send(body, member.token)
      assert.equal(replay.status, 403)
      assert.equal(replay.data.message, undefined)
      const sender = await observe(member.token, false)
      try {
        await waitForDB(data => data.users.find(user => user.id === member.user.id)?.status === 'online')
        const failure = await sendWS(sender.socket, body)
        assert.equal(failure.status, 403)
        assert.equal(failure.message, undefined)
      } finally { await closeSocket(sender.socket) }
      await waitForDB(data => data.users.find(user => user.id === member.user.id)?.status === 'offline')
    }
  } finally {
    const data = readDB()
    data.roles.find(item => item.id === role.id).permissions = originalPermissions
    writeDB(data)
    await restartServer()
  }
})

test('已注销 WebSocket 会话不能重放，向原连接回错误并关闭', async () => {
  const account = await register('receipt_session')
  await inviteAndJoin(owner.token, account.token, server.id)
  const body = payload('session-retry')
  assert.equal((await send(body, account.token)).status, 200)
  const sender = await observe(account.token, false)
  try {
    assert.equal((await api('/auth/logout', { method: 'POST', token: account.token })).status, 200)
    const failure = await sendWS(sender.socket, body)
    assert.equal(failure.type, 'message-error')
    assert.equal(failure.status, 401)
  } finally { await closeSocket(sender.socket) }
})

test('落盘失败不确认、不广播，跨传输重试保存后仍只有原消息', async () => {
  const observer = await observe(member.token)
  const sender = await observe(owner.token, false)
  const temporaryPath = path.join(getDataDir(), 'db.json.tmp')
  try {
    await waitForDB(data => data.users.some(user => user.id === owner.user.id && user.status === 'online'))
    fs.mkdirSync(temporaryPath)
    const body = payload('disk-failure-retry')
    const first = await send(body)
    assert.equal(first.status, 500)
    assert.equal(first.data.clientMessageId, body.clientMessageId)
    const second = await sendWS(sender.socket, body)
    assert.equal(second.type, 'message-error')
    assert.equal(second.status, 500)
    await flushSocket(observer.socket)
    assert.equal(observer.events.filter(event => event.type === 'message').length, 0)
    assert.equal(readDB().messages.some(message => message.clientMessageId === body.clientMessageId), false)
    const memory = await api('/messages/list/' + textChannel.id, { token: owner.token })
    const pending = memory.data.messages.filter(message => message.clientMessageId === body.clientMessageId)
    assert.equal(pending.length, 1)
    fs.rmdirSync(temporaryPath)

    const retry = await sendWS(sender.socket, body)
    assert.equal(retry.type, 'message-ack')
    assert.equal(retry.message.id, pending[0].id)
    const replay = await send(body)
    assert.equal(replay.data.message.id, pending[0].id)
    await flushSocket(observer.socket)
    assert.equal(observer.events.filter(event => event.type === 'message').length, 1)
    assert.equal(readDB().messageReceipts.filter(receipt => receipt.clientMessageId === body.clientMessageId).length, 1)
  } finally {
    if (fs.existsSync(temporaryPath) && fs.statSync(temporaryPath).isDirectory()) fs.rmdirSync(temporaryPath)
    await closeSocket(observer.socket)
    await closeSocket(sender.socket)
  }
})

test('重启保留 receipt 与全局 sequence；删除后重放 410 且重启也不复活', async () => {
  const body = payload('restart-retry')
  const first = await send(body)
  assert.equal(first.status, 200)
  await restartServer()
  const replay = await send(body)
  assert.equal(replay.status, 200)
  assert.equal(replay.data.message.id, first.data.message.id)
  assert.equal(replay.data.message.sequence, first.data.message.sequence)

  const observer = await observe(member.token)
  try {
    const deleted = await api('/messages/' + first.data.message.id, { method: 'DELETE', token: owner.token })
    assert.equal(deleted.status, 200)
    await flushSocket(observer.socket)
    assert.ok(observer.events.some(event => event.type === 'read-state'))
    assert.equal((await send(body)).status, 410)
    assert.equal(readDB().messages.some(message => message.id === first.data.message.id), false)
    assert.ok(readDB().messageReceipts.some(receipt => receipt.messageId === first.data.message.id))
  } finally { await closeSocket(observer.socket) }
  await restartServer()
  assert.equal((await send(body)).status, 410)
  const next = await send(payload('after-deletion'))
  assert.equal(next.status, 200)
  assert.ok(next.data.message.sequence > first.data.message.sequence)
})

test('删除落盘失败时同 ID 不误报永久删除，恢复保存后才返回 410', async () => {
  const body = payload('delete-disk-failure')
  const first = await send(body)
  assert.equal(first.status, 200)
  const temporaryPath = path.join(getDataDir(), 'db.json.tmp')
  fs.mkdirSync(temporaryPath)
  try {
    const deleted = await api('/messages/' + first.data.message.id, { method: 'DELETE', token: owner.token })
    assert.equal(deleted.status, 500)
    assert.ok(readDB().messages.some(message => message.id === first.data.message.id))
    assert.equal((await send(body)).status, 500)
    assert.ok(readDB().messages.some(message => message.id === first.data.message.id))
  } finally {
    fs.rmdirSync(temporaryPath)
  }
  assert.equal((await send(body)).status, 410)
  assert.equal(readDB().messages.some(message => message.id === first.data.message.id), false)
  await restartServer()
  assert.equal((await send(body)).status, 410)
})
