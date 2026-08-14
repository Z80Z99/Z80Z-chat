// /uploads 访问签名：HMAC-SHA256(secret, url.expires)，防止未授权访问与 URL 篡改
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import config, { dataDir } from '../config/index.js'

let cachedSecret = null

// 签名密钥：config.uploadSecret 优先，否则自动生成持久化到 data/.upload-secret
function getUploadSecret() {
  if (cachedSecret) return cachedSecret
  if (config.uploadSecret) {
    cachedSecret = String(config.uploadSecret)
    return cachedSecret
  }
  const secretFile = path.join(dataDir, '.upload-secret')
  try {
    if (fs.existsSync(secretFile)) {
      cachedSecret = fs.readFileSync(secretFile, 'utf8').trim()
    } else {
      cachedSecret = crypto.randomBytes(32).toString('hex')
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(secretFile, cachedSecret, 'utf8')
    }
  } catch {
    cachedSecret = 'z80z-chat-upload-fallback-secret'
  }
  return cachedSecret
}

export function getExpiresSec() {
  const v = Number(config.uploadUrlExpiresSec)
  return Number.isInteger(v) && v > 0 ? v : 604800
}

function hmacSig(url, expires) {
  return crypto.createHmac('sha256', getUploadSecret()).update(`${url}.${expires}`).digest('hex')
}

// 为 /uploads/ URL 附加签名 query；非 /uploads/ 或已签名 URL 原样返回
export function signUploadPath(url, { now = Date.now(), expiresSec = getExpiresSec() } = {}) {
  if (typeof url !== 'string' || !url.startsWith('/uploads/')) return url
  if (url.includes('sig=')) return url
  const expires = Math.floor(now / 1000) + expiresSec
  return `${url}?expires=${expires}&sig=${hmacSig(url, expires)}`
}

// 校验签名：格式、过期时间、HMAC 恒定时间比较
export function verifyUploadSig(url, expires, sig, { now = Date.now() } = {}) {
  if (typeof url !== 'string' || !url.startsWith('/uploads/')) return false
  if (!expires || !sig) return false
  const exp = Number(expires)
  if (!Number.isFinite(exp) || exp < Math.floor(now / 1000)) return false
  const expected = hmacSig(url, exp)
  const a = Buffer.from(expected)
  const b = Buffer.from(String(sig))
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

// 深度遍历对象/数组，替换所有 /uploads/ 字符串为签名 URL（服务端响应出口统一调用）
export function signUploadUrlsDeep(payload, opts = {}) {
  if (typeof payload === 'string') return signUploadPath(payload, opts)
  if (Array.isArray(payload)) return payload.map(v => signUploadUrlsDeep(v, opts))
  if (payload && typeof payload === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(payload)) out[k] = signUploadUrlsDeep(v, opts)
    return out
  }
  return payload
}
