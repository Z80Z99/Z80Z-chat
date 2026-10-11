import { Router } from 'express'
import { authMiddleware } from '../middlewares/auth.js'
import { genId, now } from '../utils/helpers.js'
import { pushToUser, pushToAll } from '../websocket/push.js'
import { collectServerFiles, cleanupAttachmentFiles, extractFileNames } from '../utils/files.js'
import { hasPermission } from '../utils/permissions.js'
import { serverProfile, validateServerProfile, pushServerProfile } from '../utils/server-profile.js'
import { logger } from '../utils/logger.js'

const router = Router()

router.post('/create', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const serverId = genId()
  let fields
  try {
    fields = validateServerProfile(db, { id: serverId, ownerId: req.user.id }, req.body)
    if (!fields.name) throw new Error('服务器名称1-50个字符')
  } catch (error) { return res.status(400).json({ error: error.message }) }
  const server = {
    id: serverId,
    name: fields.name,
    avatar: fields.avatar || 'default',
    description: fields.description || '',
    banner: fields.banner || '',
    welcome: fields.welcome || { title: '', message: '', rules: '', recommendedChannelIds: [] },
    profileRevision: 0,
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

  res.json({ server: serverProfile(db, server, req.user.id) })
})

router.get('/list', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const memberships = db.findMembersByUser(req.user.id)
  const serverIds = memberships.map(m => m.serverId)
  const servers = db.findAllServers().filter(s => serverIds.includes(s.id))
  res.json({ servers: servers.map(server => serverProfile(db, server, req.user.id)) })
})

router.get('/:id', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const server = db.findServer(req.params.id)
  if (!server) return res.status(404).json({ error: '服务器不存在' })
  const member = db.findMember(req.params.id, req.user.id)
  if (!member) return res.status(403).json({ error: '你不是该服务器成员' })

  const categories = db.findCategoriesByServer(req.params.id)
  const channels = db.findChannelsByServer(req.params.id).filter(() => hasPermission(db, req.user.id, req.params.id, 'viewChannel'))
  const roles = db.findRolesByServer(req.params.id)
  const members = db.findMembersByServer(req.params.id)
  // 批量解析用户（N+1 优化）
  const userMap = db.findUsersMap(members.map(m => m.userId))
  const fullMembers = members.map(m => {
    const user = userMap.get(m.userId) || null
    return { ...m, user: user ? { id: user.id, username: user.username, nickname: user.nickname, avatar: user.avatar, status: user.status } : null }
  })

  res.json({ server: serverProfile(db, server, req.user.id), categories, channels, roles, members: fullMembers })
})

router.put('/:id', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const server = db.findServer(req.params.id)
  if (!server) return res.status(404).json({ error: '服务器不存在' })
  if (server.ownerId !== req.user.id && (!db.findMember(server.id, req.user.id) || !hasPermission(db, req.user.id, server.id, 'manageServer'))) return res.status(403).json({ error: '没有管理社区的权限' })
  const revision = serverProfile(db, server, req.user.id).profileRevision
  if (req.body?.expectedRevision !== undefined) {
    if (!Number.isSafeInteger(req.body.expectedRevision) || req.body.expectedRevision < 0) return res.status(400).json({ error: '社区资料版本格式无效' })
    if (req.body.expectedRevision !== revision) return res.status(409).json({ error: '社区资料已更新，请重新加载后再保存' })
  }
  let updates
  try { updates = validateServerProfile(db, server, req.body) }
  catch (error) { return res.status(400).json({ error: error.message }) }
  if (Object.keys(updates).length === 0) return res.json({ server: serverProfile(db, server, req.user.id) })
  if (revision >= Number.MAX_SAFE_INTEGER) return res.status(409).json({ error: '社区资料版本已超出可用范围' })
  const previous = { ...server }
  const oldFiles = extractFileNames({ image: server.avatar, file: server.banner })
  try {
    db.updateServer(server.id, { ...updates, profileRevision: revision + 1 })
    db.save()
  } catch (error) {
    for (const key of Object.keys(server)) delete server[key]
    Object.assign(server, previous)
    logger.error('社区资料保存失败，已恢复原资料: ' + (error?.message || error))
    return res.status(500).json({ error: '社区资料保存失败，请重试' })
  }
  pushServerProfile(db, req.app.locals.wss, server)
  cleanupAttachmentFiles(db, oldFiles)
  res.json({ server: serverProfile(db, server, req.user.id) })
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
