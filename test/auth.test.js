import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, stopServer, restartServer, api, register, readDB, writeDB, waitForDB } from './helpers.js'

before(startServer)
after(stopServer)

test('注册成功：返回 token 与用户，不含密码', async () => {
  const r = await api('/auth/register', { method: 'POST', body: { username: 'alice', password: 'test1234' } })
  assert.equal(r.status, 200)
  assert.ok(r.data.token)
  assert.equal(r.data.user.username, 'alice')
  assert.equal(r.data.user.password, undefined)
})

test('重复用户名注册被拒绝', async () => {
  await register('alice2')
  const r = await api('/auth/register', { method: 'POST', body: { username: 'alice2', password: 'test1234' } })
  assert.equal(r.status, 400)
})

test('用户名/密码过短被拒绝', async () => {
  const short = await api('/auth/register', { method: 'POST', body: { username: 'a', password: 'x' } })
  assert.equal(short.status, 400)
})

test('登录成功', async () => {
  const r = await api('/auth/login', { method: 'POST', body: { username: 'alice3', password: 'test1234' } })
  assert.equal(r.status, 400) // 尚未注册
  await register('alice3')
  const ok = await api('/auth/login', { method: 'POST', body: { username: 'alice3', password: 'test1234' } })
  assert.equal(ok.status, 200)
  assert.ok(ok.data.token)
})

test('错误密码登录被拒绝', async () => {
  const r = await api('/auth/login', { method: 'POST', body: { username: 'alice3', password: 'wrong' } })
  assert.equal(r.status, 400)
})

test('获取当前用户（有效 token）', async () => {
  const u = await register('bob')
  const r = await api('/auth/me', { token: u.token })
  assert.equal(r.status, 200)
  assert.equal(r.data.user.username, 'bob')
})

test('无效 token 返回 401', async () => {
  const r = await api('/auth/me', { token: 'invalid-token-xxx' })
  assert.equal(r.status, 401)
})

test('无 token 返回 401', async () => {
  const r = await api('/auth/me')
  assert.equal(r.status, 401)
})

test('session 过期后拒绝访问', async () => {
  const u = await register('carol')
  // 篡改 db.json 中该 session 的 createdAt 为 40 天前（等待防抖落盘后操作）
  await waitForDB(d => d.sessions.some(s => s.token === u.token))
  const db = readDB()
  const session = db.sessions.find(s => s.token === u.token)
  assert.ok(session)
  session.createdAt = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString()
  writeDB(db)
  await restartServer()

  const r = await api('/auth/me', { token: u.token })
  assert.equal(r.status, 401)

  // 过期 session 应被自动清理（防抖写入，等待落盘）
  await waitForDB(d => !d.sessions.some(s => s.token === u.token))
})
