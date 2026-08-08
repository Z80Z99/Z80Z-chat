// ============================================================
// Z80Z-chat - DEMO 单文件构建脚本（纯模拟版本）
// 用法：node scripts/build-demo.js
// 输出：项目根 Z80Z-chat-DEMO.bat（引导层模拟 + 内嵌 demo-start.js）
// 特点：不打包项目 zip；所有流程均为模拟，零副作用
// ============================================================
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.join(__dirname, '..')

const TEMPLATE = path.join(projectRoot, 'deploy', 'install.template.demo.bat')
const DEMO_PS = path.join(projectRoot, 'scripts', 'demo-bootstrap.ps1')
const DEMO_JS = path.join(projectRoot, 'scripts', 'demo-start.js')
const OUTPUT = path.join(projectRoot, 'Z80Z-chat-DEMO.bat')

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  const version = pkg.version + '-demo'

  for (const f of [TEMPLATE, DEMO_PS, DEMO_JS]) {
    if (!fs.existsSync(f)) {
      console.error(`  ✖ 缺失: ${f}`)
      process.exit(1)
    }
  }

  console.log('')
  console.log('  Z80Z-chat DEMO 单文件构建（纯模拟）')
  console.log(`  版本: ${version}`)
  console.log('')

  let bat = fs.readFileSync(TEMPLATE, 'utf8')
  const required = ['__APP_VERSION__', '__APP_BUILT__', '__STARTJS_PLACEHOLDER__', '__ZIP_B64_PLACEHOLDER__', '__PS_B64_PLACEHOLDER__']
  if (!required.every(r => bat.includes(r))) {
    console.error('  ✖ 模板占位符缺失，模板可能不完整')
    process.exit(1)
  }

  // 1. 用 demo-bootstrap.ps1 替换模板中的 PS 明文块
  const psBeginMark = bat.indexOf('__NODECHAT_PS_BEGIN__')
  const psEndMark = bat.indexOf('__NODECHAT_PS_END__') + '__NODECHAT_PS_END__'.length
  if (psBeginMark === -1 || psEndMark === -1) {
    console.error('  ✖ 模板 PS 块标记缺失')
    process.exit(1)
  }
  const demoPs = fs.readFileSync(DEMO_PS, 'utf8').replace(/^\uFEFF/, '')
  bat = bat.slice(0, psBeginMark) + '__NODECHAT_PS_BEGIN__\r\n' + demoPs.replace(/\r?\n/g, '\r\n').trimEnd() + '\r\n__NODECHAT_PS_END__' + bat.slice(psEndMark)

  // 2. PS 明文 → base64（含 UTF-8 BOM，运行时按 UTF-8 解码）
  const psBegin = bat.indexOf('__NODECHAT_PS_BEGIN__')
  const psEnd = bat.indexOf('__NODECHAT_PS_END__')
  const psLines = bat.slice(psBegin).split(/\r?\n/).slice(1).join('\r\n')
  const psRaw = psLines.split('__NODECHAT_PS_END__')[0].replace(/\r?\n$/, '')
  const psBuf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(psRaw, 'utf8')])
  const psB64 = psBuf.toString('base64')
  const psB64Lines = []
  for (let i = 0; i < psB64.length; i += 76) psB64Lines.push(psB64.slice(i, i + 76))

  const psBlockStart = bat.indexOf('__NODECHAT_PS_BEGIN__')
  const psBlockEnd = bat.indexOf('__NODECHAT_PS_END__') + '__NODECHAT_PS_END__'.length
  bat = bat.slice(0, psBlockStart) + bat.slice(psBlockEnd)

  // 3. 占位符替换
  bat = bat.replace('__APP_VERSION__', version)
  const now = new Date()
  const pad = (v) => String(v).padStart(2, '0')
  const builtAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  bat = bat.replace('__APP_BUILT__', builtAt)
  bat = bat.replace('__STARTJS_PLACEHOLDER__', fs.readFileSync(DEMO_JS, 'utf8').replace(/^\uFEFF/, '').replace(/\r?\n/g, '\r\n').trimEnd())
  bat = bat.replace('__ZIP_B64_PLACEHOLDER__', '')
  bat = bat.replace('__PS_B64_PLACEHOLDER__', psB64Lines.join('\r\n'))
  console.log(`  ✔ bootstrap 内嵌 (base64 ${psB64Lines.length} 行)`)
  console.log(`  ✔ demo-start.js 内嵌 (${fs.readFileSync(DEMO_JS, 'utf8').split(/\r?\n/).length} 行)`)

  // 4. CRLF 归一 + 无 BOM
  bat = bat.replace(/^\uFEFF/, '').replace(/\r?\n/g, '\r\n')
  fs.writeFileSync(OUTPUT, bat, 'utf8')

  const sha = crypto.createHash('sha256').update(fs.readFileSync(OUTPUT)).digest('hex')
  console.log('')
  console.log(`  ✔ 生成完成: ${OUTPUT}`)
  console.log(`    大小: ${(fs.statSync(OUTPUT).size / 1024).toFixed(1)} KB`)
  console.log(`    SHA256: ${sha}`)
  console.log('')
}

main()
