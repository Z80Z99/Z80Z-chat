import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { startServer, stopServer, restartServer, api, register, getDataDir, readDB, waitForDB, PROJECT_ROOT, sleep } from './helpers.js'

const backupsDir = () => path.join(getDataDir(), 'backups')
const dbPath = () => path.join(getDataDir(), 'db.json')

const runScript = (script, input = '') => new Promise((resolve) => {
  const child = spawn(process.execPath, [script], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DATA_DIR: getDataDir() },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let out = ''
  child.stdout.on('data', d => { out += d.toString() })
  child.stderr.on('data', d => { out += d.toString() })
  child.stdin.end(input)
  child.on('exit', (code) => resolve({ code, out }))
})

const listBackups = () => {
  if (!fs.existsSync(backupsDir())) return []
  return fs.readdirSync(backupsDir()).filter(f => /^db-\d{8}-\d{9}\.json$/.test(f)).sort()
}

before(startServer)
after(stopServer)

test('备份：备份目录不存在时自动创建，备份文件内容与 db.json 一致', async () => {
  await register('bk_user1')
  const srcRaw = fs.readFileSync(dbPath(), 'utf8')

  const { code, out } = await runScript('scripts/backup.js')
  assert.equal(code, 0)
  assert.ok(fs.existsSync(backupsDir()), 'backups 目录应被自动创建')

  const backups = listBackups()
  assert.equal(backups.length, 1)
  assert.match(backups[0], /^db-\d{8}-\d{9}\.json$/)
  assert.equal(fs.readFileSync(path.join(backupsDir(), backups[0]), 'utf8'), srcRaw)
  assert.ok(out.includes('备份完成'))
})

test('多次备份保留历史，且每次内容完整', async () => {
  await register('bk_user2')
  await sleep(50)  // 确保与上一份备份时间戳不同（毫秒级命名）
  await runScript('scripts/backup.js')
  const backups = listBackups()
  assert.equal(backups.length, 2)
  for (const f of backups) {
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(backupsDir(), f), 'utf8')))
  }
})

test('恢复成功：选择最新备份，db.json 内容被替换', async () => {
  // 记录当前备份内容，然后破坏 db.json（添加垃圾用户）
  const backupFile = listBackups().at(-1)
  const backupRaw = fs.readFileSync(path.join(backupsDir(), backupFile), 'utf8')

  // 篡改 db.json：加一个多余用户
  const db = readDB()
  db.users.push({ id: 'corrupt-user', username: 'corrupt', password: 'x', createdAt: 'x' })
  fs.writeFileSync(dbPath(), JSON.stringify(db))

  // 选择 1 号备份（最新）恢复
  const { code, out } = await runScript('scripts/restore.js', '1\n')
  assert.equal(code, 0)
  assert.ok(out.includes('恢复完成'))

  // db.json 恢复为备份内容
  assert.equal(fs.readFileSync(dbPath(), 'utf8'), backupRaw)
  // 恢复前当前数据被另存（pre-restore 备份）
  const pre = fs.readdirSync(backupsDir()).filter(f => f.includes('db-pre-restore-'))
  assert.ok(pre.length >= 1, '恢复前应备份当前数据')
})

test('恢复失败：无效选择被拒绝，db.json 保持不变', async () => {
  const rawBefore = fs.readFileSync(dbPath(), 'utf8')
  const { code, out } = await runScript('scripts/restore.js', '99\n')
  assert.equal(code, 0)
  assert.ok(out.includes('已取消') || out.includes('取消'))
  assert.equal(fs.readFileSync(dbPath(), 'utf8'), rawBefore)
})

test('无备份时恢复脚本报错退出', async () => {
  fs.rmSync(backupsDir(), { recursive: true, force: true })
  const { code, out } = await runScript('scripts/restore.js', '')
  assert.notEqual(code, 0)
  assert.ok(/没有找到备份目录|没有可用备份/.test(out))
})

test('恢复后服务仍可正常读写（服务重启加载恢复数据）', async () => {
  // 上面测试已恢复备份数据；重启服务加载恢复后的 db.json
  await restartServer()
  const db = readDB()
  assert.ok(Array.isArray(db.users))
  // 注册仍正常（防抖写入，等待落盘）
  await register('bk_final')
  await waitForDB(d => d.users.some(u => u.username === 'bk_final'))
})
