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
    const configuredSecret = String(config.uploadSecret)
    if (!configuredSecret.trim()) throw new Error('上传签名密钥 uploadSecret 不能为空白字符串')
    cachedSecret = configuredSecret
    return cachedSecret
  }
  const secretFile = path.join(dataDir, '.upload-secret')
  let secret
  try {
    try {
      secret = fs.readFileSync(secretFile, 'utf8').trim()
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      const generated = crypto.randomBytes(32).toString('hex')
      fs.mkdirSync(dataDir, { recursive: true })
      try {
        // 独占创建，避免并发进程覆盖已生成的密钥；成功落盘后才缓存。
        fs.writeFileSync(secretFile, generated, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        secret = generated
      } catch (err) {
        if (err.code !== 'EEXIST') throw err
        secret = fs.readFileSync(secretFile, 'utf8').trim()
      }
    }
    if (!secret) throw new Error('持久化签名密钥为空，请恢复 data/.upload-secret 或设置 uploadSecret')
  } catch (err) {
    throw new Error(`无法加载或保存上传签名密钥: ${err.message}`, { cause: err })
  }
  cachedSecret = secret
  return cachedSecret
}

export function getExpiresSec() {
  const v = Number(config.uploadUrlExpiresSec)
  return Number.isInteger(v) && v > 0 ? v : 604800
}

function hmacSig(url, expires) {
  return crypto.createHmac('sha256', getUploadSecret()).update(`${url}.${expires}`).digest('hex')
}

// 与 /uploads/:filename 的访问规则一致，只签单层本地文件路径。
function uploadPath(url) {
  if (typeof url !== 'string') return null
  const pathname = url.split(/[?#]/, 1)[0]
  return /^\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pathname) ? pathname : null
}

// 响应出口兼容历史带签名 URL：有效签名保留，过期/损坏签名按原路径续签。
export function signUploadPath(url, { now = Date.now(), expiresSec = getExpiresSec() } = {}) {
  const pathname = uploadPath(url)
  if (!pathname) return url
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1).split('#', 1)[0] : ''
  const params = new URLSearchParams(query)
  if (params.getAll('expires').length === 1 && params.getAll('sig').length === 1 &&
      verifyUploadSig(pathname, params.get('expires'), params.get('sig'), { now })) {
    return `${pathname}?expires=${params.get('expires')}&sig=${params.get('sig')}`
  }
  const expires = Math.floor(now / 1000) + expiresSec
  return `${pathname}?expires=${expires}&sig=${hmacSig(pathname, expires)}`
}

// 校验签名：格式、过期时间、HMAC 恒定时间比较
export function verifyUploadSig(url, expires, sig, { now = Date.now() } = {}) {
  if (!uploadPath(url) || uploadPath(url) !== url) return false
  if (!expires || typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return false
  const exp = Number(expires)
  if (!Number.isSafeInteger(exp) || exp <= Math.floor(now / 1000)) return false
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
