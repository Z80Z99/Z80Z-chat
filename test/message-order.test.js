import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

test('同毫秒消息按插入顺序分页，不遗漏边界消息或改变数据库顺序', async () => {
  const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const testRoot = path.join(project, '.test-data')
  fs.mkdirSync(testRoot, { recursive: true })
  const dataDir = fs.mkdtempSync(path.join(testRoot, 'message-order-'))
  const previousDataDir = process.env.DATA_DIR
  const previousLogDir = process.env.LOG_DIR
  process.env.DATA_DIR = dataDir
  process.env.LOG_DIR = path.join(dataDir, 'logs')
  let db
  try {
    const { initDB } = await import('../models/db.js')
    db = initDB()
    for (let id = 1; id <= 5; id++) {
      db.createMessage({ id: String(id), channelId: 'channel', createdAt: '2026-10-09T00:00:00.000Z' })
    }
    db.createMessage({ id: 'other', channelId: 'other-channel', createdAt: '2026-10-10T00:00:00.000Z' })
    const first = db.findMessagesByChannel('channel', 2)
    const second = db.findMessagesByChannel('channel', 2, first.at(-1).id)
    const third = db.findMessagesByChannel('channel', 2, second.at(-1).id)
    assert.deepEqual(first.map(message => message.id), ['5', '4'])
    assert.deepEqual(second.map(message => message.id), ['3', '2'])
    assert.deepEqual(third.map(message => message.id), ['1'])
    assert.deepEqual(db.raw.messages.map(message => message.id), ['1', '2', '3', '4', '5', 'other'])
  } finally {
    db?.save()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    if (previousLogDir === undefined) delete process.env.LOG_DIR
    else process.env.LOG_DIR = previousLogDir
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(testRoot) + path.sep))
    fs.rmSync(dataDir, { recursive: true, force: true })
    try { fs.rmdirSync(testRoot) } catch {}
  }
})
