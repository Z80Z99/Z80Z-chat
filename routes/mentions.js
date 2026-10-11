import { Router } from 'express'
import { authMiddleware } from '../middlewares/auth.js'
import { hasPermission } from '../utils/permissions.js'
import { messagesWithUsers } from '../utils/message-records.js'
import { NOTIFICATION_MODES, notificationReason, pushNotificationPreference } from '../utils/mentions.js'
import { pushReadStateToUser } from '../utils/read-state.js'
import { logger } from '../utils/logger.js'
import { isMessageChannel } from '../utils/channel-types.js'

const router = Router()

function accessibleChannel(db, userId, channelId, res) {
  const channel = db.findChannel(channelId)
  if (!isMessageChannel(channel)) { res.status(404).json({ error: '文字或公告频道不存在' }); return null }
  if (!db.findMember(channel.serverId, userId) || !hasPermission(db, userId, channel.serverId, 'viewChannel')) {
    res.status(403).json({ error: '没有查看频道的权限' }); return null
  }
  return channel
}

router.get('/', authMiddleware, (req, res) => {
  const { limit: rawLimit, before: rawBefore } = req.query
  if (rawLimit !== undefined && (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 50)) {
    return res.status(400).json({ error: 'limit 必须为 1 到 50 的整数' })
  }
  if (rawBefore !== undefined && (typeof rawBefore !== 'string' || !/^\d+$/.test(rawBefore) || !Number.isSafeInteger(Number(rawBefore)) || Number(rawBefore) < 1)) {
    return res.status(400).json({ error: '提醒游标无效' })
  }
  const limit = rawLimit === undefined ? 50 : Number(rawLimit)
  const before = rawBefore === undefined ? Infinity : Number(rawBefore)
  const db = req.app.locals.db, userId = req.user.id
  const channels = new Map()
  for (const channel of db.raw.channels) {
    if (!isMessageChannel(channel) || !db.findMember(channel.serverId, userId) ||
        !hasPermission(db, userId, channel.serverId, 'viewChannel')) continue
    channels.set(channel.id, { channel, readSequence: db.getReadState(userId, channel.id).readSequence })
  }
  const notifications = []
  for (const message of db.raw.messages) {
    const current = channels.get(message.channelId)
    if (!current || message.sequence <= current.readSequence) continue
    const reason = notificationReason(db, userId, message)
    if (!reason) continue
    notifications.push({ serverId: current.channel.serverId, channelId: current.channel.id, message, reason })
  }
  // A newly joined member's initial baseline must survive restart before this response is delivered.
  try { db.save() } catch (error) {
    logger.error('提醒阅读状态保存失败: ' + (error?.message || error))
    return res.status(500).json({ error: '提醒读取失败，请重试' })
  }
  const page = notifications.filter(item => item.message.sequence < before).sort((a, b) => b.message.sequence - a.message.sequence)
  const visible = page.slice(0, limit), messages = messagesWithUsers(db, visible.map(item => item.message))
  const hasMore = page.length > limit
  res.json({ notifications: visible.map((item, index) => ({ ...item, message: messages[index] })),
    totalCount: notifications.length, hasMore, nextBefore: hasMore ? visible.at(-1).message.sequence : null })
})

router.get('/preferences/:channelId', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  if (!accessibleChannel(db, req.user.id, req.params.channelId, res)) return
  res.json({ mode: db.getNotificationPreference(req.user.id, req.params.channelId) })
})

router.put('/preferences/:channelId', authMiddleware, (req, res) => {
  const db = req.app.locals.db, userId = req.user.id
  const channel = accessibleChannel(db, userId, req.params.channelId, res)
  if (!channel) return
  const mode = req.body?.mode
  if (!NOTIFICATION_MODES.includes(mode)) return res.status(400).json({ error: '提醒模式必须为 all、mentions 或 mute' })
  const original = db.raw.notificationPreferences?.map(item => ({ ...item }))
  const revision = db.raw.readStateRevision
  let state
  try {
    db.setNotificationPreference(userId, channel.id, mode)
    state = db.getChannelReadState(userId, channel.id)
    db.save()
  } catch (error) {
    if (original === undefined) delete db.raw.notificationPreferences
    else db.raw.notificationPreferences = original
    db.raw.readStateRevision = revision
    logger.error('提醒设置保存失败: ' + (error?.message || error))
    return res.status(500).json({ error: '提醒设置保存失败，请重试' })
  }
  pushNotificationPreference(db, req.app.locals.wss, userId, channel, mode)
  pushReadStateToUser(db, req.app.locals.wss, userId, { serverId: channel.serverId, state })
  res.json({ mode })
})

export default router
