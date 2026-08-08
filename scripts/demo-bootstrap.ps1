# ============================================================
# Z80Z-chat DEMO bootstrap - pure menu simulation, zero side effects
# (embedded into Z80Z-chat-DEMO.bat by scripts/build-demo.js)
# ============================================================
param(
  [string]$Root = '.',
  [string]$AppVersion = '0.0.0',
  [string]$AppBuilt = '',
  [string]$SkipUpdatePrompt = '0',
  [string]$SkipUpdatePromptVersion = '',
  [string]$LastProject = ''
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$script:Root = ([string]$Root).Trim().Trim('"')
$script:Root = [System.IO.Path]::GetFullPath($script:Root)
$script:SimFile = Join-Path $script:Root '.z80z-chat-bootstrap.ps1'
$script:DemoVersion = '1.0.18-demo'

# ---------- output helpers (VT-capable terminals get color) ----------
$ESC = [char]27
$supportsVT = $false
try { $supportsVT = [bool]$host.UI.SupportsVirtualTerminal } catch {}
try { if ([Console]::IsOutputRedirected) { $supportsVT = $false } } catch {}

function Tone([string]$code, [string]$text) {
  if ($supportsVT) { Write-Host ($ESC + '[' + $code + 'm' + $text + $ESC + '[0m') } else { Write-Host $text }
}
function Ln([string]$t = '') { Write-Host $t }
function Clear-Screen {
  try { if ([Console]::IsOutputRedirected) { return } } catch {}
  try { Clear-Host } catch {}
}
function H1([string]$t) {
  Clear-Screen
  Ln ''
  Ln ('  ' + $t)
  Tone '38;5;69' ('  ' + ('─' * 48))
  Ln ''
}
function Item([int]$n, [string]$label) { Ln ('  ' + $n.ToString() + '.  ' + $label) }
function ItemWithDesc([int]$n, [string]$label, [string]$desc) {
  if ($desc -ne '') { Ln ('  ' + $n.ToString() + '.  ' + $label + ' ------ ' + $desc) }
  else { Ln ('  ' + $n.ToString() + '.  ' + $label) }
}
function Hint([string]$t) { Ln ('  ' + $t) }
function Ok([string]$t) { Tone '38;5;42' ('  ✔ ' + $t) }
function Bad([string]$t) { Tone '38;5;203' ('  ✖ ' + $t) }
function Warn([string]$t) { Tone '38;5;214' ('  ⚠ ' + $t) }
function Info([string]$t) { Tone '38;5;111' ('  ℹ ' + $t) }
function Progress([string]$t) { Tone '38;5;42' ('  ● ' + $t) }
function Separator {
  Tone '38;5;245' ('  ' + ('─' * 46))
}
function KeyValue([string]$key, [string]$value) {
  if ($supportsVT) {
    Tone '38;5;245' ('  ' + $key.PadRight(20) + ' : ')
    Tone '38;5;6' ('  ' + $value)
  } else {
    Ln ('  ' + $key.PadRight(20) + ' : ' + $value)
  }
}

function Self-Clean {
  Remove-Item $script:SimFile -Force -ErrorAction SilentlyContinue
}

# ---------- detect system Node.js (read-only) ----------
function Test-SystemNode {
  try {
    $v = (& node -v 2>$null | Out-String).Trim()
    if ($v -match '^v(\d+)\.') {
      $major = [int]$Matches[1]
      if ($major -ge 18) { return @{ ok = $true; version = $v } }
    }
  } catch {}
  return @{ ok = $false; version = '' }
}

# ---------- extract embedded start.js block from Z80Z-chat-DEMO.bat ----------
function Get-EmbeddedStartJs {
  $bat = Join-Path $script:Root 'Z80Z-chat-DEMO.bat'
  $lines = [System.IO.File]::ReadAllLines($bat, [System.Text.Encoding]::UTF8)
  $b = [Array]::IndexOf($lines, '__NODECHAT_STARTJS_BEGIN__')
  $e = [Array]::IndexOf($lines, '__NODECHAT_STARTJS_END__')
  if ($b -lt 0 -or $e -lt 0 -or $e -lt $b) { throw 'start.js 块缺失' }
  return ,@($lines[($b + 1)..($e - 1)])
}

# ============================================================
# 演示主菜单
# ============================================================
function Demo-Main {
  for (;;) {
    H1 'Z80Z-chat 演示模式'
    Ln ''
    Info '本版本仅模拟菜单交互，不会执行任何真实操作'
    Ln ''
    Separator
    Ln ''
    ItemWithDesc 1 '模拟首次安装流程' '名称 / 端口 / 下载 / 构建（全部模拟）'
    ItemWithDesc 2 '模拟版本更新流程' '更新界面 / 版本切换（全部模拟）'
    ItemWithDesc 3 '项目管理菜单（模拟）' '主菜单 / 备份 / 清档等，需系统 Node.js'
    ItemWithDesc 0 '退出' ''
    Ln ''
    Separator
    Ln ''
    $ch = (Read-Host '  输入选项编号').Trim()
    if ($ch -eq '1') { Demo-Install }
    elseif ($ch -eq '2') { Demo-Update }
    elseif ($ch -eq '3') { Demo-RunManager }
    elseif ($ch -eq '0') { Self-Clean; exit 0 }
  }
}

# ---------- 网络线路选择（模拟测速表） ----------
function Demo-ChooseLine([string]$purpose) {
  H1 '网络线路选择（模拟）'
  Info ('当前准备下载：' + $purpose)
  Ln ''
  Ln '  正在测速（模拟）...'
  Ln ''
  $fake = @(
    @{ name = 'npmmirror (阿里)'; ms = 28 },
    @{ name = '腾讯云'; ms = 64 },
    @{ name = '华为云'; ms = 92 },
    @{ name = '中科大'; ms = 138 },
    @{ name = 'npm 官方'; ms = 99999 }
  )
  $i = 1
  foreach ($l in $fake) {
    $t = '超时'
    $colorCode = '38;5;203'
    if ($l['ms'] -lt 99999) {
      $t = ($l['ms'].ToString() + ' ms')
      if ($l['ms'] -lt 50) { $colorCode = '38;5;42' }
      elseif ($l['ms'] -lt 150) { $colorCode = '38;5;220' }
      else { $colorCode = '38;5;214' }
    }
    Tone '38;5;111' ('  ' + $i.ToString() + '.  ' + ($l['name']).PadRight(16))
    Tone $colorCode ('      延迟：' + $t)
    $i++
  }
  Ln ''
  Separator
  Ln ''
  $ch = (Read-Host '  选择线路编号（留空自动选最快）').Trim()
  Ln ''
  $sel = $fake[0]
  if ($ch -ne '') {
    $n = 0
    try { $n = [int]$ch } catch { $n = 0 }
    if ($n -ge 1 -and $n -le $fake.Count) { $sel = $fake[$n - 1] }
  }
  Ok ('已选择线路：' + $sel['name'] + '（模拟）')
}

# ---------- Node.js 环境（模拟检测 + 模拟下载） ----------
function Demo-NodeJs {
  H1 'Node.js 运行环境（模拟）'
  Ln ''
  Info '本目录下未找到 nodejs/ 文件夹，'
  Info '但检测到系统拥有 Node.js v22.12.0（模拟检测结果）'
  Ln ''
  Separator
  Ln ''
  ItemWithDesc 1 '使用系统 Node.js' '不下载，直接使用系统环境'
  ItemWithDesc 2 '下载 nodejs/' '推荐，环境隔离，不影响系统（模拟下载）'
  ItemWithDesc 3 '退出' '返回演示主菜单'
  Ln ''
  Separator
  Ln ''
  $ch = (Read-Host '  输入选项编号').Trim()
  if ($ch -eq '3') { return $false }
  if ($ch -eq '1') {
    Ln ''
    Ok '将使用系统 Node.js v22.12.0（模拟）'
    Ln ''
    return $true
  }
  Demo-ChooseLine 'Node.js 运行时（约 25MB）'
  Ln ''
  Progress '（模拟）正在下载 node-v22.12.0-win-x64.zip ...'
  Start-Sleep -Milliseconds 400
  Ln ''
  Progress '（模拟）SHA256 校验通过'
  Start-Sleep -Milliseconds 200
  Ln ''
  Progress '（模拟）解压完成'
  Start-Sleep -Milliseconds 300
  Ln ''
  Ok 'Node.js 安装完成（模拟）'
  Ln ''
  Hint '演示模式未下载、未解压任何真实文件'
  Ln ''
  Separator
  Ln ''
  Read-Host '  按回车开始下一步'
  return $true
}

# ---------- 端口配置（模拟，不写文件） ----------
function Demo-AskPort {
  H1 '端口配置（模拟）'
  Ln ''
  Separator
  Ln ''
  Hint '  端口范围：1-65535'
  Hint '  常用端口：80、443、8080'
  Hint '  留空：自动选择随机端口（10000-60000）'
  Ln ''
  Separator
  Ln ''
  $input = (Read-Host '  请输入端口号（留空自动选择随机端口 10000-60000）').Trim()
  if ($input -eq '') {
    $port = Get-Random -Minimum 10000 -Maximum 60001
    Ln ''
    Ok ('已自动选择端口：' + $port + '（模拟）')
  } else {
    $port = 0
    try { $port = [int]$input } catch { $port = 0 }
    if ($port -lt 1 -or $port -gt 65535) {
      Bad '端口号无效（应为 1-65535 的整数），保持当前端口不变（模拟）'
      return
    }
    Ln ''
    Ok ('端口已设置为 ' + $port + '（模拟，未写入 config.json）')
  }
}

# ---------- 首次安装流程（全部模拟） ----------
function Demo-Install {
  H1 'Z80Z-chat 安装（模拟）'
  Ln ''
  Info '首次运行项目安装，正在初始化项目...'
  Ln ''
  Separator
  Ln ''
  $pn = (Read-Host '  项目文件夹名称（名称后自动追加版本号，留空默认 z80z-chat-版本号）').Trim()
  if ($pn -eq '') { $pn = 'z80z-chat' }
  while ($pn -match '[<>:"/\\|?*]' -or $pn -match '\s') {
    Bad '文件夹名称包含非法字符（< > : " / \ | ? * 或空格），请重新输入'
    $pn = (Read-Host '  项目文件夹名称（名称后自动追加版本号，留空默认 z80z-chat-版本号）').Trim()
    if ($pn -eq '') { $pn = 'z80z-chat' }
  }
  $script:demoProj = $pn + '-1.0.18'
  Ln ''
  Ok ('项目文件夹：' + $script:demoProj + '（模拟，不会实际创建）')
  Ln ''
  if (-not (Demo-NodeJs)) { return }
  Demo-ChooseLine 'Z80Z-chat 项目依赖包（npm install，约 90MB）'
  Demo-AskPort
  Ln ''
  Progress '（模拟）释放项目文件...'
  Start-Sleep -Milliseconds 250
  Ln ''
  Progress '（模拟）安装依赖（npm install，可能需要几分钟）...'
  Start-Sleep -Milliseconds 400
  Ln ''
  Progress '（模拟）构建前端（npm run build）...'
  Start-Sleep -Milliseconds 400
  Ln ''
  Separator
  Ln ''
  Ok '安装完成（模拟）'
  Ln ''
  KeyValue '项目目录' (Join-Path $script:Root $script:demoProj)
  KeyValue '版本' $script:DemoVersion
  Ln ''
  Hint '演示模式未创建任何文件、未下载任何内容'
  Ln ''
  Separator
  Ln ''
  Read-Host '  按回车返回演示主菜单'
}

# ---------- 版本更新流程（全部模拟） ----------
function Demo-Update {
  H1 'Z80Z-chat 更新（模拟）'
  Ln ''
  Info '检测到新版本！'
  Ln ''
  Ln '  当前版本：1.0.17，发布时间：2026-07-30T10:00:00（模拟）'
  Ln ('  最新版本：' + $script:DemoVersion + '，发布时间：' + $AppBuilt + '（模拟）')
  Ln ''
  Separator
  Ln ''
  Hint '更新会进行以下步骤（演示模式全部模拟）：'
  Hint '  · 停止当前服务'
  Hint '  · 备份数据到 data-backup/'
  Hint '  · 重建项目文件（保留 data / logs / node_modules / config.json）'
  Hint '  · 重新安装依赖并构建'
  Ln ''
  Separator
  Ln ''
  $ch = (Read-Host '  确认更新？Y=更新  N=切换版本  S=不再提示更新  其他=进入项目管理').Trim()
  if ($ch -eq 'Y' -or $ch -eq 'y') {
    Ln ''
    Ln '  停止服务中...（模拟）'
    Start-Sleep -Milliseconds 200
    Ok '服务已停止（模拟）'
    Ln ''
    Info '（模拟）备份数据 → data-backup\backup-<时间戳>'
    Start-Sleep -Milliseconds 200
    Ln ''
    Progress '（模拟）重建项目文件（保留 data / logs / node_modules / config.json）...'
    Start-Sleep -Milliseconds 250
    Ln ''
    Progress '（模拟）释放新版本项目文件...'
    Start-Sleep -Milliseconds 250
    Ln ''
    Progress '（模拟）安装依赖（npm install）...'
    Start-Sleep -Milliseconds 400
    Ln ''
    Progress '（模拟）构建前端（npm run build）...'
    Start-Sleep -Milliseconds 400
    Ln ''
    Separator
    Ln ''
    Ok '更新完成（模拟）'
    Ln ''
    KeyValue '版本' $script:DemoVersion
    Ln ''
    Hint '演示模式未修改任何项目文件'
    Ln ''
    Separator
    Ln ''
    Read-Host '  按回车返回演示主菜单'
    return
  }
  if ($ch -eq 'N' -or $ch -eq 'n') { Demo-SwitchVersion; return }
  if ($ch -eq 'S' -or $ch -eq 's') {
    Ln ''
    Ok '已设置不再提示更新（模拟，不会写入 bat）'
    Ln ''
    Separator
    Ln ''
    Read-Host '  按回车返回演示主菜单'
    return
  }
  Ln ''
  Info '已取消更新'
  Ln ''
  Separator
  Ln ''
  Read-Host '  按回车返回演示主菜单'
}

# ---------- 版本切换（模拟列表） ----------
function Demo-SwitchVersion {
  H1 '版本选择（模拟）'
  Ln ''
  Info '请选择要使用的版本：'
  Ln ''
  Item 1 'z80z-chat-1.0.17'
  Hint '      1.0.17  安装于 2026-07-30T10:00:00'
  Item 2 'z80z-chat-1.0.18  [当前]'
  Hint '      1.0.18  安装于 2026-08-04T11:16:28'
  Ln ''
  Separator
  Ln ''
  $ch = (Read-Host '  选择版本编号（0 返回）').Trim()
  if ($ch -eq '1') {
    Ln ''
    Ok '已切换到：z80z-chat-1.0.17（模拟，未写入偏好）'
  } elseif ($ch -eq '2') {
    Ln ''
    Info '已在使用该版本'
  } elseif ($ch -eq '0') {
    Ln ''
    Info '已返回'
  } else {
    Ln ''
    Warn '无效的编号，已返回'
  }
  Ln ''
  Separator
  Ln ''
  Read-Host '  按回车返回演示主菜单'
}

# ---------- 项目管理菜单（模拟，跑 demo-start.js） ----------
function Demo-RunManager {
  $sys = Test-SystemNode
  if (-not $sys['ok']) {
    Bad '演示模式需要系统 Node.js 运行项目管理菜单'
    Read-Host '  按回车返回演示主菜单'
    return
  }
  try {
    $js = Get-EmbeddedStartJs
    $demoDir = Join-Path $env:TEMP 'z80z-chat-demo'
    New-Item -ItemType Directory -Path $demoDir -Force | Out-Null
    $demoJs = Join-Path $demoDir 'start.js'
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($demoJs, ($js -join "`n"), $enc)
    Push-Location $demoDir
    try { & node $demoJs } finally { Pop-Location }
    Remove-Item $demoDir -Recurse -Force -ErrorAction SilentlyContinue
  } catch {
    Bad ('演示脚本运行失败：' + $_.Exception.Message)
    Read-Host '  按回车返回演示主菜单'
  }
}

# ============================================================
# main
# ============================================================
try {
  Demo-Main
} catch {
  H1 '错误'
  Ln ''
  Bad ('错误：' + $_.Exception.Message)
  Ln ''
  Separator
  Ln ''
  Read-Host '  按回车退出'
  Self-Clean
  exit 1
}
