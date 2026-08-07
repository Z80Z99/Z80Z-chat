import { Router } from 'express'
import { authMiddleware } from '../middlewares/auth.js'
import { genId } from '../utils/helpers.js'
import { hasPermission } from '../utils/permissions.js'
import { collectChannelFiles, cleanupAttachmentFiles } from '../utils/files.js'

const router = Router()

router.post('/create', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const { serverId, categoryId, name, type } = req.body

  const server = db.findServer(serverId)
  if (!server) return res.status(404).json({ error: '服务器不存在' })
  if (server.ownerId !== req.user.id && !hasPermission(db, req.user.id, serverId, 'manageChannels')) {
    return res.status(403).json({ error: '没有管理频道的权限' })
  }

  if (!name || name.length < 1) {
    return res.status(400).json({ error: '频道名称不能为空' })
  }

  const existing = db.findChannelsByServer(serverId)
  const channel = {
    id: genId(),
    serverId,
    categoryId: categoryId || null,
    name: name.toLowerCase().replace(/\s+/g, '-'),
    type: type || 'text',
    position: existing.length,
    permissions: {}
  }
  db.createChannel(channel)
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
  if (server.ownerId !== req.user.id && !hasPermission(db, req.user.id, channel.serverId, 'manageChannels')) {
    return res.status(403).json({ error: '没有管理频道的权限' })
  }

  const { name, categoryId, position, permissions } = req.body
  const updates = {}
  if (name !== undefined) updates.name = name.toLowerCase().replace(/\s+/g, '-')
  if (categoryId !== undefined) updates.categoryId = categoryId
  if (position !== undefined) updates.position = position
  if (permissions !== undefined) updates.permissions = permissions

  const updated = db.updateChannel(req.params.id, updates)
  res.json({ channel: updated })
})

router.delete('/:id', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const channel = db.findChannel(req.params.id)
  if (!channel) return res.status(404).json({ error: '频道不存在' })

  const server = db.findServer(channel.serverId)
  if (server.ownerId !== req.user.id && !hasPermission(db, req.user.id, channel.serverId, 'manageChannels')) {
    return res.status(403).json({ error: '没有管理频道的权限' })
  }

  const files = collectChannelFiles(db, req.params.id)
  db.deleteChannel(req.params.id)
  cleanupAttachmentFiles(db, files)
  res.json({ success: true })
})

export default router
