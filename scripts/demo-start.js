/* ============================================================
 * Z80Z-chat DEMO 项目管理菜单（纯模拟，零副作用）
 * 由 Z80Z-chat-DEMO.bat 提取到 %TEMP%\z80z-chat-demo\ 后运行
 * 仅演示菜单交互：不启动服务 / 不写文件 / 不碰防火墙
 * ============================================================ */

const SITE = 'Z80Z-chat'
const PORT = 35033
const DEMO = true

/* ────────────────────────── 颜色与样式 ────────────────────────── */

const USE_COLOR = process.stdout.isTTY && !process.argv.includes('--no-color')
const R = '\x1b[0m'
const B = '\x1b[1m'
const DIM = '\x1b[2m'
const ACCENT = '\x1b[38;5;69m'
const GREEN = '\x1b[38;5;42m'
const RED = '\x1b[38;5;203m'
const YELLOW = '\x1b[38;5;214m'
const CYAN = '\x1b[38;5;81m'
const GRAY = '\x1b[38;5;245m'
const WHITE = '\x1b[97m'
const BG_RED = '\x1b[48;5;203m'

function col(code, text) { return USE_COLOR ? code + text + R : text }
const bold = (t) => col(B, t)
const dim = (t) => col(DIM, t)
const accent = (t) => col(ACCENT, t)
const green = (t) => col(GREEN, t)
const red = (t) => col(RED, t)
const yellow = (t) => col(YELLOW, t)
const cyan = (t) => col(CYAN, t)
const gray = (t) => col(GRAY, t)
const white = (t) => col(WHITE, t)

const W = 48
const HLINE = gray('─'.repeat(W))

function header(title, subtitle = '', dot = null) {
  const dotStr = dot ? `${dot} ` : ''
  const inner = `${dotStr}${white(bold(title))}${subtitle ? `  ${gray('·')}  ${gray(subtitle)}` : ''}`
  console.log('')
  console.log('  ' + inner)
  console.log('  ' + accent('─'.repeat(W)))
  console.log('')
}

function section(text) {
  console.log('')
  console.log('  ' + dim(text))
}

function item(num, label, desc = '', enabled = true) {
  const d = desc ? `  ${gray('· ' + desc)}` : ''
  const numStr = enabled ? accent(bold(num)) : dim(num)
  const lbl = enabled ? white(label) : dim(label)
  return `  ${numStr}.  ${lbl}${d}`
}

function dangerItem(num, label, desc = '') {
  const d = desc ? `  ${gray('· ' + desc)}` : ''
  return `  ${red(bold(num))}.  ${red(label)}${d}`
}

function kv(key, value) {
  return `  ${dim(key + ' ')}${dim('·')}  ${value}`
}

function bullets(list) {
  return list.map(t => `  ${dim('·')}  ${t}`)
}

function hint(text) {
  console.log('')
  console.log('  ' + dim(text))
}

function ok(t) { return green('✔ ') + t }
function bad(t) { return red('✖ ') + t }
function warn(t) { return yellow('⚠ ') + t }

function log(msg = '') { console.log('  ' + msg) }

function cls() {
  try { process.stdout.write('\x1b[2J\x1b[H') } catch {}
}

/* ────────────────────────── 输入 ────────────────────────── */

const readline = require('readline')
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const inputQueue = []
const inputWaiters = []
rl.on('line', (line) => {
  const w = inputWaiters.shift()
  if (w) w(line.trim())
  else inputQueue.push(line)
})

function ask(q) {
  return new Promise((resolve) => {
    try {
      process.stdout.write(q)
      const pending = inputQueue.shift()
      if (pending !== undefined) return resolve(pending)
      inputWaiters.push(resolve)
    } catch {
      process.exit(0)
    }
  })
}

function waitKey(msg = '按回车返回') {
  console.log('')
  return ask('  ' + dim(`[ ${msg} ]`))
}

/* ────────────────────────── 模拟状态（纯内存） ────────────────────────── */

let status = 'stopped'          // stopped | running | conflict
let fakePid = 12345
let runningSeconds = 0
let conflictOnce = true         // 首次启动演示端口冲突界面
let runTimer = null

function fakeStatus() {
  if (status === 'running') {
    runningSeconds += 10
    return {
      status: 'running',
      pid: fakePid,
      message: `服务正常运行（PID: ${fakePid}）`,
      runningTime: `${Math.floor(runningSeconds / 60)}分${runningSeconds % 60}秒`
    }
  }
  if (status === 'conflict') {
    return {
      status: 'conflict',
      pid: 8888,
      message: `端口 ${PORT} 被其他进程占用（PID: 8888）（模拟）`
    }
  }
  return { status: 'stopped', pid: null, message: '服务未运行' }
}

/* ────────────────────────── 界面：项目说明 ────────────────────────── */

async function showProjectInfo() {
  header(SITE, '功能介绍')
  section('功能')
  bullets([
    '文字频道聊天，支持图片 / 文件上传',
    '语音频道，麦克风 / 扬声器 / 音量设置',
    '屏幕投屏，画质可选，手机可观看',
    '服务器 / 频道 / 分类管理，角色权限',
    '邀请链接、好友系统、移动端适配'
  ]).forEach(log)
  section('技术栈')
  bullets([
    '前端  Vue 3 + Pinia + Tailwind CSS',
    '后端  Node.js + Express',
    '实时  WebSocket 信令 / 消息推送',
    '语音  WebRTC 点对点',
    '存储  本地 JSON 数据库，无需外部依赖'
  ]).forEach(log)
  section('快速开始')
  bullets([
    '主菜单选择「启动服务」',
    '浏览器访问 本机 / 局域网 地址',
    '注册账号即可创建或加入服务器'
  ]).forEach(log)
  hint('备份数据 = 直接复制 data 目录')
  await waitKey()
}

/* ────────────────────────── 界面：查看配置 ────────────────────────── */

async function showConfig() {
  header('当前配置', 'config.json（模拟）')
  section('网络')
  ;[
    kv('端口', cyan(String(PORT))),
    kv('监听地址', cyan('0.0.0.0')),
    kv('WebSocket 路径', cyan('/ws')),
    kv('CORS 白名单', cyan('*'))
  ].forEach(log)
  section('存储')
  ;[
    kv('数据目录', cyan('data/')),
    kv('数据库文件', cyan('data/db.json')),
    kv('上传目录', cyan('data/uploads/'))
  ].forEach(log)
  section('上传与请求')
  ;[
    kv('上传大小上限', cyan('10 MB')),
    kv('允许类型', cyan('image/*, video/*, audio/*')),
    kv('请求体上限', cyan('12 MB'))
  ].forEach(log)
  section('语音 / 投屏')
  ;[
    kv('ICE 服务器', cyan('stun:stun.l.google.com:19302')),
    kv('防火墙', green('开启 · 「Z80Z-chat」'))
  ].forEach(log)
  hint('演示模式：配置仅为示意，不读取真实文件')
  await waitKey()
}

/* ────────────────────────── 界面：编辑配置 ────────────────────────── */

async function editConfig() {
  header('编辑配置', 'config.json（模拟）')
  log(dim('演示模式不会打开记事本，也不会修改任何文件'))
  await waitKey()
}

/* ────────────────────────── 界面：停止服务（模拟） ────────────────────────── */

async function stopService() {
  header('停止服务', '停止当前运行的服务（模拟）')
  if (status === 'stopped') {
    log(gray('当前没有运行中的服务'))
    await waitKey()
    return
  }
  log('停止服务 ...')
  await new Promise(r => setTimeout(r, 500))
  status = 'stopped'
  if (runTimer) { clearInterval(runTimer); runTimer = null }
  log(ok('服务已停止（模拟，未终止任何真实进程）'))
  await waitKey()
}

/* ────────────────────────── 界面：备份管理（模拟） ────────────────────────── */

const fakeBackups = [
  'backup-20260803-102030123',
  'backup-20260802-091500456',
  'pre-restore-20260801-180000789'
]

async function backupMenu() {
  for (;;) {
    cls()
    header('备份管理', 'data-backup（模拟）')
    console.log(`  ${dim('现有备份')}  ${cyan(String(fakeBackups.length))}  ${dim('份')}  ${dim('· 保留上限')}  ${cyan('3')}  ${dim('份（config.json 可改）')}`)
    console.log('')
    console.log(HLINE)
    console.log('')
    console.log(item('1', '立即备份数据', '复制 data/ → 外层 data-backup/'))
    console.log(item('2', '查看备份列表', '时间 / 大小 / 文件数'))
    console.log(item('3', '恢复备份', '恢复前强制停止服务并自动备份当前数据'))
    console.log(item('4', '清理旧备份', '删除指定或全部备份'))
    console.log(item('0', '返回主菜单', ''))
    console.log('')
    hint('输入选项数字后按回车确认')

    const choice = await ask('  ' + accent('>') + ' ')
    if (choice === '1') {
      cls()
      header('立即备份', '')
      await new Promise(r => setTimeout(r, 400))
      log(ok('备份完成（模拟）→ data-backup/backup-20260804-113000789'))
      await waitKey()
    } else if (choice === '2') {
      cls()
      header('备份列表', `共 ${fakeBackups.length} 份`)
      console.log('')
      fakeBackups.forEach((d, i) => {
        log(`  ${String(i + 1).padStart(2, ' ')}.  ${cyan(d)}  ${dim('· 2.1 MB · 34 个文件')}`)
      })
      console.log('')
      console.log(HLINE)
      await waitKey()
    } else if (choice === '3') {
      await restoreBackup()
    } else if (choice === '4') {
      await cleanupBackups()
    } else if (choice === '0') {
      return
    }
  }
}

async function restoreBackup() {
  cls()
  header('恢复备份', '恢复前强制停止服务（模拟）')
  console.log('')
  console.log(HLINE)
  console.log('')
  fakeBackups.forEach((d, i) => {
    log(`  ${String(i + 1).padStart(2, ' ')}.  ${cyan(d)}`)
  })
  console.log('')
  console.log(HLINE)
  console.log('')
  const choice = await ask('  ' + accent('>') + ' 选择备份编号（回车取消）：')
  if (!choice.trim()) {
    log(dim('已取消'))
    await waitKey()
    return
  }
  const idx = parseInt(choice, 10) - 1
  if (isNaN(idx) || idx < 0 || idx >= fakeBackups.length) {
    log(dim('无效编号，已取消'))
    await waitKey()
    return
  }
  console.log('')
  log(red('⚠ 恢复将覆盖当前 data/ 目录（账号、消息、上传文件）'))
  const conf = await ask('  ' + accent('>') + ' 确认恢复请输入 YES：')
  if (conf.trim() !== 'YES') {
    log(dim('已取消'))
    await waitKey()
    return
  }
  console.log('')
  log('停止服务 ...（模拟）')
  await new Promise(r => setTimeout(r, 400))
  status = 'stopped'
  await new Promise(r => setTimeout(r, 400))
  log(dim('已备份当前数据（模拟）→ data-backup/pre-restore-20260804-113100123'))
  await new Promise(r => setTimeout(r, 400))
  console.log('')
  log(ok(`恢复完成（模拟）：${fakeBackups[idx]}`))
  log(dim('演示模式未改动任何真实文件'))
  await waitKey()
}

async function cleanupBackups() {
  cls()
  header('清理旧备份', '')
  console.log('')
  console.log(HLINE)
  console.log('')
  fakeBackups.forEach((d, i) => {
    log(`  ${String(i + 1).padStart(2, ' ')}.  ${cyan(d)}`)
  })
  console.log('')
  console.log(HLINE)
  console.log('')
  log('  A = 删除全部备份')
  const choice = await ask('  ' + accent('>') + ' 输入编号或 A（回车取消）：')
  if (!choice.trim()) {
    log(dim('已取消'))
    await waitKey()
    return
  }
  if (choice.trim().toUpperCase() === 'A') {
    await new Promise(r => setTimeout(r, 400))
    log(ok(`已删除 ${fakeBackups.length} 份备份（模拟）`))
    await waitKey()
    return
  }
  const idx = parseInt(choice, 10) - 1
  if (isNaN(idx) || idx < 0 || idx >= fakeBackups.length) {
    log(dim('无效编号，已取消'))
    await waitKey()
    return
  }
  const conf = await ask(`  ${accent('>')} 确认删除 ${fakeBackups[idx]}？(Y/N)：`)
  if (conf.trim().toUpperCase() === 'Y') {
    await new Promise(r => setTimeout(r, 300))
    log(ok(`已删除（模拟）：${fakeBackups[idx]}`))
  } else {
    log(dim('已取消'))
  }
  await waitKey()
}

/* ────────────────────────── 界面：项目清档（模拟） ────────────────────────── */

async function clearData() {
  header('项目清档', '清空全部数据（模拟）')
  log(red('⚠⚠⚠ 此操作将永久删除以下内容，且无法恢复 ⚠⚠⚠'))
  console.log('')
  bullets([
    `数据库（全部账号 / 频道 / 消息） data/db.json`,
    `上传的文件 data/uploads/`,
    `后台运行记录 data/server.pid`
  ]).forEach(log)
  console.log('')
  log(red('删除后服务将回到全新安装状态'))
  console.log('')
  const conf = await ask('  ' + accent('>') + ' 确认请输入 YES：')
  if (conf.trim() !== 'YES') {
    log(dim('已取消'))
    await waitKey()
    return
  }
  if (status === 'running') {
    log('停止服务 ...（模拟）')
    await new Promise(r => setTimeout(r, 400))
    status = 'stopped'
    if (runTimer) { clearInterval(runTimer); runTimer = null }
  }
  await new Promise(r => setTimeout(r, 400))
  log(ok('清档完成（模拟），已清理 3 项'))
  log(dim('演示模式未删除任何真实文件'))
  await waitKey()
}

/* ────────────────────────── 启动服务（模拟，首次演示端口冲突） ────────────────────────── */

async function deploy() {
  cls()
  header('启动服务', `端口 ${PORT}（模拟）`)
  console.log(`  ${dim('目标')}  ${cyan(`http://localhost:${PORT}`)}  ${dim('· 监听 0.0.0.0')}`)
  console.log('')

  if (conflictOnce) {
    conflictOnce = false
    console.log('')
    log(red(`⚠ 端口 ${PORT} 已被进程 chrome.exe（PID: 8888）占用（模拟冲突场景）`))
    console.log('')
    console.log(item('1', '强制释放端口并启动', '终止占用进程'))
    console.log(item('2', '更换端口', '输入指定端口，留空自动选择随机可用端口'))
    console.log(item('0', '取消', ''))
    console.log('')
    const ch = await ask('  ' + accent('>') + ' ')
    if (ch === '1') {
      log('强制释放端口 ...（模拟）')
      await new Promise(r => setTimeout(r, 400))
      log(ok('占用进程已终止（模拟，未终止真实进程）'))
    } else if (ch === '2') {
      const portInput = await ask('  ' + accent('>') + ' 请输入新端口号（留空自动选择随机端口 10000-60000）：')
      if (portInput.trim()) {
        const p = parseInt(portInput, 10)
        if (isNaN(p) || p < 1 || p > 65535) {
          log(bad('端口号无效（应为 1-65535 的整数）'))
          await waitKey()
          return null
        }
        log(ok(`config.json 端口已更新为 ${p}（模拟，未写入）`))
      } else {
        const p = 10000 + Math.floor(Math.random() * 50001)
        log(dim('已自动选择端口：') + ' ' + cyan(p))
        log(ok(`config.json 端口已更新为 ${p}（模拟，未写入）`))
      }
    } else {
      log(dim('已取消启动'))
      await waitKey()
      return null
    }
    console.log('')
  }

  log('检查端口占用 ...（模拟）')
  await new Promise(r => setTimeout(r, 300))
  log(dim('端口空闲'))
  log('配置防火墙规则 ...（模拟）')
  await new Promise(r => setTimeout(r, 300))
  log(ok('防火墙规则「Z80Z-chat」已应用（模拟，未添加真实规则）'))
  log('启动服务 ...（模拟）')
  await new Promise(r => setTimeout(r, 500))
  status = 'running'
  runningSeconds = 0
  console.log('')
  console.log(`  ${green('●')} ${bold('服务启动成功（模拟）')}`)
  console.log(`    ${dim('本机')}    ${cyan(`http://localhost:${PORT}`)}`)
  console.log(`    ${dim('局域网')}  ${cyan(`http://192.168.1.100:${PORT}`)}`)
  console.log('')
  return { pid: fakePid }
}

/* ────────────────────────── 运行中菜单（模拟） ────────────────────────── */

async function runningMenu() {
  let lastStatus = 'stopped'

  const render = () => {
    const st = fakeStatus()
    if (st.status === 'running') {
      cls()
      header('服务运行中', `端口 ${PORT}`, green('●'))
      console.log(`  ${dim('本机')}    ${cyan(`http://localhost:${PORT}`)}`)
      console.log(`  ${dim('局域网')}  ${cyan(`http://192.168.1.100:${PORT}`)}`)
      console.log('')
      console.log(`  ${dim('PID')} ${cyan(st.pid)}  ${dim('·')}  ${dim('运行时间')} ${cyan(st.runningTime)}`)
      console.log('')
      console.log(HLINE)
      console.log('')
      console.log(item('1', '转入后台', '关闭窗口后服务继续运行（模拟）'))
      console.log(item('2', '停止服务', '停止服务并返回主菜单'))
      hint('直接关闭窗口也会停止服务 · 状态每 10 秒自动检测（模拟）')
    } else {
      cls()
      header('服务已停止', `端口 ${PORT}`, red('○'))
      console.log('')
      console.log(HLINE)
      console.log('')
      console.log(item('1', '返回主菜单', ''))
      hint('状态每 10 秒自动检测（模拟）')
    }
    lastStatus = st.status
  }

  render()

  runTimer = setInterval(() => {
    const st = fakeStatus()
    if (st.status !== lastStatus) {
      render()
      process.stdout.write('  ' + (USE_COLOR ? ACCENT + '>' + R : '>') + ' ')
    }
  }, 10000)

  try {
    for (;;) {
      const choice = await ask('  ' + accent('>') + ' ')

      if (lastStatus === 'running') {
        if (choice === '1') {
          clearInterval(runTimer); runTimer = null
          log('转入后台 ...（模拟）')
          await new Promise(r => setTimeout(r, 500))
          console.log('')
          log(ok(`服务已转入后台运行（PID ${fakePid}）—— 模拟，无真实进程`))
          console.log('')
          console.log('  ' + dim('[ 演示模式：项目管理菜单演示完毕，返回演示主菜单 ]'))
          console.log('')
          await waitKey('按回车返回')
          return
        } else if (choice === '2') {
          clearInterval(runTimer); runTimer = null
          log('停止服务 ...')
          await new Promise(r => setTimeout(r, 500))
          status = 'stopped'
          log(ok('服务已停止（模拟）'))
          await waitKey('按回车返回主菜单')
          return
        }
      } else {
        if (choice === '1') {
          clearInterval(runTimer); runTimer = null
          return
        }
      }
    }
  } finally {
    if (runTimer) { clearInterval(runTimer); runTimer = null }
  }
}

/* ────────────────────────── 隧道管理（模拟） ────────────────────────── */

async function tunnelMenu() {
  for (;;) {
    cls()
    header('隧道管理', '选择内网穿透服务 · 演示模式')
    console.log(`  ${yellow('●')} ${dim('Cloudflare Tunnel')}  ${yellow('未检测（演示）')}  ${dim('· 海外节点，无限流量')}`)
    console.log(`  ${yellow('●')} ${dim('SakuraFRP（国内低延迟）')}  ${yellow('未检测（演示）')}  ${dim('· 国内节点，免费 5GiB/月')}`)
    console.log('')
    console.log(HLINE)
    console.log('')
    console.log(item('1', 'Cloudflare Tunnel', '域名访问 · 无限流量 · 演示模式不可用', false))
    console.log(item('2', 'SakuraFRP', '国内低延迟 · 演示模式不可用', false))
    console.log(item('0', '返回主菜单', ''))
    console.log('')
    const choice = await ask('  ' + accent('>') + ' ')
    if (choice === '0') return
    console.log('')
    log(dim('[ 演示模式：隧道管理仅正式版可用 ]'))
    await waitKey('按回车返回')
  }
}

/* ────────────────────────── 主菜单 ────────────────────────── */

async function mainMenu() {
  for (;;) {
    cls()
    const st = fakeStatus()

    if (st.status === 'running') {
      header(SITE, '服务管理')
      console.log(`  ${green('●')} ${dim('状态')}  ${green('运行中')}  ${dim('· 端口 ' + PORT)}`)
      console.log(`  ${dim('·')}  ${dim('PID')} ${cyan(st.pid)}  ${dim('运行时间')} ${cyan(st.runningTime)}`)
      console.log(`  ${dim('·')}  ${dim('本机')} ${cyan(`http://localhost:${PORT}`)}`)
      console.log(`  ${dim('·')}  ${dim('局域网')} ${cyan(`http://192.168.1.100:${PORT}`)}`)
    } else if (st.status === 'conflict') {
      header(SITE, '服务管理')
      console.log(`  ${yellow('●')} ${dim('状态')}  ${yellow('端口冲突')}  ${dim('· 端口 ' + PORT)}`)
      console.log(`  ${dim('·')}  ${st.message}`)
    } else {
      header(SITE, '服务管理')
      console.log(`  ${red('○')} ${dim('状态')}  ${red('未运行')}  ${dim('· 端口 ' + PORT)}`)
      console.log(`  ${dim('·')}  ${dim('配置文件')} ${dim('config.json')}`)
    }
    console.log('')
    console.log(HLINE)
    console.log('')

    if (st.status === 'running') {
      console.log(item('1', '重启服务', '停止并重新启动（模拟）'))
      console.log(item('2', '停止服务', '停止当前运行的服务'))
      console.log(item('3', '备份管理', '备份 / 恢复 / 清理数据'))
      console.log(item('4', '查看配置', '浏览所有配置项'))
      console.log(item('5', '编辑配置', '用记事本打开 config.json'))
      console.log(item('6', '项目说明', '功能介绍与使用方式'))
      console.log(item('7', '隧道管理', '内网穿透（Cloudflare / SakuraFRP）'))
      console.log(dangerItem('8', '项目清档', '清空全部数据（需确认）'))
      console.log(item('0', '退出', ''))
    } else {
      console.log(item('1', '启动服务', `启动 ${SITE} 后端服务`))
      console.log(item('2', '备份管理', '备份 / 恢复 / 清理数据'))
      console.log(item('3', '查看配置', '浏览所有配置项'))
      console.log(item('4', '编辑配置', '用记事本打开 config.json'))
      console.log(item('5', '项目说明', '功能介绍与使用方式'))
      console.log(item('6', '隧道管理', '内网穿透（Cloudflare / SakuraFRP）'))
      console.log(dangerItem('7', '项目清档', '清空全部数据（需确认）'))
      console.log(item('0', '退出', ''))
    }

    console.log('')
    console.log(HLINE)
    hint('输入选项数字后按回车确认')

    const choice = await ask('  ' + accent('>') + ' ')

    if (st.status === 'running') {
      if (choice === '1') {
        log('停止服务 ...（模拟）')
        await new Promise(r => setTimeout(r, 500))
        status = 'stopped'
        const child = await deploy()
        if (child) await runningMenu()
      } else if (choice === '2') {
        cls()
        await stopService()
      } else if (choice === '3') {
        await backupMenu()
      } else if (choice === '4') {
        cls()
        await showConfig()
      } else if (choice === '5') {
        cls()
        await editConfig()
      } else if (choice === '6') {
        cls()
        await showProjectInfo()
      } else if (choice === '7') {
        await tunnelMenu()
      } else if (choice === '8') {
        cls()
        await clearData()
      } else if (choice === '0') {
        rl.close()
        console.log('')
        log(dim('再见'))
        console.log('')
        cleanup()
        process.exit(0)
      }
    } else {
      if (choice === '1') {
        const child = await deploy()
        if (child) await runningMenu()
      } else if (choice === '2') {
        await backupMenu()
      } else if (choice === '3') {
        cls()
        await showConfig()
      } else if (choice === '4') {
        cls()
        await editConfig()
      } else if (choice === '5') {
        cls()
        await showProjectInfo()
      } else if (choice === '6') {
        await tunnelMenu()
      } else if (choice === '7') {
        cls()
        await clearData()
      } else if (choice === '0') {
        rl.close()
        console.log('')
        log(dim('再见'))
        console.log('')
        cleanup()
        process.exit(0)
      }
    }
  }
}

/* ────────────────────────── 退出清理（删除自身临时文件） ────────────────────────── */

function cleanup() {
  try {
    const fs = require('fs')
    const path = require('path')
    const self = process.argv[1]
    if (self) {
      fs.rmSync(self, { force: true })
      const dir = path.dirname(self)
      try { fs.rmdirSync(dir) } catch {}
    }
  } catch {}
}

/* ────────────────────────── 入口 ────────────────────────── */

async function main() {
  console.log('')
  console.log('  ' + yellow('(演示模式) 本脚本仅模拟菜单交互，不会执行任何真实操作'))
  await waitKey('按回车进入管理菜单（模拟）')
  await mainMenu()
}

main().catch((e) => {
  console.error('\n  ' + red('演示脚本异常：') + (e?.message || e) + '\n')
  process.exit(1)
})