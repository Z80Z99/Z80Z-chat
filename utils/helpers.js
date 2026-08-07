import { v4 as uuidv4 } from 'uuid'

export function genId() {
  return uuidv4()
}

export function genCode(length = 8) {
  const chars = '0123456789'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

export function now() {
  return new Date().toISOString()
}

export function sanitizeUser(user) {
  if (!user) return null
  const { password, ...rest } = user
  return rest
}
