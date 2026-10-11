import { Router } from 'express'
import { authMiddleware } from '../middlewares/auth.js'
import { hasPermission } from '../utils/permissions.js'
import { pushReadStateToUser } from '../utils/read-state.js'
import { isMessageChannel } from '../utils/channel-types.js'

const router = Router()

function canReadServer(db, userId, serverId, res) {
  if (!db.findMember(serverId, userId)) {
    res.status(403).json({ error: '你不是该服务器成员' })
    return false
  }
  if (!hasPermission(db, userId, serverId, 'viewChannel')) {
    res.status(403).json({ error: '没有查看频道的权限' })
    return false
  }
  return true
}

router.get('/:serverId', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const serverId = req.params.serverId
  if (!db.findServer(serverId)) return res.status(404).json({ error: '服务器不存在' })
  if (!canReadServer(db, req.user.id, serverId, res)) return
  const states = db.findChannelsByServer(serverId)
    .filter(isMessageChannel)
    .map(channel => {
      db.getReadState(req.user.id, channel.id)
      return db.getChannelReadState(req.user.id, channel.id)
    })
  db.save()
  res.json({ serverId, states })
})

router.post('/:channelId', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const channel = db.findChannel(req.params.channelId)
  if (!channel) return res.status(404).json({ error: '频道不存在' })
  if (!canReadServer(db, req.user.id, channel.serverId, res)) return
  if (!isMessageChannel(channel)) return res.status(400).json({ error: '只能标记文字或公告频道的阅读状态' })
  const messageId = req.body?.messageId
  if (typeof messageId !== 'string' || !messageId) {
    return res.status(400).json({ error: '请选择已阅读的消息' })
  }
  const message = db.findMessage(messageId)
  if (!message || message.channelId !== channel.id) {
    return res.status(400).json({ error: '消息不属于该频道' })
  }
  if (!Number.isSafeInteger(message.sequence) || message.sequence < 1) {
    return res.status(400).json({ error: '消息没有有效的阅读序号' })
  }
  db.getReadState(req.user.id, channel.id)
  db.advanceReadState(req.user.id, channel.id, message.sequence)
  // A failed disk write must not produce a successful acknowledgment or device synchronization event.
  db.save()
  const payload = { serverId: channel.serverId, state: db.getChannelReadState(req.user.id, channel.id) }
  pushReadStateToUser(db, req.app.locals.wss, req.user.id, payload)
  res.json(payload)
})

export default router
