import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, stopServer, api, register, createTestServer, inviteAndJoin, wsConnect, sleep } from './helpers.js'

let a, b, server, textChannel

before(async () => {
  await startServer()
  a = await register('sync_a')
  b = await register('sync_b')
  const ctx = await createTestServer(a.token)
  server = ctx.server
  textChannel = ctx.textChannel
  await inviteAndJoin(a.token, b.token, server.id)
})

after(stopServer)

function joinChannel(ws, channelId) {
  ws.send(JSON.stringify({ type: 'join-channel', channelId }))
}

test('用户 B 收到用户 A 的消息编辑广播（message-updated）', async () => {
  const wsB = await wsConnect(b.token)
  const events = []
  wsB.on('message', (raw) => {
    const d = JSON.parse(raw.toString())
    if (d.type === 'message-updated') events.push(d)
  })
  joinChannel(wsB, textChannel.id)
  await sleep(200)

  const sent = await api('/messages/send', { method: 'POST', body: { channelId: textChannel.id, content: '原文' }, token: a.token })
  const mid = sent.data.message.id

  await api('/messages/' + mid, { method: 'PUT', body: { content: '已编辑' }, token: a.token })
  await sleep(400)

  assert.equal(events.length, 1)
  assert.equal(events[0].message.id, mid)
  assert.equal(events[0].message.content, '已编辑')
  assert.equal(events[0].channelId, textChannel.id)
  wsB.close()
})

test('用户 B 收到用户 A 的消息删除广播（message-deleted）', async () => {
  const wsB = await wsConnect(b.token)
  const events = []
  wsB.on('message', (raw) => {
    const d = JSON.parse(raw.toString())
    if (d.type === 'message-deleted') events.push(d)
  })
  joinChannel(wsB, textChannel.id)
  await sleep(200)

  const sent = await api('/messages/send', { method: 'POST', body: { channelId: textChannel.id, content: '待删' }, token: a.token })
  const mid = sent.data.message.id

  await api('/messages/' + mid, { method: 'DELETE', token: a.token })
  await sleep(400)

  assert.equal(events.length, 1)
  assert.equal(events[0].messageId, mid)
  assert.equal(events[0].channelId, textChannel.id)
  wsB.close()
})

test('未加入频道的用户不收到 message-updated / message-deleted 广播', async () => {
  const wsB = await wsConnect(b.token)  // 未 join-channel
  let got = false
  wsB.on('message', (raw) => {
    const d = JSON.parse(raw.toString())
    if (d.type === 'message-updated' || d.type === 'message-deleted') got = true
  })

  const sent = await api('/messages/send', { method: 'POST', body: { channelId: textChannel.id, content: '隔离测试' }, token: a.token })
  const mid = sent.data.message.id
  await api('/messages/' + mid, { method: 'PUT', body: { content: 'x' }, token: a.token })
  await api('/messages/' + mid, { method: 'DELETE', token: a.token })
  await sleep(400)

  assert.equal(got, false)
  wsB.close()
})
