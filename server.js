// ============================================================
// NodeChat - 服务入口
// 用途：Express + WebSocket 服务（CORS/JSON/路由/静态/SPA）
//       含全局错误处理、优雅关闭、全局异常捕获、日志接入
// 来源：NodeChat v1.0.0 合法项目代码
// 说明：如被杀毒软件误报（启发式误报），请将项目目录加入信任区
// ============================================================
import express from 'express'
import cors from 'cors'
import http from 'http'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { WebSocketServer } from 'ws'
import config, { dataDir, uploadDir } from './config/index.js'
import { initDB } from './models/db.js'
import { handleWebSocket } from './websocket/index.js'
import { logger } from './utils/logger.js'
import { verifyUploadSig, signUploadUrlsDeep } from './utils/uploadSign.js'

import authRoutes from './routes/auth.js'
import serverRoutes from './routes/servers.js'
import channelRoutes from './routes/channels.js'
import categoryRoutes from './routes/categories.js'
import messageRoutes from './routes/messages.js'
import roleRoutes from './routes/roles.js'
import memberRoutes from './routes/members.js'
import inviteRoutes from './routes/invites.js'
import friendRoutes from './routes/friends.js'
import userRoutes from './routes/users.js'
import uploadRoutes from './routes/upload.js'
import configRoutes from './routes/config.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const server = http.createServer(app)

// corsOrigins 已被 normalize 为数组；'*' 时反射请求来源，保持原意图
const corsOrigins = config.corsOrigins
app.use(cors({ origin: corsOrigins.length === 1 && corsOrigins[0] === '*' ? true : corsOrigins }))
app.use(express.json({ limit: `${config.bodyLimitMB}mb` }))
app.use(express.urlencoded({ extended: true, limit: `${config.bodyLimitMB}mb` }))

const db = await initDB()
app.locals.db = db

const wss = new WebSocketServer({ server, path: config.wsPath })
app.locals.wss = wss
handleWebSocket(wss, db)

// /api 响应出口统一签名：所有 /uploads/ URL 附带短期签名（防止未授权访问）
app.use('/api', (req, res, next) => {
  const origJson = res.json.bind(res)
  res.json = (body) => origJson(signUploadUrlsDeep(body))
  next()
})

// /uploads 改为签名访问：无有效签名一律 403（静态托管移除，避免未授权读取）
app.get('/uploads/:filename', (req, res) => {
  const { filename } = req.params
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename)) {
    return res.status(400).json({ error: '非法文件名' })
  }
  const { expires, sig } = req.query
  const url = '/uploads/' + filename
  if (!verifyUploadSig(url, expires, sig)) {
    return res.status(403).json({ error: '链接无效或已过期' })
  }
  res.sendFile(filename, { root: uploadDir }, (err) => {
    if (err && !res.headersSent) {
      logger.warn(`上传文件访问失败 ${filename}: ${err?.message || err}`)
      res.status(404).json({ error: '文件不存在' })
    }
  })
})
app.use('/api/auth', authRoutes)
app.use('/api/users', userRoutes)
app.use('/api/servers', serverRoutes)
app.use('/api/channels', channelRoutes)
app.use('/api/categories', categoryRoutes)
app.use('/api/messages', messageRoutes)
app.use('/api/roles', roleRoutes)
app.use('/api/members', memberRoutes)
app.use('/api/invites', inviteRoutes)
app.use('/api/friends', friendRoutes)
app.use('/api/upload', uploadRoutes)
app.use('/api/config', configRoutes)

const distPath = path.join(__dirname, 'dist')
app.use(express.static(distPath))

app.get('/api/version', (req, res) => {
  try {
    const stats = fs.statSync(path.join(distPath, 'index.html'))
    res.json({ version: stats.mtimeMs })
  } catch {
    res.json({ version: 0 })
  }
})

// SPA 路由 + API 404 兜底（覆盖所有 HTTP 方法，统一返回 JSON 错误）
app.all('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) {
    return res.status(404).json({ error: '接口不存在' })
  }
  if (req.method === 'GET') {
    return res.sendFile(path.join(distPath, 'index.html'))
  }
  res.status(404).json({ error: '接口不存在' })
})

// 全局错误处理：统一 JSON 错误格式，避免前端收到 HTML 错误页
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求体 JSON 格式错误' })
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: '请求体过大' })
  }
  logger.error(`请求异常 ${req.method} ${req.path}: ${err?.stack || err?.message || err}`)
  res.status(500).json({ error: '服务器内部错误' })
})

// 启动横幅：动态计算显示宽度（中文按2字符），避免框线错位
function dispWidth(s) {
  return [...s].reduce((w, ch) => w + (ch.codePointAt(0) > 0x7e ? 2 : 1), 0)
}

const BANNER_W = 32
const bannerLine = (text) => '  ║  ' + text + ' '.repeat(Math.max(0, BANNER_W - dispWidth(text))) + '  ║'
const bannerTop = '  ╔' + '═'.repeat(36) + '╗'
const bannerMid = '  ╠' + '═'.repeat(36) + '╣'
const bannerBot = '  ╚' + '═'.repeat(36) + '╝'

server.listen(config.port, config.host, () => {
  console.log(`\n${bannerTop}`)
  console.log(bannerLine(`${config.siteName} v1.0.0`))
  console.log(bannerLine('Discord-style Community Chat'))
  console.log(bannerMid)
  console.log(bannerLine(`Server: http://localhost:${config.port}`))
  console.log(bannerLine(`WebSocket: ws://localhost:${config.port}${config.wsPath}`))
  console.log(bannerBot)
  console.log(`  ──────────────────────────────────────`)
  console.log(`  数据目录: ${dataDir}`)
  console.log(`  上传目录: ${uploadDir}`)
  console.log(`  配置来源: config.json（部署脚本 start.js 管理端口与防火墙）\n`)
  logger.info(`服务启动成功: http://localhost:${config.port}（${config.siteName} v1.0.0）`)
})

/* ────────────────────────── 优雅关闭 ────────────────────────── */

let shuttingDown = false
let shutdownTimer = null

function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info(`收到 ${signal}，正在优雅关闭 ...`)

  // 1. 停止接受新的 HTTP 请求
  server.close(() => {
    logger.info('HTTP 服务已关闭')
    clearTimeout(shutdownTimer)
    process.exit(0)
  })
  // 释放空闲 keep-alive 连接，避免 close 回调挂起
  if (typeof server.closeIdleConnections === 'function') {
    server.closeIdleConnections()
  }

  // 2. 通知 WebSocket 客户端并关闭连接
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      try {
        client.send(JSON.stringify({ type: 'server-closing', reason: 'server shutting down' }))
      } catch {}
    }
    client.close(1001, 'server shutting down')
  })

  // 3. 数据库落盘（防抖写入的强制 flush，确保数据不丢）
  try {
    db.save()
  } catch (e) {
    logger.error('关闭时数据库保存失败: ' + (e?.message || e))
  }

  // 4. 超时兜底：5 秒后强制退出，避免进程挂死
  shutdownTimer = setTimeout(() => {
    logger.error('关闭超时（5s），强制退出')
    process.exit(1)
  }, 5000)
  shutdownTimer.unref?.()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGBREAK', () => shutdown('SIGBREAK'))

// 全局异常：记录日志并触发优雅关闭，避免静默退出
process.on('uncaughtException', (err) => {
  logger.error('未捕获异常: ' + (err?.stack || err?.message || err))
  shutdown('uncaughtException')
})

process.on('unhandledRejection', (reason) => {
  logger.error('未处理的 Promise 拒绝: ' + (reason?.stack || reason?.message || reason))
  shutdown('unhandledRejection')
})
