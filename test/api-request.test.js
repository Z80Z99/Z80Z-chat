import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = ts.transpileModule(readFileSync(new URL('../frontend/src/utils/api.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText

function harness(fetch) {
  const timers = new Map()
  const globals = {
    exports: {}, AbortController, FormData, fetch,
    localStorage: { getItem: () => 'test-token' },
    setTimeout(callback, delay) { timers.set(1, { callback, delay }); return 1 },
    clearTimeout(id) { timers.delete(id) }
  }
  vm.runInNewContext(source, globals)
  return { api: globals.exports.api, timers }
}

test('发送冲突保留HTTP状态码，JSON错误提示不丢失', async () => {
  const h = harness(async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer test-token')
    return { ok: false, status: 409, json: async () => ({ error: '发送编号冲突' }) }
  })
  await assert.rejects(h.api.sendMessage({ clientMessageId: 'same-id' }), error => error.status === 409 && error.message === '发送编号冲突')
  assert.equal(h.timers.size, 0)
})

test('代理返回非JSON错误仍保留HTTP状态，不误判成功', async () => {
  const h = harness(async () => ({ ok: false, status: 503, json: async () => { throw new Error('HTML') } }))
  await assert.rejects(h.api.sendMessage({}), error => error.status === 503)
  assert.equal(h.timers.size, 0)
})

test('请求超过15秒会取消fetch并报告未确认的超时，释放计时器', async () => {
  let signal
  const h = harness((url, options) => new Promise((resolve, reject) => {
    signal = options.signal
    signal.addEventListener('abort', () => reject(new Error('AbortError')))
  }))
  const pending = h.api.sendMessage({ clientMessageId: 'timeout-id' })
  assert.equal(h.timers.get(1).delay, 15000)
  h.timers.get(1).callback()
  await assert.rejects(pending, /请求超时/)
  assert.equal(signal.aborted, true)
  assert.equal(h.timers.size, 0)
})

test('社区图片按multipart上传，不手写JSON Content-Type，权限错误仍拒绝并释放计时器', async () => {
  const h = harness(async (url, options) => {
    assert.equal(url, '/api/upload/community/server%20id/banner')
    assert.equal(options.headers['Content-Type'], undefined)
    assert.equal(options.headers.Authorization, 'Bearer test-token')
    assert.ok(options.body instanceof FormData)
    assert.equal(options.body.get('file').name, 'banner.png')
    return { ok: false, status: 403, json: async () => ({ error: '没有管理服务器的权限' }) }
  })
  await assert.rejects(h.api.uploadCommunityImage('server id', 'banner', new File(['image'], 'banner.png')), error => error.status === 403)
  assert.equal(h.timers.size, 0)
})
