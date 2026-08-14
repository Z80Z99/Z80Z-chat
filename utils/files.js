import fs from 'fs'
import path from 'path'
import { uploadDir } from '../config/index.js'

// 从消息的 image / file 字段提取 /uploads/ 文件名（剥离签名 query）
export function extractFileNames(message) {
  const names = new Set()
  for (const field of ['image', 'file']) {
    const url = message?.[field]
    if (typeof url === 'string' && url.startsWith('/uploads/')) {
      const name = path.basename(url.split('?')[0])
      if (name && name !== '/') names.add(name)
    }
  }
  return [...names]
}

// 数据库中是否存在其他消息引用该文件名
function isReferenced(db, fileName, excludeId = null) {
  return db.raw.messages.some(m => {
    if (excludeId && m.id === excludeId) return false
    return (typeof m.image === 'string' && m.image.includes(fileName)) ||
           (typeof m.file === 'string' && m.file.includes(fileName))
  })
}

// 删除无引用的物理文件；删除失败仅记录日志，不影响主流程
export function cleanupAttachmentFiles(db, fileNames, excludeId = null) {
  for (const name of fileNames) {
    if (isReferenced(db, name, excludeId)) continue
    try {
      fs.unlinkSync(path.join(uploadDir, name))
    } catch (e) {
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
  for (const m of db.raw.messages) {
    if (channelIds.has(m.channelId)) {
      extractFileNames(m).forEach(n => names.add(n))
    }
  }
  return [...names]
}
