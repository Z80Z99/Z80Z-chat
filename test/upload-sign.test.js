import { test } from 'node:test'
import assert from 'node:assert/strict'
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
  const bad = (Number(params.get('sig'), 16) + 1).toString(16)
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
