// ============================================================
// NodeChat - JSON 数据库模块
// 用途：内存数据 + 原子写入（临时文件 + fsync + rename）
//       写入采用防抖合并（200ms），退出时通过 flush() 强制落盘
// 来源：NodeChat v1.0.0 合法项目代码
// 说明：如被杀毒软件误报（启发式误报），请将项目目录加入信任区
// ============================================================
import fs from 'fs'
import { dataDir, dbPath, uploadDir } from '../config/index.js'
import { logger } from '../utils/logger.js'

const defaultData = {
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

let dirty = false
let flushTimer = null

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
      data = JSON.parse(fs.readFileSync(dbPath, 'utf-8'))
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

// 原子写入核心：写临时文件 → fsync → rename 原子替换
// 任何一步失败都不会破坏现有 db.json；silent=true（防抖后台写）仅记录日志，
// silent=false（首次初始化/主动 flush）失败时抛出，由调用方决定处理
function writeAtomic(silent = false) {
  try {
    fs.writeFileSync(TMP_PATH, JSON.stringify(data, null, 2), 'utf8')
    try {
      const fd = fs.openSync(TMP_PATH, 'r')
      try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    } catch {}
    fs.renameSync(TMP_PATH, dbPath)
  } catch (e) {
    try { fs.rmSync(TMP_PATH, { force: true }) } catch {}
    logger.error('数据库写入失败（旧数据已保留）: ' + (e?.message || e))
    if (!silent) throw e
  }
}

// 防抖保存：短时间内的多次写操作合并为一次落盘（保留原 API 名称与调用点）
function saveDB() {
  dirty = true
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    if (dirty) {
      dirty = false
      writeAtomic(true) // 后台写失败仅记录日志，不中断服务
    }
  }, FLUSH_DELAY)
  flushTimer.unref?.()
}

// 强制同步落盘（优雅关闭 / 手动调用 / 首次初始化）
function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (dirty) {
    dirty = false
    writeAtomic()
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
      // createdAt 为 ISO 8601 字符串，字典序即时间序，避免 new Date 开销
      return msgs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)
    },
    createMessage(msg) { data.messages.push(msg); saveDB(); return msg },
    updateMessage(id, fields) {
      const idx = data.messages.findIndex(m => m.id === id)
      if (idx === -1) return null
      Object.assign(data.messages[idx], fields); saveDB(); return data.messages[idx]
    },
    deleteMessage(id) {
      data.messages = data.messages.filter(m => m.id !== id); saveDB()
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
