import { Router } from 'express'
import { authMiddleware } from '../middlewares/auth.js'
import { now } from '../utils/helpers.js'
import { hasPermission } from '../utils/permissions.js'
import { validateMessageSend, validateMessagePayload, validateMentionEveryone, buildMessage, saveAndBroadcastMessage, broadcastToChannel } from '../utils/message.js'
import { extractFileNames, cleanupAttachmentFiles } from '../utils/files.js'

const router = Router()

router.get('/list/:channelId', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const channel = db.findChannel(req.params.channelId)
  if (!channel) return res.status(404).json({ error: '频道不存在' })

  const member = db.findMember(channel.serverId, req.user.id)
  if (!member) return res.status(403).json({ error: '你不是该服务器成员' })
  if (!hasPermission(db, req.user.id, channel.serverId, 'viewChannel')) {
    return res.status(403).json({ error: '没有查看频道的权限' })
  }

  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200)
  const before = req.query.before || null
  const messages = db.findMessagesByChannel(req.params.channelId, limit, before)

  // 批量解析作者（N+1 优化：单次遍历建 Map，避免逐条 findUser）
  const userMap = db.findUsersMap(messages.map(m => m.userId))
  const messagesWithUsers = messages.map(m => {
    const user = userMap.get(m.userId) || null
    return {
      ...m,
      user: user ? { id: user.id, username: user.username, nickname: user.nickname, avatar: user.avatar } : null
    }
  })

  res.json({ messages: messagesWithUsers.reverse() })
})

router.post('/send', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const { channelId, content, replyTo, mentions, mentionEveryone } = req.body

  const channel = db.findChannel(channelId)
  const check = validateMessageSend(db, req.user.id, channel)
  if (!check.ok) return res.status(check.status).json({ error: check.error })

  const payloadCheck = validateMessagePayload({ content, image: req.body.image, file: req.body.file })
  if (!payloadCheck.ok) return res.status(payloadCheck.status).json({ error: payloadCheck.error })

  const mentionCheck = validateMentionEveryone(db, req.user.id, channel, !!mentionEveryone)
  if (!mentionCheck.ok) return res.status(mentionCheck.status).json({ error: mentionCheck.error })

  const message = buildMessage({
    channelId,
    userId: req.user.id,
    content,
    image: req.body.image,
    file: req.body.file,
    fileName: req.body.fileName,
    replyTo,
    mentions,
    mentionEveryone
  })

  const msgWithUser = saveAndBroadcastMessage(db, req.app.locals.wss, message, req.user)
  res.json({ message: msgWithUser })
})

router.put('/:id', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const message = db.findMessage(req.params.id)
  if (!message) return res.status(404).json({ error: '消息不存在' })
  if (message.userId !== req.user.id) return res.status(403).json({ error: '只能编辑自己的消息' })

  const { content } = req.body
  if (!content) return res.status(400).json({ error: '内容不能为空' })

  const updated = db.updateMessage(req.params.id, { content, editedAt: now() })
  broadcastToChannel(req.app.locals.wss, message.channelId, {
    type: 'message-updated',
    message: updated,
    channelId: message.channelId
  })
  res.json({ message: updated })
})

router.delete('/:id', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const message = db.findMessage(req.params.id)
  if (!message) return res.status(404).json({ error: '消息不存在' })

  if (message.userId !== req.user.id) {
    const channel = db.findChannel(message.channelId)
    if (!channel) return res.status(404).json({ error: '频道不存在' })
    if (!hasPermission(db, req.user.id, channel.serverId, 'manageMessages')) {
      return res.status(403).json({ error: '没有权限删除此消息' })
    }
  }

  const channelId = message.channelId
  const files = extractFileNames(message)
  db.deleteMessage(req.params.id)
  broadcastToChannel(req.app.locals.wss, channelId, {
    type: 'message-deleted',
    messageId: req.params.id,
    channelId
  })
  // 附件清理：先删消息记录，再检查引用并删除无引用文件（失败不影响消息删除）
  cleanupAttachmentFiles(db, files)
  res.json({ success: true })
})

export default router
