import { isSessionExpired } from '../middlewares/auth.js'
import { validateMessageSend, validateMessagePayload, validateMentionEveryone, buildMessage, saveAndBroadcastMessage } from '../utils/message.js'
import { hasPermission } from '../utils/permissions.js'

const voiceRooms = new Map()

export function handleWebSocket(wss, db) {
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost')
    const token = url.searchParams.get('token')
    if (!token) {
      ws.close(4001, '未提供token')
      return
    }

    const session = db.findSession(token)
    if (!session) {
      ws.close(4001, '无效的token')
      return
    }
    if (isSessionExpired(session)) {
      db.deleteSession(token)
      ws.close(4001, '无效的token')
      return
    }

    const user = db.findUser(session.userId)
    if (!user) {
      ws.close(4001, '用户不存在')
      return
    }

    ws.userId = user.id
    ws.username = user.username
    ws.voiceRoomId = null

    db.updateUser(user.id, { status: 'online' })
    broadcastOnlineUsers(wss, db)

    voiceRooms.forEach((room, roomId) => {
      const members = Array.from(room.keys())
      if (members.length > 0) {
        ws.send(JSON.stringify({ type: 'voice-room-members', roomId, members }))
      }
    })

    ws.on('message', (raw) => {
      let data
      try {
        data = JSON.parse(raw.toString())
      } catch {
        return
      }

      switch (data.type) {

        case 'join-channel': {
          // 权限验证：频道存在 + 成员身份 + viewChannel 权限
          const channel = db.findChannel(data.channelId)
          const member = channel ? db.findMember(channel.serverId, user.id) : null
          if (!channel || !member || !hasPermission(db, user.id, channel.serverId, 'viewChannel')) {
            ws.send(JSON.stringify({
              type: 'error',
              action: 'join-channel',
              error: !channel ? '频道不存在' : (!member ? '你不是该服务器成员' : '没有查看频道的权限')
            }))
            break
          }
          ws.channelId = data.channelId
          break
        }

        case 'leave-channel': {
          ws.channelId = null
          break
        }

        case 'typing': {
          const msg = JSON.stringify({
            type: 'typing',
            userId: user.id,
            username: user.username,
            channelId: data.channelId
          })
          wss.clients.forEach(client => {
            if (client !== ws && client.readyState === 1 && client.channelId === data.channelId) {
              client.send(msg)
            }
          })
          break
        }

        case 'message': {
          const channel = db.findChannel(data.channelId)
          const check = validateMessageSend(db, user.id, channel)
          if (!check.ok) break
          const payloadCheck = validateMessagePayload(data)
          if (!payloadCheck.ok) break
          const mentionCheck = validateMentionEveryone(db, user.id, channel, !!data.mentionEveryone)
          if (!mentionCheck.ok) break

          const message = buildMessage({
            channelId: data.channelId,
            userId: user.id,
            content: data.content,
            image: data.image,
            file: data.file,
            fileName: data.fileName,
            replyTo: data.replyTo,
            mentions: data.mentions,
            mentionEveryone: data.mentionEveryone
          })

          saveAndBroadcastMessage(db, wss, message, user)
          break
        }

        case 'voice-join': {
          const { roomId } = data
          // 权限验证：频道存在 + voice 类型 + 成员身份 + viewChannel 权限
          const channel = db.findChannel(roomId)
          const member = channel ? db.findMember(channel.serverId, user.id) : null
          if (!channel || channel.type !== 'voice' || !member || !hasPermission(db, user.id, channel.serverId, 'viewChannel')) {
            ws.send(JSON.stringify({
              type: 'error',
              action: 'voice-join',
              error: !channel ? '语音频道不存在' : (channel.type !== 'voice' ? '该频道不是语音频道' : (!member ? '你不是该服务器成员' : '没有查看频道的权限'))
            }))
            break
          }
          ws.voiceRoomId = roomId

          if (!voiceRooms.has(roomId)) {
            voiceRooms.set(roomId, new Map())
          }
          const room = voiceRooms.get(roomId)
          room.set(user.id, ws)

          const members = Array.from(room.keys())
          ws.send(JSON.stringify({ type: 'voice-members', roomId, members }))
          broadcastRoomMembers(wss, roomId, members)

          broadcastToRoom(room, ws, JSON.stringify({
            type: 'voice-user-joined',
            roomId,
            userId: user.id,
            username: user.username
          }))
          break
        }

        case 'voice-leave': {
          leaveVoiceRoom(wss, ws, user)
          break
        }

        case 'voice-offer':
        case 'voice-answer':
        case 'voice-ice-candidate':
        case 'screen-refresh': {
          const targetRoom = voiceRooms.get(data.roomId)
          // 信令隔离：发送者必须是该房间成员（否则可向房间内任意成员注入伪造信令）
          if (targetRoom && targetRoom.has(user.id)) {
            const targetWs = targetRoom.get(data.targetUserId)
            if (targetWs && targetWs.readyState === 1) {
              targetWs.send(JSON.stringify({
                type: data.type,
                roomId: data.roomId,
                userId: user.id,
                data: data.data
              }))
            }
          }
          break
        }

        case 'voice-mute':
        case 'voice-unmute': {
          broadcastToAll(wss, JSON.stringify({
            type: data.type,
            userId: user.id,
            roomId: data.roomId
          }))
          break
        }

        case 'screen-share-start':
        case 'screen-share-stop': {
          const targetRoom = voiceRooms.get(data.roomId)
          if (targetRoom) {
            broadcastToRoom(targetRoom, ws, JSON.stringify({
              type: data.type,
              roomId: data.roomId,
              userId: user.id
            }))
          }
          break
        }
      }
    })

    ws.on('close', () => {
      leaveVoiceRoom(wss, ws, user)
      db.updateUser(user.id, { status: 'offline' })
      broadcastOnlineUsers(wss, db)
    })
  })

  setInterval(() => {
    broadcastOnlineUsers(wss, db)
  }, 30000)
}

function leaveVoiceRoom(wss, ws, user) {
  if (!ws.voiceRoomId) return
  const room = voiceRooms.get(ws.voiceRoomId)
  if (!room) {
    ws.voiceRoomId = null
    return
  }
  // 只删除"当前注册的 ws"：用户重连/刷新后新 ws 已覆盖 room.set 的注册，
  // 旧 ws 关闭时不应误删新 ws 的注册，也不应广播虚假的离开事件
  if (room.get(user.id) !== ws) {
    ws.voiceRoomId = null
    return
  }
  room.delete(user.id)
  if (room.size === 0) {
    voiceRooms.delete(ws.voiceRoomId)
    broadcastRoomMembers(wss, ws.voiceRoomId, [])
  } else {
    broadcastToRoom(room, ws, JSON.stringify({
      type: 'voice-user-left',
      roomId: ws.voiceRoomId,
      userId: user.id
    }))
    broadcastRoomMembers(wss, ws.voiceRoomId, Array.from(room.keys()))
  }
  ws.voiceRoomId = null
}

function broadcastRoomMembers(wss, roomId, members) {
  const msg = JSON.stringify({ type: 'voice-room-members', roomId, members })
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(msg)
    }
  })
}

function broadcastOnlineUsers(wss, db) {
  const onlineUsers = []
  wss.clients.forEach(client => {
    if (client.readyState === 1 && client.userId) {
      const user = db.findUser(client.userId)
      if (user) {
        onlineUsers.push({ id: user.id, username: user.username, nickname: user.nickname, avatar: user.avatar, status: 'online' })
      }
    }
  })

  const msg = JSON.stringify({ type: 'online-users', users: onlineUsers })
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(msg)
    }
  })
}

function broadcastToRoom(room, sender, msg) {
  room.forEach((client) => {
    if (client !== sender && client.readyState === 1) {
      client.send(msg)
    }
  })
}

function broadcastToAll(wss, msg) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(msg)
    }
  })
}
