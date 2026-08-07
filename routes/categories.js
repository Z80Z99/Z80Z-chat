import { Router } from 'express'
import { authMiddleware } from '../middlewares/auth.js'
import { genId } from '../utils/helpers.js'
import { hasPermission } from '../utils/permissions.js'

const router = Router()

router.post('/create', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const { serverId, name } = req.body

  const server = db.findServer(serverId)
  if (!server) return res.status(404).json({ error: '服务器不存在' })
  if (server.ownerId !== req.user.id && !hasPermission(db, req.user.id, serverId, 'manageChannels')) {
    return res.status(403).json({ error: '没有管理频道的权限' })
  }
  if (!name || !name.trim()) return res.status(400).json({ error: '分组名称不能为空' })

  const cat = {
    id: genId(),
    serverId,
    name: name.trim(),
    position: db.findCategoriesByServer(serverId).length
  }
  db.createCategory(cat)
  res.json({ category: cat })
})

router.put('/:id', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const cat = db.findCategory(req.params.id)
  if (!cat) return res.status(404).json({ error: '分组不存在' })

  const server = db.findServer(cat.serverId)
  if (!server) return res.status(404).json({ error: '服务器不存在' })
  if (server.ownerId !== req.user.id && !hasPermission(db, req.user.id, cat.serverId, 'manageChannels')) {
    return res.status(403).json({ error: '没有管理频道的权限' })
  }

  const { name } = req.body
  if (name === undefined || !name.trim()) {
    return res.status(400).json({ error: '分组名称不能为空' })
  }

  const updated = db.updateCategory(req.params.id, { name: name.trim() })
  res.json({ category: updated })
})

router.delete('/:id', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const cat = db.findCategory(req.params.id)
  if (!cat) return res.status(404).json({ error: '分组不存在' })

  const server = db.findServer(cat.serverId)
  if (!server) return res.status(404).json({ error: '服务器不存在' })
  if (server.ownerId !== req.user.id && !hasPermission(db, req.user.id, cat.serverId, 'manageChannels')) {
    return res.status(403).json({ error: '没有管理频道的权限' })
  }

  const channels = db.findChannelsByCategory(cat.id)
  channels.forEach(ch => db.updateChannel(ch.id, { categoryId: null }))
  db.deleteCategory(req.params.id)
  res.json({ success: true })
})

export default router
