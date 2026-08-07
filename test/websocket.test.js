import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, stopServer, api, register, createTestServer, inviteAndJoin, wsConnect, wsConnectExpectClose, sleep } from './helpers.js'

let owner, member, outsider, server, textChannel

before(async () => {
  await startServer()
  owner = await register('ws_owner')
  member = await register('ws_member')
  outsider = await register('ws_outsider')
  const ctx = await createTestServer(owner.token)
  server = ctx.server
  textChannel = ctx.textChannel
  await inviteAndJoin(owner.token, member.token, server.id)
})

after(stopServer)

test('无 token 连接被拒绝（4001）', async () => {
  const { code } = await wsConnectExpectClose('')
  assert.equal(code, 4001)
})

test('无效 token 连接被拒绝（4001）', async () => {
  const { code } = await wsConnectExpectClose('invalid-token')
  assert.equal(code, 4001)
})

test('有效 token 连接成功', async () => {
  const ws = await wsConnect(owner.token)
  assert.equal(ws.readyState, 1)
  ws.close()
})

test('正常成员 join-channel 成功并可接收消息广播', async () => {
  const wsB = await wsConnect(member.token)
  const received = []
  wsB.on('message', (raw) => {
    const d = JSON.parse(raw.toString())
    if (d.type === 'message') received.push(d)
  })
  wsB.send(JSON.stringify({ type: 'join-channel', channelId: textChannel.id }))
  await sleep(300)

  await api('/messages/send', { method: 'POST', body: { channelId: textChannel.id, content: 'ws broadcast' }, token: owner.token })
  await sleep(500)

  assert.equal(received.length, 1)
  assert.equal(received[0].message.content, 'ws broadcast')
  wsB.close()
})

test('非成员 join-channel 收到 error 事件且不接收广播', async () => {
  const ws = await wsConnect(outsider.token)
  const events = []
  ws.on('message', (raw) => {
    const d = JSON.parse(raw.toString())
    if (d.type === 'error' || d.type === 'message') events.push(d)
  })
  ws.send(JSON.stringify({ type: 'join-channel', channelId: textChannel.id }))
  await sleep(400)

  // 触发广播验证隔离
  await api('/messages/send', { method: 'POST', body: { channelId: textChannel.id, content: 'isolation' }, token: owner.token })
  await sleep(400)

  const errors = events.filter(e => e.type === 'error')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].action, 'join-channel')
  assert.ok(!events.some(e => e.type === 'message'))
  ws.close()
})

test('不存在的频道 join-channel 收到 error', async () => {
  const ws = await wsConnect(owner.token)
  const errors = []
  ws.on('message', (raw) => {
    const d = JSON.parse(raw.toString())
    if (d.type === 'error') errors.push(d)
  })
  ws.send(JSON.stringify({ type: 'join-channel', channelId: 'no-such-channel' }))
  await sleep(400)
  assert.equal(errors.length, 1)
  ws.close()
})

test('未 join 频道的连接收不到该频道广播', async () => {
  const ws = await wsConnect(owner.token)  // 未 join-channel
  let got = false
  ws.on('message', (raw) => {
    const d = JSON.parse(raw.toString())
    if (d.type === 'message') got = true
  })
  await api('/messages/send', { method: 'POST', body: { channelId: textChannel.id, content: 'no join' }, token: owner.token })
  await sleep(400)
  assert.equal(got, false)
  ws.close()
})
