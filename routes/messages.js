import { Router } from 'express'
import { authMiddleware } from '../middlewares/auth.js'
import { now } from '../utils/helpers.js'
import { hasPermission } from '../utils/permissions.js'
import { submitMessage, broadcastToChannel, validateMessageSend } from '../utils/message.js'
import { extractFileNames, cleanupAttachmentFiles } from '../utils/files.js'
import { notifyChannelReadStates } from '../utils/read-state.js'
import { MESSAGE_REACTIONS, normalizeReactions, messagesWithUsers } from '../utils/message-records.js'
import { createMessageSearchRateLimiter } from '../utils/message-search-rate.js'
import { logger } from '../utils/logger.js'
import { validateMentions, invalidateMention } from '../utils/mentions.js'

const router = Router()
const searchLimiters = new WeakMap()

function accessibleChannel(db, userId, channelId, res) {
  const channel = db.findChannel(channelId)
  if (!channel) { res.status(404).json({ error: '频道不存在' }); return null }
  if (!db.findMember(channel.serverId, userId)) { res.status(403).json({ error: '你不是该服务器成员' }); return null }
  if (!hasPermission(db, userId, channel.serverId, 'viewChannel')) {
    res.status(403).json({ error: '没有查看频道的权限' }); return null
  }
  return channel
}

function accessibleMessage(req, res) {
  const db = req.app.locals.db
  const message = db.findMessage(req.params.id)
  if (!message) { res.status(404).json({ error: '消息不存在' }); return null }
  const channel = accessibleChannel(db, req.user.id, message.channelId, res)
  return channel ? { message, channel } : null
}

function windowLimit(value, res) {
  if (value === undefined) return 50
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 50) {
    res.status(400).json({ error: 'limit 必须为 1 到 50 的整数' }); return null
  }
  return Number(value)
}

// Updates are synchronous: restore only this record if its durable write fails, before another request can run.
function saveMessageUpdate(req, res, message, fields) {
  const db = req.app.locals.db
  const snapshot = { ...message }
  try {
    if (fields) db.updateMessage(message.id, fields)
    db.save()
  } catch (error) {
    for (const field of Object.keys(message)) if (!(field in snapshot)) delete message[field]
    Object.assign(message, snapshot)
    logger.error('消息更新保存失败: ' + (error?.message || error))
    res.status(500).json({ error: '消息更新保存失败，请重试' })
    return
  }
  const updated = messagesWithUsers(db, [message])[0]
  if (fields) broadcastToChannel(db, req.app.locals.wss, message.channelId, {
    type: 'message-updated', message: updated, channelId: message.channelId
  })
  if (fields && Object.hasOwn(fields, 'content')) {
    notifyChannelReadStates(db, req.app.locals.wss, message.channelId)
    invalidateMention(db, req.app.locals.wss, message)
  }
  res.json({ message: updated })
}

router.get('/list/:channelId', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  if (!accessibleChannel(db, req.user.id, req.params.channelId, res)) return

  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200)
  const before = req.query.before || null
  const messages = db.findMessagesByChannel(req.params.channelId, limit, before)

  res.json({ messages: messagesWithUsers(db, messages).reverse() })
})

router.get('/pins/:channelId', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  if (!accessibleChannel(db, req.user.id, req.params.channelId, res)) return
  res.json({ pins: messagesWithUsers(db, db.findPinnedMessages(req.params.channelId)) })
})

router.get('/search/:channelId', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  if (!accessibleChannel(db, req.user.id, req.params.channelId, res)) return
  if (!searchLimiters.has(db)) searchLimiters.set(db, createMessageSearchRateLimiter())
  const budget = searchLimiters.get(db)(req.user.id)
  if (!budget.allowed) return res.set('Retry-After', String(budget.retryAfter)).status(429).json({ error: '搜索过于频繁，请稍后重试' })
  const { q, authorId, before } = req.query
  if (q !== undefined && (typeof q !== 'string' || Array.from(q.trim()).length > 100)) {
    return res.status(400).json({ error: '搜索文字必须为最多 100 个字符的字符串' })
  }
  if (authorId !== undefined && (typeof authorId !== 'string' || !authorId || authorId.length > 128 || !db.findUser(authorId))) {
    return res.status(400).json({ error: '作者无效' })
  }
  const query = (q || '').trim()
  if (!query && !authorId) return res.status(400).json({ error: '请输入搜索文字或选择作者' })
  if (before !== undefined && (typeof before !== 'string' || !before || before.length > 128 || db.findMessage(before)?.channelId !== req.params.channelId)) {
    return res.status(400).json({ error: '搜索游标无效，请重新搜索' })
  }
  const limit = windowLimit(req.query.limit, res)
  if (limit === null) return
  const result = db.searchMessages(req.params.channelId, { q: query, authorId, before, limit })
  res.json({ ...result, messages: messagesWithUsers(db, result.messages) })
})

router.get('/context/:channelId/:messageId', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  if (!accessibleChannel(db, req.user.id, req.params.channelId, res)) return
  const limit = windowLimit(req.query.limit, res)
  if (limit === null) return
  const result = db.findMessageContext(req.params.channelId, req.params.messageId, limit)
  if (!result) return res.status(404).json({ error: '消息不存在或已删除' })
  res.json({ ...result, messages: messagesWithUsers(db, result.messages) })
})

router.post('/send', authMiddleware, (req, res) => {
  const result = submitMessage(req.app.locals.db, req.app.locals.wss, req.user, req.body)
  if (!result.ok) return res.status(result.status).json({ error: result.error, clientMessageId: req.body.clientMessageId })
  res.json({ message: result.message })
})

router.put('/:id/reactions', authMiddleware, (req, res) => {
  const found = accessibleMessage(req, res)
  if (!found) return
  const db = req.app.locals.db
  const permission = validateMessageSend(db, req.user.id, found.channel, { publishing: false })
  if (!permission.ok) return res.status(permission.status).json({ error: permission.error })
  const { emoji, active } = req.body || {}
  if (!MESSAGE_REACTIONS.includes(emoji) || typeof active !== 'boolean') {
    return res.status(400).json({ error: '回应表情或 active 格式无效' })
  }
  const reactions = normalizeReactions(found.message.reactions)
  const reaction = reactions.find(item => item.emoji === emoji)
  const present = !!reaction?.userIds.includes(req.user.id)
  if (active !== present) {
    if (active) {
      if (reaction) reaction.userIds.push(req.user.id)
      else reactions.push({ emoji, userIds: [req.user.id] })
    } else {
      reaction.userIds = reaction.userIds.filter(userId => userId !== req.user.id)
    }
  }
  const changed = active !== present || JSON.stringify(reactions.filter(item => item.userIds.length)) !== JSON.stringify(found.message.reactions || [])
  saveMessageUpdate(req, res, found.message, changed ? { reactions: normalizeReactions(reactions) } : null)
})

router.put('/:id/pin', authMiddleware, (req, res) => {
  const found = accessibleMessage(req, res)
  if (!found) return
  const db = req.app.locals.db
  if (!hasPermission(db, req.user.id, found.channel.serverId, 'manageMessages')) {
    return res.status(403).json({ error: '没有管理消息的权限' })
  }
  if (typeof req.body?.pinned !== 'boolean') return res.status(400).json({ error: 'pinned 必须为布尔值' })
  const pinned = !!found.message.pin
  const fields = pinned === req.body.pinned ? null : { pin: req.body.pinned ? { userId: req.user.id, createdAt: now() } : null }
  saveMessageUpdate(req, res, found.message, fields)
})

router.put('/:id', authMiddleware, (req, res) => {
  const found = accessibleMessage(req, res)
  if (!found) return
  const { message } = found
  if (message.userId !== req.user.id) return res.status(403).json({ error: '只能编辑自己的消息' })
  if (found.channel.type === 'announcement') {
    const permission = validateMessageSend(req.app.locals.db, req.user.id, found.channel)
    if (!permission.ok) return res.status(permission.status).json({ error: permission.error })
  }

  const { content } = req.body
  if (typeof content !== 'string' || !content.trim()) return res.status(400).json({ error: '内容不能为空' })
  const mentions = validateMentions(req.app.locals.db, req.user.id, found.channel, req.body, message)
  if (!mentions.ok) return res.status(mentions.status).json({ error: mentions.error })
  saveMessageUpdate(req, res, message, { content, mentions: mentions.mentions, mentionEveryone: mentions.mentionEveryone, editedAt: now() })
})

router.delete('/:id', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const found = accessibleMessage(req, res)
  if (!found) return
  const { message, channel } = found

  if (message.userId !== req.user.id) {
    if (!hasPermission(db, req.user.id, channel.serverId, 'manageMessages')) {
      return res.status(403).json({ error: '没有权限删除此消息' })
    }
  }

  const channelId = message.channelId
  const files = extractFileNames(message)
  db.deleteMessage(req.params.id)
  // 删除记录和保留的发送 receipt 必须一起落盘，防止重启后同 ID 复活消息。
  db.save()
  broadcastToChannel(db, req.app.locals.wss, channelId, {
    type: 'message-deleted',
    messageId: req.params.id,
    channelId
  })
  // 附件清理：先删消息记录，再检查引用并删除无引用文件（失败不影响消息删除）
  cleanupAttachmentFiles(db, files)
  notifyChannelReadStates(db, req.app.locals.wss, channelId)
  invalidateMention(db, req.app.locals.wss, message)
  res.json({ success: true })
})

export default router
