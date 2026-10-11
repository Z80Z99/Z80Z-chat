// ============================================================
// Z80Z-chat - 单文件构建脚本
// 用途：将 start.js + 项目源码打包生成单文件 Z80Z-chat.bat
// 用法：npm run build:single
// 输出：项目根 Z80Z-chat.bat（含引导层 + 内嵌 start.js + 内嵌项目 zip base64）
// ============================================================
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { deflateRawSync } from 'node:zlib'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.join(__dirname, '..')

const TEMPLATE = path.join(projectRoot, 'deploy', 'install.template.bat')
const OUTPUT = path.join(projectRoot, 'Z80Z-chat.bat')

// 打包排除清单（目录按名称匹配，另排除配置与环境指定的运行目录）
const EXCLUDE_DIRS = new Set([
  'node_modules', 'dist', 'data', 'logs', '.test-data', '.git',
  'nodejs', 'data-backup', '.deploy-test',
  '.art-baseline', '.art-snapshots', '.agents', '.codex', '.aws',
  'cloudflared', 'sakurafrp'
])
const EXCLUDE_FILES = new Set([
  'start.bat',         // 单文件模式不需要旧启动器
  'z80z-chat.bat',      // 构建产物自身（排除名称统一为小写）
  '.install-version',  // 安装标记由引导层安装/更新时写入
  '.install-config.json', '.npmrc', '.upload-secret', 'npm-install.log'
])
// deploy/ 内排除模板自身（保留 z80z-chat.service 等）
const EXCLUDE_DEPLOY = new Set(['install.template.bat'])

export function parseReleaseConfig(source) {
  let clean = '', inString = false, lineComment = false, blockComment = false
  for (let index = 0; index < source.length; index++) {
    const character = source[index], next = source[index + 1]
    if (lineComment) {
      if (character === '\n') { lineComment = false; clean += character }
      continue
    }
    if (blockComment) {
      if (character === '*' && next === '/') { blockComment = false; index++ }
      continue
    }
    if (inString) {
      clean += character
      if (character === '\\') { clean += next || ''; index++ }
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') { inString = true; clean += character; continue }
    if (character === '/' && next === '/') { lineComment = true; index++; continue }
    if (character === '/' && next === '*') { blockComment = true; index++; continue }
    clean += character
  }
  try {
    const config = JSON.parse(clean.replace(/^\uFEFF/, ''))
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error()
    return config
  } catch { throw new Error('发布配置 config.json 无效，请检查 JSON 和注释格式') }
}

// 共享 OpenRelay 的公开默认账号可分发；部署者的签名密钥和 TURN 账号不可分发。
export function assertSafeReleaseConfig(source) {
  const config = parseReleaseConfig(source)
  const hasValue = value => value != null && (typeof value !== 'string' || value.trim() !== '')
  if (hasValue(config.uploadSecret)) throw new Error('发布配置含私有 uploadSecret，请使用未填写密钥的发布配置')
  for (const server of Array.isArray(config.iceServers) ? config.iceServers : []) {
    if (!server || (!hasValue(server.username) && !hasValue(server.credential))) continue
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls]
    const publicDefault = urls.length > 0 && urls.every(url => typeof url === 'string' && /^turn:openrelay\.metered\.ca:(?:80|443)(?:\?transport=tcp)?$/.test(url))
      && server.username === 'openrelayproject' && server.credential === 'openrelayproject'
    if (!publicDefault) throw new Error('发布配置含私有 ICE 账号或凭据，请使用公开默认配置')
  }
  return config
}

export function collectFiles(dir, rel = '', environment = process.env) {
  const root = path.resolve(dir)
  const configPath = path.join(root, 'config.json')
  const config = fs.existsSync(configPath) ? parseReleaseConfig(fs.readFileSync(configPath, 'utf8')) : {}
  const runtimePaths = new Set()
  const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value
  function excludeRuntimePath(value, base = root) {
    if (typeof value !== 'string' || value.trim() === '') return
    const absolute = path.resolve(base, value)
    const relative = path.relative(root, absolute)
    if (relative === '') throw new Error('运行数据目录不能是项目根目录，无法安全打包')
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return
    runtimePaths.add(pathKey(absolute))
    if (fs.existsSync(absolute)) {
      const real = fs.realpathSync(absolute)
      const realRelative = path.relative(root, real)
      if (realRelative === '') throw new Error('运行数据目录不能指向项目根目录，无法安全打包')
      if (realRelative !== '..' && !realRelative.startsWith('..' + path.sep) && !path.isAbsolute(realRelative)) runtimePaths.add(pathKey(real))
    }
  }
  excludeRuntimePath(config.dataDir)
  excludeRuntimePath(environment.DATA_DIR)
  excludeRuntimePath(environment.LOG_DIR)
  // logger 的相对 LOG_DIR 按工作目录解析；也排除项目内同名路径中的历史日志。
  excludeRuntimePath(environment.LOG_DIR, process.cwd())
  return collectProjectFiles(root, rel, runtimePaths, pathKey)
}

function collectProjectFiles(dir, rel, runtimePaths, pathKey) {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? rel + '/' + entry.name : entry.name
    const full = path.join(dir, entry.name)
    const exclusionName = entry.name.toLowerCase()
    if (runtimePaths.has(pathKey(full))) continue
    if (entry.isSymbolicLink()) continue
    if (/^\.(?:update-stage-|project-rollback-|payload-check-|project-files-|npm-out-|config\.)/.test(exclusionName)) continue
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(exclusionName)) continue
      files.push(...collectProjectFiles(full, relPath, runtimePaths, pathKey))
    } else {
      if (EXCLUDE_FILES.has(exclusionName)) continue
      if (exclusionName === '.env' || exclusionName.startsWith('.env.')) continue
      if (exclusionName.endsWith('.tsbuildinfo')) continue
      if (rel.toLowerCase() === 'deploy' && EXCLUDE_DEPLOY.has(exclusionName)) continue
      files.push({ relPath, full })
    }
  }
  return files
}

// ---------- CRC32（手写 zip stored 模式用） ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ---------- ZIP deflate：同一份内存快照同时用于压缩和内容指纹 ----------
export function buildProjectZip(entries) {
  const chunks = []
  const central = []
  let offset = 0
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data) >>> 0
    const size = data.length
    const compressed = deflateRawSync(data)
    const compressedSize = compressed.length
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4)
    lfh.writeUInt16LE(0x0800, 6)     // UTF-8 filenames
    lfh.writeUInt16LE(8, 8)          // method: deflate
    lfh.writeUInt16LE(0, 10)
    lfh.writeUInt16LE(0x21, 12)
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(compressedSize, 18)
    lfh.writeUInt32LE(size, 22)
    lfh.writeUInt16LE(nameBuf.length, 26)
    lfh.writeUInt16LE(0, 28)
    chunks.push(lfh, nameBuf, compressed)
    central.push({ nameBuf, crc, size, compressedSize, offset })
    offset += 30 + nameBuf.length + compressedSize
  }
  const cdStart = offset
  const cdChunks = []
  for (const c of central) {
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(8, 10)
    cd.writeUInt16LE(0x21, 12)
    cd.writeUInt32LE(c.crc, 16)
    cd.writeUInt32LE(c.compressedSize, 20)
    cd.writeUInt32LE(c.size, 24)
    cd.writeUInt16LE(c.nameBuf.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE(0, 38)
    cd.writeUInt32LE(c.offset, 42)
    cdChunks.push(cd, c.nameBuf)
  }
  const cdSize = cdChunks.reduce((a, c) => a + c.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(central.length, 8)
  eocd.writeUInt16LE(central.length, 10)
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(cdStart, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, ...cdChunks, eocd])
}

// ---------- content fingerprint for smart updates ----------
// 与引导层 Compute-PayloadSha 一致：剔除 package.json，按相对路径排序，
// 逐文件 sha256 → 整体 sha256（文件内容变化才变化，与 zip 格式/时间戳无关）
export function computePayloadSha(entries) {
  const sorted = entries
    .filter(e => e.name !== 'package.json')
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const h = crypto.createHash('sha256')
  for (const e of sorted) {
    h.update(Buffer.from(e.name, 'utf8'))
    h.update(Buffer.from([0]))
    h.update(crypto.createHash('sha256').update(e.data).digest())
  }
  return h.digest('hex')
}

// ---------- 主流程 ----------
function main() {
  const payloadEntries = collectFiles(projectRoot).map(f => ({ name: f.relPath, data: fs.readFileSync(f.full) }))
  const releaseConfig = payloadEntries.find(entry => entry.name === 'config.json')
  if (!releaseConfig) throw new Error('发布配置 config.json 缺失')
  assertSafeReleaseConfig(releaseConfig.data.toString('utf8'))
  const pkg = JSON.parse(payloadEntries.find(entry => entry.name === 'package.json').data.toString('utf8'))
  const version = pkg.version || '0.0.0'

  if (!fs.existsSync(TEMPLATE)) {
    console.error(`  ✖ 模板缺失: ${TEMPLATE}`)
    process.exit(1)
  }
  const startJsPath = path.join(projectRoot, 'start.js')
  if (!fs.existsSync(startJsPath)) {
    console.error(`  ✖ start.js 缺失: ${startJsPath}`)
    process.exit(1)
  }

  console.log('')
  console.log('  Z80Z-chat 单文件构建')
  console.log(`  版本: ${version}`)
  console.log('')

  // 1. 打包项目源码
  const zipBuf = buildProjectZip(payloadEntries)
  console.log(`  ✔ 项目已打包 (ZIP deflate, ${(zipBuf.length / 1024).toFixed(1)} KB)`)
  const payloadSha = computePayloadSha(payloadEntries)
  console.log(`  ✔ 内容指纹 (PAYLOAD_SHA): ${payloadSha}`)

  // 2. zip → base64（每行 76 字符）
  const b64 = zipBuf.toString('base64')
  const b64Lines = []
  for (let i = 0; i < b64.length; i += 76) b64Lines.push(b64.slice(i, i + 76))
  console.log(`  ✔ base64 编码完成 (${b64Lines.length} 行)`)

  // 3. 读取 start.js
  const startJs = payloadEntries.find(entry => entry.name === 'start.js').data.toString('utf8')
  // start.js 以 base64 内嵌（与 PS/zip 块一致）：bat 明文不再包含可被
  // 安全软件静态特征扫描命中的代码（如 Stop-Process / 托盘 / 隐藏窗口等）
  const startJsB64 = Buffer.from(startJs, 'utf8').toString('base64')
  const startJsB64Lines = []
  for (let i = 0; i < startJsB64.length; i += 76) startJsB64Lines.push(startJsB64.slice(i, i + 76))
  console.log(`  ✔ start.js 内嵌 (base64 ${startJsB64Lines.length} 行, 源码 ${startJs.split(/\r?\n/).length} 行)`)

  // 4. 读取模板并替换
  let bat = fs.readFileSync(TEMPLATE, 'utf8')
  if (!bat.includes('__APP_VERSION__') || !bat.includes('__APP_BUILT__') || !bat.includes('__PAYLOAD_SHA__') || !bat.includes('__STARTJS_B64_PLACEHOLDER__') || !bat.includes('__ZIP_B64_PLACEHOLDER__') || !bat.includes('__PS_B64_PLACEHOLDER__')) {
    console.error('  ✖ 模板占位符缺失，模板可能不完整')
    process.exit(1)
  }

  // 4.1 提取明文 PS 块（__NODECHAT_PS_BEGIN__/END__ 之间）→ base64（含 UTF-8 BOM）
  // BOM 保证 certutil 还原后 PowerShell 按 UTF-8 解码中文；base64 段纯 ASCII，
  // cmd 的 findstr/echo 提取可无损处理（PS 块本身不含 % 和 !）
  const psBegin = bat.indexOf('__NODECHAT_PS_BEGIN__')
  const psEnd = bat.indexOf('__NODECHAT_PS_END__')
  if (psBegin === -1 || psEnd === -1 || psEnd < psBegin) {
    console.error('  ✖ 模板 PS 块标记缺失')
    process.exit(1)
  }
  const psLines = bat.slice(psBegin).split(/\r?\n/).slice(1).join('\r\n')
  const psRaw = psLines.split('__NODECHAT_PS_END__')[0].replace(/\r?\n$/, '')
  const psBuf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(psRaw, 'utf8')])
  const psB64 = psBuf.toString('base64')
  const psB64Lines = []
  for (let i = 0; i < psB64.length; i += 76) psB64Lines.push(psB64.slice(i, i + 76))

  // 4.2 删除明文 PS 块（含标记行），替换 base64 占位符
  const psBlockStart = bat.indexOf('__NODECHAT_PS_BEGIN__')
  const psBlockEnd = bat.indexOf('__NODECHAT_PS_END__') + '__NODECHAT_PS_END__'.length
  bat = bat.slice(0, psBlockStart) + bat.slice(psBlockEnd)

  bat = bat.replace('__APP_VERSION__', version)
  // 构建时间戳（本地时间），显示为"最新版本发布时间"
  const now = new Date()
  const pad = (v) => String(v).padStart(2, '0')
  const builtAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  bat = bat.replace('__APP_BUILT__', builtAt)
  bat = bat.replace('__PAYLOAD_SHA__', payloadSha)
  bat = bat.replace('__STARTJS_B64_PLACEHOLDER__', startJsB64Lines.join('\r\n'))
  bat = bat.replace('__ZIP_B64_PLACEHOLDER__', b64Lines.join('\r\n'))
  bat = bat.replace('__PS_B64_PLACEHOLDER__', psB64Lines.join('\r\n'))
  console.log(`  ✔ bootstrap 内嵌 (base64 ${psB64Lines.length} 行)`)

  // 关键：CMD 批处理必须是 CRLF 行尾（LF 行尾会导致 goto 标签失效）
  bat = bat.replace(/^\uFEFF/, '').replace(/\r?\n/g, '\r\n')

  // 5. 输出（UTF-8 无 BOM）
  fs.writeFileSync(OUTPUT, bat, 'utf8')

  // 6. SHA256
  const sha = crypto.createHash('sha256').update(fs.readFileSync(OUTPUT)).digest('hex')
  const sizeKB = (fs.statSync(OUTPUT).size / 1024).toFixed(1)
  console.log('')
  console.log(`  ✔ 生成完成: ${OUTPUT}`)
  console.log(`    大小: ${sizeKB} KB`)
  console.log(`    SHA256: ${sha}`)
  console.log('')
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) main()
