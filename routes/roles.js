import { Router } from 'express'
import { authMiddleware } from '../middlewares/auth.js'
import { genId } from '../utils/helpers.js'
import { hasPermission, canManageRole } from '../utils/permissions.js'

const router = Router()

router.post('/create', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const { serverId, name, color, permissions } = req.body

  const server = db.findServer(serverId)
  if (!server) return res.status(404).json({ error: '服务器不存在' })
  if (!hasPermission(db, req.user.id, serverId, 'manageRoles')) {
    return res.status(403).json({ error: '没有管理角色的权限' })
  }

  const existing = db.findRolesByServer(serverId)
  const role = {
    id: genId(),
    serverId,
    name: name || '新角色',
    color: color || '#99aab5',
    permissions: permissions || {
      viewChannel: false,
      sendMessage: false,
      uploadFile: false,
      mentionEveryone: false,
      manageChannels: false,
      manageRoles: false,
      manageMessages: false,
      kick: false,
      mute: false,
      manageServer: false
    },
    position: existing.length,
    isDefault: false
  }
  db.createRole(role)
  res.json({ role })
})

router.get('/list/:serverId', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const member = db.findMember(req.params.serverId, req.user.id)
  if (!member) return res.status(403).json({ error: '你不是该服务器成员' })

  const roles = db.findRolesByServer(req.params.serverId)
  res.json({ roles })
})

router.put('/:id', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const role = db.findRole(req.params.id)
  if (!role) return res.status(404).json({ error: '角色不存在' })
  if (role.isDefault) return res.status(400).json({ error: '不能修改@everyone角色' })

  const server = db.findServer(role.serverId)
  if (!server) return res.status(404).json({ error: '服务器不存在' })
  if (server.ownerId !== req.user.id && !hasPermission(db, req.user.id, role.serverId, 'manageRoles')) {
    return res.status(403).json({ error: '没有管理角色的权限' })
  }
  // 角色层级：只能修改 position 低于自己的角色（owner 豁免）
  if (!canManageRole(db, req.user.id, role.serverId, role)) {
    return res.status(403).json({ error: '没有权限操作该角色' })
  }

  const updates = {}
  if (req.body.name !== undefined) updates.name = req.body.name
  if (req.body.color !== undefined) updates.color = req.body.color
  if (req.body.permissions !== undefined) updates.permissions = req.body.permissions
  const updated = db.updateRole(req.params.id, updates)
  res.json({ role: updated })
})

router.delete('/:id', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const role = db.findRole(req.params.id)
  if (!role) return res.status(404).json({ error: '角色不存在' })
  if (role.isDefault) return res.status(400).json({ error: '不能删除@everyone角色' })

  const server = db.findServer(role.serverId)
  if (!server) return res.status(404).json({ error: '服务器不存在' })
  if (server.ownerId !== req.user.id && !hasPermission(db, req.user.id, role.serverId, 'manageRoles')) {
    return res.status(403).json({ error: '没有管理角色的权限' })
  }
  // 角色层级：不能删除高于或等于自己的角色（owner 豁免）
  if (!canManageRole(db, req.user.id, role.serverId, role)) {
    return res.status(403).json({ error: '没有权限操作该角色' })
  }

  db.deleteRole(req.params.id)
  res.json({ success: true })
})

export default router
