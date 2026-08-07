import { Router } from 'express'
import { authMiddleware } from '../middlewares/auth.js'
import { genId, now } from '../utils/helpers.js'
import { pushToUser, pushToAll } from '../websocket/push.js'
import { collectServerFiles, cleanupAttachmentFiles } from '../utils/files.js'

const router = Router()

router.post('/create', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const { name, description, avatar } = req.body
  if (!name || name.length < 1 || name.length > 50) {
    return res.status(400).json({ error: '服务器名称1-50个字符' })
  }

  const serverId = genId()
  const server = {
    id: serverId,
    name,
    avatar: avatar || 'default',
    description: description || '',
    ownerId: req.user.id,
    createdAt: now()
  }
  db.createServer(server)

  db.createMember({ serverId, userId: req.user.id, roles: [], joinedAt: now() })

  const everyoneRole = {
    id: genId(),
    serverId,
    name: '@everyone',
    color: '#99aab5',
    permissions: {
      viewChannel: true,
      sendMessage: true,
      uploadFile: true,
      mentionEveryone: false,
      manageChannels: false,
      manageRoles: false,
      manageMessages: false,
      kick: false,
      mute: false,
      manageServer: false
    },
    position: 0,
    isDefault: true
  }
  db.createRole(everyoneRole)

  const generalCategory = {
    id: genId(),
    serverId,
    name: '文字频道',
    position: 0
  }
  db.createCategory(generalCategory)

  const generalChannel = {
    id: genId(),
    serverId,
    categoryId: generalCategory.id,
    name: '一般聊天',
    type: 'text',
    position: 0,
    permissions: {}
  }
  db.createChannel(generalChannel)

  const voiceCategory = {
    id: genId(),
    serverId,
    name: '语音频道',
    position: 1
  }
  db.createCategory(voiceCategory)

  const voiceChannel = {
    id: genId(),
    serverId,
    categoryId: voiceCategory.id,
    name: '一般语音',
    type: 'voice',
    position: 0,
    permissions: {}
  }
  db.createChannel(voiceChannel)

  res.json({ server })
})

router.get('/list', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const memberships = db.findMembersByUser(req.user.id)
  const serverIds = memberships.map(m => m.serverId)
  const servers = db.findAllServers().filter(s => serverIds.includes(s.id))
  res.json({ servers })
})

router.get('/:id', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const server = db.findServer(req.params.id)
  if (!server) return res.status(404).json({ error: '服务器不存在' })
  const member = db.findMember(req.params.id, req.user.id)
  if (!member) return res.status(403).json({ error: '你不是该服务器成员' })

  const categories = db.findCategoriesByServer(req.params.id)
  const channels = db.findChannelsByServer(req.params.id)
  const roles = db.findRolesByServer(req.params.id)
  const members = db.findMembersByServer(req.params.id)
  // 批量解析用户（N+1 优化）
  const userMap = db.findUsersMap(members.map(m => m.userId))
  const fullMembers = members.map(m => {
    const user = userMap.get(m.userId) || null
    return { ...m, user: user ? { id: user.id, username: user.username, nickname: user.nickname, avatar: user.avatar, status: user.status } : null }
  })

  res.json({ server, categories, channels, roles, members: fullMembers })
})

router.put('/:id', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const server = db.findServer(req.params.id)
  if (!server) return res.status(404).json({ error: '服务器不存在' })
  if (server.ownerId !== req.user.id) return res.status(403).json({ error: '只有群主可修改' })

  const { name, description, avatar } = req.body
  const updates = {}
  if (name !== undefined) {
    if (name.length < 1 || name.length > 50) return res.status(400).json({ error: '服务器名称1-50个字符' })
    updates.name = name
  }
  if (description !== undefined) updates.description = description
  if (avatar !== undefined) updates.avatar = avatar

  const updated = db.updateServer(req.params.id, updates)
  res.json({ server: updated })
})

router.post('/transfer/:id', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const server = db.findServer(req.params.id)
  if (!server) return res.status(404).json({ error: '服务器不存在' })
  if (server.ownerId !== req.user.id) return res.status(403).json({ error: '只有群主可转让' })

  const { userId } = req.body
  const member = db.findMember(req.params.id, userId)
  if (!member) return res.status(400).json({ error: '目标用户不是成员' })

  db.updateServer(req.params.id, { ownerId: userId })
  res.json({ success: true })
})

router.delete('/:id', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const server = db.findServer(req.params.id)
  if (!server) return res.status(404).json({ error: '服务器不存在' })
  if (server.ownerId !== req.user.id) return res.status(403).json({ error: '只有群主可解散' })

  const files = collectServerFiles(db, req.params.id)
  db.deleteServer(req.params.id)
  pushToAll(req.app.locals.wss, 'server-deleted', { serverId: req.params.id })
  cleanupAttachmentFiles(db, files)
  res.json({ success: true })
})

router.post('/join', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const { code } = req.body
  if (!code) return res.status(400).json({ error: '邀请码不能为空' })

  const invite = db.findInvite(code)
  if (!invite) return res.status(404).json({ error: '邀请码无效' })

  if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
    return res.status(400).json({ error: '邀请码已过期' })
  }

  if (invite.maxUses && invite.uses >= invite.maxUses) {
    return res.status(400).json({ error: '邀请码已达使用上限' })
  }

  const existingMember = db.findMember(invite.serverId, req.user.id)
  if (existingMember) return res.status(400).json({ error: '你已在此服务器中' })

  db.createMember({ serverId: invite.serverId, userId: req.user.id, roles: [], joinedAt: now() })
  db.updateInvite(invite.id, { uses: invite.uses + 1 })
  pushToAll(req.app.locals.wss, 'member-added', { serverId: invite.serverId, userId: req.user.id })

  res.json({ serverId: invite.serverId })
})

router.post('/leave/:id', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const server = db.findServer(req.params.id)
  if (!server) return res.status(404).json({ error: '服务器不存在' })
  if (server.ownerId === req.user.id) return res.status(400).json({ error: '群主不能退出，请先转让' })

  db.deleteMember(req.params.id, req.user.id)
  pushToAll(req.app.locals.wss, 'member-removed', { serverId: req.params.id, userId: req.user.id })
  pushToUser(req.app.locals.wss, req.user.id, 'server-removed', { serverId: req.params.id })
  res.json({ success: true })
})

export default router
