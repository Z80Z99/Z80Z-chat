import { signUploadUrlsDeep } from '../utils/uploadSign.js'

export function pushToUser(wss, userIds, type, payload = {}) {
  if (!wss || !userIds || userIds.length === 0) return
  const idSet = new Set(Array.isArray(userIds) ? userIds : [userIds])
  const msg = JSON.stringify({ type, ...signUploadUrlsDeep(payload) })
  wss.clients.forEach(client => {
    if (client.readyState === 1 && client.userId && idSet.has(client.userId)) {
      client.send(msg)
    }
  })
}

export function pushToAll(wss, type, payload = {}) {
  if (!wss) return
  const msg = JSON.stringify({ type, ...signUploadUrlsDeep(payload) })
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(msg)
    }
  })
}
