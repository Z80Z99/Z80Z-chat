import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import WebSocket from 'ws'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = path.join(__dirname, '..')

// 测试数据根目录：移入项目内（避免系统 Temp 活动，降低杀软启发式误报概率）
const TEST_DATA_ROOT = path.join(PROJECT_ROOT, '.test-data')

// 每个测试文件随机独立端口（3100~3899），支持并行执行
export const TEST_PORT = 3100 + Math.floor(Math.random() * 800)

let proc = null
let tmpDataDir = null
let logs = ''

export const sleep = (ms) => new Promise(r => setTimeout(r, ms))

export function getDataDir() {
  return tmpDataDir
}

export async function startServer() {
  if (!tmpDataDir) {
    fs.mkdirSync(TEST_DATA_ROOT, { recursive: true })
    tmpDataDir = fs.mkdtempSync(path.join(TEST_DATA_ROOT, 'z80z-chat-test-'))
  }
  logs = ''
  proc = spawn(process.execPath, ['server.js'], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(TEST_PORT), DATA_DIR: tmpDataDir }
  })
  proc.stdout.on('data', d => { logs += d.toString() })
  proc.stderr.on('data', d => { logs += d.toString() })
  await waitReady()
}

// 等待 db.json 满足条件（防抖写入后测试需等待落盘，5s 超时）
export async function waitForDB(predicate, timeoutMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const db = JSON.parse(fs.readFileSync(path.join(tmpDataDir, 'db.json'), 'utf8'))
      if (predicate(db)) return db
    } catch {}
    await sleep(50)
  }
  throw new Error('waitForDB 超时：db.json 未满足条件')
}

export async function waitReady() {
  for (let i = 0; i < 60; i++) {
    if (proc && proc.exitCode !== null) {
      throw new Error('server exited early:\n' + logs.slice(-800))
    }
    try {
      const r = await fetch(`http://localhost:${TEST_PORT}/api/version`)
      if (r.ok) return
    } catch {}
    await sleep(300)
  }
  throw new Error('server not ready:\n' + logs.slice(-800))
}

export async function stopServer({ keepData = false } = {}) {
  if (proc) {
    const p = proc
    proc = null
    p.kill()
    await Promise.race([
      new Promise(r => p.on('exit', r)),
      sleep(3000)
    ])
  }
  if (!keepData && tmpDataDir) {
    fs.rmSync(tmpDataDir, { recursive: true, force: true })
    tmpDataDir = null
    // 根目录为空时移除（非 recursive，避免并行文件互删）
    try { fs.rmdirSync(TEST_DATA_ROOT) } catch {}
  }
}

// 重启进程但保留数据目录（用于篡改 db.json 后重载数据的场景）
export async function restartServer() {
  await stopServer({ keepData: true })
  await startServer()
}

// 通用 API 请求封装
export async function api(pathname, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = 'Bearer ' + token
  const res = await fetch(`http://localhost:${TEST_PORT}/api${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}

export async function register(username, password = 'test1234') {
  const r = await api('/auth/register', { method: 'POST', body: { username, password } })
  if (r.status !== 200) throw new Error('register failed: ' + JSON.stringify(r.data))
  return r.data
}

export async function login(username, password = 'test1234') {
  const r = await api('/auth/login', { method: 'POST', body: { username, password } })
  return r.data
}

// 创建服务器并返回文字频道
export async function createTestServer(token, name = '测试服务器') {
  const r = await api('/servers/create', { method: 'POST', body: { name }, token })
  if (r.status !== 200) throw new Error('create server failed: ' + JSON.stringify(r.data))
  const srv = r.data.server
  const ch = await api('/channels/list/' + srv.id, { token })
  const textChannel = ch.data.channels.find(c => c.type === 'text')
  return { server: srv, textChannel }
}

// owner 邀请用户加入服务器，返回加入结果
export async function inviteAndJoin(ownerToken, memberToken, serverId) {
  const inv = await api('/invites/create', { method: 'POST', body: { serverId }, token: ownerToken })
  const join = await api('/servers/join', { method: 'POST', body: { code: inv.data.invite.code }, token: memberToken })
  return join
}

// 直接读写测试数据目录中的 db.json（供篡改场景使用，配合 restartServer）
export function readDB() {
  return JSON.parse(fs.readFileSync(path.join(tmpDataDir, 'db.json'), 'utf8'))
}

export function writeDB(data) {
  fs.writeFileSync(path.join(tmpDataDir, 'db.json'), JSON.stringify(data))
}

// WebSocket 连接（open 时 resolve，失败时 close 事件带错误码）
export function wsConnect(token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws?token=${token}`)
    ws.on('open', () => resolve(ws))
  })
}

export function wsConnectExpectClose(token, expectCode) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws?token=${token}`)
    ws.on('close', (code) => resolve({ code, ws }))
    ws.on('error', () => {})
  })
}
