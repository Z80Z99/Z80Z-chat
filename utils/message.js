import { genId, now } from './helpers.js'
import crypto from 'node:crypto'
import { hasPermission } from '../utils/permissions.js'
import { signUploadUrlsDeep } from './uploadSign.js'
import { notifyChannelReadStates } from './read-state.js'
import { logger } from './logger.js'
import { hasActiveSocketSession } from './ws-session.js'
import { messagesWithUsers } from './message-records.js'
import { parseMentions, validateMentions, notifyMessageMentions } from './mentions.js'
import { isMessageChannel } from './channel-types.js'

// 保存失败时保留未广播消息；同进程重试确认落盘后只广播一次。
const pendingBroadcasts = new WeakMap()

// 校验发送者是否有权在频道发消息（频道存在 / 成员 / 禁言 / sendMessage 权限）
export function validateMessageSend(db, userId, channel, { publishing = true } = {}) {
  if (!channel) return { ok: false, status: 404, error: '频道不存在' }
  if (!isMessageChannel(channel)) return { ok: false, status: 400, error: '该频道不支持文字消息' }
  const member = db.findMember(channel.serverId, userId)
  if (!member) return { ok: false, status: 403, error: '你不是该服务器成员' }
  if (member.muted) return { ok: false, status: 403, error: '你已被禁言' }
  if (!hasPermission(db, userId, channel.serverId, 'viewChannel')) {
    return { ok: false, status: 403, error: '没有查看频道的权限' }
  }
  if (!hasPermission(db, userId, channel.serverId, 'sendMessage')) {
    return { ok: false, status: 403, error: '没有发送消息的权限' }
  }
  if (publishing && channel.type === 'announcement' && !hasPermission(db, userId, channel.serverId, 'manageMessages')) {
    return { ok: false, status: 403, error: '只有社区所有者或拥有管理消息权限的成员可以发布公告' }
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
export function buildMessage({ channelId, userId, content, image, file, fileName, replyTo, mentions, mentionEveryone, clientMessageId }) {
  const message = {
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
    mentionEveryone: !!mentionEveryone
  }
  if (clientMessageId !== undefined) message.clientMessageId = clientMessageId
  return message
}

function messageWithUser(db, message) { return messagesWithUsers(db, [message])[0] }

function canonicalAttachment(value) {
  return typeof value === 'string' && value.startsWith('/uploads/') ? value.split(/[?#]/, 1)[0] : value
}

function messageFingerprint(payload) {
  // 固定字段顺序、与建消息时一致的默认值；附件签名过期重签不改变发送身份。
  const normalized = {
    channelId: payload.channelId,
    content: payload.content || '',
    image: canonicalAttachment(payload.image || null),
    file: canonicalAttachment(payload.file || null),
    fileName: payload.fileName || null,
    replyTo: payload.replyTo || null,
    mentions: payload.mentions || [],
    mentionEveryone: !!payload.mentionEveryone
  }
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

function publishMessage(db, wss, message) {
  try {
    broadcastToChannel(db, wss, message.channelId, { type: 'message', message, channelId: message.channelId })
  } catch (error) {
    logger.error('消息已保存，广播失败: ' + (error?.message || error))
  }
  notifyChannelReadStates(db, wss, message.channelId)
  notifyMessageMentions(db, wss, message)
}

// REST 与 WS 共用发送事务；所有重放在查 receipt 前重新检查当前权限。
export function submitMessage(db, wss, user, payload = {}) {
  const channel = db.findChannel(payload.channelId)
  const permission = validateMessageSend(db, user.id, channel)
  if (!permission.ok) return permission
  if (channel.type === 'announcement' && (payload.image || payload.file) && !hasPermission(db, user.id, channel.serverId, 'uploadFile')) {
    return { ok: false, status: 403, error: '没有上传文件的权限' }
  }
  const validity = validateMessagePayload(payload)
  if (!validity.ok) return validity
  const originalPayload = payload
  const parsedMentions = parseMentions(payload)
  if (!parsedMentions.ok) return parsedMentions
  payload = { ...payload, mentions: parsedMentions.mentions, mentionEveryone: parsedMentions.mentionEveryone }

  const clientMessageId = payload.clientMessageId
  if (clientMessageId === undefined) {
    const mentionPermission = validateMentions(db, user.id, channel, payload)
    if (!mentionPermission.ok) return mentionPermission
    const message = buildMessage({ ...payload, userId: user.id })
    try {
      return { ok: true, status: 200, message: saveAndBroadcastMessage(db, wss, message, user) }
    } catch (error) {
      logger.error('消息保存失败: ' + (error?.message || error))
      return { ok: false, status: 500, error: '消息保存失败，请先核对聊天记录' }
    }
  }
  if (typeof clientMessageId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(clientMessageId)) {
    return { ok: false, status: 400, error: 'clientMessageId 格式无效' }
  }

  const fingerprint = messageFingerprint(payload)
  const receipt = db.findMessageReceipt(user.id, clientMessageId)
  if (receipt && (receipt.channelId !== payload.channelId ||
      (receipt.fingerprint !== fingerprint && receipt.fingerprint !== messageFingerprint(originalPayload)))) {
    return { ok: false, status: 409, error: '该发送标识已用于不同的消息内容或频道' }
  }
  let message
  if (receipt) {
    message = db.findMessage(receipt.messageId)
    if (!message) {
      try { db.save() } catch (error) {
        logger.error('消息删除尚未保存: ' + (error?.message || error))
        return { ok: false, status: 500, error: '消息删除尚未保存，请重试' }
      }
      pendingBroadcasts.get(db)?.delete(receipt.messageId)
      return { ok: false, status: 410, error: '该消息已删除，请使用新的发送标识' }
    }
    // A failed first save is still a new send; a durable receipt only rechecks the sender's access.
    if (pendingBroadcasts.get(db)?.has(message.id)) {
      const mentionPermission = validateMentions(db, user.id, channel, payload)
      if (!mentionPermission.ok) return mentionPermission
    }
  } else {
    const mentionPermission = validateMentions(db, user.id, channel, payload)
    if (!mentionPermission.ok) return mentionPermission
    message = buildMessage({ ...payload, userId: user.id })
    db.createMessage(message)
    db.createMessageReceipt({
      userId: user.id, clientMessageId, channelId: message.channelId,
      messageId: message.id, fingerprint, createdAt: message.createdAt
    })
    if (!pendingBroadcasts.has(db)) pendingBroadcasts.set(db, new Set())
    pendingBroadcasts.get(db).add(message.id)
  }

  try {
    // 只有消息与 receipt 一起落盘，才确认发送；失败时内存 dirty 保留供相同 ID 重试。
    db.save()
  } catch (error) {
    logger.error('消息保存失败，等待同标识重试: ' + (error?.message || error))
    return { ok: false, status: 500, error: '消息保存失败，请重试' }
  }
  const result = messageWithUser(db, message)
  if (pendingBroadcasts.get(db)?.delete(message.id)) publishMessage(db, wss, result)
  return { ok: true, status: 200, message: result }
}

// 广播 JSON 消息给已 join 指定频道的客户端
export function broadcastToChannel(db, wss, channelId, payload) {
  if (!wss) return
  const channel = db.findChannel(channelId)
  if (!channel) return
  const msgStr = JSON.stringify(signUploadUrlsDeep(payload))
  wss.clients.forEach(client => {
    if (client.readyState === 1 && client.channelId === channelId && hasActiveSocketSession(db, client) &&
        db.findMember(channel.serverId, client.userId) && hasPermission(db, client.userId, channel.serverId, 'viewChannel')) {
      try { client.send(msgStr) } catch (error) {
        logger.warn('频道消息发送失败: ' + (error?.message || error))
      }
    }
  })
}

// 保存消息并广播给频道内已 join 的客户端
export function saveAndBroadcastMessage(db, wss, message, user) {
  db.createMessage(message)
  db.save()
  const msgWithUser = messageWithUser(db, message)
  publishMessage(db, wss, msgWithUser)
  return msgWithUser
}
