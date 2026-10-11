// ============================================================
// Z80Z-chat - JSON 数据库模块
// 用途：内存数据 + 原子写入（临时文件 + fsync + rename）
//       写入采用防抖合并（200ms），退出时通过 flush() 强制落盘
// 来源：Z80Z-chat v1.0.0 合法项目代码
// 说明：如被杀毒软件误报（启发式误报），请将项目目录加入信任区
// ============================================================
import fs from 'fs'
import { dataDir, dbPath, uploadDir } from '../config/index.js'
import { logger } from '../utils/logger.js'
import { messageMentionIds } from '../utils/mentions.js'
import { isMessageChannel } from '../utils/channel-types.js'

const defaultData = {
  chatStateVersion: 1,
  lastMessageSequence: 0,
  readStateRevision: 0,
  readStates: [],
  messageReceipts: [],
  users: [],
  sessions: [],
  friends: [],
  servers: [],
  categories: [],
  channels: [],
  messages: [],
  roles: [],
  members: [],
  invites: []
}

let data = null

const TMP_PATH = dbPath + '.tmp'
const FLUSH_DELAY = 200
const RETRY_DELAY = 1000
const MAX_RETRY_DELAY = 30000

let dirty = false
let flushTimer = null
let retryDelay = RETRY_DELAY

export function initDB() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true })

  // 清理上次写入中断的残留临时文件（db.json 仍是上次完整写入的数据，tmp 不可信）
  try {
    if (fs.existsSync(TMP_PATH)) {
      fs.unlinkSync(TMP_PATH)
      logger.info('已清理残留的临时文件 db.json.tmp')
    }
  } catch {}

  if (fs.existsSync(dbPath)) {
    try {
      const original = fs.readFileSync(dbPath, 'utf-8')
      data = JSON.parse(original)
      if (data.notificationPreferences !== undefined && !Array.isArray(data.notificationPreferences)) {
        throw new Error('数据库 notificationPreferences 字段格式错误')
      }
      if (needsChatStateMigration()) {
        const backup = `${dbPath}.pre-chat-state-${Date.now()}-${process.pid}.bak`
        fs.writeFileSync(backup, original, { encoding: 'utf8', flag: 'wx' })
        migrateChatState()
        writeAtomic()
        logger.info(`消息顺序和阅读状态已升级，原数据备份: ${backup}`)
      }
    } catch (e) {
      logger.error(`数据库文件解析失败 ${dbPath}: ${e?.message || e}`)
      throw e
    }
  } else {
    data = JSON.parse(JSON.stringify(defaultData))
    writeAtomic() // 首次创建：无条件立即落盘（不走防抖）
  }

  return createAPI()
}

function needsChatStateMigration() {
  return data.chatStateVersion !== 1 || !Array.isArray(data.readStates) || !Array.isArray(data.messageReceipts) ||
    !Number.isSafeInteger(data.lastMessageSequence) || data.lastMessageSequence < 0 ||
    !Number.isSafeInteger(data.readStateRevision) || data.readStateRevision < 0 ||
    data.messages.some(message => !Number.isSafeInteger(message.sequence) || message.sequence <= 0 || message.sequence > data.lastMessageSequence)
}

function migrateChatState() {
  for (const field of ['readStates', 'messageReceipts']) {
    if (data[field] !== undefined && !Array.isArray(data[field])) throw new Error(`数据库 ${field} 字段格式错误`)
    data[field] ||= []
  }
  let sequence = Number.isSafeInteger(data.lastMessageSequence) && data.lastMessageSequence >= 0 ? data.lastMessageSequence : 0
  for (const message of data.messages) {
    if (Number.isSafeInteger(message.sequence) && message.sequence > 0) sequence = Math.max(sequence, message.sequence)
  }
  for (const message of data.messages) {
    if (!Number.isSafeInteger(message.sequence) || message.sequence <= 0) {
      if (sequence >= Number.MAX_SAFE_INTEGER) throw new Error('消息顺序已超出可用范围')
      message.sequence = ++sequence
    }
  }
  data.lastMessageSequence = sequence
  data.readStateRevision = Number.isSafeInteger(data.readStateRevision) && data.readStateRevision >= 0 ? data.readStateRevision : 0
  const latest = new Map()
  for (const message of data.messages) latest.set(message.channelId, Math.max(latest.get(message.channelId) || 0, message.sequence))
  for (const channel of data.channels) {
    if (!isMessageChannel(channel)) continue
    for (const member of data.members.filter(member => member.serverId === channel.serverId)) {
      if (!data.readStates.some(state => state.userId === member.userId && state.channelId === channel.id)) {
        data.readStates.push({ userId: member.userId, channelId: channel.id, readSequence: latest.get(channel.id) || 0 })
      }
    }
  }
  data.chatStateVersion = 1
}

function bumpReadRevision() {
  if (data.readStateRevision >= Number.MAX_SAFE_INTEGER) throw new Error('阅读状态版本已超出可用范围')
  data.readStateRevision++
}

// 原子写入核心：写临时文件 → fsync → rename 原子替换
// 任何一步失败都不会破坏现有 db.json；silent=true（防抖后台写）仅记录日志，
// silent=false（首次初始化/主动 flush）失败时抛出，由调用方决定处理
function writeAtomic(silent = false) {
  try {
    fs.writeFileSync(TMP_PATH, JSON.stringify(data, null, 2), 'utf8')
    const fd = fs.openSync(TMP_PATH, 'r+')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.renameSync(TMP_PATH, dbPath)
    return true
  } catch (e) {
    try { fs.rmSync(TMP_PATH, { force: true }) } catch {}
    logger.error('数据库写入失败（旧数据已保留）: ' + (e?.message || e))
    if (!silent) throw e
    return false
  }
}

function scheduleFlush(delay = FLUSH_DELAY) {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    if (dirty) {
      if (writeAtomic(true)) {
        dirty = false
        retryDelay = RETRY_DELAY
      } else {
        scheduleRetry()
      }
    }
  }, delay)
  flushTimer.unref?.()
}

// 临时磁盘故障后无需新写操作即可恢复；退避上限避免持续故障时频繁写盘/刷日志。
function scheduleRetry() {
  scheduleFlush(retryDelay)
  retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY)
}

// 防抖保存：短时间内的多次写操作合并为一次落盘（保留原 API 名称与调用点）
function saveDB() {
  dirty = true
  scheduleFlush()
}

// 强制同步落盘（优雅关闭 / 手动调用 / 首次初始化）
function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (dirty) {
    try {
      writeAtomic()
      dirty = false
      retryDelay = RETRY_DELAY
    } catch (e) {
      scheduleRetry()
      throw e
    }
  }
}

function createAPI() {
  const api = {
    get raw() { return data },

    save() { flush() },

    /* Users */
    findUser(id) { return data.users.find(u => u.id === id) },
    findUserByUsername(username) { return data.users.find(u => u.username === username) },
    findAllUsers() { return data.users },
    // 批量查询：单次遍历构建 id→user Map，避免循环内 findUser 的 O(n²)（N+1 优化）
    findUsersMap(ids) {
      const set = new Set(ids)
      const map = new Map()
      for (const u of data.users) {
        if (set.has(u.id)) map.set(u.id, u)
      }
      return map
    },
    createUser(user) { data.users.push(user); saveDB(); return user },
    updateUser(id, fields) {
      const idx = data.users.findIndex(u => u.id === id)
      if (idx === -1) return null
      Object.assign(data.users[idx], fields); saveDB(); return data.users[idx]
    },

    /* Sessions */
    findSession(token) { return data.sessions.find(s => s.token === token) },
    createSession(session) { data.sessions.push(session); saveDB(); return session },
    deleteSession(token) {
      data.sessions = data.sessions.filter(s => s.token !== token); saveDB()
    },

    /* Servers */
    findServer(id) { return data.servers.find(s => s.id === id) },
    findAllServers() { return data.servers },
    createServer(server) { data.servers.push(server); saveDB(); return server },
    updateServer(id, fields) {
      const idx = data.servers.findIndex(s => s.id === id)
      if (idx === -1) return null
      Object.assign(data.servers[idx], fields); saveDB(); return data.servers[idx]
    },
    deleteServer(id) {
      const channelIds = new Set(data.channels.filter(channel => channel.serverId === id).map(channel => channel.id))
      data.servers = data.servers.filter(s => s.id !== id)
      data.categories = data.categories.filter(c => c.serverId !== id)
      data.channels = data.channels.filter(c => c.serverId !== id)
      data.messages = data.messages.filter(m => {
        const ch = data.channels.find(c => c.id === m.channelId)
        return ch && ch.serverId !== id
      })
      data.roles = data.roles.filter(r => r.serverId !== id)
      data.members = data.members.filter(m => m.serverId !== id)
      data.invites = data.invites.filter(i => i.serverId !== id)
      data.readStates = data.readStates.filter(state => !channelIds.has(state.channelId))
      if (data.notificationPreferences) data.notificationPreferences = data.notificationPreferences.filter(state => !channelIds.has(state.channelId))
      bumpReadRevision()
      saveDB()
    },

    /* Categories */
    findCategory(id) { return data.categories.find(c => c.id === id) },
    findCategoriesByServer(serverId) { return data.categories.filter(c => c.serverId === serverId) },
    createCategory(cat) { data.categories.push(cat); saveDB(); return cat },
    updateCategory(id, fields) {
      const idx = data.categories.findIndex(c => c.id === id)
      if (idx === -1) return null
      Object.assign(data.categories[idx], fields); saveDB(); return data.categories[idx]
    },
    deleteCategory(id) {
      data.categories = data.categories.filter(c => c.id !== id)
      data.channels.filter(ch => ch.categoryId === id).forEach(ch => { ch.categoryId = null })
      saveDB()
    },

    /* Channels */
    findChannel(id) { return data.channels.find(c => c.id === id) },
    findChannelsByServer(serverId) { return data.channels.filter(c => c.serverId === serverId) },
    findChannelsByCategory(categoryId) { return data.channels.filter(c => c.categoryId === categoryId) },
    createChannel(channel) { data.channels.push(channel); saveDB(); return channel },
    updateChannel(id, fields) {
      const idx = data.channels.findIndex(c => c.id === id)
      if (idx === -1) return null
      Object.assign(data.channels[idx], fields); saveDB(); return data.channels[idx]
    },
    deleteChannel(id) {
      data.channels = data.channels.filter(c => c.id !== id)
      data.messages = data.messages.filter(m => m.channelId !== id)
      data.readStates = data.readStates.filter(state => state.channelId !== id)
      if (data.notificationPreferences) data.notificationPreferences = data.notificationPreferences.filter(state => state.channelId !== id)
      bumpReadRevision()
      saveDB()
    },

    /* Messages */
    findMessage(id) { return data.messages.find(m => m.id === id) },
    findMessagesByChannel(channelId, limit = 50, before = null) {
      let msgs = data.messages.filter(m => m.channelId === channelId)
      if (before) {
        const beforeIdx = msgs.findIndex(m => m.id === before)
        if (beforeIdx !== -1) msgs = msgs.slice(0, beforeIdx)
      }
      return msgs.sort((a, b) => b.sequence - a.sequence).slice(0, limit)
    },
    searchMessages(channelId, { q = '', authorId = null, before = null, limit = 50 } = {}) {
      const cursor = before ? api.findMessage(before) : null
      const query = q.toLowerCase()
      const users = new Map(data.users.map(user => [user.id, user]))
      const searchText = message => {
        const content = typeof message.content === 'string' ? message.content : ''
        const readable = content.replace(/<@([a-zA-Z0-9_-]{1,128})>/g, (tag, userId) => {
          const user = users.get(userId)
          return user ? '@' + (user.nickname || user.username) : tag
        })
        return `${content}\n${readable}\n${typeof message.fileName === 'string' ? message.fileName : ''}`.toLowerCase()
      }
      const matches = data.messages.filter(message => message.channelId === channelId &&
        (!cursor || message.sequence < cursor.sequence) &&
        (!authorId || message.userId === authorId) &&
        (!query || searchText(message).includes(query)))
        .sort((a, b) => b.sequence - a.sequence)
      const messages = matches.slice(0, limit)
      const hasMore = matches.length > limit
      return { messages, hasMore, nextBefore: hasMore ? messages.at(-1)?.id || null : null }
    },
    findMessageContext(channelId, messageId, limit = 50) {
      const messages = data.messages.filter(message => message.channelId === channelId).sort((a, b) => a.sequence - b.sequence)
      const target = messages.findIndex(message => message.id === messageId)
      if (target === -1) return null
      const start = Math.max(0, Math.min(target - Math.floor((limit - 1) / 2), messages.length - limit))
      const end = Math.min(messages.length, start + limit)
      return { messages: messages.slice(start, end), hasMoreBefore: start > 0, hasMoreAfter: end < messages.length }
    },
    findPinnedMessages(channelId) {
      return data.messages.filter(message => message.channelId === channelId && message.pin?.userId && message.pin?.createdAt)
        .sort((a, b) => b.pin.createdAt.localeCompare(a.pin.createdAt) || b.sequence - a.sequence)
    },
    createMessage(msg) {
      if (data.lastMessageSequence >= Number.MAX_SAFE_INTEGER) throw new Error('消息顺序已超出可用范围')
      const channel = api.findChannel(msg.channelId)
      if (isMessageChannel(channel)) {
        // New members' baselines precede the first new message, so its unread state is never swallowed.
        for (const member of data.members.filter(member => member.serverId === channel.serverId)) api.getReadState(member.userId, channel.id)
      }
      msg.sequence = ++data.lastMessageSequence
      msg.revision = 0
      msg.reactions = []
      msg.pin = null
      data.messages.push(msg)
      bumpReadRevision()
      saveDB()
      return msg
    },
    findMessageReceipt(userId, clientMessageId) {
      return data.messageReceipts.find(receipt => receipt.userId === userId && receipt.clientMessageId === clientMessageId)
    },
    createMessageReceipt(receipt) {
      if (api.findMessageReceipt(receipt.userId, receipt.clientMessageId)) throw new Error('消息发送编号已存在')
      data.messageReceipts.push(receipt)
      saveDB()
      return receipt
    },
    updateMessage(id, fields) {
      const idx = data.messages.findIndex(m => m.id === id)
      if (idx === -1) return null
      const message = data.messages[idx]
      const revision = Number.isSafeInteger(message.revision) && message.revision >= 0 ? message.revision : 0
      if (revision >= Number.MAX_SAFE_INTEGER) throw new Error('消息版本已超出可用范围')
      const mentionsChanged = JSON.stringify(messageMentionIds(message)) !== JSON.stringify(messageMentionIds({ ...message, ...fields })) ||
        (message.mentionEveryone === true) !== ({ ...message, ...fields }.mentionEveryone === true)
      Object.assign(message, fields, { revision: revision + 1 })
      if (mentionsChanged) bumpReadRevision()
      saveDB(); return message
    },
    deleteMessage(id) {
      if (!data.messages.some(message => message.id === id)) return
      data.messages = data.messages.filter(m => m.id !== id)
      bumpReadRevision()
      saveDB()
    },

    /* Read cursors: sequence remains valid even if its message is later deleted. */
    getReadState(userId, channelId) {
      let state = data.readStates.find(state => state.userId === userId && state.channelId === channelId)
      if (!state) {
        const latestSequence = data.messages.reduce((latest, message) => message.channelId === channelId ? Math.max(latest, message.sequence) : latest, 0)
        state = { userId, channelId, readSequence: latestSequence }
        data.readStates.push(state)
        bumpReadRevision()
        saveDB()
      }
      return state
    },
    advanceReadState(userId, channelId, sequence) {
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('非法阅读顺序')
      const state = api.getReadState(userId, channelId)
      if (sequence > state.readSequence) {
        state.readSequence = sequence
        bumpReadRevision()
        saveDB()
      }
      return state
    },
    getChannelReadState(userId, channelId) {
      const state = api.getReadState(userId, channelId)
      let latestSequence = 0
      let unreadCount = 0
      let mentionCount = 0
      const muted = api.getNotificationPreference(userId, channelId) === 'mute'
      for (const message of data.messages) {
        if (message.channelId !== channelId) continue
        latestSequence = Math.max(latestSequence, message.sequence)
        if (message.sequence > state.readSequence && message.userId !== userId) {
          unreadCount++
          if (!muted && (message.mentionEveryone === true || messageMentionIds(message).includes(userId))) mentionCount++
        }
      }
      return { channelId, readSequence: state.readSequence, latestSequence, unreadCount, mentionCount, revision: data.readStateRevision }
    },

    /* Missing preference tables remain response-only until a user changes a setting. */
    getNotificationPreference(userId, channelId) {
      const mode = data.notificationPreferences?.find(item => item?.userId === userId && item.channelId === channelId)?.mode
      return ['all', 'mentions', 'mute'].includes(mode) ? mode : 'mentions'
    },
    setNotificationPreference(userId, channelId, mode) {
      if (!['all', 'mentions', 'mute'].includes(mode)) throw new Error('非法提醒模式')
      data.notificationPreferences ||= []
      let preference = data.notificationPreferences.find(item => item?.userId === userId && item.channelId === channelId)
      if (preference?.mode === mode) return preference
      if (preference) preference.mode = mode
      else { preference = { userId, channelId, mode }; data.notificationPreferences.push(preference) }
      bumpReadRevision()
      saveDB()
      return preference
    },

    /* Roles */
    findRole(id) { return data.roles.find(r => r.id === id) },
    findRolesByServer(serverId) { return data.roles.filter(r => r.serverId === serverId) },
    findDefaultRole(serverId) { return data.roles.find(r => r.serverId === serverId && r.isDefault) },
    createRole(role) { data.roles.push(role); saveDB(); return role },
    updateRole(id, fields) {
      const idx = data.roles.findIndex(r => r.id === id)
      if (idx === -1) return null
      Object.assign(data.roles[idx], fields); saveDB(); return data.roles[idx]
    },
    deleteRole(id) {
      data.roles = data.roles.filter(r => r.id !== id)
      data.members.forEach(m => { m.roles = m.roles.filter(r => r !== id) })
      saveDB()
    },

    /* Members */
    findMember(serverId, userId) { return data.members.find(m => m.serverId === serverId && m.userId === userId) },
    findMembersByServer(serverId) { return data.members.filter(m => m.serverId === serverId) },
    findMembersByUser(userId) { return data.members.filter(m => m.userId === userId) },
    createMember(member) { data.members.push(member); saveDB(); return member },
    updateMember(serverId, userId, fields) {
      const member = data.members.find(m => m.serverId === serverId && m.userId === userId)
      if (!member) return null
      Object.assign(member, fields); saveDB(); return member
    },
    deleteMember(serverId, userId) {
      data.members = data.members.filter(m => !(m.serverId === serverId && m.userId === userId))
      saveDB()
    },

    /* Invites */
    findInvite(code) { return data.invites.find(i => i.code === code) },
    findInviteById(id) { return data.invites.find(i => i.id === id) },
    findInvitesByServer(serverId) { return data.invites.filter(i => i.serverId === serverId) },
    createInvite(invite) { data.invites.push(invite); saveDB(); return invite },
    updateInvite(id, fields) {
      const idx = data.invites.findIndex(i => i.id === id)
      if (idx === -1) return null
      Object.assign(data.invites[idx], fields); saveDB(); return data.invites[idx]
    },
    deleteInvite(id) {
      data.invites = data.invites.filter(i => i.id !== id); saveDB()
    },

    /* Friends */
    findFriend(userId, friendId) {
      return data.friends.find(f =>
        (f.userId === userId && f.friendId === friendId) ||
        (f.userId === friendId && f.friendId === userId)
      )
    },
    findFriendsByUser(userId) { return data.friends.filter(f => f.userId === userId || f.friendId === userId) },
    createFriend(rel) { data.friends.push(rel); saveDB(); return rel },
    updateFriend(id, fields) {
      const idx = data.friends.findIndex(f => f.id === id)
      if (idx === -1) return null
      Object.assign(data.friends[idx], fields); saveDB(); return data.friends[idx]
    },
    deleteFriend(id) {
      data.friends = data.friends.filter(f => f.id !== id); saveDB()
    }
  }
  return api
}
