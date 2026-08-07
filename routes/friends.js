import { Router } from 'express'
import { authMiddleware } from '../middlewares/auth.js'
import { genId, now, sanitizeUser } from '../utils/helpers.js'
import { pushToUser } from '../websocket/push.js'

const router = Router()

router.get('/list', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const relations = db.findFriendsByUser(req.user.id)
  const friends = relations.map(r => {
    const otherId = r.userId === req.user.id ? r.friendId : r.userId
    const user = db.findUser(otherId)
    return {
      id: r.id,
      status: r.status,
      // 请求方向：本用户为发起方 → outgoing，否则 → incoming（前端区分已发送/收到的请求）
      direction: r.userId === req.user.id ? 'outgoing' : 'incoming',
      friend: user ? sanitizeUser(user) : null
    }
  })
  res.json({ friends })
})

router.post('/add', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const { username } = req.body
  if (!username) return res.status(400).json({ error: '请输入用户名' })

  const target = db.findUserByUsername(username)
  if (!target) return res.status(404).json({ error: '用户不存在' })
  if (target.id === req.user.id) return res.status(400).json({ error: '不能添加自己为好友' })

  const existing = db.findFriend(req.user.id, target.id)
  if (existing) return res.status(400).json({ error: '已经是好友或已发送请求' })

  const rel = {
    id: genId(),
    userId: req.user.id,
    friendId: target.id,
    status: 'pending',
    createdAt: now()
  }
  db.createFriend(rel)
  pushToUser(req.app.locals.wss, target.id, 'friend-updated', { userId: req.user.id })
  res.json({ friend: { id: rel.id, status: rel.status, friend: sanitizeUser(target) } })
})

router.post('/accept', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const { friendId } = req.body
  if (!friendId) return res.status(400).json({ error: '参数错误' })

  const rel = db.findFriend(req.user.id, friendId)
  if (!rel) return res.status(404).json({ error: '好友请求不存在' })
  if (rel.status !== 'pending') return res.status(400).json({ error: '请求已处理' })
  // 只有被请求方（rel.friendId）可以接受，发起方不能自己接受
  if (rel.friendId !== req.user.id) return res.status(403).json({ error: '不能接受自己发起的请求' })

  db.updateFriend(rel.id, { status: 'accepted' })
  const otherId = rel.userId === req.user.id ? rel.friendId : rel.userId
  pushToUser(req.app.locals.wss, otherId, 'friend-updated', { userId: req.user.id })
  res.json({ success: true })
})

router.delete('/:friendId', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const rel = db.findFriend(req.user.id, req.params.friendId)
  if (!rel) return res.status(404).json({ error: '好友关系不存在' })

  db.deleteFriend(rel.id)
  const otherId = rel.userId === req.user.id ? rel.friendId : rel.userId
  pushToUser(req.app.locals.wss, otherId, 'friend-updated', { userId: req.user.id })
  res.json({ success: true })
})

export default router
