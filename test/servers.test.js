import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, stopServer, api, register, createTestServer, inviteAndJoin } from './helpers.js'

before(startServer)
after(stopServer)

test('创建服务器成功：自动生成 @everyone 角色与文字/语音频道', async () => {
  const owner = await register('owner1')
  const { server, textChannel } = await createTestServer(owner.token)
  assert.ok(server.id)
  assert.equal(server.ownerId, owner.user.id)
  assert.ok(textChannel)

  const roles = await api('/roles/list/' + server.id, { token: owner.token })
  const everyone = roles.data.roles.find(r => r.isDefault)
  assert.ok(everyone)
  assert.equal(everyone.permissions.viewChannel, true)
})

test('服务器列表只返回自己所属的服务器', async () => {
  const a = await register('owner2')
  const b = await register('member2')
  const srv = (await createTestServer(a.token, '私有服')).server

  const listA = await api('/servers/list', { token: a.token })
  assert.ok(listA.data.servers.some(s => s.id === srv.id))
  const listB = await api('/servers/list', { token: b.token })
  assert.ok(!listB.data.servers.some(s => s.id === srv.id))
})

test('非成员访问服务器详情被拒绝', async () => {
  const a = await register('owner3')
  const b = await register('outsider3')
  const srv = (await createTestServer(a.token)).server
  const r = await api('/servers/' + srv.id, { token: b.token })
  assert.equal(r.status, 403)
})

test('通过邀请码加入服务器', async () => {
  const a = await register('owner4')
  const b = await register('member4')
  const srv = (await createTestServer(a.token)).server
  const join = await inviteAndJoin(a.token, b.token, srv.id)
  assert.equal(join.status, 200)

  const detail = await api('/servers/' + srv.id, { token: b.token })
  assert.equal(detail.status, 200)
})

test('非 owner 修改服务器被拒绝', async () => {
  const a = await register('owner5')
  const b = await register('member5')
  const srv = (await createTestServer(a.token)).server
  await inviteAndJoin(a.token, b.token, srv.id)
  const r = await api('/servers/' + srv.id, { method: 'PUT', body: { name: '改个名' }, token: b.token })
  assert.equal(r.status, 403)
})

test('转让服务器后原 owner 失去管理权', async () => {
  const a = await register('owner6')
  const b = await register('member6')
  const srv = (await createTestServer(a.token)).server
  await inviteAndJoin(a.token, b.token, srv.id)

  const transfer = await api('/servers/transfer/' + srv.id, { method: 'POST', body: { userId: b.user.id }, token: a.token })
  assert.equal(transfer.status, 200)

  const r = await api('/servers/' + srv.id, { method: 'PUT', body: { name: '原owner改名' }, token: a.token })
  assert.equal(r.status, 403)
})

test('频道权限：owner 可创建，非成员被拒绝', async () => {
  const a = await register('owner7')
  const b = await register('outsider7')
  const srv = (await createTestServer(a.token)).server

  const ok = await api('/channels/create', { method: 'POST', body: { serverId: srv.id, name: '新频道' }, token: a.token })
  assert.equal(ok.status, 200)

  const denied = await api('/channels/create', { method: 'POST', body: { serverId: srv.id, name: '越权频道' }, token: b.token })
  assert.equal(denied.status, 403)
})

test('角色权限：owner 可创建角色，普通成员被拒绝', async () => {
  const a = await register('owner8')
  const b = await register('member8')
  const srv = (await createTestServer(a.token)).server
  await inviteAndJoin(a.token, b.token, srv.id)

  const ok = await api('/roles/create', { method: 'POST', body: { serverId: srv.id, name: '新角色' }, token: a.token })
  assert.equal(ok.status, 200)

  const denied = await api('/roles/create', { method: 'POST', body: { serverId: srv.id, name: '越权角色' }, token: b.token })
  assert.equal(denied.status, 403)
})

test('非成员获取频道列表被拒绝', async () => {
  const a = await register('owner9')
  const b = await register('outsider9')
  const srv = (await createTestServer(a.token)).server
  const r = await api('/channels/list/' + srv.id, { token: b.token })
  assert.equal(r.status, 403)
})
