import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, stopServer, restartServer, api, register, createTestServer, inviteAndJoin, wsConnect, readDB, writeDB, waitForDB, sleep } from './helpers.js'

let owner, member, outsider, server, textChannel, voiceChannel

before(async () => {
  await startServer()
  owner = await register('vo_owner')
  member = await register('vo_member')
  outsider = await register('vo_outsider')
  const ctx = await createTestServer(owner.token)
  server = ctx.server
  const chans = (await api('/channels/list/' + server.id, { token: owner.token })).data.channels
  textChannel = chans.find(c => c.type === 'text')
  voiceChannel = chans.find(c => c.type === 'voice')
  await inviteAndJoin(owner.token, member.token, server.id)
})

after(stopServer)

// 先注册监听，再发送，等待收集
async function sendAndCollect(ws, payload, ms, filter) {
  const events = []
  const onMsg = (raw) => {
    const d = JSON.parse(raw.toString())
    if (!filter || filter(d)) events.push(d)
  }
  ws.on('message', onMsg)
  ws.send(JSON.stringify(payload))
  await sleep(ms)
  ws.off('message', onMsg)
  return events
}

test('成员 voice-join 语音频道成功并收到 voice-members', async () => {
  const ws = await wsConnect(member.token)
  const events = await sendAndCollect(ws, { type: 'voice-join', roomId: voiceChannel.id }, 500,
    d => d.type === 'voice-members' || d.type === 'error')
  const got = events.filter(e => e.type === 'voice-members')
  assert.equal(got.length, 1)
  assert.ok(got[0].members.includes(member.user.id))
  ws.send(JSON.stringify({ type: 'voice-leave', roomId: voiceChannel.id }))
  ws.close()
})

test('非成员 voice-join 被拒绝（error 事件）', async () => {
  const ws = await wsConnect(outsider.token)
  const errors = await sendAndCollect(ws, { type: 'voice-join', roomId: voiceChannel.id }, 400,
    d => d.type === 'error' && d.action === 'voice-join')
  assert.equal(errors.length, 1)
  ws.close()
})

test('文字频道不能 voice-join', async () => {
  const ws = await wsConnect(member.token)
  const errors = await sendAndCollect(ws, { type: 'voice-join', roomId: textChannel.id }, 400,
    d => d.type === 'error' && d.action === 'voice-join')
  assert.equal(errors.length, 1)
  assert.match(errors[0].error, /不是语音频道/)
  ws.close()
})

test('不存在的语音频道 voice-join 被拒绝', async () => {
  const ws = await wsConnect(member.token)
  const errors = await sendAndCollect(ws, { type: 'voice-join', roomId: 'no-such-room' }, 400,
    d => d.type === 'error' && d.action === 'voice-join')
  assert.equal(errors.length, 1)
  ws.close()
})

test('信令隔离：未加入房间的用户收不到 voice-offer', async () => {
  const wsM = await wsConnect(member.token)
  const wsO = await wsConnect(outsider.token)  // 非成员，未在房间
  let outsiderGotOffer = false
  wsO.on('message', (raw) => {
    const d = JSON.parse(raw.toString())
    if (d.type === 'voice-offer') outsiderGotOffer = true
  })

  wsM.send(JSON.stringify({ type: 'voice-join', roomId: voiceChannel.id }))
  await sleep(300)
  // 向 outsider 发 offer —— 其不在房间，不应被转发
  wsM.send(JSON.stringify({ type: 'voice-offer', roomId: voiceChannel.id, targetUserId: outsider.user.id, data: { sdp: 'x' } }))
  await sleep(400)
  assert.equal(outsiderGotOffer, false)
  wsM.close(); wsO.close()
})

test('信令隔离：非房间成员不能向房间内成员发送 voice-offer', async () => {
  const wsM = await wsConnect(member.token)
  const wsO = await wsConnect(outsider.token)  // 非服务器成员，未加入房间
  let memberGotOffer = false
  wsM.on('message', (raw) => {
    const d = JSON.parse(raw.toString())
    if (d.type === 'voice-offer') memberGotOffer = true
  })

  wsM.send(JSON.stringify({ type: 'voice-join', roomId: voiceChannel.id }))
  await sleep(300)
  // outsider 未加入房间，向 member 发 offer —— 不应被转发
  wsO.send(JSON.stringify({ type: 'voice-offer', roomId: voiceChannel.id, targetUserId: member.user.id, data: { sdp: 'x' } }))
  await sleep(400)
  assert.equal(memberGotOffer, false)
  wsM.send(JSON.stringify({ type: 'voice-leave', roomId: voiceChannel.id }))
  wsM.close(); wsO.close()
})

test('重连后旧 ws 关闭不误删新 ws 注册', async () => {
  const wsM = await wsConnect(member.token)
  wsM.send(JSON.stringify({ type: 'voice-join', roomId: voiceChannel.id }))
  await sleep(300)

  // owner 第一个 ws join
  const ws1 = await wsConnect(owner.token)
  ws1.send(JSON.stringify({ type: 'voice-join', roomId: voiceChannel.id }))
  await sleep(300)

  // owner 第二个 ws join（覆盖 room 内的注册）
  const ws2 = await wsConnect(owner.token)
  ws2.send(JSON.stringify({ type: 'voice-join', roomId: voiceChannel.id }))
  await sleep(300)

  // 关闭旧 ws1：不应误删 ws2 的注册
  ws1.close()
  await sleep(400)

  // member 向 owner 发 offer，应转发给 ws2
  let gotOffer = false
  ws2.on('message', (raw) => {
    const d = JSON.parse(raw.toString())
    if (d.type === 'voice-offer') gotOffer = true
  })
  wsM.send(JSON.stringify({ type: 'voice-offer', roomId: voiceChannel.id, targetUserId: owner.user.id, data: { sdp: 'x' } }))
  await sleep(400)
  assert.equal(gotOffer, true)

  wsM.send(JSON.stringify({ type: 'voice-leave', roomId: voiceChannel.id }))
  ws2.send(JSON.stringify({ type: 'voice-leave', roomId: voiceChannel.id }))
  wsM.close(); ws2.close()
})

test('无 viewChannel 权限的成员 voice-join 被拒绝，owner 豁免', async () => {
  // 等待防抖落盘（读到包含 @everyone 角色的完整数据）
  const db = await waitForDB(d => d.roles.some(r => r.serverId === server.id && r.isDefault))
  const everyone = db.roles.find(r => r.serverId === server.id && r.isDefault)
  everyone.permissions.viewChannel = false
  writeDB(db)
  await restartServer()

  const wsM = await wsConnect(member.token)  // 成员无角色 → 无 viewChannel
  const errors = await sendAndCollect(wsM, { type: 'voice-join', roomId: voiceChannel.id }, 400,
    d => d.type === 'error' && d.action === 'voice-join')
  assert.equal(errors.length, 1)
  assert.match(errors[0].error, /没有查看频道的权限/)
  wsM.close()

  // owner 豁免：voice-join 成功
  const wsA = await wsConnect(owner.token)
  const got = await sendAndCollect(wsA, { type: 'voice-join', roomId: voiceChannel.id }, 400,
    d => d.type === 'voice-members')
  assert.equal(got.length, 1)
  wsA.send(JSON.stringify({ type: 'voice-leave', roomId: voiceChannel.id }))
  wsA.close()
})
