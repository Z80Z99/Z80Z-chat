import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { genId, now, sanitizeUser } from '../utils/helpers.js'
import { authMiddleware } from '../middlewares/auth.js'

const router = Router()

// 用于用户不存在时执行假 bcrypt 比较，避免时序攻击枚举用户名
const DUMMY_HASH = bcrypt.hashSync('dummy-password', 10)

router.post('/register', (req, res) => {
  const { username, password } = req.body
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' })
  }
  if (username.length < 2 || username.length > 20) {
    return res.status(400).json({ error: '用户名长度2-20个字符' })
  }
  if (password.length < 4) {
    return res.status(400).json({ error: '密码至少4个字符' })
  }

  const db = req.app.locals.db
  if (db.findUserByUsername(username)) {
    return res.status(400).json({ error: '用户名已存在' })
  }

  const hashedPassword = bcrypt.hashSync(password, 10)
  const user = {
    id: genId(),
    username,
    password: hashedPassword,
    avatar: 'default',
    nickname: username,
    status: 'online',
    bio: '',
    createdAt: now()
  }
  db.createUser(user)

  const token = genId()
  db.createSession({ token, userId: user.id, createdAt: now() })

  res.json({ token, user: sanitizeUser(user) })
})

router.post('/login', (req, res) => {
  const { username, password } = req.body
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' })
  }

  const db = req.app.locals.db
  const user = db.findUserByUsername(username)
  const passwordValid = bcrypt.compareSync(password, user ? user.password : DUMMY_HASH)
  if (!user || !passwordValid) {
    return res.status(400).json({ error: '用户名或密码错误' })
  }

  db.updateUser(user.id, { status: 'online' })

  const token = genId()
  db.createSession({ token, userId: user.id, createdAt: now() })

  res.json({ token, user: sanitizeUser(user) })
})

router.get('/me', authMiddleware, (req, res) => {
  res.json({ user: sanitizeUser(req.user) })
})

router.post('/logout', authMiddleware, (req, res) => {
  const db = req.app.locals.db
  db.updateUser(req.user.id, { status: 'offline' })
  db.deleteSession(req.token)
  res.json({ success: true })
})

export default router
