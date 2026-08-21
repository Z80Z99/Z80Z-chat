import { spawn, spawnSync, execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import readline from 'readline'
import { fileURLToPath } from 'url'
import config, { projectRoot, dataDir, dbPath, uploadDir, reloadConfig } from './config/index.js'
import { downloadWithProgress } from './utils/download.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CONFIG_PATH = path.join(projectRoot, 'config.json')
const PID_FILE = path.join(dataDir, 'server.pid')
const SKIP_FIREWALL = process.argv.includes('--no-firewall')
// "直接使用现有目录"进入（bat 层传递）：跳过第一次安装建议
const DIRECT_USE = process.argv.includes('--direct-use')

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
const BG_ACCENT = '\x1b[48;5;69m'
const BG_GREEN = '\x1b[48;5;42m'
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

/* ────────────────────────── 基础功能 ────────────────────────── */

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

// readline.question 在管道输入下连续调用会卡住（await 链中第二个
// question 不触发）。改用 'line' 事件队列：TTY 与管道输入均可用。
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

function cls() {
  try { execSync('cls', { stdio: 'inherit' }) } catch {}
}

function validateConfig() {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    return { ok: false, msg: `config.json 中端口配置无效：${config.port}（应为 1~65535 的整数）` }
  }
  if (typeof config.firewall?.ruleName !== 'string' || !config.firewall.ruleName.trim()) {
    return { ok: false, msg: 'config.json 中防火墙规则名无效（firewall.ruleName）' }
  }
  return { ok: true }
}

function killPid(pid) {
  try {
    execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function portInUse(port) {
  try {
    const out = execSync(`netstat -ano -p tcp | findstr "LISTENING" | findstr ":${port} "`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return out.trim().length > 0
  } catch {
    return false
  }
}

function killPort(port) {
  let out = ''
  try {
    out = execSync(`netstat -ano -p tcp | findstr "LISTENING" | findstr ":${port} "`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    return false
  }
  const pids = new Set()
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(/(\d+)\s*$/)
    if (m && m[1] !== '0') pids.add(m[1])
  }
  let killed = false
  for (const pid of pids) {
    if (killPid(pid)) killed = true
  }
  return killed
}

// 获取进程名（wmic 优先，tasklist 兜底），用于端口占用警告
function getProcessName(pid) {
  try {
    const out = execSync(`wmic process where processid=${pid} get name`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const name = out.trim().split(/\r?\n/).slice(1).find(l => l.trim())?.trim()
    if (name) return name
  } catch {}
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const m = out.match(/"([^"]+)"/)
    if (m) return m[1]
  } catch {}
  return '未知进程'
}

// 写临时 ps1 并以管理员提权执行（UAC 弹窗），返回是否执行成功；拒绝授权/失败返回 false
function runElevatedPs1(scriptLines, prefix = 'z80z-chat-fw') {
  const tmpScript = path.join(os.tmpdir(), `${prefix}-${Date.now()}.ps1`)
  fs.writeFileSync(tmpScript, scriptLines.join('\n'), 'utf-8')
  try {
    execSync(
      `powershell -NoProfile -Command "Start-Process -Verb RunAs -Wait powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${tmpScript}'"`,
      { stdio: 'ignore', windowsHide: true }
    )
    return true
  } catch {
    return false
  } finally {
    try { fs.unlinkSync(tmpScript) } catch {}
  }
}

function applyFirewall(port, ruleName) {
  const legacyRuleNames = ['Z80Z-chat3000', 'Z80Z-chat', 'NodeChat3000', 'NodeChat'].filter(n => n !== ruleName)
  const script = [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `netsh advfirewall firewall delete rule name='${ruleName.replace(/'/g, "''")}'`,
    `netsh advfirewall firewall add rule name='${ruleName.replace(/'/g, "''")}' dir=in action=allow protocol=TCP localport=${port}`,
    ...legacyRuleNames.map(n => `netsh advfirewall firewall delete rule name='${n}'`),
    `exit 0`
  ]
  if (runElevatedPs1(script)) {
    log(ok(`防火墙规则「${ruleName}」已应用 · TCP ${port} 入站放行`))
    return true
  }
  log(warn('未获得管理员授权，防火墙规则未更新（其他设备将无法访问本服务）'))
  log('  如需手动配置：以管理员身份运行 netsh advfirewall firewall add rule name="' + ruleName + '" dir=in action=allow protocol=TCP localport=' + port)
  return false
}

// 防火墙规则是否存在（netsh show 无需管理员权限，用于避免无谓的 UAC 弹窗）
function firewallRuleExists(ruleName) {
  try {
    const out = execSync(`netsh advfirewall firewall show rule name='${ruleName.replace(/'/g, "''")}'`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return out.includes('已匹配规则') || out.includes('Matched rules') || out.includes(ruleName)
  } catch {
    return false
  }
}

// 删除防火墙规则（停止服务/清档时调用，防止端口被利用；需 UAC 授权）
function removeFirewall(ruleName) {
  if (SKIP_FIREWALL) return false
  if (!ruleName || !firewallRuleExists(ruleName)) return false
  const script = [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `netsh advfirewall firewall delete rule name='${ruleName.replace(/'/g, "''")}'`,
    `exit 0`
  ]
  if (runElevatedPs1(script, 'z80z-chat-fw-del')) {
    log(ok(`防火墙规则「${ruleName}」已删除 · TCP 入站已关闭`))
    return true
  }
  log(warn('未获得管理员授权，防火墙规则未删除'))
  log('  如需手动删除：以管理员身份运行 netsh advfirewall firewall delete rule name="' + ruleName + '"')
  return false
}

function spawnAttached() {
  return spawn('node', ['server.js'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, PORT: String(config.port) }
  })
}

function spawnBackground() {
  const child = spawn('node', ['server.js'], {
    cwd: projectRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, PORT: String(config.port) }
  })
  child.unref()
  try {
    fs.writeFileSync(PID_FILE, String(child.pid))
  } catch {}
  return child.pid
}

/* ────────────────────────── 系统托盘（后台运行管理） ────────────────────────── */

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

// 生成托盘脚本（NotyfiIcon，右键菜单：打开面板 / 停止服务 / 退出托盘；服务停止后自动退出）
function buildTrayScript() {
  const node = process.execPath
  const proj = projectRoot
  const pidFile = PID_FILE
  const site = config.siteName
  const q = (s) => s.replace(/'/g, "''")
  return `param()
$ErrorActionPreference = 'Continue'
try { [System.IO.File]::WriteAllText((Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '.z80z-tray.pid'), [string]$PID) } catch {}

$TrayCs = @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class Z80Tray : NativeWindow {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct NID {
    public int cbSize; public IntPtr hWnd; public int uID; public uint uFlags;
    public uint uCallbackMessage; public IntPtr hIcon;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szTip;
    public uint dwState; public uint dwStateMask;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string szInfo;
    public uint uTimeoutOrVersion;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string szInfoTitle;
    public uint dwInfoFlags; public Guid guidItem; public IntPtr hBalloonIcon;
  }
  const uint NIM_ADD = 0; const uint NIM_DELETE = 2;
  const uint NIF_MESSAGE = 1; const uint NIF_ICON = 2; const uint NIF_TIP = 4;
  const int WM_USER = 0x400;
  const int WM_LBUTTONDBLCLK = 0x0203; const int WM_RBUTTONUP = 0x0205;
  const int UID = 0x0D5;
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern bool Shell_NotifyIcon(uint m, ref NID n);
  [DllImport("user32.dll")]
  static extern bool SetForegroundWindow(IntPtr hWnd);
  public event Action DoubleClicked;
  ContextMenuStrip _menu;
  public Z80Tray(IntPtr h, string tip, ContextMenuStrip menu) {
    _menu = menu;
    CreateHandle(new CreateParams());
    NID n = new NID(); n.cbSize = Marshal.SizeOf(typeof(NID)); n.hWnd = Handle; n.uID = UID;
    n.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP; n.uCallbackMessage = WM_USER + 1;
    n.hIcon = h; n.szTip = tip;
    Shell_NotifyIcon(NIM_ADD, ref n);
  }
  protected override void WndProc(ref Message m) {
    if (m.Msg == WM_USER + 1) {
      int msg = (int)m.LParam & 0xFFFF;
      if (msg == WM_LBUTTONDBLCLK) {
        if (DoubleClicked != null) DoubleClicked();
      } else if (msg == WM_RBUTTONUP) {
        if (_menu != null) {
          SetForegroundWindow(Handle);
          _menu.Show(Cursor.Position);
        }
      }
    }
    base.WndProc(ref m);
  }
  public void DisposeTray() {
    NID n = new NID();
    n.cbSize = Marshal.SizeOf(typeof(NID));
    n.hWnd = Handle;
    n.uID = UID;
    Shell_NotifyIcon(NIM_DELETE, ref n);
    DestroyHandle();
  }
}
'@

function Test-Service {
  if (-not (Test-Path -LiteralPath '${q(pidFile)}')) { return $false }
  try {
    $p = [int](([System.IO.File]::ReadAllText('${q(pidFile)}')).Trim())
    if ($p -le 0) { return $false }
    return [bool](Get-Process -Id $p -ErrorAction SilentlyContinue)
  } catch { return $false }
}
function Stop-ServiceNow {
  try {
    $p = [int](([System.IO.File]::ReadAllText('${q(pidFile)}')).Trim())
    if ($p -gt 0) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
  } catch {}
}
function Open-Panel {
  try {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('cd /d "${q(proj)}" && "${q(node)}" start.js') -WindowStyle Normal
  } catch {}
}

$script:quit = $false
$tray = $null
try {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
  Add-Type -AssemblyName System.Drawing -ErrorAction Stop
  Add-Type -TypeDefinition $TrayCs -ReferencedAssemblies @('System.Windows.Forms', 'System.Drawing') -ErrorAction Stop
  $iconDir = Join-Path $PSScriptRoot 'assets/icons'
  $iconFile = Join-Path $iconDir 'app-icon.png'
  if (Test-Path -LiteralPath $iconFile) {
    $bmp = [System.Drawing.Bitmap]::FromFile($iconFile)
  } else {
    $bmp = New-Object System.Drawing.Bitmap 16,16
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::FromArgb(255, 88, 101, 242))
    $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)), 4, 3, 8, 10)
    $g.Dispose()
  }
  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $mOpen = New-Object System.Windows.Forms.ToolStripMenuItem('打开管理面板')
  $mOpen.add_Click({ Open-Panel })
  $mStop = New-Object System.Windows.Forms.ToolStripMenuItem('停止服务并退出')
  $mStop.add_Click({ Stop-ServiceNow; $script:quit = $true; try { [System.Windows.Forms.Application]::Exit() } catch {} })
  $mExit = New-Object System.Windows.Forms.ToolStripMenuItem('退出托盘（服务继续运行）')
  $mExit.add_Click({ $script:quit = $true; try { [System.Windows.Forms.Application]::Exit() } catch {} })
  [void]$menu.Items.Add($mOpen)
  [void]$menu.Items.Add($mStop)
  [void]$menu.Items.Add($mExit)
  $tray = New-Object Z80Tray -ArgumentList @($bmp.GetHicon(), '${q(site)} 服务运行中', $menu)
  $tray.add_DoubleClicked({ Open-Panel })
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 5000
  $timer.add_Tick({
    if (-not (Test-Service)) {
      $timer.Stop()
      $script:quit = $true
      try { [System.Windows.Forms.Application]::Exit() } catch {}
    }
  })
  $timer.Start()
  [System.Windows.Forms.Application]::Run()
  $timer.Stop()
  $timer.Dispose()
} catch {
  try { [System.IO.File]::AppendAllText((Join-Path $env:TEMP 'z80z-tray-err.log'), ('ERR: ' + $_.Exception.Message + [Environment]::NewLine)) } catch {}
}
if ($tray) { try { $tray.DisposeTray() } catch {} }
`
}

// 确保系统托盘在运行（已存在则跳过；生成脚本时写 UTF-8 BOM，PS 5.1 才能正确读中文）
// 卡巴斯基行为（已实测）：Hidden 启动 + 原生 Shell_NotifyIcon 可存活；
// WinForms NotifyIcon + Hidden/Minimized 启动均被拦截终止
function ensureTray() {
  try {
    const trayPidFile = path.join(outerRoot, '.z80z-tray.pid')
    if (fs.existsSync(trayPidFile)) {
      const tp = Number(fs.readFileSync(trayPidFile, 'utf8').trim())
      if (Number.isInteger(tp) && tp > 0 && isProcessAlive(tp)) return
    }
    const psFile = path.join(outerRoot, '.z80z-tray.ps1')
    fs.writeFileSync(psFile, '\uFEFF' + buildTrayScript(), 'utf8')
    // Windows 上 detached + unref 不够：关闭终端时子进程仍被杀
    // 用 start /min 启动，进程完全脱离当前终端进程树
    // PS 脚本内自行写 PID 文件（$PID），无需外部追踪
    spawn('cmd.exe', [
      '/c', 'start', '/min', 'powershell.exe',
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', psFile
    ], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  } catch {}
}

function killTray() {
  try {
    const trayPidFile = path.join(outerRoot, '.z80z-tray.pid')
    if (fs.existsSync(trayPidFile)) {
      const tp = Number(fs.readFileSync(trayPidFile, 'utf8').trim())
      if (Number.isInteger(tp) && tp > 0) killPid(tp)
      fs.unlinkSync(trayPidFile)
    }
  } catch {}
}

function waitForServer(port, timeoutMs = 8000) {
  const start = Date.now()
  return new Promise((resolve) => {
    const tick = async () => {
      if (Date.now() - start > timeoutMs) return resolve(false)
      try {
        const res = await fetch(`http://localhost:${port}/api/config`)
        if (res.ok) return resolve(true)
      } catch {}
      setTimeout(tick, 500)
    }
    tick()
  })
}

function localIPv4() {
  const list = []
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) list.push(iface.address)
    }
  }
  return list
}

function getProcessInfo(pid) {
  // 优先使用 wmic（较快），不可用时回退 PowerShell（新版 Windows 已移除 wmic）
  try {
    const cmdOut = execSync(`wmic process where processid=${pid} get commandline`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const cmdLines = cmdOut.trim().split(/\r?\n/)
    const cmdLine = cmdLines.slice(1).find(l => l.trim())?.trim() || ''

    if (!cmdLine) return null

    let startTime = null
    try {
      const dateOut = execSync(`wmic process where processid=${pid} get creationdate`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
      const dateLines = dateOut.trim().split(/\r?\n/)
      const dateStr = dateLines.slice(1).find(l => l.trim())?.trim() || ''
      // WMI 日期格式：20230801120000.000000+480 → 手动解析
      const m = dateStr.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/)
      if (m) {
        startTime = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`)
      }
    } catch {}

    return { cmdLine, startTime }
  } catch {}

  // 回退：PowerShell CIM（wmic 不可用时）
  try {
    const output = execSync(
      `powershell -NoProfile -Command "$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($p){$p.CommandLine; if($p.CreationDate){$p.CreationDate.ToString('o')}}"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const lines = output.trim().split(/\r?\n/)
    const cmdLine = (lines[0] || '').trim()
    if (!cmdLine) return null
    let startTime = null
    if (lines[1]) {
      try { startTime = new Date(lines[1].trim()) } catch {}
    }
    return { cmdLine, startTime }
  } catch {}

  return null
}

function checkServiceStatus() {
  const result = {
    status: 'stopped',
    pid: null,
    message: '服务未运行',
    runningTime: null
  }

  // 从 netstat 获取监听端口的 PID（不依赖 PID 文件，前台/后台均可检测）
  let portPids = []
  try {
    const out = execSync(`netstat -ano -p tcp | findstr "LISTENING" | findstr ":${config.port} "`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/(\d+)\s*$/)
      if (m && m[1] !== '0') portPids.push(m[1])
    }
  } catch {}

  if (portPids.length === 0) {
    return result
  }

  // 逐个检查 PID 是否为 node server.js 进程
  for (const pid of portPids) {
    const info = getProcessInfo(pid)
    if (info && info.cmdLine && info.cmdLine.includes('server.js')) {
      result.status = 'running'
      result.pid = Number(pid)
      result.message = `服务正常运行（PID: ${pid}）`

      if (info.startTime && !isNaN(info.startTime.getTime())) {
        const diffMs = Date.now() - info.startTime.getTime()
        if (diffMs > 0) {
          const diffMinutes = Math.floor(diffMs / 60000)
          const diffSeconds = Math.floor((diffMs % 60000) / 1000)
          result.runningTime = `${diffMinutes}分${diffSeconds}秒`
        }
      }
      return result
    }
  }

  // 端口被占用但不是 Z80Z-chat 服务
  result.status = 'conflict'
  result.pid = Number(portPids[0]) || null
  result.message = `端口 ${config.port} 被其他进程占用（PID: ${portPids[0]}）`
  return result
}

/* ────────────────────────── 单文件模式工具 ────────────────────────── */

// 外层目录（Z80Z-chat.bat 所在层，与 nodejs/、data-backup/ 平级）
const outerRoot = path.join(projectRoot, '..')
const OUTER_BACKUP = path.join(outerRoot, 'data-backup')

// 单文件模式判定：外层存在 Z80Z-chat.bat
function isSingleFileMode() {
  return fs.existsSync(path.join(outerRoot, 'Z80Z-chat.bat'))
}

// 首次部署判定：有 .install-version（单文件已装）→ 非首次；
// 无标记但依赖完整（node_modules + dist 可正常运行）→ 非首次（unregistered，
// 直接进主菜单；仅提示未登记，便于"直接使用现有目录"场景不再误入部署界面）；
// 依赖缺失 → 首次部署；仅当 data/ 存在且 node_modules 缺失时才警告（真·数据风险）
function isFirstDeploy() {
  if (fs.existsSync(path.join(projectRoot, '.install-version'))) {
    return { isFirst: false, needWarning: false, unregistered: false }
  }
  const hasNM = fs.existsSync(path.join(projectRoot, 'node_modules'))
  const hasDist = fs.existsSync(path.join(projectRoot, 'dist'))
  const hasData = fs.existsSync(path.join(projectRoot, 'data'))
  if (hasNM && hasDist) {
    return { isFirst: false, needWarning: false, unregistered: true }
  }
  if (!hasNM && !hasDist && !hasData) {
    return { isFirst: true, needWarning: false, unregistered: false }
  }
  return { isFirst: true, needWarning: hasData && !hasNM, unregistered: false }
}

// 随机可用端口（范围 10000-60000，避开常用端口段）
function getRandomAvailablePort(min = 10000, max = 60000) {
  for (let i = 0; i < 100; i++) {
    const p = Math.floor(Math.random() * (max - min + 1)) + min
    if (!portInUse(p)) return p
  }
  return 3000
}

// 更新 config.json 中的端口（保留注释与其余配置）
function updateConfigPort(port) {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
  const updated = raw.replace(/"port":\s*\d+/, `"port": ${port}`)
  fs.writeFileSync(CONFIG_PATH, updated, 'utf8')
}

// npm registry 镜像测速（HEAD 请求，每次实测）
async function testNpmMirrors() {
  const mirrors = [
    { name: 'npm 官方', registry: 'https://registry.npmjs.org/' },
    { name: 'npmmirror (阿里)', registry: 'https://registry.npmmirror.com' },
    { name: '华为云', registry: 'https://repo.huaweicloud.com/repository/npm/' },
    { name: '腾讯云', registry: 'https://mirrors.cloud.tencent.com/npm/' },
    { name: '中科大', registry: 'https://mirrors.ustc.edu.cn/npm/' }
  ]
  const results = []
  for (const m of mirrors) {
    const start = Date.now()
    try {
      const res = await fetch(m.registry + 'express', { method: 'HEAD' })
      results.push({ ...m, ms: res.ok ? Date.now() - start : 99999 })
    } catch {
      results.push({ ...m, ms: 99999 })
    }
  }
  return results.sort((a, b) => a.ms - b.ms)
}

// 显示测速结果并让用户选择（留空自动选最快），返回选中镜像
async function chooseNpmMirror() {
  section(`镜像测速（npm registry）· 当前准备下载：${config.siteName} 项目依赖包`)
  const results = await testNpmMirrors()
  results.forEach((r, i) => {
    const t = r.ms >= 99999 ? '超时' : r.ms + ' ms'
    log(`  ${i + 1}.  ${r.name.padEnd(16)}  ·  ${cyan(t)}`)
  })
  console.log('')
  const choice = await ask('  ' + accent('>') + ' 选择镜像编号（留空自动选最快）：')
  let idx = 0
  if (choice.trim()) {
    const n = parseInt(choice, 10)
    if (!isNaN(n) && n >= 1 && n <= results.length) idx = n - 1
  }
  const sel = results[idx]
  if (sel.ms >= 99999) {
    log(bad('所选镜像不可达，请重新选择'))
    return null
  }
  log(ok(`已选择线路：${sel.name}`))
  return sel
}

// 备份时间戳（与引导层一致：yyyyMMdd-HHmmssfff）
function backupStamp() {
  const n = new Date()
  const pad = v => String(v).padStart(2, '0')
  const ms = String(n.getMilliseconds()).padStart(3, '0')
  return `${n.getFullYear()}${pad(n.getMonth() + 1)}${pad(n.getDate())}-${pad(n.getHours())}${pad(n.getMinutes())}${pad(n.getSeconds())}${ms}`
}

// 列出外层备份目录（按时间倒序）
function listBackupDirs() {
  try {
    if (!fs.existsSync(OUTER_BACKUP)) return []
    return fs.readdirSync(OUTER_BACKUP)
      .filter(n => /^backup-\d{8}-\d{9}$/.test(n) || /^pre-restore-\d{8}-\d{9}$/.test(n))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

// 立即备份 data/ → 外层 data-backup/backup-<时间戳>/，按 backupKeep 清理旧备份
function backupDataNow(silent = false) {
  if (!fs.existsSync(dataDir)) {
    if (!silent) log(warn('没有 data 目录，无需备份'))
    return null
  }
  try {
    fs.mkdirSync(OUTER_BACKUP, { recursive: true })
    const dest = path.join(OUTER_BACKUP, `backup-${backupStamp()}`)
    fs.cpSync(dataDir, dest, { recursive: true })
    const keep = Math.max(1, Number(config.backupKeep) || 3)
    const dirs = fs.readdirSync(OUTER_BACKUP)
      .filter(n => /^backup-\d{8}-\d{9}$/.test(n))
      .sort()
    while (dirs.length > keep) {
      const oldest = dirs.shift()
      fs.rmSync(path.join(OUTER_BACKUP, oldest), { recursive: true, force: true })
    }
    return dest
  } catch (e) {
    if (!silent) log(bad('备份失败：' + (e?.message || e)))
    return null
  }
}

/* ────────────────────────── 界面：项目说明 ────────────────────────── */

async function showProjectInfo() {
  header(config.siteName, '功能介绍')
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
  section('数据路径')
  bullets([
    `数据库   ${dbPath}`,
    `上传目录 ${uploadDir}`,
    `配置文件 ${CONFIG_PATH}`
  ]).forEach(log)
  hint('备份数据 = 直接复制 data 目录')
  await waitKey()
}

/* ────────────────────────── 界面：第一次安装建议 ────────────────────────── */

async function showFirstInstallAdvice() {
  header(config.siteName, '第一次安装建议')
  console.log('')
  log(yellow('如果您是第一次安装，请先阅读以下建议：'))
  console.log('')
  log(dim('因本项目部署会释放大量文件（node_modules 约 90MB），'))
  log(dim('请新建一个空白文件夹，将本安装程序放入该文件夹以正常部署。'))
  console.log('')
  log(dim('如果您已经安装过本项目，或确认当前目录可正常使用，'))
  log(dim('可以直接进行下一步。'))
  console.log('')
  await waitKey('按回车继续')
}

// 检测外层目录是否有无关文件（仅单文件模式启用）
function outerHasOtherFiles() {
  const ignore = new Set([
    'nodejs', 'data-backup', '.z80z-chat-bootstrap.ps1',
    path.basename(projectRoot), 'Z80Z-chat.bat', 'start.bat', 'install.bat'
  ])
  try {
    return fs.readdirSync(outerRoot).some(item => !ignore.has(item))
  } catch {
    return false
  }
}

/* ────────────────────────── 界面：首次部署菜单 ────────────────────────── */

// 选项 1：安装依赖并构建前端（端口询问 + 镜像测速 + npm install + build）
async function installAndBuild() {
  cls()
  header('安装依赖并构建前端', '首次部署')

  console.log(`  ${dim('当前端口')}  ${cyan(String(config.port))}`)
  console.log('')
  const portInput = await ask('  ' + accent('>') + ' 请输入端口号（留空自动选择随机端口 10000-60000）：')
  let port
  if (portInput.trim()) {
    port = parseInt(portInput, 10)
    if (isNaN(port) || port < 1 || port > 65535) {
      log(bad('端口号无效（应为 1-65535 的整数）'))
      await waitKey()
      return false
    }
  } else {
    port = getRandomAvailablePort()
    log(dim('已自动选择端口：') + ' ' + cyan(port))
  }
  if (port !== config.port) {
    updateConfigPort(port)
    config.port = port
    log(ok(`config.json 端口已更新为 ${port}`))
  }

  // 镜像：优先用 config.json 记录的线路，否则测速选择
  let registry = config.npmRegistry
  if (!registry) {
    console.log('')
    const sel = await chooseNpmMirror()
    if (!sel) return false
    registry = sel.registry
  }

  console.log('')
  log('安装依赖（npm install，可能需要几分钟）...')
  // 经 PowerShell 中间层执行：node 直接 spawn 子进程时，若父进程
  // 工作目录含空格（如 E:\Opencode Project），vite 构建会异常
  try {
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "npm install --registry=${registry}"`, { cwd: projectRoot, stdio: 'inherit' })
  } catch {
    log(bad('依赖安装失败，请检查网络后重试'))
    await waitKey()
    return false
  }

  log('构建前端（npm run build）...')
  // 同上走 PowerShell 中间层；vite 5.4 另有 html-inline-proxy 偶发失败（重跑即好），自动重试一次
  let buildOk = false
  for (let attempt = 1; attempt <= 2 && !buildOk; attempt++) {
    try {
      execSync('powershell -NoProfile -ExecutionPolicy Bypass -Command "npm run build"', { cwd: projectRoot, stdio: 'inherit' })
      buildOk = true
    } catch {
      if (attempt === 1) {
        log(warn('前端构建失败，自动重试一次 ...'))
      }
    }
  }
  if (!buildOk) {
    log(bad('前端构建失败'))
    await waitKey()
    return false
  }

  // 标记为已安装（version 与 bat 构建版本同源于 package.json，
  // 下次运行 bat 自动发现后直接进入主菜单；仅成功后写入）
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
    fs.writeFileSync(
      path.join(projectRoot, '.install-version'),
      JSON.stringify({ version: pkg.version || '0.0.0', installedAt: new Date().toISOString().slice(0, 19) }),
      'utf8'
    )
  } catch {}

  log(ok('依赖安装与前端构建完成'))
  return true
}

async function firstDeployMenu(needWarning) {
  for (;;) {
    cls()
    header(config.siteName, '首次部署')
    if (needWarning) {
      console.log('')
      console.log('  ' + BG_RED + white(bold('⚠⚠⚠ 严重警告 ⚠⚠⚠')) + R)
      console.log('  ' + BG_RED + white(bold('检测到 data/ 目录存在，但缺少 node_modules/ 依赖')) + R)
      console.log('  ' + BG_RED + white(bold('部署不会删除数据，若 data/ 含重要数据请立即备份')) + R)
      console.log('')
    }
    console.log('')
    console.log(item('1', '安装依赖并构建前端', 'npm install + npm run build'))
    console.log(item('2', '项目介绍', '功能介绍与使用方式'))
    console.log(item('3', '退出', ''))
    console.log('')
    hint('输入选项数字后按回车确认')

    const choice = await ask('  ' + accent('>') + ' ')
    if (choice === '1') {
      const okRes = await installAndBuild()
      if (okRes) {
        console.log('')
        log(ok('部署完成'))
        await waitKey('按回车进入主菜单')
        return
      }
    } else if (choice === '2') {
      cls()
      await showProjectInfo()
    } else if (choice === '3') {
      rl.close()
      console.log('')
      log(dim('再见'))
      console.log('')
      process.exit(0)
    }
  }
}

/* ────────────────────────── 界面：备份管理 ────────────────────────── */

async function backupMenu() {
  for (;;) {
    cls()
    header('备份管理', OUTER_BACKUP)
    const dirs = listBackupDirs()
    const keep = Math.max(1, Number(config.backupKeep) || 3)
    console.log(`  ${dim('现有备份')}  ${cyan(String(dirs.length))}  ${dim('份')}  ${dim('· 保留上限')}  ${cyan(String(keep))}  ${dim('份（config.json 可改）')}`)
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
      const dest = backupDataNow()
      if (dest) log(ok(`备份完成 → ${dest}`))
      await waitKey()
    } else if (choice === '2') {
      cls()
      header('备份列表', `共 ${dirs.length} 份`)
      console.log('')
      if (dirs.length === 0) {
        log(dim('还没有任何备份'))
      } else {
        dirs.forEach((d, i) => {
          const full = path.join(OUTER_BACKUP, d)
          let size = 0
          let count = 0
          try {
            const walk = p => {
              for (const e of fs.readdirSync(p, { withFileTypes: true })) {
                const fp = path.join(p, e.name)
                if (e.isDirectory()) walk(fp)
                else { size += fs.statSync(fp).size; count++ }
              }
            }
            walk(full)
          } catch {}
          const sizeStr = size >= 1048576
            ? (size / 1048576).toFixed(1) + ' MB'
            : (size / 1024).toFixed(1) + ' KB'
          log(`  ${String(i + 1).padStart(2, ' ')}.  ${cyan(d)}  ${dim('· ' + sizeStr + ' · ' + count + ' 个文件')}`)
        })
      }
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
  header('恢复备份', '恢复前强制停止服务')
  const dirs = listBackupDirs()
  if (dirs.length === 0) {
    log(dim('还没有任何备份'))
    await waitKey()
    return
  }
  console.log('')
  dirs.forEach((d, i) => {
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
  if (isNaN(idx) || idx < 0 || idx >= dirs.length) {
    log(dim('无效编号，已取消'))
    await waitKey()
    return
  }
  const src = path.join(OUTER_BACKUP, dirs[idx])
  console.log('')
  log(red('⚠ 恢复将覆盖当前 data/ 目录（账号、消息、上传文件）'))
  const conf = await ask('  ' + accent('>') + ' 确认恢复请输入 YES：')
  if (conf.trim() !== 'YES') {
    log(dim('已取消'))
    await waitKey()
    return
  }

  // 强制停止服务
  console.log('')
  log('停止服务 ...')
  if (portInUse(config.port)) killPort(config.port)
  try { fs.unlinkSync(PID_FILE) } catch {}
  await new Promise(r => setTimeout(r, 500))

  // 恢复前备份当前数据（保留现场便于回滚）
  if (fs.existsSync(dataDir)) {
    try {
      fs.mkdirSync(OUTER_BACKUP, { recursive: true })
      const pre = path.join(OUTER_BACKUP, `pre-restore-${backupStamp()}`)
      fs.cpSync(dataDir, pre, { recursive: true })
      log(dim(`已备份当前数据 → ${pre}`))
    } catch {}
  }

  // 清空并恢复
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.cpSync(src, dataDir, { recursive: true })
  console.log('')
  log(ok(`恢复完成：${dirs[idx]}`))
  log(dim('请重新启动服务使恢复生效'))
  await waitKey()
}

async function cleanupBackups() {
  cls()
  header('清理旧备份', '')
  const dirs = listBackupDirs()
  if (dirs.length === 0) {
    log(dim('还没有任何备份'))
    await waitKey()
    return
  }
  console.log('')
  dirs.forEach((d, i) => {
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
    let removed = 0
    for (const d of dirs) {
      try { fs.rmSync(path.join(OUTER_BACKUP, d), { recursive: true, force: true }); removed++ } catch {}
    }
    log(ok(`已删除 ${removed} 份备份`))
    await waitKey()
    return
  }
  const idx = parseInt(choice, 10) - 1
  if (isNaN(idx) || idx < 0 || idx >= dirs.length) {
    log(dim('无效编号，已取消'))
    await waitKey()
    return
  }
  const target = path.join(OUTER_BACKUP, dirs[idx])
  const conf = await ask(`  ${accent('>')} 确认删除 ${dirs[idx]}？(Y/N)：`)
  if (conf.trim().toUpperCase() === 'Y') {
    fs.rmSync(target, { recursive: true, force: true })
    log(ok(`已删除：${dirs[idx]}`))
  } else {
    log(dim('已取消'))
  }
  await waitKey()
}

/* ────────────────────────── 界面：查看配置 ────────────────────────── */

async function showConfig() {
  header('当前配置', 'config.json')
  section('网络')
  ;[
    kv('端口', cyan(String(config.port))),
    kv('监听地址', cyan(config.host || '(全部网卡)')),
    kv('WebSocket 路径', cyan(config.wsPath)),
    kv('CORS 白名单', cyan(config.corsOrigins.join(', ')))
  ].forEach(log)
  section('存储')
  ;[
    kv('数据目录', cyan(dataDir)),
    kv('数据库文件', cyan(dbPath)),
    kv('上传目录', cyan(uploadDir))
  ].forEach(log)
  section('上传与请求')
  ;[
    kv('上传大小上限', cyan(config.maxUploadSizeMB + ' MB')),
    kv('允许类型', cyan(config.allowedUploadTypes)),
    kv('请求体上限', cyan(config.bodyLimitMB + ' MB'))
  ].forEach(log)
  section('语音 / 投屏')
  ;[
    kv('ICE 服务器', cyan(config.iceServers.map(s => s.urls).join(', '))),
    kv('防火墙', config.firewall?.enabled === false
      ? yellow('关闭')
      : green(`开启 · 「${config.firewall?.ruleName}」`))
  ].forEach(log)
  hint('修改 config.json 后重启服务即可生效')
  await waitKey()
}

/* ────────────────────────── 界面：停止服务 ────────────────────────── */

async function stopService() {
  header('停止服务', '停止当前运行的服务')
  if (!portInUse(config.port)) {
    log(gray('当前没有运行中的服务'))
    await waitKey()
    return
  }
  let stopped = false
  let src = '端口占用进程'
  if (fs.existsSync(PID_FILE)) {
    try {
      const pid = Number(fs.readFileSync(PID_FILE, 'utf-8').trim())
      if (Number.isInteger(pid) && pid > 0 && killPid(pid)) {
        stopped = true
        src = `后台服务 PID ${pid}`
      }
    } catch {}
  }
  if (!stopped && killPort(config.port)) {
    stopped = true
  }
  if (stopped) {
    log(ok(`服务已停止（${src}）`))
    try { fs.unlinkSync(PID_FILE) } catch {}
    killTray()
    // 停止后删除防火墙规则，防止端口被外部利用
    if (config.firewall?.enabled !== false && config.firewall?.ruleName) {
      removeFirewall(config.firewall.ruleName)
    }
  } else {
    log(warn('未能停止服务，可能需要管理员权限'))
  }
  await waitKey()
}

/* ────────────────────────── 界面：项目清档 ────────────────────────── */

async function clearData() {
  header('项目清档', '清空全部数据')
  log(red('⚠⚠⚠ 此操作将永久删除以下内容，且无法恢复 ⚠⚠⚠'))
  console.log('')
  bullets([
    `数据库（全部账号 / 频道 / 消息） ${dbPath}`,
    `上传的文件 ${uploadDir}`,
    `后台运行记录 ${PID_FILE}`,
    `隧道配置（Cloudflare / SakuraFRP） ${path.join(outerRoot, 'cloudflared')} · ${path.join(outerRoot, 'sakurafrp')}`
  ]).forEach(log)
  console.log('')
  log(dim('隧道程序本体（cloudflared.exe / frpc.exe）保留，仅清除配置与状态'))
  console.log('')
  log(red('删除后服务将回到全新安装状态'))
  console.log('')
  const conf = await ask('  ' + accent('>') + ' 确认请输入 YES：')
  if (conf.trim() !== 'YES') {
    log(dim('已取消'))
    await waitKey()
    return
  }

  if (portInUse(config.port)) {
    log('停止服务 ...')
    killPort(config.port)
    await new Promise(r => setTimeout(r, 500))
    try { fs.unlinkSync(PID_FILE) } catch {}
    killTray()
    // 清档停止服务后一并删除防火墙规则
    if (config.firewall?.enabled !== false && config.firewall?.ruleName) {
      removeFirewall(config.firewall.ruleName)
    }
  }
  // 清档一并停止运行中的隧道（Cloudflare / SakuraFRP）
  if (cfTunnelRunning()) { log('停止隧道（Cloudflare）...'); cfStopTunnel() }
  if (sfpRunning()) { log('停止隧道（SakuraFRP）...'); sfpStop() }

  let cleared = 0
  const targets = [dbPath, uploadDir]
  if (fs.existsSync(PID_FILE)) targets.push(PID_FILE)
  // 隧道配置文件（保留 exe，避免重新下载）
  for (const p of [CF_SETTINGS_FILE, CF_CONFIG_FILE, CF_PID_FILE, SFP_SETTINGS_FILE, SFP_PID_FILE, SFP_LOG_FILE, path.join(SFP_DIR, 'frpc.ini')]) {
    if (fs.existsSync(p)) targets.push(p)
  }
  for (const p of targets) {
    try { fs.rmSync(p, { recursive: true, force: true }); cleared++ } catch {}
  }
  log(ok(`清档完成，已清理 ${cleared} 项`))
  log(dim('重启服务后将自动重建空数据'))
  await waitKey()
}

/* ────────────────────────── 界面：部署 ────────────────────────── */

async function deploy() {
  cls()
  // 启动前重新读取 config.json：编辑配置后无需重启管理程序即生效
  const oldPort = config.port
  reloadConfig()
  header('启动服务', `端口 ${config.port}`)

  const valid = validateConfig()
  if (!valid.ok) {
    log(bad(valid.msg))
    await waitKey()
    return null
  }

  console.log(`  ${dim('目标')}  ${cyan(`http://localhost:${config.port}`)}  ${dim('· 监听 ' + (config.host || '0.0.0.0'))}`)
  console.log('')

  // 端口被其他进程占用时警告（checkServiceStatus: conflict = 非本服务占用）
  // 三选项：强制释放 / 更换端口（安装时风格界面）/ 取消；换端口后循环复查
  for (;;) {
    const conflict = checkServiceStatus()
    if (conflict.status !== 'conflict') break
    console.log('')
    log(red('⚠ 端口 ' + config.port + ' 已被进程 ' + getProcessName(conflict.pid) + '（PID: ' + conflict.pid + '）占用'))
    console.log('')
    console.log(item('1', '强制释放端口并启动', '终止占用进程'))
    console.log(item('2', '更换端口', '输入指定端口，留空自动选择随机可用端口'))
    console.log(item('0', '取消', ''))
    console.log('')
    const ch = await ask('  ' + accent('>') + ' ')
    if (ch === '1') {
      log('强制释放端口 ...')
      if (killPort(config.port)) {
        log(ok('占用进程已终止'))
      } else {
        log(warn('未能终止占用进程，可能需要管理员权限'))
      }
      break
    } else if (ch === '2') {
      console.log('')
      console.log(`  ${dim('当前端口')}  ${cyan(String(config.port))}`)
      console.log('')
      const portInput = await ask('  ' + accent('>') + ' 请输入新端口号（留空自动选择随机端口 10000-60000）：')
      let newPort
      if (portInput.trim()) {
        newPort = parseInt(portInput, 10)
        if (isNaN(newPort) || newPort < 1 || newPort > 65535) {
          log(bad('端口号无效（应为 1-65535 的整数）'))
          continue
        }
      } else {
        newPort = getRandomAvailablePort()
        log(dim('已自动选择端口：') + ' ' + cyan(newPort))
      }
      if (newPort !== config.port) {
        updateConfigPort(newPort)
        config.port = newPort
        log(ok(`config.json 端口已更新为 ${newPort}`))
      }
      continue
    } else {
      log(dim('已取消启动'))
      await waitKey()
      return null
    }
  }

  log('检查端口占用 ...')
  // 同时清理旧端口（配置修改前的）与新端口上的残留进程，避免端口漂移
  let freed = killPort(oldPort) || (config.port !== oldPort && killPort(config.port))
  log(freed ? ok('已停止旧服务进程') : dim('端口空闲'))
  try { fs.unlinkSync(PID_FILE) } catch {}

  if (SKIP_FIREWALL || config.firewall?.enabled === false) {
    log(dim('跳过防火墙配置'))
  } else {
    log('配置防火墙规则 ...')
    applyFirewall(config.port, config.firewall.ruleName)
  }

  log('启动服务 ...')
  const child = spawnAttached()

  log('等待服务就绪 ...')
  const ready = await waitForServer(config.port)
  if (!ready) {
    log(bad('服务启动失败或超时'))
    killPid(child.pid)
    await waitKey()
    return null
  }

  console.log('')
  console.log(`  ${green('●')} ${bold('服务启动成功')}`)
  console.log(`    ${dim('本机')}    ${cyan(`http://localhost:${config.port}`)}`)
  for (const ip of localIPv4()) {
    console.log(`    ${dim('局域网')}  ${cyan(`http://${ip}:${config.port}`)}`)
  }
  console.log('')
  return child
}

/* ────────────────────────── 界面：运行中菜单 ────────────────────────── */

async function runningMenu(child = null, isBackground = false) {
  let lastStatus = null
  let currentStatus = null

  const render = () => {
    reloadConfig()
    currentStatus = checkServiceStatus()

    if (currentStatus.status === 'running') {
      cls()
      header('服务运行中', `端口 ${config.port}`, green('●'))
      console.log(`  ${dim('本机')}    ${cyan(`http://localhost:${config.port}`)}`)
      for (const ip of localIPv4()) {
        console.log(`  ${dim('局域网')}  ${cyan(`http://${ip}:${config.port}`)}`)
      }
      console.log('')
      if (currentStatus.runningTime) {
        console.log(`  ${dim('PID')} ${cyan(currentStatus.pid)}  ${dim('·')}  ${dim('运行时间')} ${cyan(currentStatus.runningTime)}`)
      }
      console.log('')
      console.log(HLINE)
      console.log('')
      if (isBackground) {
        console.log(item('1', '停止服务', '停止后台服务并返回主菜单'))
        console.log(item('0', '返回主菜单', '服务继续在后台运行'))
        hint('服务在后台运行，关闭窗口不影响服务 · 状态每 10 秒自动检测')
      } else {
        console.log(item('1', '转入后台', '关闭窗口后服务继续运行'))
        console.log(item('2', '停止服务', '停止服务并返回主菜单'))
        console.log(item('0', '返回主菜单', '服务转入后台继续运行'))
        hint('直接关闭窗口也会停止服务 · 状态每 10 秒自动检测')
      }
    } else {
      const dot = currentStatus.status === 'conflict' ? yellow('●') : red('○')
      const title = currentStatus.status === 'conflict' ? '服务状态异常' : '服务已停止'
      cls()
      header(title, `端口 ${config.port}`, dot)
      console.log(`  ${currentStatus.message}`)
      console.log('')
      console.log(item('1', '返回主菜单', ''))
      hint('状态每 10 秒自动检测')
    }

    lastStatus = currentStatus.status
  }

  render()

  // 10秒定时检测：仅在状态变化时重绘，避免打断用户输入
  const timer = setInterval(() => {
    const newStatus = checkServiceStatus()
    if (newStatus.status !== lastStatus) {
      render()
      process.stdout.write('  ' + (USE_COLOR ? ACCENT + '>' + R : '>') + ' ')
    }
  }, 10000)

  try {
    for (;;) {
      const choice = await ask('  ' + accent('>') + ' ')

      if (lastStatus === 'running') {
        if (isBackground) {
          if (choice === '1') {
            clearInterval(timer)
            log('停止服务 ...')
            const pid = currentStatus.pid
            if (pid && killPid(pid)) {
              log(ok('服务已停止'))
            } else {
              log(warn('尝试按端口清理 ...'))
              if (killPort(config.port)) log(ok('服务已停止'))
              else log(dim('服务可能已自行退出'))
            }
            try { fs.unlinkSync(PID_FILE) } catch {}
            if (config.firewall?.enabled !== false && config.firewall?.ruleName) {
              removeFirewall(config.firewall.ruleName)
            }
            await waitKey('按回车返回主菜单')
            return
          } else if (choice === '0') {
            clearInterval(timer)
            return
          }
        } else {
          if (choice === '1') {
            clearInterval(timer)
            log('转入后台 ...')
            killPid(child.pid)
            await new Promise(r => setTimeout(r, 800))
            const pid = spawnBackground()
            ensureTray()
            console.log('')
            log(ok(`服务已转入后台运行（PID ${pid}）`))
            log(dim('  已生成系统托盘图标，可右键打开面板或停止服务'))
            console.log('')
            rl.close()
            process.exit(0)
          } else if (choice === '2') {
            clearInterval(timer)
            log('停止服务 ...')
            if (killPid(child.pid)) {
              log(ok('服务已停止'))
            } else {
              log(warn('尝试按端口清理 ...'))
              if (killPort(config.port)) log(ok('服务已停止'))
              else log(dim('服务可能已自行退出'))
            }
            try { fs.unlinkSync(PID_FILE) } catch {}
            killTray()
            if (config.firewall?.enabled !== false && config.firewall?.ruleName) {
              removeFirewall(config.firewall.ruleName)
            }
            await waitKey('按回车返回主菜单')
            return
          } else if (choice === '0') {
            // 转入后台并返回主菜单（服务继续运行，不停止）
            clearInterval(timer)
            log('转入后台 ...')
            killPid(child.pid)
            await new Promise(r => setTimeout(r, 800))
            const pid = spawnBackground()
            ensureTray()
            console.log('')
            log(ok(`服务已转入后台运行（PID ${pid}）`))
            console.log('')
            await waitKey('按回车返回主菜单')
            return
          }
        }
      } else {
        // 服务未运行，仅有返回主菜单选项
        if (choice === '1') {
          clearInterval(timer)
          return
        }
      }
    }
  } finally {
    clearInterval(timer)
  }
}

/* ────────────────────────── 界面：切换版本 ────────────────────────── */

// 外层所有已安装项目（与引导层 Find-Project 判定一致）
function listInstalledProjects() {
  if (!isSingleFileMode()) return []
  const out = []
  try {
    for (const e of fs.readdirSync(outerRoot, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const dir = path.join(outerRoot, e.name)
      if (!fs.existsSync(path.join(dir, 'start.js'))) continue
      if (!fs.existsSync(path.join(dir, '.install-version'))) continue
      let ver = ''
      try {
        const mk = JSON.parse(fs.readFileSync(path.join(dir, '.install-version'), 'utf8'))
        ver = mk.version || ''
      } catch {}
      out.push({ name: e.name, dir, version: ver })
    }
  } catch {}
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// 写外层 bat 偏好（等长 PAD，与引导层 Set-BatPreferenceSafe 的 64 基准一致）
function setBatPreference(key, value) {
  const batPath = path.join(outerRoot, 'Z80Z-chat.bat')
  if (!fs.existsSync(batPath)) return false
  try {
    const lines = fs.readFileSync(batPath, 'utf8').split(/\r?\n/)
    if (!lines.some(l => /^REM _CONFIG_HASH=nch1$/.test(l))) return false
    const re = new RegExp('^REM _' + key + '=')
    let found = false
    let oldLen = 0
    let newLen = 0
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        oldLen += lines[i].length
        const r = 'REM _' + key + '=' + value
        newLen += r.length
        lines[i] = r
        found = true
      }
    }
    if (!found) return false
    const diff = newLen - oldLen
    for (let i = 0; i < lines.length; i++) {
      if (/^REM PAD +$/.test(lines[i])) {
        const pad = 64 - diff
        lines[i] = 'REM PAD' + ' '.repeat(pad < 0 ? 0 : pad)
        break
      }
    }
    fs.writeFileSync(batPath, lines.join('\r\n'), 'utf8')
    return true
  } catch {
    return false
  }
}

async function switchVersion() {
  cls()
  header('切换版本', '在外层已安装的版本之间选择')
  if (!isSingleFileMode()) {
    log(dim('仅单文件部署模式（外层存在 Z80Z-chat.bat）支持切换版本'))
    await waitKey()
    return
  }
  const projects = listInstalledProjects()
  if (projects.length === 0) {
    log(dim('未找到其他已安装的项目'))
    await waitKey()
    return
  }
  const current = path.basename(projectRoot)
  console.log('')
  console.log(HLINE)
  console.log('')
  projects.forEach((p, i) => {
    const mark = p.name === current ? '  [当前]' : ''
    log(`  ${String(i + 1).padStart(2, ' ')}.  ${cyan(p.name)}${dim(mark)}  ${dim('· 版本 ' + (p.version || '未知'))}`)
  })
  console.log('')
  console.log(HLINE)
  console.log('')
  const choice = await ask('  ' + accent('>') + ' 选择版本编号（0 返回）：')
  if (!choice.trim()) {
    log(dim('已取消'))
    await waitKey()
    return
  }
  const idx = parseInt(choice, 10) - 1
  if (isNaN(idx) || idx < 0 || idx >= projects.length) {
    log(dim('无效编号，已取消'))
    await waitKey()
    return
  }
  const target = projects[idx]
  if (target.name === current) {
    log(dim('当前已在使用该版本'))
    await waitKey()
    return
  }
  // 运行中先停止当前服务
  if (portInUse(config.port)) {
    console.log('')
    log('切换前停止当前服务 ...')
    killPort(config.port)
    await new Promise(r => setTimeout(r, 500))
    try { fs.unlinkSync(PID_FILE) } catch {}
    if (config.firewall?.enabled !== false && config.firewall?.ruleName) {
      removeFirewall(config.firewall.ruleName)
    }
    log(ok('服务已停止'))
  }
  console.log('')
  if (setBatPreference('LAST_PROJECT', target.name)) {
    log(ok(`已切换到：${target.name}`))
    log(dim('请关闭本窗口，重新运行 Z80Z-chat.bat 进入该版本'))
  } else {
    log(bad('写入外层 Z80Z-chat.bat 偏好失败，切换未生效'))
    log(dim('请通过引导层「版本选择」切换'))
  }
  await waitKey()
  rl.close()
  process.exit(0)
}

/* ────────────────────────── 界面：隧道管理 ────────────────────────── */

// cloudflared 与 Node.js 同模式：不内嵌二进制，首次使用按需下载到外层 cloudflared/
const CF_DIR = path.join(outerRoot, 'cloudflared')
const CF_EXE = path.join(CF_DIR, 'cloudflared.exe')
const CF_PID_FILE = path.join(CF_DIR, '.cloudflared.pid')
const CF_SETTINGS_FILE = path.join(CF_DIR, 'settings.json')
const CF_CONFIG_FILE = path.join(CF_DIR, 'config.yml')
const CF_TUNNEL_NAME = 'z80z-chat'
const CF_DEFAULT_HOSTNAME = 'chat.z80z99.cn'
// cloudflared 下载源（测速选择，镜像 Node.js 的网络线路选择）
const CF_SOURCES = [
  { name: 'GitHub 官方', url: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' },
  { name: 'ghproxy.net', url: 'https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' },
  { name: 'gh-proxy.com', url: 'https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' }
]
const CF_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

// SakuraFRP（樱花内网穿透）：frpc 下载链接与隧道均来自官方管理面板，无法自动注册
const SFP_DIR = path.join(outerRoot, 'sakurafrp')
const SFP_EXE = path.join(SFP_DIR, 'frpc.exe')
const SFP_PID_FILE = path.join(SFP_DIR, '.sakurafrp.pid')
const SFP_SETTINGS_FILE = path.join(SFP_DIR, 'settings.json')
const SFP_LOG_FILE = path.join(SFP_DIR, 'frpc.log')
const SFP_PANEL_URL = 'https://www.natfrp.com/user/'
const SFP_TUNNEL_URL = 'https://www.natfrp.com/tunnel/'

// 查找 cloudflared：本地 cloudflared/ 优先，回退系统 PATH
function findCloudflared() {
  if (fs.existsSync(CF_EXE)) return CF_EXE
  try {
    execSync('cloudflared --version', { stdio: 'ignore' })
    return 'cloudflared'
  } catch {}
  return null
}

// 读取/写入隧道设置（hostname 可在 settings.json 中自定义）
function cfSettings() {
  try { return JSON.parse(fs.readFileSync(CF_SETTINGS_FILE, 'utf8')) } catch { return {} }
}

function cfSaveSettings(s) {
  fs.mkdirSync(CF_DIR, { recursive: true })
  fs.writeFileSync(CF_SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8')
}

function cfHostname() { return cfSettings().hostname || CF_DEFAULT_HOSTNAME }

// 隧道是否已创建：settings 缓存 → tunnel list → tunnel info
function cfTunnelId() {
  const s = cfSettings()
  if (s.tunnelId) return s.tunnelId
  const exe = findCloudflared()
  if (!exe) return null
  try {
    const out = execSync(`"${exe}" tunnel list`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const m = out.match(new RegExp('(' + CF_UUID_RE.source + ')\\s+' + CF_TUNNEL_NAME + '\\s'))
    if (m) { cfSaveSettings({ ...s, tunnelId: m[1] }); return m[1] }
  } catch {}
  try {
    const out = execSync(`"${exe}" tunnel info ${CF_TUNNEL_NAME}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const m = out.match(new RegExp('ID:\\s*(' + CF_UUID_RE.source + ')', 'i'))
    if (m) { cfSaveSettings({ ...s, tunnelId: m[1] }); return m[1] }
  } catch {}
  return null
}

// 隧道是否在运行（PID 文件 + tasklist 校验）
function cfTunnelRunning() {
  try {
    const pid = Number(fs.readFileSync(CF_PID_FILE, 'utf8').trim())
    if (!pid) return null
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.includes(`"${pid}"`) ? pid : null
  } catch {
    return null
  }
}

function cfStopTunnel() {
  const pid = cfTunnelRunning()
  if (!pid) return false
  const killed = killPid(pid)
  if (killed) { try { fs.unlinkSync(CF_PID_FILE) } catch {} }
  return killed
}

// 版本校验（下载后/已安装时读取版本号）
function cfCheck(exe) {
  try {
    const out = execSync(`"${exe}" --version`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.trim().split(/\r?\n/)[0] || 'cloudflared'
  } catch {
    return null
  }
}

// 从指定线路下载（带进度显示），返回是否成功
async function cfDownloadFrom(url) {
  const r = await downloadWithProgress(url, CF_EXE, { dim })
  if (!r.ok) log(bad(`下载失败：${r.error}`))
  return r.ok
}

// 网络线路选择（镜像 Node.js 的 Choose-Line）：HEAD 测速 + 颜色分级
async function cfChooseSource(purpose) {
  header('网络线路选择', 'cloudflared 下载源测速')
  console.log('')
  log(`当前准备下载：${purpose}`)
  console.log('')
  log(dim('正在测速（延迟越低越好）...'))
  console.log('')
  const results = []
  for (const s of CF_SOURCES) {
    const start = Date.now()
    let ms = 99999
    try {
      const res = await fetch(s.url, { method: 'HEAD', signal: AbortSignal.timeout(8000) })
      if (res.ok) ms = Date.now() - start
    } catch {}
    results.push({ ...s, ms })
  }
  results.sort((a, b) => a.ms - b.ms)
  results.forEach((s, i) => {
    const t = s.ms >= 99999 ? '超时' : s.ms + ' ms'
    const c = s.ms >= 99999 ? red(t) : (s.ms < 50 ? green(t) : (s.ms < 150 ? yellow(t) : red(t)))
    log(`  ${accent(String(i + 1).padStart(2, ' '))}.  ${white(s.name.padEnd(16))}${dim('延迟：')}${c}`)
  })
  console.log('')
  console.log(HLINE)
  console.log('')
  const ch = await ask('  ' + accent('>') + ' 选择线路编号（留空自动选最快）：')
  let idx = 0
  const n = parseInt(ch.trim(), 10)
  if (!isNaN(n) && n >= 1 && n <= results.length) idx = n - 1
  const sel = results[idx]
  console.log('')
  log(ok(`已选择线路：${sel.name}`))
  return sel
}

// 生成 config.yml（每次启动时按当前 config.json 端口重写）
function cfWriteConfig(tunnelId) {
  const cred = path.join(os.homedir(), '.cloudflared', tunnelId + '.json').replace(/\\/g, '/')
  const yml = [
    `tunnel: ${tunnelId}`,
    `credentials-file: ${cred}`,
    ``,
    `ingress:`,
    `  - hostname: ${cfHostname()}`,
    `    service: http://localhost:${config.port}`,
    `  - service: http_status:404`,
    ``
  ].join('\n')
  fs.mkdirSync(CF_DIR, { recursive: true })
  fs.writeFileSync(CF_CONFIG_FILE, yml, 'utf8')
}

// 交互式 cloudflared 命令（登录/路由需要浏览器或终端交互）
function cfRunInteractive(args) {
  const exe = findCloudflared()
  if (!exe) return -1
  return spawnSync(exe, args, { stdio: 'inherit' }).status ?? -1
}

// 启动隧道（后台运行 + PID 记录 + 公网可达检测）
async function cfStart() {
  const exe = findCloudflared()
  if (!exe) return { ok: false, msg: 'cloudflared 未安装，请先在「隧道管理」中安装' }
  const tunnelId = cfTunnelId()
  if (!tunnelId) return { ok: false, msg: '隧道尚未创建，请先运行「首次配置向导」' }
  if (cfTunnelRunning()) return { ok: true, msg: '隧道已在运行' }
  cfWriteConfig(tunnelId)
  const child = spawn(exe, ['tunnel', '--config', CF_CONFIG_FILE, 'run', CF_TUNNEL_NAME], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.unref()
  try { fs.writeFileSync(CF_PID_FILE, String(child.pid)) } catch {}
  log(dim('隧道启动中（首次建立连接需 10~30 秒）...'))
  const url = `https://${cfHostname()}/api/config`
  const reachable = await new Promise((resolve) => {
    const start = Date.now()
    const tick = async () => {
      if (Date.now() - start > 30000) return resolve(false)
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
        if (res.ok) return resolve(true)
      } catch {}
      setTimeout(tick, 2000)
    }
    tick()
  })
  if (reachable) return { ok: true, msg: `公网访问正常：${url}` }
  return { ok: true, msg: `已启动（公网连接建立中，稍后访问 https://${cfHostname()}）` }
}

// 首次配置向导：登录 → 创建隧道 → 绑定域名 → 写配置 → 启动
async function cfWizard() {
  cls()
  header('首次配置向导', '登录 Cloudflare · 创建隧道 · 绑定域名')
  let exe = findCloudflared()
  if (!exe) {
    console.log('')
    log(warn('cloudflared 未安装，需先安装（约 54MB）'))
    console.log('')
    const installed = await cfInstallMenu()
    if (!installed) return
    exe = findCloudflared()
  }
  console.log('')
  log('第 1/4 步：登录 Cloudflare 账号')
  log(dim('  将打开浏览器，请选择并授权你的域名（z80z99.cn）'))
  console.log('')
  if (cfRunInteractive(['tunnel', 'login']) !== 0) {
    log(bad('登录失败或已取消'))
    await waitKey()
    return
  }
  log(ok('登录成功'))
  console.log('')
  log('第 2/4 步：创建隧道（已存在则复用）')
  console.log('')
  let tunnelId = cfTunnelId()
  if (!tunnelId) {
    const r = spawnSync(exe, ['tunnel', 'create', CF_TUNNEL_NAME], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    const out = (r.stdout || '') + (r.stderr || '')
    const m = out.match(CF_UUID_RE)
    if (r.status === 0 && m) {
      tunnelId = m[0]
      cfSaveSettings({ ...cfSettings(), tunnelId })
      log(ok(`隧道已创建（${tunnelId}）`))
    } else {
      tunnelId = cfTunnelId()
      if (!tunnelId) {
        log(bad('创建隧道失败'))
        if (out.trim()) console.log('  ' + dim(out.trim()))
        await waitKey()
        return
      }
      log(ok(`复用已有隧道（${tunnelId}）`))
    }
  } else {
    log(dim(`隧道已存在（${tunnelId}），跳过创建`))
  }
  console.log('')
  log(`第 3/4 步：绑定域名 ${cfHostname()} → 隧道`)
  console.log('')
  if (cfRunInteractive(['tunnel', 'route', 'dns', CF_TUNNEL_NAME, cfHostname()]) !== 0) {
    log(warn('DNS 路由未成功（若记录已存在可忽略）'))
  } else {
    log(ok('DNS 路由已绑定'))
  }
  cfWriteConfig(tunnelId)
  log(ok(`配置已写入 ${CF_CONFIG_FILE}`))
  console.log('')
  const ans = await ask('  ' + accent('>') + ' 立即启动隧道？(y/N)：')
  if (ans.trim().toLowerCase() === 'y') {
    console.log('')
    const r = await cfStart()
    log(r.ok ? ok(r.msg) : bad(r.msg))
  }
  await waitKey()
}

// 安装/修复菜单（镜像 Node.js 的 Ensure-NodeJs 流程：说明 → 线路选择 → 下载 → 校验 → 完成）
async function cfInstallMenu() {
  cls()
  header('需要下载 cloudflared 并安装', 'Cloudflare Tunnel 客户端（约 54MB）')
  console.log('')
  const existing = findCloudflared()
  if (existing) {
    log(ok('已检测到 cloudflared（' + (cfCheck(existing) || '已安装') + '），可重新安装修复'))
  } else {
    log(warn('未检测到 cloudflared 运行环境'))
  }
  console.log('')
  console.log(item('1', '自动下载 cloudflared 安装（约 54MB）', '推荐，一键安装'))
  console.log(item('2', '手动下载（内含教程）', '手动下载后放入 cloudflared/ 目录'))
  console.log(item('0', '返回', '稍后手动安装'))
  console.log('')
  console.log(HLINE)
  console.log('')
  log(dim('为什么需要 cloudflared？'))
  console.log('')
  for (const t of [
    '  它是 Cloudflare Tunnel 的客户端，用于把本机服务安全地暴露到公网，',
    '  无需公网 IP、无需路由器端口映射。',
    '  它用于：将 Z80Z-chat 通过域名 https://chat.z80z99.cn 对外访问。',
    '  cloudflared 将安装到当前文件夹内的 cloudflared/ 目录，',
    '  不影响系统其他程序。'
  ]) log(dim(t))
  console.log('')
  console.log(HLINE)
  console.log('')
  const choice = await ask('  ' + accent('>') + ' 输入选项编号：')
  if (choice === '1') {
    for (;;) {
      cls()
      const sel = await cfChooseSource('cloudflared（约 54MB）')
      console.log('')
      log(dim(`正在下载 cloudflared（${sel.name}，网络较慢时可能需要数分钟）...`))
      console.log('')
      if (await cfDownloadFrom(sel.url)) {
        console.log('')
        log('校验安装（cloudflared --version）...')
        const ver = cfCheck(CF_EXE)
        if (ver) {
          log(ok('校验通过'))
          console.log('')
          log(ok('cloudflared 安装完成：' + ver))
          console.log('')
          log(dim('安装位置：' + CF_DIR))
          console.log('')
          for (const t of [
            'cloudflared 与项目本体在同一文件夹内（cloudflared/），卸载时',
            '删除整个文件夹即可彻底卸载。'
          ]) log(dim(t))
          console.log('')
          await waitKey('按回车返回隧道管理')
          return true
        }
        log(bad('安装校验失败（文件可能不完整），已删除，请重新下载'))
        try { fs.unlinkSync(CF_EXE) } catch {}
        await waitKey('按回车重新选择线路下载')
        continue
      }
      await waitKey('按回车重新选择线路下载')
    }
  }
  if (choice === '2') {
    cls()
    header('手动下载教程', 'cloudflared')
    console.log('')
    console.log('  ' + white('步骤 1：下载'))
    console.log('')
    log('  浏览器打开：' + CF_SOURCES[0].url)
    log('  （自动跳转到 GitHub 最新版 cloudflared-windows-amd64.exe）')
    console.log('')
    console.log('  ' + HLINE)
    console.log('')
    console.log('  ' + white('步骤 2：重命名'))
    console.log('')
    log('  将下载的 exe 重命名为 cloudflared.exe')
    console.log('')
    console.log('  ' + HLINE)
    console.log('')
    console.log('  ' + white('步骤 3：放入目录'))
    console.log('')
    log('  放入当前文件夹内的 cloudflared/ 目录')
    log('  （完整路径：' + CF_DIR + '）')
    console.log('')
    console.log('  ' + HLINE)
    console.log('')
    log(dim('完成后回到「隧道管理」→「首次配置向导」继续'))
    console.log('')
    await waitKey('按回车返回')
    return fs.existsSync(CF_EXE)
  }
  return false
}

// 公网访问测试
async function cfTest() {
  const url = `https://${cfHostname()}/api/config`
  log('测试 ' + url + ' ...')
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (res.ok) log(ok('公网访问正常'))
    else log(warn('公网可访问，但返回异常状态 ' + res.status))
  } catch {
    log(bad('无法访问（隧道未启动或连接未建立）'))
  }
  await waitKey()
}

// Cloudflare Tunnel 管理子菜单（经「隧道管理」选择页进入）
async function cfMenu() {
  for (;;) {
    cls()
    header('Cloudflare Tunnel', '管理 · ' + cfHostname())
    const exe = findCloudflared()
    const running = cfTunnelRunning()
    const tunnelId = cfTunnelId()
    console.log('')
    console.log(`  ${exe ? green('●') : red('○')} ${dim('cloudflared')}  ${exe ? green('已安装') : red('未安装')}`)
    console.log(`  ${tunnelId ? green('●') : yellow('○')} ${dim('隧道')}  ${tunnelId ? green('已创建') : yellow('未创建')}`)
    console.log(`  ${running ? green('●') : red('○')} ${dim('运行')}  ${running ? green('运行中 · PID ' + running) : red('已停止')}`)
    console.log(`  ${dim('·')}  ${dim('公网地址')} ${cyan('https://' + cfHostname())}`)
    console.log('')
    console.log(HLINE)
    console.log('')
    console.log(item('1', '首次配置向导', '登录 Cloudflare · 创建隧道 · 绑定域名'))
    console.log(item('2', '启动隧道', '后台运行，将公网地址指向本机服务', !!exe))
    console.log(item('3', '停止隧道', '停止后台 cloudflared 进程', !!running))
    console.log(item('4', '安装 / 修复 cloudflared', '自动下载（约 54MB，线路测速选择）'))
    console.log(item('5', '测试公网访问', `检查 https://${cfHostname()} 是否可达`, !!running))
    console.log(item('0', '返回主菜单', ''))
    console.log('')
    const choice = await ask('  ' + accent('>') + ' ')
    if (choice === '1') {
      await cfWizard()
    } else if (choice === '2') {
      console.log('')
      const r = await cfStart()
      log(r.ok ? ok(r.msg) : bad(r.msg))
      await waitKey()
    } else if (choice === '3') {
      console.log('')
      if (cfStopTunnel()) log(ok('隧道已停止'))
      else log(warn('未发现运行中的隧道'))
      await waitKey()
    } else if (choice === '4') {
      await cfInstallMenu()
    } else if (choice === '5') {
      console.log('')
      await cfTest()
    } else if (choice === '0') {
      return
    }
  }
}

/* ────────────────────────── 界面：隧道管理（服务选择） ────────────────────────── */

// 隧道服务选择页：Cloudflare Tunnel / SakuraFRP
async function tunnelMenu() {
  for (;;) {
    cls()
    header('隧道管理', '选择内网穿透服务')
    const cfExe = findCloudflared()
    const cfRun = cfTunnelRunning()
    const sfpExe = findFrpc()
    const sfpRun = sfpRunning()
    console.log('')
    console.log(`  ${cfExe ? green('●') : red('○')}  ${white('Cloudflare Tunnel')}  ${cfRun ? green('运行中') : (cfExe ? dim('已停止') : red('未安装'))}  ${dim('· 海外节点，无限流量')}`)
    console.log(`  ${sfpExe ? green('●') : red('○')}  ${white('SakuraFRP（国内低延迟）')}  ${sfpRun ? green('运行中') : (sfpExe ? dim('已停止') : red('未安装'))}  ${dim('· 国内节点，免费 5GiB/月')}`)
    console.log('')
    console.log(HLINE)
    console.log('')
    console.log(item('1', 'Cloudflare Tunnel', '域名访问 · 无限流量 · 需 Cloudflare 账号'))
    console.log(item('2', 'SakuraFRP', '国内低延迟 · 需 natfrp.com 账号'))
    console.log(item('0', '返回主菜单', ''))
    console.log('')
    const choice = await ask('  ' + accent('>') + ' ')
    if (choice === '1') {
      await cfMenu()
    } else if (choice === '2') {
      await sfpMenu()
    } else if (choice === '0') {
      return
    }
  }
}

/* ────────────────────────── SakuraFRP（樱花内网穿透） ────────────────────────── */

// 查找 frpc：外层 sakurafrp/frpc.exe
function findFrpc() {
  return fs.existsSync(SFP_EXE) ? SFP_EXE : null
}

// 读取/写入 SakuraFRP 设置（token / tunnelId / mode / accessUrl 等）
function sfpSettings() {
  try { return JSON.parse(fs.readFileSync(SFP_SETTINGS_FILE, 'utf8')) } catch { return {} }
}

function sfpSaveSettings(s) {
  fs.mkdirSync(SFP_DIR, { recursive: true })
  fs.writeFileSync(SFP_SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8')
}

// frpc 是否在运行（PID 文件 + tasklist 校验）
function sfpRunning() {
  try {
    const pid = Number(fs.readFileSync(SFP_PID_FILE, 'utf8').trim())
    if (!pid) return null
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.includes(`"${pid}"`) ? pid : null
  } catch {
    return null
  }
}

function sfpStop() {
  const pid = sfpRunning()
  if (!pid) return false
  const killed = killPid(pid)
  if (killed) { try { fs.unlinkSync(SFP_PID_FILE) } catch {} }
  return killed
}

// 版本校验（frpc -v）
function sfpCheck(exe) {
  try {
    const out = execSync(`"${exe}" -v`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.trim().split(/\r?\n/)[0] || 'frpc'
  } catch {
    return null
  }
}

// 从面板复制链接下载 frpc（账号专属链接，无法自动获取），返回是否成功
async function sfpDownloadFrom(url) {
  const r = await downloadWithProgress(url, SFP_EXE, { dim })
  if (!r.ok) log(bad(`下载失败：${r.error}`))
  return r.ok
}

// 下载 frpc（引导粘贴面板链接）→ 校验 → 返回是否成功
async function sfpInstallFrpc() {
  cls()
  header('需要下载 frpc 并安装', 'SakuraFrp 客户端（约 10~20MB）')
  console.log('')
  const existing = findFrpc()
  if (existing) {
    log(ok('已检测到 frpc（' + (sfpCheck(existing) || '已安装') + '），可重新下载修复'))
  } else {
    log(warn('未检测到 frpc 运行环境'))
  }
  console.log('')
  console.log('  ' + white('获取下载链接：'))
  console.log('')
  for (const t of [
    'frpc 的下载链接由 SakuraFrp 管理面板按账号生成，',
    '请按以下步骤复制：',
    '',
    '1. 浏览器打开面板：' + SFP_PANEL_URL,
    '2. 登录后进入「软件下载」页面',
    '3. 选择 frpc → Windows → amd64（x64）',
    '4. 点击「复制下载链接」'
  ]) log(dim(t))
  console.log('')
  console.log(HLINE)
  console.log('')
  console.log('  ' + accent('>') + ' 粘贴下载链接（留空取消）：')
  const url = await ask('  ' + accent('>') + ' ')
  if (!url.trim()) return false
  console.log('')
  log(dim('正在下载 frpc（网络较慢时可能需要数分钟）...'))
  console.log('')
  if (await sfpDownloadFrom(url.trim())) {
    console.log('')
    log('校验安装（frpc -v）...')
    const ver = sfpCheck(SFP_EXE)
    if (ver) {
      log(ok('校验通过'))
      console.log('')
      log(ok('frpc 安装完成：' + ver))
      console.log('')
      log(dim('安装位置：' + SFP_DIR))
      console.log('')
      await waitKey('按回车继续')
      return true
    }
    log(bad('安装校验失败（文件可能不完整），已删除，请重新下载'))
    try { fs.unlinkSync(SFP_EXE) } catch {}
    await waitKey()
    return false
  }
  await waitKey()
  return false
}

// 从 frpc 日志解析公网访问地址（成功连接后 frpc 会打印访问地址）
function sfpParseLogUrl() {
  try {
    const logText = fs.readFileSync(SFP_LOG_FILE, 'utf8')
    const m = logText.match(/https?:\/\/[^\s"'<>]+/)
    return m ? m[0].replace(/[),，;；]$/, '') : null
  } catch {
    return null
  }
}

// 读取访问地址：settings 缓存 → 日志解析
function sfpAccessUrl() {
  const s = sfpSettings()
  if (s.accessUrl) return s.accessUrl
  return sfpParseLogUrl()
}

// 启动隧道（后台运行 + PID 记录 + 日志重定向 + 公网可达检测）
async function sfpStart() {
  const exe = findFrpc()
  if (!exe) return { ok: false, msg: 'frpc 未安装，请先在「首次配置向导」中安装' }
  const s = sfpSettings()
  const running = sfpRunning()
  if (running) return { ok: true, msg: '隧道已在运行' }
  let args = []
  if (s.mode === 'cli') {
    if (!s.token || !s.tunnelId) return { ok: false, msg: '未配置访问密钥/隧道 ID，请重新运行「首次配置向导」' }
    args = ['-f', `${s.token}:${s.tunnelId}`]
  } else if (!fs.existsSync(path.join(SFP_DIR, 'frpc.ini'))) {
    return { ok: false, msg: '未检测到 frpc.ini，请先通过「首次配置向导」的交互模式配置隧道' }
  }
  const child = spawn(exe, args, {
    cwd: SFP_DIR,
    detached: true,
    stdio: ['ignore', fs.openSync(SFP_LOG_FILE, 'a'), fs.openSync(SFP_LOG_FILE, 'a')],
    windowsHide: true
  })
  child.unref()
  try { fs.writeFileSync(SFP_PID_FILE, String(child.pid)) } catch {}
  log(dim('隧道启动中（连接国内节点通常 3~10 秒）...'))
  const url = sfpAccessUrl()
  if (url) {
    const reachable = await new Promise((resolve) => {
      const start = Date.now()
      const tick = async () => {
        if (Date.now() - start > 30000) return resolve(false)
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
          if (res.ok) return resolve(true)
        } catch {}
        setTimeout(tick, 2000)
      }
      tick()
    })
    if (reachable) return { ok: true, msg: `公网访问正常：${url}` }
    return { ok: true, msg: `已启动（公网连接建立中，稍后访问 ${url}）` }
  }
  return { ok: true, msg: '已启动（访问地址请到 SakuraFrp 面板「隧道列表」查看）' }
}

// 公网访问测试
async function sfpTest() {
  const url = sfpAccessUrl()
  if (!url) {
    log(warn('尚未获取到访问地址，请先启动隧道，或到面板「隧道列表」复制访问地址'))
    console.log('')
    log(dim('提示：可在 sakurafrp/settings.json 中手动填入 accessUrl 字段'))
    await waitKey()
    return
  }
  log('测试 ' + url + ' ...')
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (res.ok) log(ok('公网访问正常'))
    else log(warn('公网可访问，但返回异常状态 ' + res.status))
  } catch {
    log(bad('无法访问（隧道未启动或连接未建立）'))
  }
  await waitKey()
}

// 首次配置向导：下载 frpc → 访问密钥 → 创建隧道指引 → 连接配置
async function sfpWizard() {
  cls()
  header('首次配置向导', 'SakuraFrp 国内低延迟穿透')
  console.log('')
  for (const t of [
    'SakuraFrp（樱花内网穿透）提供国内节点，延迟远低于 Cloudflare。',
    '免费额度：2 条隧道 · 10Mbps 限速 · 每月 5 GiB 流量（可签到领取）。',
    '需要：natfrp.com 账号（含实名认证）+ 面板中创建的隧道。',
    '语音 / 投屏走 WebRTC 点对点不占流量，文字聊天与文件上传才消耗额度。'
  ]) log(dim(t))
  console.log('')
  console.log(HLINE)
  console.log('')
  let exe = findFrpc()
  if (!exe) {
    log('第 1/4 步：安装 frpc')
    console.log('')
    if (!(await sfpInstallFrpc())) return
    exe = findFrpc()
  } else {
    log(ok('frpc 已安装（' + (sfpCheck(exe) || '已安装') + '），跳过下载'))
    console.log('')
  }
  console.log('')
  log('第 2/4 步：访问密钥（Token）')
  console.log('')
  for (const t of [
    '访问密钥与登录密码不同，在面板「用户信息」页查看并复制，',
    '是 frpc 连接隧道的专用凭据，请勿泄露。'
  ]) log(dim(t))
  console.log('')
  const token = await ask('  ' + accent('>') + ' 粘贴访问密钥（留空取消）：')
  if (!token.trim()) return
  const s = { ...sfpSettings(), token: token.trim() }
  console.log('')
  log(ok('访问密钥已保存'))
  console.log('')
  log('第 3/4 步：创建隧道')
  console.log('')
  for (const t of [
    '隧道必须在面板创建，创建完成后请记下隧道 ID（在隧道名称下方）。',
    '填写建议：',
    '  · 类型：HTTP / HTTPS（WebSocket 兼容）',
    '  · 本地 IP：127.0.0.1',
    '  · 本地端口：' + config.port + '（Z80Z-chat 当前端口）',
    '  · 节点：就近选择延迟较低的节点'
  ]) log(dim(t))
  console.log('')
  const open = await ask('  ' + accent('>') + ' 立即打开面板创建隧道？(y/N)：')
  if (open.trim().toLowerCase() === 'y') {
    try { execSync(`start "" "${SFP_TUNNEL_URL}"`) } catch {}
  }
  console.log('')
  log('第 4/4 步：连接方式')
  console.log('')
  log('  1. 交互模式（推荐）：运行一次 frpc，在界面中输入访问密钥、')
  log('     勾选隧道后按 Ctrl-C，之后每次「启动隧道」自动连接')
  log('  2. 命令行模式：直接填写隧道 ID，用 frpc -f 密钥:ID 连接')
  console.log('')
  const mode = await ask('  ' + accent('>') + ' 选择连接方式（1/2，留空默认 1）：')
  if (mode.trim() === '2') {
    const tid = await ask('  ' + accent('>') + ' 粘贴隧道 ID（留空取消）：')
    if (!tid.trim()) return
    s.mode = 'cli'
    s.tunnelId = tid.trim()
    sfpSaveSettings(s)
    console.log('')
    log(ok('命令行模式已配置（隧道 ID ' + s.tunnelId + '）'))
    console.log('')
    const go = await ask('  ' + accent('>') + ' 立即启动隧道？(y/N)：')
    if (go.trim().toLowerCase() === 'y') {
      console.log('')
      const r = await sfpStart()
      log(r.ok ? ok(r.msg) : bad(r.msg))
    }
    await waitKey()
    return
  }
  s.mode = 'tui'
  sfpSaveSettings(s)
  console.log('')
  log('交互模式：即将打开 frpc 配置界面')
  for (const t of [
    '1. 在 Token 输入框中粘贴访问密钥，回车登录',
    '2. 用方向键 / 鼠标勾选要启动的隧道（可按节点选中）',
    '3. 按 Ctrl-C 保存配置并退出'
  ]) log(dim(t))
  console.log('')
  await waitKey('按回车打开 frpc 配置界面')
  spawnSync(exe, [], { cwd: SFP_DIR, stdio: 'inherit' })
  console.log('')
  if (fs.existsSync(path.join(SFP_DIR, 'frpc.ini'))) {
    log(ok('配置已保存（frpc.ini），之后可在「启动隧道」一键连接'))
    console.log('')
    const go = await ask('  ' + accent('>') + ' 立即启动隧道？(y/N)：')
    if (go.trim().toLowerCase() === 'y') {
      console.log('')
      const r = await sfpStart()
      log(r.ok ? ok(r.msg) : bad(r.msg))
    }
  } else {
    log(warn('未生成 frpc.ini，交互配置可能未完成'))
  }
  await waitKey()
}

// SakuraFRP 管理子菜单
async function sfpMenu() {
  for (;;) {
    cls()
    header('SakuraFRP', '管理 · 国内低延迟穿透')
    const exe = findFrpc()
    const running = sfpRunning()
    const s = sfpSettings()
    const url = sfpAccessUrl()
    console.log('')
    console.log(`  ${exe ? green('●') : red('○')} ${dim('frpc')}  ${exe ? green('已安装') : red('未安装')}`)
    console.log(`  ${s.token ? green('●') : yellow('○')} ${dim('配置')}  ${s.token ? green('已保存访问密钥' + (s.mode === 'cli' ? ' · 命令行模式' : '')) : yellow('未配置')}`)
    console.log(`  ${running ? green('●') : red('○')} ${dim('运行')}  ${running ? green('运行中 · PID ' + running) : red('已停止')}`)
    console.log(`  ${dim('·')}  ${dim('访问地址')} ${url ? cyan(url) : dim('未获取（启动后自动解析或到面板查看）')}`)
    console.log('')
    console.log(HLINE)
    console.log('')
    console.log(item('1', '首次配置向导', '安装 frpc · 访问密钥 · 隧道配置'))
    console.log(item('2', '启动隧道', '后台运行 frpc（交互 / 命令行模式）', !!exe && (!!s.token)))
    console.log(item('3', '停止隧道', '停止后台 frpc 进程', !!running))
    console.log(item('4', '安装 / 修复 frpc', '粘贴面板下载链接（约 10~20MB）'))
    console.log(item('5', '测试公网访问', `检查 ${url || '访问地址'} 是否可达`, !!running && !!url))
    console.log(item('6', '重新配置连接', '交互模式 / 命令行模式重选', !!exe))
    console.log(item('0', '返回隧道管理', ''))
    console.log('')
    const choice = await ask('  ' + accent('>') + ' ')
    if (choice === '1') {
      await sfpWizard()
    } else if (choice === '2') {
      console.log('')
      const r = await sfpStart()
      log(r.ok ? ok(r.msg) : bad(r.msg))
      await waitKey()
    } else if (choice === '3') {
      console.log('')
      if (sfpStop()) log(ok('隧道已停止'))
      else log(warn('未发现运行中的隧道'))
      await waitKey()
    } else if (choice === '4') {
      await sfpInstallFrpc()
    } else if (choice === '5') {
      console.log('')
      await sfpTest()
    } else if (choice === '6') {
      const exe0 = findFrpc()
      if (!exe0) continue
      cls()
      header('重新配置连接', '交互模式 / 命令行模式')
      console.log('')
      log('  1. 交互模式：重新运行 frpc 配置界面（生成 frpc.ini）')
      log('  2. 命令行模式：重新填写隧道 ID')
      console.log('')
      const m = await ask('  ' + accent('>') + ' 选择（1/2，留空取消）：')
      if (m.trim() === '1') {
        spawnSync(exe0, [], { cwd: SFP_DIR, stdio: 'inherit' })
        if (fs.existsSync(path.join(SFP_DIR, 'frpc.ini'))) {
          sfpSaveSettings({ ...sfpSettings(), mode: 'tui' })
          log(ok('已切换为交互模式'))
        } else {
          log(warn('未生成 frpc.ini'))
        }
      } else if (m.trim() === '2') {
        const tid = await ask('  ' + accent('>') + ' 粘贴隧道 ID（留空取消）：')
        if (tid.trim()) {
          sfpSaveSettings({ ...sfpSettings(), mode: 'cli', tunnelId: tid.trim() })
          log(ok('已切换为命令行模式（隧道 ID ' + tid.trim() + '）'))
        }
      }
      await waitKey()
    } else if (choice === '0') {
      return
    }
  }
}

/* ────────────────────────── 界面：主菜单 ────────────────────────── */

async function mainMenu() {
  for (;;) {
    reloadConfig()
    cls()
    const status = checkServiceStatus()
    
    if (status.status === 'running') {
      header(config.siteName, '服务管理')
      console.log(`  ${green('●')} ${dim('状态')}  ${green('运行中')}  ${dim('· 端口 ' + config.port)}`)
      console.log(`  ${dim('·')}  ${dim('PID')} ${cyan(status.pid)}  ${dim('运行时间')} ${cyan(status.runningTime)}`)
      console.log(`  ${dim('·')}  ${dim('本机')} ${cyan(`http://localhost:${config.port}`)}`)
      for (const ip of localIPv4()) {
        console.log(`  ${dim('·')}  ${dim('局域网')} ${cyan(`http://${ip}:${config.port}`)}`)
      }
    } else if (status.status === 'conflict') {
      header(config.siteName, '服务管理')
      console.log(`  ${yellow('●')} ${dim('状态')}  ${yellow('端口冲突')}  ${dim('· 端口 ' + config.port)}`)
      console.log(`  ${dim('·')}  ${status.message}`)
    } else {
      header(config.siteName, '服务管理')
      console.log(`  ${red('○')} ${dim('状态')}  ${red('未运行')}  ${dim('· 端口 ' + config.port)}`)
      console.log(`  ${dim('·')}  ${dim('配置文件')} ${dim(CONFIG_PATH)}`)
    }
    console.log('')
    console.log(HLINE)
    console.log('')

    if (status.status === 'running') {
      console.log(item('1', '重启服务', '停止并重新启动'))
      console.log(item('2', '停止服务', '停止当前运行的服务'))
      console.log(item('3', '备份管理', '备份 / 恢复 / 清理数据'))
      console.log(item('4', '查看配置', '浏览所有配置项'))
      console.log(item('5', '编辑配置', '用记事本打开 config.json'))
      console.log(item('6', '项目说明', '功能介绍与使用方式'))
      console.log(item('7', '隧道管理', '内网穿透（Cloudflare / SakuraFRP）'))
      console.log(item('8', '切换版本', '在外层已安装的版本之间选择'))
      console.log(dangerItem('9', '项目清档', '清空全部数据（需确认）'))
      console.log(item('0', '退出', ''))
    } else {
      console.log(item('1', '启动服务', `启动 ${config.siteName} 后端服务`))
      console.log(item('2', '备份管理', '备份 / 恢复 / 清理数据'))
      console.log(item('3', '查看配置', '浏览所有配置项'))
      console.log(item('4', '编辑配置', '用记事本打开 config.json'))
      console.log(item('5', '项目说明', '功能介绍与使用方式'))
      console.log(item('6', '隧道管理', '内网穿透（Cloudflare / SakuraFRP）'))
      console.log(item('7', '切换版本', '在外层已安装的版本之间选择'))
      console.log(dangerItem('8', '项目清档', '清空全部数据（需确认）'))
      console.log(item('0', '退出', ''))
    }

    console.log('')
    hint('输入选项数字后按回车确认')

    const choice = await ask('  ' + accent('>') + ' ')

    if (status.status === 'running') {
      if (choice === '1') {
        cls()
        log('停止服务 ...')
        killPort(config.port)
        await new Promise(r => setTimeout(r, 500))
        const child = await deploy()
        if (child) await runningMenu(child)
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
        header('编辑配置', 'config.json')
        spawn('notepad', [CONFIG_PATH], { detached: true, stdio: 'ignore' }).unref()
        log(ok('已在记事本中打开'))
        log(dim('  保存后返回主菜单即自动生效（无需重启）'))
        await waitKey()
      } else if (choice === '6') {
        cls()
        await showProjectInfo()
      } else if (choice === '7') {
        await tunnelMenu()
      } else if (choice === '8') {
        await switchVersion()
      } else if (choice === '9') {
        cls()
        await clearData()
      } else if (choice === '0') {
        rl.close()
        console.log('')
        log(dim('再见'))
        console.log('')
        process.exit(0)
      }
    } else {
      if (choice === '1') {
        const child = await deploy()
        if (child) await runningMenu(child)
      } else if (choice === '2') {
        await backupMenu()
      } else if (choice === '3') {
        cls()
        await showConfig()
      } else if (choice === '4') {
        cls()
        header('编辑配置', 'config.json')
        spawn('notepad', [CONFIG_PATH], { detached: true, stdio: 'ignore' }).unref()
        log(ok('已在记事本中打开'))
        log(dim('  保存后返回主菜单即自动生效（无需重启）'))
        await waitKey()
      } else if (choice === '5') {
        cls()
        await showProjectInfo()
      } else if (choice === '6') {
        await tunnelMenu()
      } else if (choice === '7') {
        await switchVersion()
      } else if (choice === '8') {
        cls()
        await clearData()
      } else if (choice === '0') {
        rl.close()
        console.log('')
        log(dim('再见'))
        console.log('')
        process.exit(0)
      }
    }
  }
}

async function main() {
  if (SKIP_FIREWALL) {
    console.log(yellow('  (调试模式：已跳过防火墙配置 --no-firewall)'))
  }
  
  // 检测后台服务，有则直接进入运行中菜单（并确保系统托盘图标存在）
  const status = checkServiceStatus()
  if (status.status === 'running') {
    ensureTray()
    await runningMenu(null, true)
  }

  // 首次部署：进入首次部署菜单（依赖缺失时）
  const deployCheck = isFirstDeploy()
  if (deployCheck.isFirst) {
    // 单文件模式（外层有 Z80Z-chat.bat）检测外层目录纯净度；
    // "直接使用现有目录"进入时用户已明确目录用途，跳过建议
    if (isSingleFileMode() && !DIRECT_USE && outerHasOtherFiles()) {
      cls()
      await showFirstInstallAdvice()
    }
    await firstDeployMenu(deployCheck.needWarning)
  } else if (deployCheck.unregistered) {
    // 依赖完整但未登记安装标记（"直接使用现有目录"进入的场景）
    console.log('')
    log(dim('当前目录依赖完整，已直接进入管理菜单。'))
    log(dim('该目录未记录安装标记（.install-version），下次运行会再次提示确认。'))
    await waitKey('按回车进入管理菜单')
  }

  await mainMenu()
}

main().catch((e) => {
  console.error('\n  ' + red('部署脚本异常：') + (e?.message || e) + '\n')
  process.exit(1)
})