import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import express from 'express'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.test-data')
const previousEnv = { DATA_DIR: process.env.DATA_DIR, LOG_DIR: process.env.LOG_DIR }
const wss = { clients: new Set() }
let dir, db, server, baseUrl, config, readImageInfo, validCommunityDimensions, cleanupAttachmentFiles, collectServerFiles, extractFileNames, counter = 0
before(async () => {
  fs.mkdirSync(root, { recursive: true })
  dir = fs.mkdtempSync(path.join(root, 'community-'))
  process.env.DATA_DIR = dir; process.env.LOG_DIR = path.join(dir, 'logs')
  const { initDB } = await import('../models/db.js')
  const { default: serversRouter } = await import('../routes/servers.js')
  const { default: uploadRouter } = await import('../routes/upload.js')
  const { signUploadUrlsDeep } = await import('../utils/uploadSign.js')
  ;({ default: config } = await import('../config/index.js'))
  ;({ readImageInfo, validCommunityDimensions } = await import('../utils/server-profile.js'))
  ;({ cleanupAttachmentFiles, collectServerFiles, extractFileNames } = await import('../utils/files.js'))
  db = initDB()
  const app = express(); app.locals.db = db; app.locals.wss = wss
  app.use(express.json())
  app.use((req, res, next) => { const original = res.json.bind(res); res.json = body => original(signUploadUrlsDeep(body)); next() })
  app.use('/servers', serversRouter); app.use('/upload', uploadRouter)
  server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  db?.save()
  if (server) await new Promise(resolve => server.close(resolve))
  for (const [name, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
  if (dir) { assert.ok(path.resolve(dir).startsWith(root + path.sep)); fs.rmSync(dir, { recursive: true, force: true }) }
  try { fs.rmdirSync(root) } catch {}
})

function png(width = 256, height = 256, compression = {}) {
  const chunk = (type, data) => {
    const bytes = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
    const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); bytes.copy(result, 4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
    return result
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  const scanlines = Buffer.alloc(height * (width * 4 + 1), 110)
  for (let row = 0; row < height; row++) scanlines[row * (width * 4 + 1)] = 0
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines, compression)), chunk('IEND', Buffer.alloc(0))])
}
const uploads = () => path.join(dir, 'uploads')
const asset = (bytes = png(), extension = 'png') => { const filename = `image-${++counter}.${extension}`; fs.writeFileSync(path.join(uploads(), filename), bytes); return '/uploads/' + filename }
const exists = url => fs.existsSync(path.join(uploads(), path.basename(url.split('?')[0])))
const durableServer = id => JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).servers.find(value => value.id === id)

function fixture() {
  const prefix = `community-${++counter}`, serverId = `${prefix}-server`, ownerId = `${prefix}-owner`, managerId = `${prefix}-manager`, memberId = `${prefix}-member`, blockedId = `${prefix}-blocked`, outsiderId = `${prefix}-outsider`
  for (const id of [ownerId, managerId, memberId, blockedId, outsiderId]) {
    db.createUser({ id, username: id, nickname: id, avatar: 'default' })
    db.createSession({ token: `${id}-token`, userId: id, createdAt: new Date().toISOString() })
  }
  db.createServer({ id: serverId, ownerId, name: '旧社区', avatar: '/uploads/historical.gif', description: '旧简介' })
  db.createRole({ id: `${prefix}-default`, serverId, isDefault: true, permissions: { viewChannel: false } })
  db.createRole({ id: `${prefix}-manager`, serverId, permissions: { viewChannel: true, manageServer: true } })
  db.createRole({ id: `${prefix}-reader`, serverId, permissions: { viewChannel: true } })
  for (const [userId, roles] of [[ownerId, []], [managerId, [`${prefix}-manager`]], [memberId, [`${prefix}-reader`]], [blockedId, []]]) db.createMember({ serverId, userId, roles })
  const channelId = `${prefix}-text`, voiceId = `${prefix}-voice`
  db.createChannel({ id: channelId, serverId, type: 'text' }); db.createChannel({ id: voiceId, serverId, type: 'voice' })
  const socket = (userId, token = `${userId}-token`) => ({ userId, sessionToken: token, readyState: 1, events: [], send(raw) {
    const event = JSON.parse(raw)
    if (event.type === 'server-updated') assert.equal(durableServer(event.serverId).profileRevision, event.server.profileRevision, 'push occurs after durable save')
    this.events.push(event)
  } })
  const owner = socket(ownerId), manager = socket(managerId), member = socket(memberId), second = socket(memberId), blocked = socket(blockedId), outsider = socket(outsiderId), revoked = socket(memberId, 'deleted-session'), expired = socket(memberId, 'expired-session')
  db.createSession({ token: 'expired-session', userId: memberId, createdAt: '2000-01-01T00:00:00.000Z' })
  wss.clients.clear(); for (const client of [owner, manager, member, second, blocked, outsider, revoked, expired]) wss.clients.add(client)
  db.save()
  return { serverId, ownerId, managerId, memberId, blockedId, outsiderId, channelId, voiceId, owner, manager, member, second, blocked, outsider, revoked, expired }
}
async function request(f, { method = 'GET', pathname = `/servers/${f.serverId}`, body, userId = f.ownerId, token = `${userId}-token` } = {}) {
  const response = await fetch(baseUrl + pathname, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, data: await response.json() }
}
const edit = (f, body, userId) => request(f, { method: 'PUT', body, userId })
async function upload(f, { kind = 'avatar', bytes = png(), name = '头像.png', type = 'image/png', userId = f.ownerId, token = `${userId}-token` } = {}) {
  const form = new FormData(); form.append('file', new Blob([bytes], { type }), name)
  const response = await fetch(`${baseUrl}/upload/community/${f.serverId}/${kind}`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form })
  return { status: response.status, data: await response.json() }
}

test('旧社区响应补稳定默认值，不迁移旧头像或改动数据库；非成员不能读取', async () => {
  const f = fixture(), before = JSON.stringify(db.findServer(f.serverId))
  const detail = await request(f)
  assert.equal(detail.status, 200); assert.equal(detail.data.server.banner, ''); assert.equal(detail.data.server.profileRevision, 0)
  assert.deepEqual(detail.data.server.welcome, { title: '', message: '', rules: '', recommendedChannelIds: [] })
  assert.ok(detail.data.server.avatar.startsWith('/uploads/historical.gif'))
  assert.equal(JSON.stringify(db.findServer(f.serverId)), before)
  const list = await request(f, { pathname: '/servers/list' }); assert.deepEqual(list.data.servers.find(item => item.id === f.serverId).welcome, detail.data.server.welcome)
  assert.equal((await request(f, { userId: f.outsiderId })).status, 403)
})

test('群主与当前 manageServer 成员可编辑；普通成员、已退出管理员和未登录被拒绝', async () => {
  const f = fixture()
  assert.equal((await edit(f, { name: '  新社区  ' })).data.server.name, '新社区')
  const managed = await edit(f, { description: '管理员修改' }, f.managerId)
  assert.equal(managed.status, 200); assert.equal(managed.data.server.profileRevision, 2)
  assert.equal((await edit(f, { name: '越权' }, f.memberId)).status, 403)
  assert.equal((await edit(f, { name: '越权' }, f.outsiderId)).status, 403)
  db.deleteMember(f.serverId, f.managerId)
  assert.equal((await edit(f, { name: '已退出' }, f.managerId)).status, 403)
  assert.equal((await request(f, { method: 'PUT', body: { name: '失效' }, token: 'none' })).status, 401)
  assert.equal(db.findServer(f.serverId).profileRevision, 2)
})

test('资料类型与文字上限严格校验，trim 后的名称可保留50字，错误请求不改版本', async () => {
  const f = fixture()
  for (const body of [{ name: {} }, { name: [] }, { name: 12 }, { name: ' ' }, { name: 'x'.repeat(51) }, { description: null }, { description: 'x'.repeat(1001) }, { welcome: null }, { welcome: [] }, { welcome: { title: 123 } }, { welcome: { message: 'x'.repeat(2001) } }, { welcome: { rules: 'x'.repeat(4001) } }, { welcome: { title: 'x'.repeat(101) } }, { welcome: { unsafe: 'field' } }]) {
    assert.equal((await edit(f, body)).status, 400, JSON.stringify(body).slice(0, 100)); assert.equal(db.findServer(f.serverId).profileRevision, undefined)
  }
  const maximum = await edit(f, { name: '  ' + 'x'.repeat(50) + '  ', description: 'x'.repeat(1000), welcome: { title: 'x'.repeat(100), message: 'x'.repeat(2000), rules: 'x'.repeat(4000) } })
  assert.equal(maximum.status, 200); assert.equal(maximum.data.server.name.length, 50)
})

test('欢迎页部分更新保留其他字段，推荐频道只接受本社区最多6个唯一有效ID', async () => {
  const f = fixture(), foreignId = `foreign-${++counter}`
  db.createChannel({ id: foreignId, serverId: 'another-server', type: 'text' })
  assert.equal((await edit(f, { welcome: { title: '你好', message: '入门', rules: '尊重成员', recommendedChannelIds: [f.channelId, f.voiceId] } })).status, 200)
  const partial = await edit(f, { welcome: { title: '新标题' } })
  assert.equal(partial.data.server.welcome.message, '入门'); assert.deepEqual(partial.data.server.welcome.recommendedChannelIds, [f.channelId, f.voiceId])
  for (const ids of [null, 'id', [foreignId], [123], ['missing'], [f.channelId, f.channelId], Array.from({ length: 7 }, (_, index) => `missing-${index}`)]) assert.equal((await edit(f, { welcome: { recommendedChannelIds: ids } })).status, 400)
  db.deleteChannel(f.voiceId)
  assert.deepEqual((await request(f)).data.server.welcome.recommendedChannelIds, [f.channelId])
  const denied = await request(f, { userId: f.blockedId })
  assert.deepEqual(denied.data.channels, []); assert.deepEqual(denied.data.server.welcome.recommendedChannelIds, [])
})

test('成功修改在落盘后推送全部合法成员会话，不泄漏给外部/失效会话/无查看权限成员', async () => {
  const f = fixture(), banner = asset(png(1600, 400))
  const result = await edit(f, { banner, welcome: { recommendedChannelIds: [f.channelId] } })
  assert.equal(result.status, 200); assert.equal(durableServer(f.serverId).banner, banner)
  for (const socket of [f.owner, f.manager, f.member, f.second]) {
    assert.equal(socket.events.length, 1); assert.equal(socket.events[0].type, 'server-updated'); assert.equal(socket.events[0].serverId, f.serverId)
    assert.match(socket.events[0].server.banner, /expires=\d+&sig=[a-f0-9]{64}$/)
  }
  for (const socket of [f.blocked, f.outsider, f.revoked, f.expired]) assert.equal(socket.events.length, 0)
})

test('推送逐会话重新检查当前成员和权限，发送失败不阻止后续成员接收', async () => {
  const f = fixture()
  f.owner.send = () => { db.deleteMember(f.serverId, f.memberId); throw new Error('closed socket') }
  assert.equal((await edit(f, { description: '变化' })).status, 200)
  assert.equal(f.manager.events.length, 1); assert.equal(f.member.events.length, 0); assert.equal(f.second.events.length, 0)
})

test('持久化失败恢复原位资料和版本，不发推送、不删除旧图片，随后重试可成功', async () => {
  const f = fixture(), oldImage = asset(), nextImage = asset()
  db.updateServer(f.serverId, { avatar: oldImage, profileRevision: 4, welcome: { title: '旧欢迎', message: '', rules: '', recommendedChannelIds: [] } }); db.save()
  const original = db.findServer(f.serverId), before = JSON.stringify(original), saved = db.save
  db.save = () => { throw new Error('disk full') }
  let failed
  try { failed = await edit(f, { avatar: nextImage, welcome: { title: '未保存' } }) } finally { db.save = saved }
  assert.equal(failed.status, 500); assert.equal(db.findServer(f.serverId), original); assert.equal(JSON.stringify(original), before)
  assert.equal(durableServer(f.serverId).profileRevision, 4); assert.ok(exists(oldImage)); assert.ok(exists(nextImage))
  for (const client of wss.clients) assert.equal(client.events.length, 0)
  db.save(); assert.equal(durableServer(f.serverId).avatar, oldImage)
  const success = await edit(f, { avatar: nextImage })
  assert.equal(success.status, 200); assert.equal(success.data.server.profileRevision, 5); assert.ok(!exists(oldImage)); assert.ok(exists(nextImage))
})

test('实际数据库 rename 失败保留旧磁盘数据，重试写入不会留下失败的新资料', async () => {
  const f = fixture(), oldImage = asset(), replacement = asset()
  db.updateServer(f.serverId, { avatar: oldImage, profileRevision: 7 }); db.save()
  const savedRename = fs.renameSync
  fs.renameSync = (from, to) => { if (path.resolve(to) === path.join(dir, 'db.json')) throw new Error('simulated rename failure'); return savedRename(from, to) }
  let result
  try { result = await edit(f, { name: '未持久化', avatar: replacement }) } finally { fs.renameSync = savedRename }
  assert.equal(result.status, 500); assert.equal(db.findServer(f.serverId).name, '旧社区'); assert.equal(db.findServer(f.serverId).profileRevision, 7)
  assert.equal(durableServer(f.serverId).avatar, oldImage); assert.ok(exists(oldImage)); assert.equal(f.owner.events.length, 0)
  db.save(); assert.equal(durableServer(f.serverId).name, '旧社区'); assert.equal(durableServer(f.serverId).profileRevision, 7)
})

test('本地图片提交剥签名参数，拒绝外链/穿越/未知参数/非图片，旧头像未提交时保持', async () => {
  const f = fixture(), image = asset(), banner = asset(png(400, 100))
  const signed = `${image}?expires=1&sig=${'a'.repeat(64)}`
  const result = await edit(f, { avatar: signed, banner: `${banner}?expires=1&sig=${'a'.repeat(64)}` })
  assert.equal(result.status, 200); assert.equal(db.findServer(f.serverId).avatar, image); assert.equal(db.findServer(f.serverId).banner, banner)
  const fake = asset(Buffer.from('not an image'))
  for (const value of [null, {}, [], 'https://example.com/a.png', '//example.com/a.png', 'data:image/png;base64,x', '/uploads/../db.png', '/uploads/..%2fdb.png', '/uploads/sub/a.png', '/uploads/a.png#hash', '/uploads/missing.png', `${image}?evil=x`, `${image}?expires=1&expires=2&sig=${'a'.repeat(64)}`, fake]) {
    assert.equal((await edit(f, { avatar: value })).status, 400); assert.equal((await edit(f, { banner: value })).status, 400)
  }
  assert.equal((await edit(f, { avatar: 'default', banner: '' })).status, 200)
  const legacy = fixture(); await edit(legacy, { description: '仅改简介' })
  assert.equal(db.findServer(legacy.serverId).avatar, '/uploads/historical.gif')
})

test('通用图片上传或已有文件不能绕过资料保存时的用途尺寸、比例与体积限制', async () => {
  const f = fixture(), before = JSON.stringify(db.findServer(f.serverId))
  const genericUpload = async bytes => {
    const form = new FormData(); form.append('file', new Blob([bytes], { type: 'image/png' }), 'generic.png')
    const response = await fetch(`${baseUrl}/upload/image`, { method: 'POST', headers: { Authorization: `Bearer ${f.ownerId}-token` }, body: form })
    assert.equal(response.status, 200); return (await response.json()).url
  }
  for (const [kind, bytes] of [['avatar', png(64, 64)], ['avatar', png(256, 128)], ['avatar', png(1025, 1025)], ['banner', png(400, 400)], ['banner', png(300, 75)], ['banner', png(3204, 801)]]) {
    const url = await genericUpload(bytes)
    assert.equal((await edit(f, { [kind]: url })).status, 400, `${kind} rejects generic image dimensions`)
    assert.ok(exists(url), 'failed save does not delete an uploaded file')
  }
  const oversizedAvatar = asset(png(1024, 1024, { level: 0 })), oversizedBanner = asset(png(3200, 800, { level: 0 }))
  assert.equal(readImageInfo(fs.readFileSync(path.join(uploads(), path.basename(oversizedAvatar)))).width, 1024)
  assert.equal((await edit(f, { avatar: oversizedAvatar })).status, 400)
  assert.equal((await edit(f, { banner: oversizedBanner })).status, 400)
  const validAvatar = asset(), maximum = config.maxUploadSizeMB; config.maxUploadSizeMB = 0.00001
  try { assert.equal((await edit(f, { avatar: validAvatar })).status, 400) } finally { config.maxUploadSizeMB = maximum }
  assert.equal(JSON.stringify(db.findServer(f.serverId)), before); assert.equal(f.owner.events.length, 0)
  assert.equal((await edit(f, { avatar: await genericUpload(png()), banner: await genericUpload(png(1600, 400)) })).status, 200)
})

test('社区上传先检查登录/成员/管理权限，拒绝的 multipart 请求不会写文件', async () => {
  const f = fixture(), files = fs.readdirSync(uploads())
  assert.equal((await upload(f, { token: '' })).status, 401)
  assert.equal((await upload(f, { userId: f.outsiderId })).status, 403)
  assert.equal((await upload(f, { userId: f.memberId })).status, 403)
  assert.equal((await upload(f, { kind: 'other' })).status, 400)
  assert.deepEqual(fs.readdirSync(uploads()), files)
})

test('PNG社区上传返回签名链接、真实尺寸和中文文件名，管理成员可上传且不自动改资料', async () => {
  const f = fixture()
  const avatar = await upload(f, { userId: f.managerId })
  assert.equal(avatar.status, 200); assert.equal(avatar.data.filename, '头像.png'); assert.equal(avatar.data.width, 256); assert.equal(avatar.data.height, 256); assert.equal(avatar.data.kind, 'avatar')
  assert.match(avatar.data.url, /^\/uploads\/[a-f0-9-]+\.png\?expires=\d+&sig=[a-f0-9]{64}$/); assert.ok(exists(avatar.data.url))
  const banner = await upload(f, { kind: 'banner', bytes: png(1600, 400), name: '横幅.png' })
  assert.equal(banner.status, 200); assert.equal(banner.data.width, 1600); assert.equal(banner.data.height, 400)
  assert.equal(db.findServer(f.serverId).banner, undefined)
  assert.equal((await edit(f, { avatar: avatar.data.url, banner: banner.data.url })).status, 200)
})

test('上传尚未完成时撤销管理权限，二次权限检查拒绝且不写文件', async () => {
  const f = fixture(), bytes = png(), before = fs.readdirSync(uploads()), boundary = 'community-permission-check'
  let entered; const permissionChecked = new Promise(resolve => { entered = resolve })
  const original = db.findMember
  db.findMember = (serverId, userId) => { const result = original(serverId, userId); if (serverId === f.serverId && userId === f.managerId) entered(); return result }
  const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\n`)
  async function *body() {
    yield Buffer.concat([header, bytes.subarray(0, 16)])
    await permissionChecked
    const roleId = db.findMember(f.serverId, f.managerId).roles[0]
    db.updateRole(roleId, { permissions: { viewChannel: true, manageServer: false } })
    yield Buffer.concat([bytes.subarray(16), Buffer.from(`\r\n--${boundary}--\r\n`)])
  }
  let response
  try { response = await fetch(`${baseUrl}/upload/community/${f.serverId}/avatar`, { method: 'POST', headers: { Authorization: `Bearer ${f.managerId}-token`, 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body: body(), duplex: 'half' }) }
  finally { db.findMember = original }
  assert.equal(response.status, 403); assert.deepEqual(fs.readdirSync(uploads()), before)
})

test('图片写入失败删除不完整新文件并返回可重试错误，资料保持原值', async () => {
  const f = fixture(), before = fs.readdirSync(uploads()), original = fs.writeFileSync
  fs.writeFileSync = (filePath, bytes, options) => {
    if (typeof filePath === 'string' && path.dirname(filePath) === uploads() && path.extname(filePath) === '.png') { original(filePath, Buffer.from([0]), options); const error = new Error('simulated full disk'); error.code = 'ENOSPC'; throw error }
    return original(filePath, bytes, options)
  }
  let result
  try { result = await upload(f) } finally { fs.writeFileSync = original }
  assert.equal(result.status, 500); assert.deepEqual(fs.readdirSync(uploads()), before); assert.equal(db.findServer(f.serverId).profileRevision, undefined)
})

test('社区上传拒绝错误签名、扩展名/MIME伪装、截断或损坏图片且不留文件', async () => {
  const f = fixture(), before = fs.readdirSync(uploads()), damaged = png(); damaged[damaged.length - 1] ^= 1
  for (const options of [{ bytes: Buffer.from('not PNG') }, { name: 'x.jpg' }, { type: 'image/jpeg' }, { name: 'x.gif', type: 'image/gif' }, { name: 'x.svg', type: 'image/svg+xml' }, { bytes: png().subarray(0, 33) }, { bytes: damaged }, { bytes: Buffer.concat([png(), Buffer.from('suffix')]) }]) assert.equal((await upload(f, options)).status, 400)
  assert.deepEqual(fs.readdirSync(uploads()), before)
})

test('社区上传限制合理像素范围和1:1/4:1比例，体积同时遵守配置上限', async () => {
  const f = fixture(), before = fs.readdirSync(uploads())
  for (const options of [{ bytes: png(64, 64) }, { bytes: png(1025, 1025) }, { bytes: png(256, 128) }, { kind: 'banner', bytes: png(300, 75) }, { kind: 'banner', bytes: png(400, 400) }, { kind: 'banner', bytes: png(3204, 801) }, { bytes: Buffer.alloc(2 * 1024 * 1024 + 1) }, { kind: 'banner', bytes: Buffer.alloc(5 * 1024 * 1024 + 1) }]) assert.equal((await upload(f, options)).status, 400)
  const maximum = config.maxUploadSizeMB; config.maxUploadSizeMB = 0.00001
  try { assert.equal((await upload(f)).status, 400) } finally { config.maxUploadSizeMB = maximum }
  assert.deepEqual(fs.readdirSync(uploads()), before)
  assert.equal((await upload(f, { bytes: png(128, 128) })).status, 200)
  assert.equal((await upload(f, { kind: 'banner', bytes: png(400, 100) })).status, 200)
})

test('替换图片仅清理无引用旧文件，用户头像、另一个社区和消息引用都保护文件', async () => {
  const f = fixture(), shared = asset(), replacement = asset(), fileName = path.basename(shared)
  db.updateServer(f.serverId, { avatar: shared, banner: shared })
  db.updateUser(f.memberId, { avatar: shared + '?expires=1&sig=old' })
  const otherId = `shared-server-${++counter}`; db.createServer({ id: otherId, ownerId: f.ownerId, avatar: shared })
  const message = db.createMessage({ id: `shared-message-${++counter}`, channelId: f.channelId, userId: f.ownerId, image: shared })
  db.save()
  assert.equal((await edit(f, { avatar: replacement, banner: '' })).status, 200); assert.ok(exists(shared))
  db.updateUser(f.memberId, { avatar: 'default' }); cleanupAttachmentFiles(db, [fileName]); assert.ok(exists(shared))
  db.deleteServer(otherId); cleanupAttachmentFiles(db, [fileName]); assert.ok(exists(shared))
  db.deleteMessage(message.id); db.save(); cleanupAttachmentFiles(db, [fileName]); assert.ok(!exists(shared))
})

test('服务器文件收集包含横幅与头像，清理拒绝穿越且精确匹配文件名', () => {
  const f = fixture(), avatar = asset(), banner = asset(png(400, 100)), fileName = path.basename(avatar)
  db.updateServer(f.serverId, { avatar, banner }); db.save()
  assert.deepEqual(new Set(collectServerFiles(db, f.serverId)), new Set([path.basename(avatar), path.basename(banner)]))
  const stray = asset(), dbFile = path.join(dir, 'db.json')
  cleanupAttachmentFiles(db, ['../db.json', '..\\db.json', '/', path.basename(stray)])
  assert.ok(fs.existsSync(dbFile)); assert.ok(exists(avatar)); assert.ok(!exists(stray))
  assert.deepEqual(extractFileNames({ image: '/uploads/../db.json', file: '/uploads/sub/name.png' }), [])
  assert.deepEqual(extractFileNames({ image: avatar + '?expires=1&sig=test' }), [fileName])
})

test('图片结构解析：JPEG SOF与WebP VP8/VP8L尺寸，不接受截断、动画或虚假的VP8X元数据', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 1, 0, 1, 0, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x44, 0xff, 0xd9])
  assert.deepEqual(readImageInfo(jpeg), { format: 'jpeg', width: 256, height: 256 }); assert.equal(readImageInfo(jpeg.subarray(0, -2)), null)
  const riff = (type, frame) => { const padded = frame.length % 2 ? Buffer.concat([frame, Buffer.from([0])]) : frame; const bytes = Buffer.alloc(20); bytes.write('RIFF'); bytes.writeUInt32LE(padded.length + 12, 4); bytes.write('WEBP', 8); bytes.write(type, 12); bytes.writeUInt32LE(frame.length, 16); return Buffer.concat([bytes, padded]) }
  const vp8 = Buffer.from([0, 0, 0, 0x9d, 1, 0x2a, 0, 1, 0, 1, 0x44]); assert.deepEqual(readImageInfo(riff('VP8 ', vp8)), { format: 'webp', width: 256, height: 256 })
  const vp8l = Buffer.alloc(6); vp8l[0] = 0x2f; vp8l.writeUInt32LE(255 + (255 << 14), 1)
  assert.deepEqual(readImageInfo(riff('VP8L', vp8l)), { format: 'webp', width: 256, height: 256 })
  assert.equal(readImageInfo(riff('VP8X', Buffer.alloc(10))), null); assert.equal(readImageInfo(riff('ANIM', Buffer.alloc(6))), null)
  assert.equal(readImageInfo(riff('VP8 ', vp8).subarray(0, -1)), null)
  assert.equal(validCommunityDimensions({ width: 256, height: 256 }, 'unknown'), false)
})

test('空修改不增加版本或推送，版本溢出拒绝而保留已保存资料', async () => {
  const f = fixture(); assert.equal((await edit(f, {})).data.server.profileRevision, 0); assert.equal(f.owner.events.length, 0)
  db.updateServer(f.serverId, { profileRevision: Number.MAX_SAFE_INTEGER }); db.save()
  assert.equal((await edit(f, { name: '溢出' })).status, 409); assert.equal(db.findServer(f.serverId).name, '旧社区'); assert.equal(f.owner.events.length, 0)
})

test('提供编辑基线版本时成功保存，旧表单冲突不覆盖较新资料；旧客户端可省略版本', async () => {
  const f = fixture()
  const first = await edit(f, { expectedRevision: 0, welcome: { title: '第一版' } }, f.managerId)
  assert.equal(first.status, 200); assert.equal(first.data.server.profileRevision, 1)
  const beforeEvents = f.owner.events.length
  const stale = await edit(f, { expectedRevision: 0, welcome: { title: '旧表单' } })
  assert.equal(stale.status, 409); assert.match(stale.data.error, /重新加载/); assert.equal(db.findServer(f.serverId).welcome.title, '第一版'); assert.equal(f.owner.events.length, beforeEvents)
  assert.equal((await edit(f, { expectedRevision: 0, avatar: '/uploads/already-replaced.png' })).status, 409, 'stale image references still request reload instead of failing image validation')
  assert.equal((await edit(f, { expectedRevision: 1, welcome: { title: '第二版' } })).data.server.profileRevision, 2)
  assert.equal((await edit(f, { description: '兼容未提供版本' })).status, 200)
})

test('编辑基线版本仅接受非负安全整数，非法类型不修改资料', async () => {
  const f = fixture()
  for (const expectedRevision of [null, '0', [], {}, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal((await edit(f, { expectedRevision, name: '非法版本' })).status, 400)
  assert.equal(db.findServer(f.serverId).profileRevision, undefined); assert.equal(f.owner.events.length, 0)
})
