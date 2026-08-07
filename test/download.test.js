import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { downloadWithProgress } from '../utils/download.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const testDataRoot = path.join(__dirname, '..', '.test-data')
fs.mkdirSync(testDataRoot, { recursive: true })
const TMP = fs.mkdtempSync(path.join(testDataRoot, 'dl-'))

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
})

// 本地 HTTP 服务：支持 /ok（含 content-length）、/no-length、/missing
function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

test('下载成功：字节完整 + 返回 ok', async () => {
  const body = Buffer.from('hello-download-' + 'x'.repeat(1000))
  const { server, port } = await serve((req, res) => {
    res.setHeader('Content-Length', body.length)
    res.end(body)
  })
  try {
    const dest = path.join(TMP, 'ok.bin')
    const r = await downloadWithProgress(`http://127.0.0.1:${port}/ok`, dest)
    assert.equal(r.ok, true)
    assert.deepEqual(fs.readFileSync(dest), body)
    assert.ok(!fs.existsSync(dest + '.tmp'), '不应残留 .tmp')
  } finally { server.close() }
})

test('下载失败（404）：返回 not ok，无 .tmp 残留', async () => {
  const { server, port } = await serve((req, res) => { res.statusCode = 404; res.end('nope') })
  try {
    const dest = path.join(TMP, 'missing.bin')
    const r = await downloadWithProgress(`http://127.0.0.1:${port}/missing`, dest)
    assert.equal(r.ok, false)
    assert.ok(r.error.includes('404'))
    assert.ok(!fs.existsSync(dest), '目标文件不应创建')
    assert.ok(!fs.existsSync(dest + '.tmp'), '不应残留 .tmp')
  } finally { server.close() }
})

test('下载无 content-length 也能完成', async () => {
  const body = Buffer.from('stream-no-length')
  const { server, port } = await serve((req, res) => { res.end(body) })
  try {
    const dest = path.join(TMP, 'nolength.bin')
    const r = await downloadWithProgress(`http://127.0.0.1:${port}/x`, dest)
    assert.equal(r.ok, true)
    assert.deepEqual(fs.readFileSync(dest), body)
  } finally { server.close() }
})
