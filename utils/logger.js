// ============================================================
// NodeChat - 日志模块
// 用途：应用日志（app.log / error.log）控制台+文件双输出，5MB 自动轮转
// 来源：NodeChat v1.0.0 合法项目代码
// 说明：如被杀毒软件误报（启发式误报），请将项目目录加入信任区
// ============================================================
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_LOG_DIR = path.join(__dirname, '..', 'logs')
const DEFAULT_MAX_SIZE = 5 * 1024 * 1024

// 日志目录：默认项目 logs/，可通过环境变量覆盖（测试隔离用）
export function getLogDir() {
  return process.env.LOG_DIR || DEFAULT_LOG_DIR
}

// 轮转阈值：默认 5MB，可通过环境变量覆盖（测试用）
export function getMaxSize() {
  const v = Number(process.env.LOG_MAX_SIZE)
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_MAX_SIZE
}

function ensureDir() {
  try {
    fs.mkdirSync(getLogDir(), { recursive: true })
  } catch {}
}

// 轮转：文件超过阈值时重命名为 <file>.old（旧的 .old 被覆盖，保留最新一份历史）
function rotateIfNeeded(file) {
  const full = path.join(getLogDir(), file)
  try {
    const stat = fs.statSync(full)
    if (stat.size > getMaxSize()) {
      const old = full + '.old'
      try { fs.unlinkSync(old) } catch {}
      fs.renameSync(full, old)
    }
  } catch {}
}

function write(level, file, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`
  // 控制台输出：与文件格式一致（去掉尾随换行），保留原有 console 通道
  const consoleLine = line.slice(0, -1)
  if (level === 'ERROR') {
    console.error(consoleLine)
  } else if (level === 'WARN') {
    console.warn(consoleLine)
  } else {
    console.log(consoleLine)
  }
  // 文件写入：失败不影响主程序；写入后检查大小并轮转
  try {
    ensureDir()
    fs.appendFileSync(path.join(getLogDir(), file), line, 'utf8')
    rotateIfNeeded(file)
  } catch {}
}

export const logger = {
  info(msg) { write('INFO', 'app.log', msg) },
  warn(msg) { write('WARN', 'app.log', msg) },
  error(msg) { write('ERROR', 'error.log', msg) }
}
