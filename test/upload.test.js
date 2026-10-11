import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'fs'
import path from 'path'
import { startServer, stopServer, restartServer, waitForDB, api, register, createTestServer, getDataDir, TEST_PORT, sleep } from './helpers.js'

let token, server, textChannel
const uploadsDir = () => path.join(getDataDir(), 'uploads')

async function uploadFile(tok, filename, content = 'file-content', endpoint = 'file') {
  const fd = new FormData()
  fd.append('file', new Blob([content]), filename)
  const res = await fetch(`http://localhost:${TEST_PORT}/api/upload/${endpoint}`, {
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

test('浏览器 UTF-8 multipart 保留长中文、重音及 emoji 原文件名，并用于消息显示', async () => {
  const names = [
    '测试附件-长文件名-用于检查手机卡片是否换行.txt',
    'plain-ASCII-attachment.txt',
    'café-résumé.txt',
    '附件-🚀-计划.txt'
  ]
  for (const filename of names) {
    const uploaded = await uploadFile(token, filename)
    assert.equal(uploaded.status, 200)
    assert.equal(uploaded.data.filename, filename)
    const sent = await api('/messages/send', {
      method: 'POST',
      body: { channelId: textChannel.id, file: uploaded.data.url, fileName: uploaded.data.filename },
      token
    })
    assert.equal(sent.status, 200)
    assert.equal(sent.data.message.fileName, filename)
    const history = await api('/messages/list/' + textChannel.id, { token })
    assert.equal(history.status, 200)
    assert.equal(history.data.messages.find(message => message.id === sent.data.message.id).fileName, filename)
  }
  const image = await uploadFile(token, '头像-照片.png', 'image-content', 'image')
  assert.equal(image.status, 200)
  assert.equal(image.data.filename, '头像-照片.png')
})

test('已解析为 Unicode 的 filename* 及旧客户端 Latin-1 文件名保持原值', async () => {
  const boundary = 'z80z-filename-encoding-test'
  for (const { filename, extended } of [
    { filename: '照片-🚀.txt', extended: true },
    { filename: 'café.txt', extended: true },
    { filename: 'café.txt', extended: false }
  ]) {
    const disposition = extended
      ? `filename="fallback.txt"; filename*=UTF-8''${encodeURIComponent(filename)}`
      : `filename="${filename}"`
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; ${disposition}\r\nContent-Type: text/plain\r\n\r\n`, extended ? 'utf8' : 'latin1'),
      Buffer.from(`legacy-content\r\n--${boundary}--\r\n`)
    ])
    const response = await fetch(`http://localhost:${TEST_PORT}/api/upload/file`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).filename, filename)
  }
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
  const sig = params.get('sig')
  const badSig = (sig[0] === '0' ? '1' : '0') + sig.slice(1)
  assert.notEqual(badSig, sig)
  const tampered = await fetch(`http://localhost:${TEST_PORT}${base}?expires=${params.get('expires')}&sig=${badSig}`)
  assert.equal(tampered.status, 403)

  // 篡改 expires → 403
  const badExp = String(Number(params.get('expires')) + 1)
  const expTampered = await fetch(`http://localhost:${TEST_PORT}${base}?expires=${badExp}&sig=${params.get('sig')}`)
  assert.equal(expTampered.status, 403)
})

test('历史消息持久化的过期附件链接在重新读取后续签并可访问', async () => {
  const up = await uploadFile(token, 'history.jpg', 'historical attachment')
  assert.equal(up.status, 200)
  const base = up.data.url.split('?')[0]
  const expires = Math.floor(Date.now() / 1000) - 1
  const secret = fs.readFileSync(path.join(getDataDir(), '.upload-secret'), 'utf8').trim()
  const sig = crypto.createHmac('sha256', secret).update(`${base}.${expires}`).digest('hex')
  const expiredUrl = `${base}?expires=${expires}&sig=${sig}`
  const expired = await fetch(`http://localhost:${TEST_PORT}${expiredUrl}`)
  assert.equal(expired.status, 403)

  const sent = await api('/messages/send', {
    method: 'POST',
    body: { channelId: textChannel.id, content: 'old signed attachment', file: expiredUrl },
    token
  })
  assert.equal(sent.status, 200)
  await waitForDB(db => db.messages.some(message => message.id === sent.data.message.id && message.file === expiredUrl))
  await restartServer()

  const history = await api('/messages/list/' + textChannel.id, { token })
  assert.equal(history.status, 200)
  const message = history.data.messages.find(item => item.id === sent.data.message.id)
  assert.ok(message)
  assert.notEqual(message.file, expiredUrl)
  assert.equal(message.file.split('?')[0], base)
  const file = await fetch(`http://localhost:${TEST_PORT}${message.file}`)
  assert.equal(file.status, 200)
  assert.equal(await file.text(), 'historical attachment')
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
