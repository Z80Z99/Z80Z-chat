import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { startServer, stopServer, api, register, createTestServer, getDataDir, TEST_PORT, sleep } from './helpers.js'

let token, server, textChannel
const uploadsDir = () => path.join(getDataDir(), 'uploads')

async function uploadFile(tok, filename, content = 'file-content') {
  const fd = new FormData()
  fd.append('file', new Blob([content]), filename)
  const res = await fetch(`http://localhost:${TEST_PORT}/api/upload/file`, {
    method: 'POST',
    headers: tok ? { Authorization: 'Bearer ' + tok } : {},
    body: fd
  })
  return { status: res.status, data: await res.json().catch(() => null) }
}

before(async () => {
  await startServer()
  const u = await register('up_owner')
  token = u.token
  const ctx = await createTestServer(token)
  server = ctx.server
  textChannel = ctx.textChannel
})

after(stopServer)

test('未登录上传被拒绝', async () => {
  const r = await uploadFile(null, 'a.jpg')
  assert.equal(r.status, 401)
})

test('jpg 上传成功且文件名为 UUID 格式（URL 带签名）', async () => {
  const r = await uploadFile(token, 'photo.jpg')
  assert.equal(r.status, 200)
  assert.ok(r.data.url.includes('expires='), '上传响应 URL 应带签名')
  assert.ok(r.data.url.includes('sig='), '上传响应 URL 应带签名')
  const name = path.basename(r.data.url.split('?')[0])
  assert.match(name, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/)
  assert.ok(fs.existsSync(path.join(uploadsDir(), name)))
})

test('签名访问控制：无签名 403 / 有效签名 200 / 篡改 403', async () => {
  const up = await uploadFile(token, 'signed.jpg')
  assert.equal(up.status, 200)
  const url = up.data.url
  const [base, qs] = url.split('?')
  const params = new URLSearchParams(qs)

  // 无签名 → 403
  const raw = await fetch(`http://localhost:${TEST_PORT}${base}`)
  assert.equal(raw.status, 403)

  // 有效签名 → 200 且内容正确
  const ok = await fetch(`http://localhost:${TEST_PORT}${url}`)
  assert.equal(ok.status, 200)
  assert.equal(await ok.text(), 'file-content')

  // 篡改 sig → 403
  const badSig = params.get('sig').slice(0, -2) + '00'
  const tampered = await fetch(`http://localhost:${TEST_PORT}${base}?expires=${params.get('expires')}&sig=${badSig}`)
  assert.equal(tampered.status, 403)

  // 篡改 expires → 403
  const badExp = String(Number(params.get('expires')) + 1)
  const expTampered = await fetch(`http://localhost:${TEST_PORT}${base}?expires=${badExp}&sig=${params.get('sig')}`)
  assert.equal(expTampered.status, 403)
})

test('路径穿越文件名被拒绝', async () => {
  const res = await fetch(`http://localhost:${TEST_PORT}/uploads/..%2F..%2Fconfig.json?expires=1&sig=x`)
  assert.equal(res.status, 400)
  const res2 = await fetch(`http://localhost:${TEST_PORT}/uploads/..%5C..%5Cdb.json?expires=1&sig=x`)
  assert.equal(res2.status, 400)
})

test('子串绕过文件名被拒绝（tjpeg / fakejpg）', async () => {
  const a = await uploadFile(token, 'x.tjpeg')
  assert.equal(a.status, 400)
  const b = await uploadFile(token, 'x.fakejpg')
  assert.equal(b.status, 400)
})

test('危险扩展名被拒绝（html / exe / js）', async () => {
  for (const name of ['x.html', 'x.exe', 'x.js']) {
    const r = await uploadFile(token, name)
    assert.equal(r.status, 400, name + ' should be rejected')
  }
})

test('删除消息后无引用附件被物理清理', async () => {
  const up = await uploadFile(token, 'cleanup.jpg')
  const fileUrl = up.data.url
  const fileName = path.basename(fileUrl.split('?')[0])

  const sent = await api('/messages/send', { method: 'POST', body: { channelId: textChannel.id, content: 'with file', file: fileUrl }, token })
  assert.equal(sent.status, 200)
  assert.ok(fs.existsSync(path.join(uploadsDir(), fileName)))

  await api('/messages/' + sent.data.message.id, { method: 'DELETE', token })
  await sleep(200)
  assert.ok(!fs.existsSync(path.join(uploadsDir(), fileName)), 'file should be cleaned')
})

test('被多条消息引用的附件在删除单条消息后保留', async () => {
  const up = await uploadFile(token, 'shared.jpg')
  const fileUrl = up.data.url
  const fileName = path.basename(fileUrl.split('?')[0])

  const m1 = await api('/messages/send', { method: 'POST', body: { channelId: textChannel.id, content: 'a', file: fileUrl }, token })
  const m2 = await api('/messages/send', { method: 'POST', body: { channelId: textChannel.id, content: 'b', file: fileUrl }, token })
  assert.equal(m1.status, 200)
  assert.equal(m2.status, 200)

  await api('/messages/' + m1.data.message.id, { method: 'DELETE', token })
  await sleep(200)
  assert.ok(fs.existsSync(path.join(uploadsDir(), fileName)), 'still referenced by m2')

  await api('/messages/' + m2.data.message.id, { method: 'DELETE', token })
  await sleep(200)
  assert.ok(!fs.existsSync(path.join(uploadsDir(), fileName)), 'reference gone, file cleaned')
})
