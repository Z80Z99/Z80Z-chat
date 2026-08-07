import { Router } from 'express'
import { authMiddleware } from '../middlewares/auth.js'
import { pushToUser, pushToAll } from '../websocket/push.js'
import { hasPermission, canManageRole } from '../utils/permissions.js'

const router = Router()

router.get('/list/:serverId', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const member = db.findMember(req.params.serverId, req.user.id)
  if (!member) return res.status(403).json({ error: '你不是该服务器成员' })

  const members = db.findMembersByServer(req.params.serverId)
  // 批量解析用户（N+1 优化）
  const userMap = db.findUsersMap(members.map(m => m.userId))
  const fullMembers = members.map(m => {
    const user = userMap.get(m.userId) || null
    return {
      ...m,
      user: user ? { id: user.id, username: user.username, nickname: user.nickname, avatar: user.avatar, status: user.status } : null
    }
  })

  res.json({ members: fullMembers })
})

router.post('/set-role', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const { serverId, userId, roleId } = req.body

  const server = db.findServer(serverId)
  if (!server) return res.status(404).json({ error: '服务器不存在' })

  if (!hasPermission(db, req.user.id, serverId, 'manageRoles')) {
    return res.status(403).json({ error: '没有管理角色的权限' })
  }

  const member = db.findMember(serverId, userId)
  if (!member) return res.status(404).json({ error: '成员不存在' })

  const role = db.findRole(roleId)
  if (!role || role.serverId !== serverId) return res.status(404).json({ error: '角色不存在' })
  // 角色层级：不能给任何人（含自己）分配高于或等于自己最高角色的角色（owner 豁免）
  if (!canManageRole(db, req.user.id, serverId, role)) {
    return res.status(403).json({ error: '没有权限分配该角色' })
  }

  if (!member.roles.includes(roleId)) {
    member.roles.push(roleId)
    db.updateMember(serverId, userId, { roles: member.roles })
  }

  res.json({ success: true })
})

router.post('/remove-role', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const { serverId, userId, roleId } = req.body

  const server = db.findServer(serverId)
  if (!server) return res.status(404).json({ error: '服务器不存在' })

  if (!hasPermission(db, req.user.id, serverId, 'manageRoles')) {
    return res.status(403).json({ error: '没有管理角色的权限' })
  }

  const member = db.findMember(serverId, userId)
  if (!member) return res.status(404).json({ error: '成员不存在' })

  const role = db.findRole(roleId)
  if (!role || role.serverId !== serverId) return res.status(404).json({ error: '角色不存在' })
  // 角色层级：不能移除高于或等于自己最高角色的角色（与 set-role 一致，owner 豁免）
  if (!canManageRole(db, req.user.id, serverId, role)) {
    return res.status(403).json({ error: '没有权限移除该角色' })
  }

  member.roles = member.roles.filter(r => r !== roleId)
  db.updateMember(serverId, userId, { roles: member.roles })

  res.json({ success: true })
})

router.post('/kick', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const { serverId, userId } = req.body

  const server = db.findServer(serverId)
  if (!server) return res.status(404).json({ error: '服务器不存在' })

  if (!hasPermission(db, req.user.id, serverId, 'kick')) {
    return res.status(403).json({ error: '没有踢人权限' })
  }

  if (server.ownerId === userId) return res.status(400).json({ error: '不能踢出群主' })

  db.deleteMember(serverId, userId)
  pushToAll(req.app.locals.wss, 'member-removed', { serverId, userId })
  pushToUser(req.app.locals.wss, userId, 'server-removed', { serverId })
  res.json({ success: true })
})

router.post('/mute', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const { serverId, userId, muted } = req.body

  const server = db.findServer(serverId)
  if (!server) return res.status(404).json({ error: '服务器不存在' })

  if (!hasPermission(db, req.user.id, serverId, 'mute')) {
    return res.status(403).json({ error: '没有禁言权限' })
  }

  db.updateMember(serverId, userId, { muted: !!muted })
  res.json({ success: true })
})

export default router
