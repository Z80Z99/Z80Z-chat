import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

test('显式保存失败仍保留待写状态，再次保存无需新增修改', async () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const testRoot = path.join(projectRoot, '.test-data')
  fs.mkdirSync(testRoot, { recursive: true })
  const testDir = fs.mkdtempSync(path.join(testRoot, 'z80z-chat-flush-test-'))
  const previousDataDir = process.env.DATA_DIR
  const previousLogDir = process.env.LOG_DIR
  process.env.DATA_DIR = testDir
  process.env.LOG_DIR = path.join(testDir, 'logs')
  let db
  const tmpPath = path.join(testDir, 'db.json.tmp')
  const dbPath = path.join(testDir, 'db.json')

  try {
    // 独立测试进程首次加载配置，所有数据库和日志写入均位于测试目录。
    const { initDB } = await import('../models/db.js')
    db = initDB()
    const previousFile = fs.readFileSync(dbPath, 'utf8')
    db.createUser({ id: 'flush-pending', username: 'flush_pending' })
    fs.mkdirSync(tmpPath)

    assert.throws(() => db.save())
    assert.equal(fs.readFileSync(dbPath, 'utf8'), previousFile)

    fs.rmdirSync(tmpPath)
    db.save()
    const saved = JSON.parse(fs.readFileSync(dbPath, 'utf8'))
    assert.equal(saved.users.filter(u => u.id === 'flush-pending').length, 1)
    assert.ok(!fs.existsSync(tmpPath))
  } finally {
    if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).isDirectory()) fs.rmdirSync(tmpPath)
    db?.save()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    if (previousLogDir === undefined) delete process.env.LOG_DIR
    else process.env.LOG_DIR = previousLogDir
    assert.ok(path.resolve(testDir).startsWith(testRoot + path.sep))
    fs.rmSync(testDir, { recursive: true, force: true })
    try { fs.rmdirSync(testRoot) } catch {}
  }
})
