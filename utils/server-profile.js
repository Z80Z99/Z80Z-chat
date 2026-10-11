import fs from 'node:fs'
import path from 'node:path'
import config, { uploadDir } from '../config/index.js'
import { hasPermission } from './permissions.js'
import { hasActiveSocketSession } from './ws-session.js'
import { signUploadUrlsDeep } from './uploadSign.js'
import { logger } from './logger.js'

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

// Read container structure and dimensions; this is deliberately not a complete image decoder.
export function readImageInfo(bytes) {
  if (!Buffer.isBuffer(bytes)) return null
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    let offset = 8, dimensions = null, hasData = false
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8)
      if (length > bytes.length - offset - 12) return null
      if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) return null
      if (offset === 8) {
        if (type !== 'IHDR' || length !== 13) return null
        dimensions = { format: 'png', width: bytes.readUInt32BE(offset + 8), height: bytes.readUInt32BE(offset + 12) }
        if (!dimensions.width || !dimensions.height || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) return null
      } else if (type === 'IHDR') return null
      if (type === 'IDAT' && length > 0) hasData = true
      if (type === 'IEND') return length === 0 && hasData && offset + 12 === bytes.length ? dimensions : null
      offset += length + 12
    }
    return null
  }
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
    let offset = 2, dimensions = null
    const frames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) return null
      while (bytes[offset] === 0xff) offset++
      const marker = bytes[offset++]
      if (marker === 0xd9) return null
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > bytes.length) return null
      const length = bytes.readUInt16BE(offset)
      if (length < 2 || offset + length > bytes.length - 2) return null
      if (frames.has(marker)) {
        if (length < 8 || length !== 8 + 3 * bytes[offset + 7]) return null
        dimensions = { format: 'jpeg', height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) }
      }
      if (marker === 0xda) return dimensions?.width && dimensions?.height && offset + length < bytes.length - 2 ? dimensions : null
      offset += length
    }
    return null
  }
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) {
    let offset = 12, dimensions = null, hasImage = false
    while (offset + 8 <= bytes.length) {
      const type = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4), start = offset + 8
      if (length > bytes.length - start) return null
      if (type === 'VP8X') {
        if (length !== 10 || (bytes[start] & 0x02)) return null // Animated community artwork is not supported.
        dimensions = { format: 'webp', width: 1 + bytes.readUIntLE(start + 4, 3), height: 1 + bytes.readUIntLE(start + 7, 3) }
      } else if (type === 'VP8 ') {
        if (length <= 10 || (bytes[start] & 1) || !bytes.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) return null
        const frame = { format: 'webp', width: bytes.readUInt16LE(start + 6) & 0x3fff, height: bytes.readUInt16LE(start + 8) & 0x3fff }
        if (dimensions && (dimensions.width !== frame.width || dimensions.height !== frame.height)) return null
        dimensions ||= frame; hasImage = true
      } else if (type === 'VP8L') {
        if (length <= 5 || bytes[start] !== 0x2f || (bytes[start + 4] >> 5) !== 0) return null
        const bits = bytes.readUInt32LE(start + 1)
        const frame = { format: 'webp', width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }
        if (dimensions && (dimensions.width !== frame.width || dimensions.height !== frame.height)) return null
        dimensions ||= frame; hasImage = true
      } else if (type === 'ANIM' || type === 'ANMF') return null
      offset = start + length + (length % 2)
    }
    return offset === bytes.length && hasImage && dimensions?.width && dimensions?.height ? dimensions : null
  }
  return null
}

export function validCommunityDimensions(info, kind) {
  if (!info || !Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height)) return false
  if (kind === 'avatar') return info.width >= 128 && info.width <= 1024 && info.width === info.height
  if (kind === 'banner') return info.width >= 400 && info.width <= 3200 && info.height >= 100 && info.height <= 800 && info.width === info.height * 4
  return false
}

export function canonicalCommunityImage(value, { kind, allowEmpty = false, allowDefault = false } = {}) {
  if ((allowEmpty && value === '') || (allowDefault && value === 'default')) return value
  if (typeof value !== 'string' || !/^\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpe?g|webp)(?:\?[^#]*)?$/i.test(value)) throw new Error('图片必须是已上传的本地 PNG、JPEG 或 WebP')
  const [pathname, query] = value.split('?')
  if (query !== undefined) {
    const params = new URLSearchParams(query)
    if ([...params.keys()].some(key => key !== 'expires' && key !== 'sig') || params.getAll('expires').length !== 1 || params.getAll('sig').length !== 1 || !/^\d+$/.test(params.get('expires')) || !/^[a-f0-9]{64}$/.test(params.get('sig'))) throw new Error('图片链接格式无效')
  }
  const filePath = path.join(uploadDir, path.basename(pathname))
  const maximumBytes = Math.min(config.maxUploadSizeMB, kind === 'avatar' ? 2 : 5) * 1024 * 1024
  let info
  try {
    const resolvedRoot = fs.realpathSync(uploadDir), resolvedFile = fs.realpathSync(filePath)
    const stat = fs.statSync(filePath)
    if (path.dirname(resolvedFile) !== resolvedRoot || !stat.isFile() || !IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase()) || stat.size > maximumBytes) throw new Error('invalid')
    info = readImageInfo(fs.readFileSync(filePath))
    if (!info || (info.format === 'jpeg' ? !/\.jpe?g$/i.test(filePath) : !filePath.toLowerCase().endsWith('.' + info.format))) throw new Error('invalid')
  } catch { throw new Error('图片文件不存在或格式无效') }
  if (!validCommunityDimensions(info, kind)) throw new Error(kind === 'avatar' ? '头像须为128–1024像素的正方形' : '横幅须为4:1，宽400–3200像素、高100–800像素')
  return pathname
}

export function serverProfile(db, server, userId) {
  const welcome = server.welcome && typeof server.welcome === 'object' ? server.welcome : {}
  const canView = hasPermission(db, userId, server.id, 'viewChannel')
  return { ...server, banner: typeof server.banner === 'string' ? server.banner : '',
    profileRevision: Number.isSafeInteger(server.profileRevision) && server.profileRevision >= 0 ? server.profileRevision : 0,
    welcome: { title: typeof welcome.title === 'string' ? welcome.title : '', message: typeof welcome.message === 'string' ? welcome.message : '', rules: typeof welcome.rules === 'string' ? welcome.rules : '',
      recommendedChannelIds: canView && Array.isArray(welcome.recommendedChannelIds) ? [...new Set(welcome.recommendedChannelIds)].filter(id => db.findChannel(id)?.serverId === server.id).slice(0, 6) : [] } }
}

export function validateServerProfile(db, server, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('社区资料格式无效')
  const updates = {}
  const text = (value, maximum, label, minimum = 0) => {
    if (typeof value !== 'string') throw new Error(`${label}须为文字`)
    const normalized = minimum ? value.trim() : value
    if (normalized.length > maximum || normalized.length < minimum) throw new Error(`${label}须为${minimum ? minimum + '-' : '不超过'}${maximum}个字符的文字`)
    return normalized
  }
  if (body.name !== undefined) updates.name = text(body.name, 50, '服务器名称', 1)
  if (body.description !== undefined) updates.description = text(body.description, 1000, '简介')
  if (body.avatar !== undefined) updates.avatar = canonicalCommunityImage(body.avatar, { kind: 'avatar', allowDefault: true })
  if (body.banner !== undefined) updates.banner = canonicalCommunityImage(body.banner, { kind: 'banner', allowEmpty: true })
  if (body.welcome !== undefined) {
    const incoming = body.welcome
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming) || Object.keys(incoming).some(key => !['title', 'message', 'rules', 'recommendedChannelIds'].includes(key))) throw new Error('欢迎页格式无效')
    updates.welcome = { ...serverProfile(db, server, server.ownerId).welcome }
    for (const [key, maximum, label] of [['title', 100, '欢迎标题'], ['message', 2000, '欢迎正文'], ['rules', 4000, '社区规则']]) {
      if (incoming[key] !== undefined) updates.welcome[key] = text(incoming[key], maximum, label)
    }
    if (incoming.recommendedChannelIds !== undefined) {
      const ids = incoming.recommendedChannelIds
      if (!Array.isArray(ids) || ids.length > 6 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || db.findChannel(id)?.serverId !== server.id)) throw new Error('推荐频道须为最多6个本社区的不同频道')
      updates.welcome.recommendedChannelIds = [...ids]
    }
  }
  return updates
}

export function pushServerProfile(db, wss, server) {
  if (!wss) return
  for (const client of wss.clients) {
    if (client.readyState !== 1 || !db.findMember(server.id, client.userId) || !hasActiveSocketSession(db, client) || !hasPermission(db, client.userId, server.id, 'viewChannel')) continue
    try { client.send(JSON.stringify({ type: 'server-updated', serverId: server.id, server: signUploadUrlsDeep(serverProfile(db, server, client.userId)) })) }
    catch (error) { logger.warn('社区资料推送失败: ' + (error?.message || error)) }
  }
}
