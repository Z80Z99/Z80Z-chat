import { Router } from 'express'
import { authMiddleware } from '../middlewares/auth.js'
import { genId, now, genCode } from '../utils/helpers.js'
import { pushToUser, pushToAll } from '../websocket/push.js'
import { hasPermission } from '../utils/permissions.js'

const router = Router()

router.post('/create', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const { serverId, maxUses, expiresInHours } = req.body

  const server = db.findServer(serverId)
  if (!server) return res.status(404).json({ error: '服务器不存在' })
  if (server.ownerId !== req.user.id && !hasPermission(db, req.user.id, serverId, 'manageServer')) {
    return res.status(403).json({ error: '没有管理服务器的权限' })
  }

  const invite = {
    id: genId(),
    code: genCode(10),
    serverId,
    creatorId: req.user.id,
    maxUses: maxUses || null,
    uses: 0,
    expiresAt: expiresInHours ? new Date(Date.now() + expiresInHours * 3600000).toISOString() : null,
    createdAt: now()
  }
  db.createInvite(invite)
  res.json({ invite })
})

router.post('/friend', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const { serverId, userId } = req.body
  if (!serverId || !userId) return res.status(400).json({ error: '参数错误' })

  const server = db.findServer(serverId)
  if (!server) return res.status(404).json({ error: '服务器不存在' })

  const inviterMember = db.findMember(serverId, req.user.id)
  if (!inviterMember) return res.status(403).json({ error: '你不是该服务器成员' })

  const target = db.findUser(userId)
  if (!target) return res.status(404).json({ error: '用户不存在' })

  const friendRel = db.findFriend(req.user.id, userId)
  if (!friendRel || friendRel.status !== 'accepted') {
    return res.status(400).json({ error: '对方不是你的好友' })
  }

  const existingMember = db.findMember(serverId, userId)
  if (existingMember) return res.status(400).json({ error: '对方已在此服务器中' })

  db.createMember({ serverId, userId, roles: [], invitedBy: req.user.id, joinedAt: now() })
  pushToUser(req.app.locals.wss, userId, 'server-added', { serverId })
  pushToAll(req.app.locals.wss, 'member-added', { serverId, userId })
  res.json({ success: true })
})

router.get('/list/:serverId', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const member = db.findMember(req.params.serverId, req.user.id)
  if (!member) return res.status(403).json({ error: '你不是该服务器成员' })

  // 脱敏：仅 owner / manageServer 权限可见完整 code，普通成员隐藏
  const canViewCodes = hasPermission(db, req.user.id, req.params.serverId, 'manageServer')
  const invites = db.findInvitesByServer(req.params.serverId).map(inv => {
    if (canViewCodes) return inv
    const { code, ...rest } = inv
    return { ...rest, code: null }
  })
  res.json({ invites })
})

router.delete('/:id', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const invite = db.findInviteById(req.params.id)
  if (!invite) return res.status(404).json({ error: '邀请码不存在' })

  const server = db.findServer(invite.serverId)
  if (!server) return res.status(404).json({ error: '服务器不存在' })
  if (server.ownerId !== req.user.id && !hasPermission(db, req.user.id, invite.serverId, 'manageServer')) {
    return res.status(403).json({ error: '没有权限' })
  }

  db.deleteInvite(req.params.id)
  res.json({ success: true })
})

export default router
