import { hasPermission } from './permissions.js'
import { logger } from './logger.js'
import { hasActiveSocketSession } from './ws-session.js'
import { isMessageChannel } from './channel-types.js'

// Reading state belongs to the user, so deliver it to every session regardless of the selected channel.
export function pushReadStateToUser(db, wss, userId, payload) {
  if (!wss) return
  if (!db.findMember(payload.serverId, userId) || !hasPermission(db, userId, payload.serverId, 'viewChannel')) return
  const event = JSON.stringify({ type: 'read-state', ...payload })
  for (const client of wss.clients) {
    if (client.readyState !== 1 || client.userId !== userId || !hasActiveSocketSession(db, client) ||
        !db.findMember(payload.serverId, userId) || !hasPermission(db, userId, payload.serverId, 'viewChannel')) continue
    try {
      client.send(event)
    } catch (error) {
      logger.warn('阅读状态推送失败: ' + (error?.message || error))
    }
  }
}

export function notifyChannelReadStates(db, wss, channelId) {
  const channel = db.findChannel(channelId)
  if (!isMessageChannel(channel)) return
  const notifications = []
  for (const member of db.findMembersByServer(channel.serverId)) {
    if (!hasPermission(db, member.userId, channel.serverId, 'viewChannel')) continue
    db.getReadState(member.userId, channelId)
    notifications.push({
      userId: member.userId,
      payload: { serverId: channel.serverId, state: db.getChannelReadState(member.userId, channelId) }
    })
  }
  try {
    // New members' initial baselines must survive restart before they are announced.
    db.save()
  } catch (error) {
    logger.error('阅读状态保存失败，已跳过推送: ' + (error?.message || error))
    return
  }
  for (const { userId, payload } of notifications) pushReadStateToUser(db, wss, userId, payload)
}
