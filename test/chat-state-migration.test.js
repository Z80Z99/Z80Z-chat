import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url))
const TEST_ROOT = path.join(PROJECT_ROOT, '.test-data')
const CREATED_AT = '2026-10-09T00:00:00.000Z'

function oldDatabase() {
  return {
    users: [{ id: 'reader', username: '保留旧用户' }, { id: 'author', username: 'author' }],
    sessions: [{ token: 'old-session-token', userId: 'reader', createdAt: CREATED_AT }],
    friends: [], servers: [{ id: 'server-a', ownerId: 'reader', name: 'Legacy server' }],
    categories: [],
    channels: [{ id: 'text-a', serverId: 'server-a', type: 'text' }, { id: 'text-b', serverId: 'server-a', type: 'text' }],
    messages: [
      { id: 'old-1', channelId: 'text-a', userId: 'author', content: 'first', createdAt: CREATED_AT },
      { id: 'old-2', channelId: 'text-b', userId: 'author', content: 'other channel', createdAt: CREATED_AT },
      { id: 'old-3', channelId: 'text-a', userId: 'author', content: 'third', createdAt: CREATED_AT },
      { id: 'old-4', channelId: 'text-a', userId: 'reader', content: 'fourth', createdAt: CREATED_AT },
      { id: 'old-5', channelId: 'text-b', userId: 'reader', content: 'fifth', createdAt: CREATED_AT },
      { id: 'old-6', channelId: 'text-a', userId: 'author', content: 'latest', createdAt: CREATED_AT }
    ],
    roles: [{ id: 'everyone', serverId: 'server-a', isDefault: true, permissions: { viewChannel: true, sendMessage: true } }],
    members: [{ serverId: 'server-a', userId: 'reader', roles: [] }, { serverId: 'server-a', userId: 'author', roles: [] }],
    invites: []
  }
}

function withFixture(run) {
  fs.mkdirSync(TEST_ROOT, { recursive: true })
  const dir = fs.mkdtempSync(path.join(TEST_ROOT, 'chat-state-migration-'))
  const dbFile = path.join(dir, 'db.json')
  const original = JSON.stringify(oldDatabase(), null, 3) + '\n'
  fs.writeFileSync(dbFile, original)
  const read = () => JSON.parse(fs.readFileSync(dbFile, 'utf8'))
  const backups = () => fs.readdirSync(dir).filter(name => /^db\.json\.pre-chat-state-.*\.bak$/.test(name))
  try { run({ dir, dbFile, original, read, backups }) } finally {
    assert.ok(path.resolve(dir).startsWith(TEST_ROOT + path.sep))
    fs.rmSync(dir, { recursive: true, force: true })
    try { fs.rmdirSync(TEST_ROOT) } catch {}
  }
}

function runDatabase(dir, source) {
  // Every invocation starts a fresh config/model import cache and only writes this fixture's data/logs.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import path from 'node:path'
    import { initDB } from './models/db.js'
    import { dataDir, dbPath } from './config/index.js'
    const createdAt = '${CREATED_AT}'
    ${source}
  `], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DATA_DIR: dir, LOG_DIR: path.join(dir, 'logs') },
    encoding: 'utf8', timeout: 10000
  })
  assert.equal(child.status, 0, child.stderr || child.stdout || String(child.error))
}

test('旧 JSON 升级前逐字备份；按插入顺序分配全局 sequence，同毫秒分页稳定', () => {
  withFixture(fixture => {
    runDatabase(fixture.dir, `
      const db = initDB()
      assert.deepEqual(db.raw.messages.map(message => message.sequence), [1, 2, 3, 4, 5, 6])
      assert.equal(db.raw.lastMessageSequence, 6)
      assert.equal(db.raw.chatStateVersion, 1)
      assert.deepEqual(db.findMessagesByChannel('text-a', 2).map(message => message.id), ['old-6', 'old-4'])
      assert.deepEqual(db.findMessagesByChannel('text-a', 2, 'old-4').map(message => message.id), ['old-3', 'old-1'])
      assert.deepEqual(db.findMessagesByChannel('text-b', 2).map(message => message.id), ['old-5', 'old-2'])
      assert.equal(db.getReadState('reader', 'text-a').readSequence, 6)
      assert.equal(db.getReadState('reader', 'text-b').readSequence, 5)
      assert.equal(db.getChannelReadState('reader', 'text-a').unreadCount, 0, '升级前旧消息默认为已读')
    `)
    const files = fixture.backups()
    assert.equal(files.length, 1)
    assert.equal(fs.readFileSync(path.join(fixture.dir, files[0]), 'utf8'), fixture.original)
    const upgraded = fixture.read()
    assert.deepEqual(upgraded.users, oldDatabase().users)
    assert.deepEqual(upgraded.sessions, oldDatabase().sessions)
    assert.deepEqual(upgraded.messages.map(({ sequence, ...message }) => message), oldDatabase().messages)
    assert.ok(Array.isArray(upgraded.readStates))
    assert.ok(Array.isArray(upgraded.messageReceipts))
  })
})

test('重启保留消息顺序、已读游标及 receipt；删除最新消息后编号不重用', () => {
  withFixture(fixture => {
    runDatabase(fixture.dir, `
      const db = initDB()
      const message = { id: 'persisted-send', channelId: 'text-a', userId: 'author', content: 'persist', clientMessageId: 'saved-client-id', createdAt }
      db.createMessage(message)
      assert.equal(message.sequence, 7)
      assert.equal(db.getChannelReadState('reader', 'text-a').unreadCount, 1, '升级后首条新消息应未读')
      db.createMessageReceipt({ userId: 'author', clientMessageId: 'saved-client-id', channelId: 'text-a', messageId: message.id, fingerprint: 'original-fingerprint', createdAt })
      db.advanceReadState('reader', 'text-a', message.sequence)
      db.createMessage({ id: 'latest-to-delete', channelId: 'text-a', userId: 'author', content: 'unread', createdAt })
      db.save()
    `)
    const saved = fixture.read()
    const savedRevision = saved.readStateRevision
    assert.equal(saved.lastMessageSequence, 8)
    assert.equal(saved.readStates.find(state => state.userId === 'reader' && state.channelId === 'text-a').readSequence, 7)
    assert.equal(fixture.backups().length, 1)

    runDatabase(fixture.dir, `
      const db = initDB()
      assert.equal(db.findMessage('persisted-send').sequence, 7)
      assert.equal(db.findMessageReceipt('author', 'saved-client-id').fingerprint, 'original-fingerprint')
      assert.equal(db.getReadState('reader', 'text-a').readSequence, 7)
      assert.equal(db.getChannelReadState('reader', 'text-a').unreadCount, 1)
      assert.equal(db.raw.readStateRevision, ${savedRevision})
      db.advanceReadState('reader', 'text-a', 2)
      assert.equal(db.getReadState('reader', 'text-a').readSequence, 7, '旧的已读请求不能回退游标')
      db.deleteMessage('latest-to-delete')
      db.deleteMessage('persisted-send')
      assert.equal(db.getReadState('reader', 'text-a').readSequence, 7, '已读消息删除后仍保留顺序游标')
      assert.ok(db.findMessageReceipt('author', 'saved-client-id'), '删除不删除发送 receipt')
      db.save()
    `)
    assert.equal(fixture.read().lastMessageSequence, 8)
    runDatabase(fixture.dir, `
      const db = initDB()
      assert.equal(db.findMessage('persisted-send'), undefined)
      assert.equal(db.findMessageReceipt('author', 'saved-client-id').messageId, 'persisted-send')
      const message = { id: 'after-delete', channelId: 'text-a', userId: 'author', content: 'new', createdAt }
      db.createMessage(message)
      assert.equal(message.sequence, 9)
      assert.equal(db.getChannelReadState('reader', 'text-a').unreadCount, 1)
      db.save()
    `)
    assert.equal(fixture.read().lastMessageSequence, 9)
    assert.equal(fixture.backups().length, 1, '已升级数据在后续重启不再重复备份')
  })
})

test('未打开频道的新成员首条新消息保持未读，当前作者自己的消息不计未读', () => {
  withFixture(fixture => {
    runDatabase(fixture.dir, `
      const db = initDB()
      db.createUser({ id: 'new-member', username: 'joined offline' })
      db.createMember({ serverId: 'server-a', userId: 'new-member', roles: [] })
      assert.equal(db.raw.readStates.some(state => state.userId === 'new-member'), false)
      db.createMessage({ id: 'first-after-join', channelId: 'text-a', userId: 'author', content: 'new unread', createdAt })
      assert.equal(db.getReadState('new-member', 'text-a').readSequence, 6)
      assert.equal(db.getChannelReadState('new-member', 'text-a').unreadCount, 1)
      assert.equal(db.getChannelReadState('reader', 'text-a').unreadCount, 1)
      assert.equal(db.getChannelReadState('author', 'text-a').unreadCount, 0)
      db.save()
    `)
    runDatabase(fixture.dir, `
      const db = initDB()
      assert.equal(db.getChannelReadState('new-member', 'text-a').unreadCount, 1)
      assert.equal(db.getReadState('new-member', 'text-a').readSequence, 6)
    `)
    assert.equal(fixture.backups().length, 1)
  })
})

test('异常的负数或落后 sequence 元数据升级后不会分配重复编号', () => {
  for (const corrupted of [{ lastMessageSequence: -1, readStateRevision: -1 }, { lastMessageSequence: 0, readStateRevision: 0 }]) {
    withFixture(fixture => {
      runDatabase(fixture.dir, 'initDB()')
      const data = { ...fixture.read(), ...corrupted }
      const original = JSON.stringify(data, null, 2)
      fs.writeFileSync(fixture.dbFile, original)
      runDatabase(fixture.dir, `
        const db = initDB()
        assert.equal(db.raw.lastMessageSequence, 6)
        assert.ok(db.raw.readStateRevision >= 0)
        const message = { id: 'counter-recovered', channelId: 'text-a', userId: 'author', content: 'new', createdAt }
        db.createMessage(message)
        assert.equal(message.sequence, 7)
        db.save()
      `)
      const backups = fixture.backups().map(name => fs.readFileSync(path.join(fixture.dir, name), 'utf8'))
      assert.equal(backups.length, 2)
      assert.ok(backups.includes(original))
      assert.equal(new Set(fixture.read().messages.map(message => message.sequence)).size, 7)
    })
  }
})

test('迁移 atomic 替换失败时保留原 db 和原备份；修复后可以重新升级', () => {
  withFixture(fixture => {
    runDatabase(fixture.dir, `
      const rename = fs.renameSync
      fs.renameSync = (from, to) => {
        if (to === dbPath) throw Object.assign(new Error('injected migration rename failure'), { code: 'EACCES' })
        return rename(from, to)
      }
      try { assert.throws(() => initDB(), /injected migration rename failure/) }
      finally { fs.renameSync = rename }
      assert.equal(fs.existsSync(dbPath + '.tmp'), false)
    `)
    assert.equal(fs.readFileSync(fixture.dbFile, 'utf8'), fixture.original)
    assert.equal(fixture.backups().length, 1)
    assert.equal(fs.readFileSync(path.join(fixture.dir, fixture.backups()[0]), 'utf8'), fixture.original)
    runDatabase(fixture.dir, `
      const db = initDB()
      assert.equal(db.raw.chatStateVersion, 1)
      assert.deepEqual(db.raw.messages.map(message => message.sequence), [1, 2, 3, 4, 5, 6])
    `)
    assert.equal(fixture.backups().length, 2)
    for (const backup of fixture.backups()) assert.equal(fs.readFileSync(path.join(fixture.dir, backup), 'utf8'), fixture.original)
    runDatabase(fixture.dir, 'initDB()')
    assert.equal(fixture.backups().length, 2)
  })
})

test('迁移前备份失败则拒绝升级，不写入或覆盖旧数据', () => {
  withFixture(fixture => {
    runDatabase(fixture.dir, `
      const write = fs.writeFileSync
      fs.writeFileSync = (target, ...args) => {
        if (String(target).startsWith(dbPath + '.pre-chat-state-')) throw Object.assign(new Error('injected backup failure'), { code: 'EACCES' })
        return write(target, ...args)
      }
      try { assert.throws(() => initDB(), /injected backup failure/) }
      finally { fs.writeFileSync = write }
    `)
    assert.equal(fs.readFileSync(fixture.dbFile, 'utf8'), fixture.original)
    assert.equal(fixture.backups().length, 0)
    assert.equal(fs.existsSync(fixture.dbFile + '.tmp'), false)
  })
})
