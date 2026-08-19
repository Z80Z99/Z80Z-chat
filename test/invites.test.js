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

test('普通成员可查看完整 code', async () => {
  const r = await api('/invites/list/' + server.id, { token: member.token })
  assert.equal(r.status, 200)
  assert.ok(r.data.invites.length > 0)
  assert.match(r.data.invites[0].code, /^\d{10}$/)
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

test('普通成员可创建邀请（有效期固定 1 小时）', async () => {
  const r = await api('/invites/create', { method: 'POST', body: { serverId: server.id, expiresInHours: 24 }, token: member.token })
  assert.equal(r.status, 200)
  assert.ok(r.data.invite.code)
  // 普通成员忽略传入有效期，强制 1 小时
  const diffH = (new Date(r.data.invite.expiresAt) - Date.now()) / 3600000
  assert.ok(diffH > 0.9 && diffH < 1.1, 'expiresAt 应约 1 小时: ' + r.data.invite.expiresAt)
})

test('manageServer 成员可以创建邀请', async () => {
  const r = await api('/invites/create', { method: 'POST', body: { serverId: server.id }, token: manager.token })
  assert.equal(r.status, 200)
  assert.ok(r.data.invite.code)
})
