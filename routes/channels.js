import { Router } from 'express'
import { authMiddleware } from '../middlewares/auth.js'
import { genId } from '../utils/helpers.js'
import { hasPermission } from '../utils/permissions.js'
import { collectChannelFiles, cleanupAttachmentFiles } from '../utils/files.js'
import { hasActiveSocketSession } from '../utils/ws-session.js'
import { logger } from '../utils/logger.js'

const router = Router()
const CHANNEL_TYPES = ['text', 'voice', 'announcement']

function channelName(value) {
  if (typeof value !== 'string' || !value.trim() || Array.from(value.trim()).length > 50) return null
  return value.trim().toLowerCase().replace(/\s+/g, '-')
}

function validCategory(db, serverId, categoryId) {
  return categoryId === null || (typeof categoryId === 'string' && db.findCategory(categoryId)?.serverId === serverId)
}

function pushChannelEvent(req, type, channel, extra = {}) {
  const db = req.app.locals.db, wss = req.app.locals.wss
  if (!wss) return
  const payload = { type, serverId: channel.serverId, ...extra }
  if (type !== 'channel-deleted') payload.channel = channel
  const event = JSON.stringify(payload)
  for (const client of wss.clients) {
    if (client.readyState !== 1 || !hasActiveSocketSession(db, client) ||
        !db.findMember(channel.serverId, client.userId) ||
        !hasPermission(db, client.userId, channel.serverId, 'viewChannel')) continue
    try { client.send(event) } catch (error) { logger.warn('频道更新推送失败: ' + (error?.message || error)) }
  }
}

function saveChannelChange(db, res, mutate) {
  // All mutations here are synchronous; restore records before another request or deferred flush runs.
  const fields = ['channels', 'messages', 'readStates', 'notificationPreferences', 'readStateRevision']
  const snapshot = Object.fromEntries(fields.map(field => [field, db.raw[field]]))
  const channelRecords = db.raw.channels.map(channel => [channel, { ...channel }])
  try { const result = mutate(); db.save(); return result }
  catch (error) {
    for (const field of fields) {
      if (snapshot[field] === undefined) delete db.raw[field]
      else db.raw[field] = snapshot[field]
    }
    for (const [channel, original] of channelRecords) {
      for (const field of Object.keys(channel)) if (!(field in original)) delete channel[field]
      Object.assign(channel, original)
    }
    logger.error('频道更新保存失败: ' + (error?.message || error))
    res.status(500).json({ error: '频道更新保存失败，请重试' })
    return null
  }
}

router.post('/create', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const { serverId, categoryId, name, type } = req.body

  const server = db.findServer(serverId)
  if (!server) return res.status(404).json({ error: '服务器不存在' })
  if (server.ownerId !== req.user.id && !hasPermission(db, req.user.id, serverId, 'manageChannels')) {
    return res.status(403).json({ error: '没有管理频道的权限' })
  }

  const normalizedName = channelName(name)
  if (!normalizedName) return res.status(400).json({ error: '频道名称必须为 1 到 50 个字符' })
  const channelType = type === undefined ? 'text' : type
  if (!CHANNEL_TYPES.includes(channelType)) return res.status(400).json({ error: '频道类型必须为 text、voice 或 announcement' })
  const category = categoryId === undefined ? null : categoryId
  if (!validCategory(db, serverId, category)) return res.status(400).json({ error: '所属分组不在当前服务器' })

  const existing = db.findChannelsByServer(serverId)
  const channel = {
    id: genId(),
    serverId,
    categoryId: category,
    name: normalizedName,
    type: channelType,
    position: existing.length,
    permissions: {},
    revision: 1
  }
  // createChannel pushes into the current array, so use a new array to preserve rollback's snapshot.
  const saved = saveChannelChange(db, res, () => { db.raw.channels = [...db.raw.channels]; return db.createChannel(channel) })
  if (!saved) return
  pushChannelEvent(req, 'channel-created', saved)
  res.json({ channel })
})

router.get('/list/:serverId', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const member = db.findMember(req.params.serverId, req.user.id)
  if (!member) return res.status(403).json({ error: '你不是该服务器成员' })

  // 过滤无 viewChannel 权限的频道（owner 由 hasPermission 豁免，可见全部）
  const channels = db.findChannelsByServer(req.params.serverId)
    .filter(ch => hasPermission(db, req.user.id, req.params.serverId, 'viewChannel'))
  res.json({ channels })
})

router.put('/:id', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const channel = db.findChannel(req.params.id)
  if (!channel) return res.status(404).json({ error: '频道不存在' })

  const server = db.findServer(channel.serverId)
  if (!server) return res.status(404).json({ error: '服务器不存在' })
  if (server.ownerId !== req.user.id && !hasPermission(db, req.user.id, channel.serverId, 'manageChannels')) {
    return res.status(403).json({ error: '没有管理频道的权限' })
  }

  const { name, categoryId, position, permissions, type } = req.body
  if (type !== undefined && type !== channel.type) return res.status(400).json({ error: '现有频道不能转换类型，请新建频道' })
  const updates = {}
  if (name !== undefined) {
    updates.name = channelName(name)
    if (!updates.name) return res.status(400).json({ error: '频道名称必须为 1 到 50 个字符' })
  }
  if (categoryId !== undefined) {
    if (!validCategory(db, channel.serverId, categoryId)) return res.status(400).json({ error: '所属分组不在当前服务器' })
    updates.categoryId = categoryId
  }
  if (position !== undefined) {
    if (!Number.isSafeInteger(position) || position < 0) return res.status(400).json({ error: '频道位置必须为非负整数' })
    updates.position = position
  }
  if (permissions !== undefined) {
    if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return res.status(400).json({ error: '频道权限格式无效' })
    updates.permissions = permissions
  }
  const revision = Number.isSafeInteger(channel.revision) && channel.revision >= 0 ? channel.revision : 0
  if (revision >= Number.MAX_SAFE_INTEGER) return res.status(400).json({ error: '频道版本已超出可用范围' })
  updates.revision = revision + 1

  const updated = saveChannelChange(db, res, () => db.updateChannel(req.params.id, updates))
  if (!updated) return
  pushChannelEvent(req, 'channel-updated', updated)
  res.json({ channel: updated })
})

router.delete('/:id', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const channel = db.findChannel(req.params.id)
  if (!channel) return res.status(404).json({ error: '频道不存在' })

  const server = db.findServer(channel.serverId)
  if (!server) return res.status(404).json({ error: '服务器不存在' })
  if (server.ownerId !== req.user.id && !hasPermission(db, req.user.id, channel.serverId, 'manageChannels')) {
    return res.status(403).json({ error: '没有管理频道的权限' })
  }

  const files = collectChannelFiles(db, req.params.id)
  const deleted = saveChannelChange(db, res, () => { db.deleteChannel(req.params.id); return channel })
  if (!deleted) return
  pushChannelEvent(req, 'channel-deleted', channel, { channelId: channel.id })
  cleanupAttachmentFiles(db, files)
  res.json({ success: true })
})

export default router
