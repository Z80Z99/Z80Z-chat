import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { startServer, stopServer, restartServer, api, register, getDataDir, readDB, waitForDB, TEST_PORT, sleep } from './helpers.js'

const tmpPath = () => path.join(getDataDir(), 'db.json.tmp')
const dbPath = () => path.join(getDataDir(), 'db.json')

before(startServer)
after(stopServer)

test('正常保存：注册后 db.json 可解析且数据完整', async () => {
  const before = readDB().users.length
  await register('atomic_user1')
  // 防抖写入：等待落盘
  const db = await waitForDB(d => d.users.some(u => u.username === 'atomic_user1'))
  assert.equal(db.users.length, before + 1)
  // 不应残留 tmp 文件
  assert.ok(!fs.existsSync(tmpPath()))
})

test('写入失败时旧 db.json 保持有效（防抖异步写，接口不受影响）', async () => {
  const rawBefore = fs.readFileSync(dbPath(), 'utf8')

  // 把 tmp 路径占为目录 → 下次防抖落盘失败
  fs.mkdirSync(tmpPath())
  const r = await api('/auth/register', { method: 'POST', body: { username: 'atomic_fail', password: 'test1234' } })
  assert.equal(r.status, 200) // 防抖：写失败不再同步阻塞接口

  // 等待防抖落盘失败发生后，旧 db.json 未被破坏；服务仍存活（写失败不触发退出）
  await sleep(400)
  assert.equal(fs.readFileSync(dbPath(), 'utf8'), rawBefore)
  const ping = await fetch(`http://localhost:${TEST_PORT}/api/version`)
  assert.equal(ping.status, 200, '写失败后服务仍应存活')

  // 清理占位目录后恢复可用（失败的写入保留在内存，恢复时一并落盘）
  fs.rmdirSync(tmpPath())
  await register('atomic_recover')
  const dbAfter = await waitForDB(d => d.users.some(u => u.username === 'atomic_recover'))
  assert.ok(dbAfter.users.some(u => u.username === 'atomic_user1'))
})

test('启动时清理残留 tmp 文件', async () => {
  // 模拟上次写入中断的残留
  fs.writeFileSync(tmpPath(), '{"partial":')
  await restartServer()

  assert.ok(!fs.existsSync(tmpPath()), '残留 tmp 应被清理')
  // 服务正常，db.json 仍为上次完整数据
  const db = readDB()
  assert.ok(Array.isArray(db.users))
  // 清理后保存正常
  await register('atomic_after_restart')
  await waitForDB(d => d.users.some(u => u.username === 'atomic_after_restart'))
  assert.ok(!fs.existsSync(tmpPath()))
})

test('rename 语义：写入中断不会留下半截 db.json', async () => {
  // 正常写操作后 db.json 始终是完整 JSON（原子替换保证）
  await register('atomic_final')
  await waitForDB(d => d.users.some(u => u.username === 'atomic_final'))
  const raw = fs.readFileSync(dbPath(), 'utf8')
  assert.doesNotThrow(() => JSON.parse(raw))
})
