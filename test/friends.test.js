import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, stopServer, api, register } from './helpers.js'

let alice, bob
before(async () => {
  await startServer()
  alice = await register('fr_alice')
  bob = await register('fr_bob')
})
after(stopServer)

test('好友请求方向：发送方 outgoing，接收方 incoming', async () => {
  await api('/friends/add', { method: 'POST', body: { username: 'fr_bob' }, token: alice.token })

  const sent = (await api('/friends/list', { token: alice.token })).data.friends
  const received = (await api('/friends/list', { token: bob.token })).data.friends

  const relSent = sent.find(f => f.friend?.username === 'fr_bob')
  const relRecv = received.find(f => f.friend?.username === 'fr_alice')
  assert.ok(relSent, 'alice 视角应有 bob 的好友关系')
  assert.ok(relRecv, 'bob 视角应有 alice 的好友关系')
  assert.equal(relSent.direction, 'outgoing', '发送方应为 outgoing')
  assert.equal(relRecv.direction, 'incoming', '接收方应为 incoming')
})

test('接受请求后为 accepted，direction 保留（accepted 也应有值）', async () => {
  const recv = (await api('/friends/list', { token: bob.token })).data.friends
  const rel = recv.find(f => f.friend?.username === 'fr_alice')
  assert.ok(rel, 'bob 应有 alice 的 pending 请求')

  const acc = await api('/friends/accept', { method: 'POST', body: { friendId: rel.friend.id }, token: bob.token })
  assert.equal(acc.status, 200)

  const bobList = (await api('/friends/list', { token: bob.token })).data.friends
  const rel2 = bobList.find(f => f.friend?.username === 'fr_alice')
  assert.equal(rel2.status, 'accepted')
  assert.equal(rel2.direction, 'incoming', 'accepted 关系也应带 direction')
})
