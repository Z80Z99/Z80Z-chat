import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { authMiddleware } from '../middlewares/auth.js'
import { sanitizeUser } from '../utils/helpers.js'
import { pushToAll } from '../websocket/push.js'

const router = Router()

router.get('/search/:query', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const query = req.params.query.toLowerCase()
  const users = db.findAllUsers()
    .filter(u => u.id !== req.user.id && u.username.toLowerCase().includes(query))
    .map(u => sanitizeUser(u))
  res.json({ users })
})

router.get('/search', authMiddleware, (req, res) => {
  res.status(400).json({ error: '缺少搜索关键词' })
})

router.get('/:id', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const user = db.findUser(req.params.id)
  if (!user) return res.status(404).json({ error: '用户不存在' })
  res.json({ user: sanitizeUser(user) })
})

router.post('/update', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const { nickname, avatar } = req.body
  const updates = {}
  if (nickname !== undefined) updates.nickname = nickname
  if (avatar !== undefined) updates.avatar = avatar

  const user = db.updateUser(req.user.id, updates)
  if (!user) return res.status(404).json({ error: '用户不存在' })

  const wss = req.app.locals.wss
  if (wss && (updates.avatar !== undefined || updates.nickname !== undefined)) {
    const payload = { userId: req.user.id }
    if (updates.avatar !== undefined) payload.avatar = updates.avatar
    if (updates.nickname !== undefined) payload.nickname = updates.nickname
    pushToAll(wss, 'user-profile-updated', payload)
  }

  res.json({ user: sanitizeUser(user) })
})

router.post('/change-password', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  const { oldPassword, newPassword } = req.body
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: '请输入当前密码和新密码' })
  }
  if (newPassword.length < 4) {
    return res.status(400).json({ error: '新密码至少4个字符' })
  }

  const user = db.findUser(req.user.id)
  if (!user || !bcrypt.compareSync(oldPassword, user.password)) {
    return res.status(400).json({ error: '当前密码错误' })
  }

  db.updateUser(user.id, { password: bcrypt.hashSync(newPassword, 10) })
  res.json({ success: true })
})

export default router
