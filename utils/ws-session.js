import { isSessionExpired } from '../middlewares/auth.js'

// Socket identity is fixed at authentication; recheck the session before each private push.
export function hasActiveSocketSession(db, client) {
  if (!client.sessionToken || !client.userId) return false
  const session = db.findSession(client.sessionToken)
  return !!session && session.userId === client.userId && !isSessionExpired(session) && !!db.findUser(client.userId)
}
