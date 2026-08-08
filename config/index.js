import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CONFIG_PATH = path.join(__dirname, '..', 'config.json')

const defaults = {
  siteName: 'Z80Z-chat',
  port: 3000,
  host: '0.0.0.0',
  dataDir: 'data',
  dbFile: 'db.json',
  uploadDir: 'uploads',
  maxUploadSizeMB: 10,
  allowedUploadTypes: 'jpeg|jpg|png|gif|webp|mp4|mp3|pdf|zip|txt|doc|docx',
  bodyLimitMB: 50,
  corsOrigins: '*',
  wsPath: '/ws',
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  firewall: { enabled: true, ruleName: 'Z80Z-chat' },
  backupKeep: 3,
  uploadUrlExpiresSec: 604800,
  uploadSecret: '',
  nodeVersion: '22',
  nodeMirror: '',
  npmRegistry: ''
}

function stripComments(src) {
  let out = ''
  let inString = false
  let inLineComment = false
  let inBlockComment = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const next = src[i + 1]

    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false
        out += c
      }
      continue
    }

    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false
        i++
      }
      continue
    }

    if (inString) {
      out += c
      if (c === '\\') {
        out += next || ''
        i++
      } else if (c === '"') {
        inString = false
      }
      continue
    }

    if (c === '"') {
      inString = true
      out += c
      continue
    }

    if (c === '/' && next === '/') {
      inLineComment = true
      i++
      continue
    }

    if (c === '/' && next === '*') {
      inBlockComment = true
      i++
      continue
    }

    out += c
  }
  return out
}

function deepMerge(target, source) {
  if (Array.isArray(source)) return source
  if (typeof source === 'object' && source !== null) {
    for (const key of Object.keys(source)) {
      if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key]) && target[key] && typeof target[key] === 'object') {
        deepMerge(target[key], source[key])
      } else {
        target[key] = source[key]
      }
    }
  }
  return target
}

function normalize(config) {
  if (typeof config.host !== 'string' || config.host.trim() === '') {
    config.host = '0.0.0.0'
  }
  if (typeof config.corsOrigins === 'string') {
    config.corsOrigins = config.corsOrigins.split(',').map(s => s.trim()).filter(Boolean)
  }
  if (!Array.isArray(config.iceServers) || config.iceServers.length === 0) {
    config.iceServers = defaults.iceServers
  }
  return config
}

function loadConfig() {
  const config = JSON.parse(JSON.stringify(defaults))

  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
      const parsed = JSON.parse(stripComments(raw))
      deepMerge(config, parsed)
    } catch (e) {
      console.error('')
      console.error('  ╔══════════════════════════════════════════════════════╗')
      console.error('  ║  config.json 配置文件解析失败！                        ║')
      console.error(`  ║  ${String(e.message || e).slice(0, 52)}`)
      console.error('  ║                                                      ║')
      console.error('  ║  请检查 config.json 的格式（引号/逗号/注释），          ║')
      console.error('  ║  或直接删除该文件，重启后会自动生成默认配置。            ║')
      console.error('  ╚══════════════════════════════════════════════════════╝')
      console.error('')
      process.exit(1)
    }
  } else {
    fs.writeFileSync(CONFIG_PATH, `{\n  "port": ${defaults.port},\n  "host": "${defaults.host}"\n}\n`)
  }

  if (process.env.PORT) config.port = Number(process.env.PORT) || config.port
  if (process.env.HOST) config.host = process.env.HOST
  if (process.env.DATA_DIR) config.dataDir = process.env.DATA_DIR

  return normalize(config)
}

const config = loadConfig()

// 运行时重新加载 config.json（编辑配置后无需重启进程）。
// 将新解析结果合并进导出的 config 对象，所有引用处自动生效。
// 注意：projectRoot/dataDir 等路径常量基于首次加载值，不随重载变化。
export function reloadConfig() {
  const next = loadConfig()
  Object.assign(config, next)
}

export const projectRoot = path.join(__dirname, '..')
export const dataDir = path.isAbsolute(config.dataDir) ? config.dataDir : path.join(projectRoot, config.dataDir)
export const dbPath = path.join(dataDir, config.dbFile)
export const uploadDir = path.join(dataDir, config.uploadDir)

export default config
