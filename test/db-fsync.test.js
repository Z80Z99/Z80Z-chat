import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

test('fsync EIO/ENOSPC 不确认或广播消息，关闭描述符并保留旧数据库，同 ID 可恢复', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.test-data')
  fs.mkdirSync(root, { recursive: true })
  const dir = fs.mkdtempSync(path.join(root, 'fsync-test-'))
  const previous = { DATA_DIR: process.env.DATA_DIR, LOG_DIR: process.env.LOG_DIR }
  process.env.DATA_DIR = dir
  process.env.LOG_DIR = path.join(dir, 'logs')
  const originals = { open: fs.openSync, sync: fs.fsyncSync, close: fs.closeSync }
  const tmpPath = path.join(dir, 'db.json.tmp')
  const dbPath = path.join(dir, 'db.json')
  let db
  try {
    const { initDB } = await import('../models/db.js')
    const { submitMessage } = await import('../utils/message.js')
    db = initDB()
    const user = { id: 'fsync-owner', username: 'owner' }
    db.createUser(user)
    db.createSession({ token: 'fsync-session', userId: user.id, createdAt: new Date().toISOString() })
    db.createServer({ id: 'fsync-server', ownerId: user.id })
    db.createMember({ serverId: 'fsync-server', userId: user.id, roles: [] })
    db.createChannel({ id: 'fsync-channel', serverId: 'fsync-server', type: 'text' })
    db.save()
    const events = []
    const wss = { clients: new Set([{ userId: user.id, sessionToken: 'fsync-session', channelId: 'fsync-channel', readyState: 1, send: raw => events.push(JSON.parse(raw)) }]) }
    for (const code of ['EIO', 'ENOSPC']) {
      const oldFile = fs.readFileSync(dbPath, 'utf8')
      const descriptors = new Set()
      let closed = 0
      fs.openSync = (file, flags, ...args) => {
        const fd = originals.open(file, flags, ...args)
        if (file === tmpPath) { assert.equal(flags, 'r+'); descriptors.add(fd) }
        return fd
      }
      fs.fsyncSync = fd => {
        if (descriptors.has(fd)) throw Object.assign(new Error(`injected fsync ${code}`), { code })
        return originals.sync(fd)
      }
      fs.closeSync = fd => {
        if (descriptors.delete(fd)) closed++
        return originals.close(fd)
      }
      const payload = { channelId: 'fsync-channel', content: code, clientMessageId: `fsync-${code}` }
      events.length = 0
      try {
        const failed = submitMessage(db, wss, user, payload)
        assert.equal(failed.status, 500)
        assert.equal(failed.ok, false)
        assert.equal(fs.readFileSync(dbPath, 'utf8'), oldFile)
        assert.deepEqual(events, [])
        assert.equal(closed, 1)
        assert.equal(descriptors.size, 0)
        assert.equal(fs.existsSync(tmpPath), false)
      } finally {
        fs.openSync = originals.open
        fs.fsyncSync = originals.sync
        fs.closeSync = originals.close
      }
      const recovered = submitMessage(db, wss, user, payload)
      assert.equal(recovered.status, 200)
      assert.equal(submitMessage(db, wss, user, payload).message.id, recovered.message.id)
      assert.equal(events.filter(event => event.type === 'message').length, 1)
      const saved = JSON.parse(fs.readFileSync(dbPath, 'utf8'))
      assert.equal(saved.messages.filter(message => message.clientMessageId === payload.clientMessageId).length, 1)
      assert.equal(saved.messageReceipts.filter(receipt => receipt.clientMessageId === payload.clientMessageId).length, 1)
    }
  } finally {
    fs.openSync = originals.open
    fs.fsyncSync = originals.sync
    fs.closeSync = originals.close
    db?.save()
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    assert.ok(path.resolve(dir).startsWith(root + path.sep))
    fs.rmSync(dir, { recursive: true, force: true })
    try { fs.rmdirSync(root) } catch {}
  }
})
