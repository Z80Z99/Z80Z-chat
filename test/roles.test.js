import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, stopServer, api, register, createTestServer, inviteAndJoin } from './helpers.js'

let owner, member, plainMember, outsider, server
let roleLow, roleAdmin, roleHigh

before(async () => {
  await startServer()
  owner = await register('rl_owner')
  member = await register('rl_member')
  plainMember = await register('rl_plain')
  outsider = await register('rl_outsider')
  const ctx = await createTestServer(owner.token)
  server = ctx.server
  await inviteAndJoin(owner.token, member.token, server.id)
  await inviteAndJoin(owner.token, plainMember.token, server.id)

  // position 递增：@everyone(0) < roleLow(1) < roleAdmin(2) < roleHigh(3)
  roleLow = (await api('/roles/create', { method: 'POST', body: { serverId: server.id, name: '低权限' }, token: owner.token })).data.role
  roleAdmin = (await api('/roles/create', { method: 'POST', body: { serverId: server.id, name: '管理员', permissions: { manageRoles: true, viewChannel: true, sendMessage: true } }, token: owner.token })).data.role
  roleHigh = (await api('/roles/create', { method: 'POST', body: { serverId: server.id, name: '高权限', permissions: { manageRoles: true, viewChannel: true, sendMessage: true } }, token: owner.token })).data.role
  // member 获得 roleAdmin（manageRoles），其最高 position = roleAdmin.position
  await api('/members/set-role', { method: 'POST', body: { serverId: server.id, userId: member.user.id, roleId: roleAdmin.id }, token: owner.token })
})

after(stopServer)

test('owner 可以修改任意角色', async () => {
  const r = await api('/roles/' + roleHigh.id, { method: 'PUT', body: { name: '高权限改' }, token: owner.token })
  assert.equal(r.status, 200)
  assert.equal(r.data.role.name, '高权限改')
})

test('owner 可以删除任意角色', async () => {
  const tmp = (await api('/roles/create', { method: 'POST', body: { serverId: server.id, name: '临时' }, token: owner.token })).data.role
  const r = await api('/roles/' + tmp.id, { method: 'DELETE', token: owner.token })
  assert.equal(r.status, 200)
})

test('管理员可以修改低于自己的角色', async () => {
  const r = await api('/roles/' + roleLow.id, { method: 'PUT', body: { name: '低权限改' }, token: member.token })
  assert.equal(r.status, 200)
})

test('管理员不能修改同级角色', async () => {
  const r = await api('/roles/' + roleAdmin.id, { method: 'PUT', body: { name: '篡改' }, token: member.token })
  assert.equal(r.status, 403)
})

test('管理员不能删除高于自己的角色', async () => {
  const r = await api('/roles/' + roleHigh.id, { method: 'DELETE', token: member.token })
  assert.equal(r.status, 403)
})

test('管理员不能移除他人身上高于自身等级的角色（remove-role 层级校验）', async () => {
  const target = await register('rl_target')
  await inviteAndJoin(owner.token, target.token, server.id)
  // target 先由 owner 分配 roleHigh
  await api('/members/set-role', { method: 'POST', body: { serverId: server.id, userId: target.user.id, roleId: roleHigh.id }, token: owner.token })
  // member（最高 position=roleAdmin < roleHigh）尝试移除 → 应 403
  const r = await api('/members/remove-role', { method: 'POST', body: { serverId: server.id, userId: target.user.id, roleId: roleHigh.id }, token: member.token })
  assert.equal(r.status, 403)
  // 角色应仍在
  const list = (await api('/members/list/' + server.id, { token: member.token })).data.members
  const tm = list.find(m => m.userId === target.user.id)
  assert.ok(tm.roles.includes(roleHigh.id), '高等级角色不应被移除')
})

test('管理员可以移除他人身上低于自身等级的角色', async () => {
  const target = await register('rl_target2')
  await inviteAndJoin(owner.token, target.token, server.id)
  await api('/members/set-role', { method: 'POST', body: { serverId: server.id, userId: target.user.id, roleId: roleLow.id }, token: owner.token })
  const r = await api('/members/remove-role', { method: 'POST', body: { serverId: server.id, userId: target.user.id, roleId: roleLow.id }, token: member.token })
  assert.equal(r.status, 200)
  const list = (await api('/members/list/' + server.id, { token: member.token })).data.members
  const tm = list.find(m => m.userId === target.user.id)
  assert.ok(!tm.roles.includes(roleLow.id), '低等级角色应被移除')
})

test('管理员不能给自己分配高于自身等级的角色', async () => {
  const r = await api('/members/set-role', { method: 'POST', body: { serverId: server.id, userId: member.user.id, roleId: roleHigh.id }, token: member.token })
  assert.equal(r.status, 403)
})

test('管理员也不能给他人分配高于自身等级的角色', async () => {
  const r = await api('/members/set-role', { method: 'POST', body: { serverId: server.id, userId: plainMember.user.id, roleId: roleHigh.id }, token: member.token })
  assert.equal(r.status, 403)
})

test('普通成员（无 manageRoles）不能创建角色', async () => {
  const r = await api('/roles/create', { method: 'POST', body: { serverId: server.id, name: '越权' }, token: plainMember.token })
  assert.equal(r.status, 403)
})

test('非成员不能管理角色', async () => {
  const r = await api('/roles/create', { method: 'POST', body: { serverId: server.id, name: '越权' }, token: outsider.token })
  assert.equal(r.status, 403)
})
