import { hasPermission } from './permissions.js'
import { hasActiveSocketSession } from './ws-session.js'
import { signUploadUrlsDeep } from './uploadSign.js'
import { logger } from './logger.js'
import { isMessageChannel } from './channel-types.js'

export const NOTIFICATION_MODES = Object.freeze(['all', 'mentions', 'mute'])
const USER_ID = /^[a-zA-Z0-9_-]{1,128}$/
const EVERYONE = /(^|[\s([{，。！？；：、])@everyone(?=$|[\s)\]},.!?;:，。！？；：、])/u

// Existing records may contain old mentions arrays; normalize for responses without rewriting them.
export function messageMentionIds(message) {
  const ids = Array.isArray(message?.mentions) ? message.mentions : []
  const parsed = typeof message?.content === 'string'
    ? [...message.content.matchAll(/<@([a-zA-Z0-9_-]{1,128})>/g)].map(match => match[1]) : []
  return [...new Set([...ids, ...parsed].filter(id => typeof id === 'string' && USER_ID.test(id)))].slice(0, 50)
}

export function parseMentions(payload) {
  const content = typeof payload?.content === 'string' ? payload.content : ''
  if (payload?.mentionEveryone !== undefined && typeof payload.mentionEveryone !== 'boolean') {
    return { ok: false, status: 400, error: 'mentionEveryone 必须为布尔值' }
  }
  if (payload?.mentions !== undefined && (!Array.isArray(payload.mentions) ||
      payload.mentions.some(id => typeof id !== 'string' || !USER_ID.test(id)))) {
    return { ok: false, status: 400, error: 'mentions 格式无效' }
  }
  const tags = [...content.matchAll(/<@([^>]*)>/g)]
  if (tags.some(match => !USER_ID.test(match[1])) || content.replace(/<@[^>]*>/g, '').includes('<@')) {
    return { ok: false, status: 400, error: '成员提及格式无效' }
  }
  const mentions = [...new Set(tags.map(match => match[1]))]
  if (mentions.length > 50 || new Set(payload?.mentions || []).size > 50) {
    return { ok: false, status: 400, error: '一条消息最多提及 50 位成员' }
  }
  const supplied = [...new Set(payload?.mentions || [])]
  if (supplied.length && (supplied.length !== mentions.length || supplied.some(id => !mentions.includes(id)))) {
    return { ok: false, status: 400, error: '提及成员必须与消息正文一致' }
  }
  return { ok: true, mentions, mentionEveryone: payload?.mentionEveryone === true || EVERYONE.test(content) }
}

export function validateMentions(db, userId, channel, payload, previousMessage) {
  const parsed = parseMentions(payload)
  if (!parsed.ok) return parsed
  const { mentions, mentionEveryone } = parsed
  const existing = previousMessage ? messageMentionIds(previousMessage) : []
  for (const targetId of mentions) {
    if (existing.includes(targetId)) continue
    if (!db.findUser(targetId) || !db.findMember(channel.serverId, targetId) ||
        !hasPermission(db, targetId, channel.serverId, 'viewChannel')) {
      return { ok: false, status: 400, error: '提及成员不在当前服务器或不能查看频道' }
    }
  }
  if (mentionEveryone && !hasPermission(db, userId, channel.serverId, 'mentionEveryone')) {
    return { ok: false, status: 403, error: '没有 @所有人 的权限' }
  }
  return { ok: true, mentions, mentionEveryone }
}

export function notificationReason(db, userId, message) {
  if (message.userId === userId) return null
  const mode = db.getNotificationPreference?.(userId, message.channelId) || 'mentions'
  if (mode === 'mute') return null
  if (messageMentionIds(message).includes(userId)) return 'mention'
  if (message.mentionEveryone === true) return 'everyone'
  return mode === 'all' ? 'message' : null
}

function pushToEligible(db, wss, channel, event, select) {
  if (!wss || !isMessageChannel(channel)) return
  for (const client of wss.clients) {
    if (client.readyState !== 1 || !hasActiveSocketSession(db, client) ||
        !db.findMember(channel.serverId, client.userId) ||
        !hasPermission(db, client.userId, channel.serverId, 'viewChannel')) continue
    const payload = select ? select(client.userId) : event
    if (!payload) continue
    try { client.send(JSON.stringify(signUploadUrlsDeep(payload))) }
    catch (error) { logger.warn('提醒推送失败: ' + (error?.message || error)) }
  }
}

export function notifyMessageMentions(db, wss, message) {
  const channel = db.findChannel(message.channelId)
  pushToEligible(db, wss, channel, null, userId => {
    const reason = notificationReason(db, userId, message)
    return reason ? { type: 'mention-notification', serverId: channel.serverId,
      channelId: channel.id, message, reason } : null
  })
}

// Edits and deletions refresh the inbox, including recipients removed by an edit; they never alert again.
export function invalidateMention(db, wss, message) {
  const channel = db.findChannel(message.channelId)
  if (!channel) return
  pushToEligible(db, wss, channel, { type: 'mention-invalidated', messageId: message.id,
    channelId: channel.id, serverId: channel.serverId })
}

export function pushNotificationPreference(db, wss, userId, channel, mode) {
  pushToEligible(db, wss, channel, null, targetId => targetId === userId
    ? { type: 'notification-preference', serverId: channel.serverId, channelId: channel.id, mode } : null)
}
