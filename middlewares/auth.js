const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export function isSessionExpired(session) {
  if (!session?.createdAt) return false
  return Date.now() - new Date(session.createdAt).getTime() > SESSION_TTL_MS
}

export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录' })
  }

  const token = authHeader.slice(7)
  const db = req.app.locals.db
  const session = db.findSession(token)

  if (!session) {
    return res.status(401).json({ error: '登录已过期' })
  }

  if (isSessionExpired(session)) {
    db.deleteSession(token)
    return res.status(401).json({ error: '登录已过期' })
  }

  const user = db.findUser(session.userId)
  if (!user) {
    return res.status(401).json({ error: '用户不存在' })
  }

  req.user = user
  req.token = token
  next()
}
