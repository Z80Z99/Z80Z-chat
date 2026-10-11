import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import config from '../config/index.js'
import { signUploadPath, verifyUploadSig, signUploadUrlsDeep, getExpiresSec } from '../utils/uploadSign.js'

// 注入测试密钥：避免自动生成写入真实 data/.upload-secret
config.uploadSecret = 'unit-test-secret'

const NOW = 1750000000000 // 固定 now 便于测试

test('签名 → 校验通过（roundtrip）', () => {
  const url = '/uploads/abc.png'
  const signed = signUploadPath(url, { now: NOW })
  const m = signed.match(/^(\/uploads\/abc\.png)\?expires=(\d+)&sig=([0-9a-f]+)$/)
  assert.ok(m, '签名 URL 格式正确')
  assert.equal(verifyUploadSig(m[1], m[2], m[3], { now: NOW }), true)
})

test('非 /uploads/ 路径不签名', () => {
  assert.equal(signUploadPath('/api/version', { now: NOW }), '/api/version')
  assert.equal(signUploadPath('default', { now: NOW }), 'default')
  assert.equal(signUploadPath('https://x.com/a.png', { now: NOW }), 'https://x.com/a.png')
})

test('已签名 URL 不再重复签名', () => {
  const signed = signUploadPath('/uploads/a.png', { now: NOW })
  assert.equal(signUploadPath(signed, { now: NOW }), signed)
})

test('篡改 sig 校验失败', () => {
  const signed = signUploadPath('/uploads/a.png', { now: NOW })
  const [url, qs] = signed.split('?')
  const params = new URLSearchParams(qs)
  const sig = params.get('sig')
  const bad = (sig[0] === '0' ? '1' : '0') + sig.slice(1)
  assert.notEqual(bad, sig)
  assert.equal(verifyUploadSig(url, params.get('expires'), bad, { now: NOW }), false)
})

test('篡改 expires 校验失败', () => {
  const signed = signUploadPath('/uploads/a.png', { now: NOW })
  const [url, qs] = signed.split('?')
  const params = new URLSearchParams(qs)
  assert.equal(verifyUploadSig(url, String(Number(params.get('expires')) + 1), params.get('sig'), { now: NOW }), false)
})

test('过期 URL 校验失败', () => {
  const signed = signUploadPath('/uploads/a.png', { now: NOW })
  const [url, qs] = signed.split('?')
  const params = new URLSearchParams(qs)
  // 模拟 8 天后（超过默认 7 天有效期）
  assert.equal(verifyUploadSig(url, params.get('expires'), params.get('sig'), { now: NOW + 8 * 86400 * 1000 }), false)
})

test('历史消息中的过期签名在响应出口续签，且不修改原记录', () => {
  const oldUrl = signUploadPath('/uploads/history.png', { now: NOW })
  const later = NOW + 8 * 86400 * 1000
  const stored = { messages: [{ image: oldUrl, user: { avatar: oldUrl } }] }
  const out = signUploadUrlsDeep(stored, { now: later })
  const renewed = out.messages[0].image
  const parsed = new URL(renewed, 'http://localhost')
  assert.notEqual(renewed, oldUrl)
  assert.equal(parsed.pathname, '/uploads/history.png')
  assert.equal(verifyUploadSig(parsed.pathname, parsed.searchParams.get('expires'), parsed.searchParams.get('sig'), { now: later }), true)
  assert.equal(out.messages[0].user.avatar, renewed)
  assert.equal(stored.messages[0].image, oldUrl)
})

test('过期时间到达即失效并续签', () => {
  const signed = signUploadPath('/uploads/expiry.png', { now: NOW, expiresSec: 10 })
  const parsed = new URL(signed, 'http://localhost')
  const atExpiry = NOW + 10000
  assert.equal(verifyUploadSig(parsed.pathname, parsed.searchParams.get('expires'), parsed.searchParams.get('sig'), { now: atExpiry }), false)
  assert.notEqual(signUploadPath(signed, { now: atExpiry }), signed)
})

test('旧 query、片段、损坏或重复签名被规范化为可访问的本地路径', () => {
  const valid = signUploadPath('/uploads/query.png', { now: NOW })
  const invalidSig = valid.replace(/sig=./, 'sig=x')
  for (const url of [
    '/uploads/query.png?download=1#preview',
    invalidSig,
    valid + '&sig=duplicate',
    valid + '&expires=1',
    '/uploads/query.png?expires=Infinity&sig=wrong'
  ]) {
    assert.equal(signUploadPath(url, { now: NOW }), valid, url)
  }
  assert.equal(signUploadPath(valid + '#preview', { now: NOW }), valid)
})

test('不为目录、路径穿越或外部地址签名', () => {
  for (const url of [
    '/uploads/', '/uploads/nested/file.png', '/uploads/../config.json',
    '/uploads/..%2Fdb.json', '/uploads/a\\b.png', '//example.com/uploads/a.png',
    'https://example.com/uploads/a.png'
  ]) {
    assert.equal(signUploadPath(url, { now: NOW }), url)
    assert.equal(verifyUploadSig(url, String(NOW / 1000 + 100), 'a'.repeat(64), { now: NOW }), false)
  }
})

test('缺少参数校验失败', () => {
  assert.equal(verifyUploadSig('/uploads/a.png', null, 'x', { now: NOW }), false)
  assert.equal(verifyUploadSig('/uploads/a.png', '123', null, { now: NOW }), false)
  assert.equal(verifyUploadSig('/api/version', '123', 'x', { now: NOW }), false)
})

test('signUploadUrlsDeep 深度遍历：只改 /uploads/ 字符串', () => {
  const payload = {
    messages: [
      { content: 'hi', image: '/uploads/img1.png', user: { avatar: 'default' } },
      { content: 'no image', file: '/uploads/f2.zip' }
    ],
    count: 2,
    meta: { url: '/uploads/meta.png' }
  }
  const out = signUploadUrlsDeep(payload, { now: NOW })
  assert.ok(out.messages[0].image.includes('expires='), 'image 已签名')
  assert.ok(out.messages[1].file.includes('expires='), 'file 已签名')
  assert.ok(out.meta.url.includes('expires='), '嵌套 url 已签名')
  assert.equal(out.messages[0].content, 'hi', '普通字段不变')
  assert.equal(out.messages[0].user.avatar, 'default', '非 /uploads 不变')
  assert.equal(out.count, 2, '数字不变')
})

test('getExpiresSec 默认 7 天', () => {
  assert.equal(getExpiresSec(), 604800)
})

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url))

// 每次子进程使用独立 DATA_DIR，以覆盖密钥初始化而不触碰真实运行数据。
function withSecretFixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z80z-upload-secret-'))
  try { run(dir) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

function secretProcess(dir, source) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import path from 'node:path'
    import config, { dataDir } from './config/index.js'
    import { signUploadPath, verifyUploadSig } from './utils/uploadSign.js'
    config.uploadSecret = ''
    const secretFile = path.join(dataDir, '.upload-secret')
    const fixedNow = ${NOW}
    ${source}
  `], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DATA_DIR: dir },
    encoding: 'utf8'
  })
  assert.equal(child.status, 0, child.stderr || child.stdout)
  return child.stdout.trim()
}

test('自动生成的随机密钥持久化后跨进程保持一致', () => {
  withSecretFixture(dir => {
    const first = secretProcess(dir, `console.log(signUploadPath('/uploads/persist.png', { now: fixedNow }))`)
    const secret = fs.readFileSync(path.join(dir, '.upload-secret'), 'utf8')
    assert.match(secret, /^[0-9a-f]{64}$/)
    const second = secretProcess(dir, `console.log(signUploadPath('/uploads/persist.png', { now: fixedNow }))`)
    assert.equal(second, first)
  })
})

test('空的持久化密钥明确报错，不签发可预测链接', () => {
  withSecretFixture(dir => {
    fs.writeFileSync(path.join(dir, '.upload-secret'), ' \n\t')
    secretProcess(dir, `
      for (let i = 0; i < 2; i++) {
        assert.throws(() => signUploadPath('/uploads/a.png'), /持久化签名密钥为空/)
      }
    `)
  })
})

test('密钥读取或落盘失败时不缓存后备密钥，后续操作仍拒绝签发', () => {
  for (const operation of ['readFileSync', 'writeFileSync']) {
    withSecretFixture(dir => {
      secretProcess(dir, `
        const original = fs.${operation}
        fs.${operation} = (target, ...args) => {
          if (target === secretFile) throw Object.assign(new Error('isolated permission failure'), { code: 'EACCES' })
          return original(target, ...args)
        }
        for (let i = 0; i < 2; i++) {
          assert.throws(() => signUploadPath('/uploads/a.png'), /无法加载或保存上传签名密钥: isolated permission failure/)
        }
        fs.${operation} = original
        assert.equal(fs.existsSync(secretFile), false)
      `)
    })
  }
})
