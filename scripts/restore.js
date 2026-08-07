// ============================================================
// NodeChat - 数据恢复脚本
// 用途：列出备份 → 用户选择 → 恢复前备份当前 db.json → 原子替换恢复
// 用法：node scripts/restore.js（恢复前请先停止服务）
// 来源：NodeChat v1.0.0 合法项目代码
// 说明：如被杀毒软件误报（启发式误报），请将项目目录加入信任区
// ============================================================
import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { dataDir, dbPath } from '../config/index.js'

const backupsDir = path.join(dataDir, 'backups')

function stamp() {
  const n = new Date()
  const pad = (v) => String(v).padStart(2, '0')
  const ms = String(n.getMilliseconds()).padStart(3, '0')
  return `${n.getFullYear()}${pad(n.getMonth() + 1)}${pad(n.getDate())}-${pad(n.getHours())}${pad(n.getMinutes())}${pad(n.getSeconds())}${ms}`
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const ask = (q) => new Promise(r => rl.question(q, r))

function main() {
  if (!fs.existsSync(backupsDir)) {
    console.error('  没有找到备份目录：' + backupsDir)
    process.exit(1)
  }

  // 列出备份（按时间倒序）
  const backups = fs.readdirSync(backupsDir)
    .filter(f => /^db-\d{8}-\d{9}\.json$/.test(f))
    .sort()
    .reverse()
  if (backups.length === 0) {
    console.error('  没有可用备份，请先执行 npm run backup')
    process.exit(1)
  }

  console.log('  可用备份：')
  backups.forEach((f, i) => {
    const size = fs.statSync(path.join(backupsDir, f)).size
    console.log(`  ${String(i + 1).padStart(2, ' ')}. ${f}  (${(size / 1024).toFixed(1)} KB)`)
  })
  console.log('')

  main2(backups)
}

async function main2(backups) {
  const choice = await ask('  选择备份编号（回车取消）: ')
  rl.close()
  const idx = parseInt(choice, 10) - 1
  if (!choice.trim() || Number.isNaN(idx) || idx < 0 || idx >= backups.length) {
    console.log('  已取消恢复')
    process.exit(0)
  }

  const src = path.join(backupsDir, backups[idx])

  // 恢复前备份当前 db.json（保留现场，便于回滚）
  if (fs.existsSync(dbPath)) {
    const pre = path.join(backupsDir, `db-pre-restore-${stamp()}.json`)
    fs.copyFileSync(dbPath, pre)
    console.log(`  已备份当前数据: ${pre}`)
  }

  // 原子恢复：复制到临时文件后 rename 替换
  const tmp = dbPath + '.restore-tmp'
  fs.copyFileSync(src, tmp)
  fs.renameSync(tmp, dbPath)

  console.log('  ✔ 恢复完成: ' + backups[idx])
  console.log('  请重启服务使恢复生效（或当前运行中的服务会在下次写入时覆盖，建议先停止服务）')
}

main()
