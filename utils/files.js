import fs from 'fs'
import path from 'path'
import { uploadDir } from '../config/index.js'

// 从消息的 image / file 字段提取 /uploads/ 文件名（剥离签名 query）
function localFileName(url) {
  if (typeof url !== 'string') return null
  const pathname = url.split(/[?#]/, 1)[0]
  return /^\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pathname) ? pathname.slice('/uploads/'.length) : null
}

export function extractFileNames(message) {
  const names = new Set()
  for (const field of ['image', 'file']) {
    const url = message?.[field]
    const name = localFileName(url)
    if (name) names.add(name)
  }
  return [...names]
}

// 消息、用户头像和社区图片的所有引用共同保护文件。
function isReferenced(db, fileName, excludeId = null) {
  return db.raw.messages.some(m => {
    if (excludeId && m.id === excludeId) return false
    return extractFileNames(m).includes(fileName)
  }) || db.raw.servers.some(server => [server.avatar, server.banner].some(url => localFileName(url) === fileName)) || db.raw.users.some(user => localFileName(user.avatar) === fileName)
}

// 删除无引用的物理文件；删除失败仅记录日志，不影响主流程
export function cleanupAttachmentFiles(db, fileNames, excludeId = null) {
  for (const name of fileNames) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) continue
    if (isReferenced(db, name, excludeId)) continue
    try {
      fs.unlinkSync(path.join(uploadDir, name))
    } catch (e) {
      if (e?.code === 'ENOENT') continue
      console.error(`  [files] 删除附件文件失败 ${name}:`, e?.message || e)
    }
  }
}

// 收集某频道的全部消息附件文件名
export function collectChannelFiles(db, channelId) {
  const names = new Set()
  for (const m of db.raw.messages) {
    if (m.channelId === channelId) {
      extractFileNames(m).forEach(n => names.add(n))
    }
  }
  return [...names]
}

// 收集某服务器的全部消息附件文件名
export function collectServerFiles(db, serverId) {
  const channelIds = new Set(
    db.raw.channels.filter(c => c.serverId === serverId).map(c => c.id)
  )
  const names = new Set()
  const server = db.findServer(serverId)
  for (const url of [server?.avatar, server?.banner]) {
    const name = localFileName(url)
    if (name) names.add(name)
  }
  for (const m of db.raw.messages) {
    if (channelIds.has(m.channelId)) {
      extractFileNames(m).forEach(n => names.add(n))
    }
  }
  return [...names]
}
