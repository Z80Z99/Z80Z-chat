import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, stopServer, api, register, createTestServer, inviteAndJoin } from './helpers.js'

let owner, member, manager, outsider, server

before(async () => {
  await startServer()
  owner = await register('inv_owner')
  member = await register('inv_member')
  manager = await register('inv_manager')
  outsider = await register('inv_outsider')
  const ctx = await createTestServer(owner.token)
  server = ctx.server
  await inviteAndJoin(owner.token, member.token, server.id)
  await inviteAndJoin(owner.token, manager.token, server.id)

  // 授予 manager 一个 manageServer 角色
  const role = (await api('/roles/create', {
    method: 'POST',
    body: { serverId: server.id, name: '服务器管理员', permissions: { manageServer: true, viewChannel: true, sendMessage: true } },
    token: owner.token
  })).data.role
  await api('/members/set-role', { method: 'POST', body: { serverId: server.id, userId: manager.user.id, roleId: role.id }, token: owner.token })

  await api('/invites/create', { method: 'POST', body: { serverId: server.id }, token: owner.token })
})

after(stopServer)

test('普通成员获取邀请列表时 code 被隐藏', async () => {
  const r = await api('/invites/list/' + server.id, { token: member.token })
  assert.equal(r.status, 200)
  assert.ok(r.data.invites.length > 0)
  assert.equal(r.data.invites[0].code, null)
})

test('owner 可以查看完整 code', async () => {
  const r = await api('/invites/list/' + server.id, { token: owner.token })
  assert.equal(r.status, 200)
  assert.match(r.data.invites[0].code, /^\d{10}$/)
})

test('manageServer 成员可以查看完整 code', async () => {
  const r = await api('/invites/list/' + server.id, { token: manager.token })
  assert.equal(r.status, 200)
  assert.match(r.data.invites[0].code, /^\d{10}$/)
})

test('非成员无法获取邀请列表', async () => {
  const r = await api('/invites/list/' + server.id, { token: outsider.token })
  assert.equal(r.status, 403)
})

test('普通成员创建邀请被拒绝', async () => {
  const r = await api('/invites/create', { method: 'POST', body: { serverId: server.id }, token: member.token })
  assert.equal(r.status, 403)
})

test('manageServer 成员可以创建邀请', async () => {
  const r = await api('/invites/create', { method: 'POST', body: { serverId: server.id }, token: manager.token })
  assert.equal(r.status, 200)
  assert.ok(r.data.invite.code)
})
