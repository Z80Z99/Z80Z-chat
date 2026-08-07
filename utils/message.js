import { genId, now } from './helpers.js'
import { hasPermission } from '../utils/permissions.js'
import { signUploadUrlsDeep } from './uploadSign.js'

// 校验发送者是否有权在频道发消息（频道存在 / 成员 / 禁言 / sendMessage 权限）
export function validateMessageSend(db, userId, channel) {
  if (!channel) return { ok: false, status: 404, error: '频道不存在' }
  const member = db.findMember(channel.serverId, userId)
  if (!member) return { ok: false, status: 403, error: '你不是该服务器成员' }
  if (member.muted) return { ok: false, status: 403, error: '你已被禁言' }
  if (!hasPermission(db, userId, channel.serverId, 'sendMessage')) {
    return { ok: false, status: 403, error: '没有发送消息的权限' }
  }
  return { ok: true }
}

// 校验消息内容（文字 / 图片 / 文件至少一项）
export function validateMessagePayload({ content, image, file } = {}) {
  if (!content && !image && !file) {
    return { ok: false, status: 400, error: '消息内容不能为空' }
  }
  return { ok: true }
}

// 校验 @所有人 权限（mentionEveryone=true 时需要 mentionEveryone 权限；owner 由 hasPermission 豁免）
export function validateMentionEveryone(db, userId, channel, mentionEveryone) {
  if (!mentionEveryone) return { ok: true }
  if (!hasPermission(db, userId, channel.serverId, 'mentionEveryone')) {
    return { ok: false, status: 403, error: '没有 @所有人 的权限' }
  }
  return { ok: true }
}

// 构建消息记录
export function buildMessage({ channelId, userId, content, image, file, fileName, replyTo, mentions, mentionEveryone }) {
  return {
    id: genId(),
    channelId,
    userId,
    content: content || '',
    image: image || null,
    file: file || null,
    fileName: fileName || null,
    createdAt: now(),
    editedAt: null,
    replyTo: replyTo || null,
    mentions: mentions || [],
    mentionEveryone: mentionEveryone || false
  }
}

// 广播 JSON 消息给已 join 指定频道的客户端
export function broadcastToChannel(wss, channelId, payload) {
  if (!wss) return
  const msgStr = JSON.stringify(signUploadUrlsDeep(payload))
  wss.clients.forEach(client => {
    if (client.readyState === 1 && client.channelId === channelId) {
      client.send(msgStr)
    }
  })
}

// 保存消息并广播给频道内已 join 的客户端
export function saveAndBroadcastMessage(db, wss, message, user) {
  const msgWithUser = {
    ...message,
    user: { id: user.id, username: user.username, nickname: user.nickname, avatar: user.avatar }
  }
  db.createMessage(message)
  broadcastToChannel(wss, message.channelId, { type: 'message', message: msgWithUser, channelId: message.channelId })
  return msgWithUser
}
