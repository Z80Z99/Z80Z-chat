// ============================================================
// Z80Z-chat - 手动备份脚本
// 用途：复制 data/db.json 到 data/backups/db-YYYYMMDD-HHmmssSSS.json
// 用法：npm run backup
// 来源：Z80Z-chat v1.0.0 合法项目代码
// 说明：如被杀毒软件误报（启发式误报），请将项目目录加入信任区
// ============================================================
import fs from 'fs'
import path from 'path'
import { dataDir, dbPath } from '../config/index.js'

const backupsDir = path.join(dataDir, 'backups')

function stamp() {
  const n = new Date()
  const pad = (v) => String(v).padStart(2, '0')
  const ms = String(n.getMilliseconds()).padStart(3, '0')
  return `${n.getFullYear()}${pad(n.getMonth() + 1)}${pad(n.getDate())}-${pad(n.getHours())}${pad(n.getMinutes())}${pad(n.getSeconds())}${ms}`
}

function main() {
  if (!fs.existsSync(dbPath)) {
    console.error('  找不到数据库文件：' + dbPath)
    process.exit(1)
  }

  // 自动创建备份目录
  fs.mkdirSync(backupsDir, { recursive: true })

  const target = path.join(backupsDir, `db-${stamp()}.json`)
  // 安全复制：先写临时文件再 rename，避免产生半截备份
  const tmp = target + '.tmp'
  fs.copyFileSync(dbPath, tmp)
  fs.renameSync(tmp, target)

  const size = fs.statSync(target).size
  console.log(`  ✔ 备份完成: ${target}`)
  console.log(`    大小: ${(size / 1024).toFixed(1)} KB`)

  // 展示现有备份数量
  const count = fs.readdirSync(backupsDir).filter(f => /^db-\d{8}-\d{9}\.json$/.test(f)).length
  console.log(`    当前共 ${count} 份备份`)
}

main()
