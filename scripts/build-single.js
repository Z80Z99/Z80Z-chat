// ============================================================
// Z80Z-chat - 单文件构建脚本
// 用途：将 start.js + 项目源码打包生成单文件 Z80Z-chat.bat
// 用法：npm run build:single
// 输出：项目根 Z80Z-chat.bat（含引导层 + 内嵌 start.js + 内嵌项目 zip base64）
// ============================================================
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import os from 'os'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.join(__dirname, '..')

const TEMPLATE = path.join(projectRoot, 'deploy', 'install.template.bat')
const OUTPUT = path.join(projectRoot, 'Z80Z-chat.bat')

// 打包排除清单（相对项目根，目录按名前缀匹配）
const EXCLUDE_DIRS = new Set([
  'node_modules', 'dist', 'data', 'logs', '.test-data', '.git',
  'nodejs', 'data-backup', '.deploy-test',
  '.art-baseline', '.art-snapshots'
])
const EXCLUDE_FILES = new Set([
  'start.js',          // 单独内嵌到模板，不打包
  'start.bat',         // 单文件模式不需要旧启动器
  'Z80Z-chat.bat',      // 构建产物自身
  'Z80Z-chat-DEMO.bat', // 演示版构建产物
  'package-lock.json', // 锁文件由引导层 npm install 时重新生成
  '.install-version'   // 安装标记由引导层安装/更新时写入
])
// deploy/ 内排除模板自身（保留 z80z-chat.service 等）
const EXCLUDE_DEPLOY = new Set(['install.template.bat'])

function collectFiles(dir, rel = '') {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? rel + '/' + entry.name : entry.name
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue
      files.push(...collectFiles(full, relPath))
    } else {
      if (EXCLUDE_FILES.has(entry.name)) continue
      if (rel === 'deploy' && EXCLUDE_DEPLOY.has(entry.name)) continue
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

// ---------- 手写 stored zip（无压缩，跨平台兜底） ----------
function buildStoredZip(entries) {
  const chunks = []
  const central = []
  let offset = 0
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data) >>> 0
    const size = data.length
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4)
    lfh.writeUInt16LE(0, 6)
    lfh.writeUInt16LE(0, 8)          // method: stored
    lfh.writeUInt16LE(0, 10)
    lfh.writeUInt16LE(0x21, 12)
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(size, 18)
    lfh.writeUInt32LE(size, 22)
    lfh.writeUInt16LE(nameBuf.length, 26)
    lfh.writeUInt16LE(0, 28)
    chunks.push(lfh, nameBuf, data)
    central.push({ nameBuf, crc, size, offset })
    offset += 30 + nameBuf.length + size
  }
  const cdStart = offset
  const cdChunks = []
  for (const c of central) {
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0, 8)
    cd.writeUInt16LE(0, 10)
    cd.writeUInt16LE(0x21, 12)
    cd.writeUInt32LE(c.crc, 16)
    cd.writeUInt32LE(c.size, 20)
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

// ---------- 生成项目 zip ----------
function buildProjectZip() {
  const files = collectFiles(projectRoot)
  const entries = files.map(f => ({
    name: f.relPath,
    data: fs.readFileSync(f.full)
  }))

  // Windows 优先用系统 Compress-Archive（体积小），失败回退手写 stored zip
  if (os.platform() === 'win32') {
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'z80z-chat-pack-'))
      for (const e of entries) {
        const dest = path.join(tmp, e.name)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, e.data)
      }
      const zipPath = path.join(tmp, 'project.zip')
      const script = `Compress-Archive -Path '${tmp}\\*' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`
      execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '\\"')}"`, { stdio: 'ignore' })
      const zipBuf = fs.readFileSync(zipPath)
      fs.rmSync(tmp, { recursive: true, force: true })
      console.log(`  ✔ 项目已打包 (Compress-Archive, ${(zipBuf.length / 1024).toFixed(1)} KB)`)
      return zipBuf
    } catch {
      console.log('  ℹ Compress-Archive 不可用，改用内置打包')
    }
  }
  const zipBuf = buildStoredZip(entries)
  console.log(`  ✔ 项目已打包 (内置 stored zip, ${(zipBuf.length / 1024).toFixed(1)} KB)`)
  return zipBuf
}

// ---------- content fingerprint for smart updates ----------
// 与引导层 Compute-PayloadSha 一致：剔除 package.json，按相对路径排序，
// 逐文件 sha256 → 整体 sha256（文件内容变化才变化，与 zip 格式/时间戳无关）
function computePayloadSha(entries) {
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
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
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
  const zipBuf = buildProjectZip()
  // 内容指纹（与 zip 打包方式无关，供引导层智能更新比对）
  const payloadEntries = collectFiles(projectRoot).map(f => ({ name: f.relPath, data: fs.readFileSync(f.full) }))
  const payloadSha = computePayloadSha(payloadEntries)
  console.log(`  ✔ 内容指纹 (PAYLOAD_SHA): ${payloadSha}`)

  // 2. zip → base64（每行 76 字符）
  const b64 = zipBuf.toString('base64')
  const b64Lines = []
  for (let i = 0; i < b64.length; i += 76) b64Lines.push(b64.slice(i, i + 76))
  console.log(`  ✔ base64 编码完成 (${b64Lines.length} 行)`)

  // 3. 读取 start.js
  const startJs = fs.readFileSync(startJsPath, 'utf8')
  console.log(`  ✔ start.js 内嵌 (${startJs.split(/\r?\n/).length} 行)`)

  // 4. 读取模板并替换
  let bat = fs.readFileSync(TEMPLATE, 'utf8')
  if (!bat.includes('__APP_VERSION__') || !bat.includes('__APP_BUILT__') || !bat.includes('__PAYLOAD_SHA__') || !bat.includes('__STARTJS_PLACEHOLDER__') || !bat.includes('__ZIP_B64_PLACEHOLDER__') || !bat.includes('__PS_B64_PLACEHOLDER__')) {
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
  bat = bat.replace('__STARTJS_PLACEHOLDER__', startJs.replace(/\r?\n/g, '\r\n').trimEnd())
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

main()
