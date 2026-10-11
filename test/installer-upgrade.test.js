import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('../', import.meta.url))
const testRoot = path.join(project, '.test-data')
const template = path.join(project, 'deploy', 'install.template.bat')
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const windows = { skip: process.platform !== 'win32' }
const packageData = version => JSON.stringify({
  name: 'installer-fixture', version,
  dependencies: { beta: '2.0.0', alpha: '1.0.0' },
  devDependencies: { compiler: '3.0.0' }
})
const userConfig = '// 用户配置必须逐字节保留\r\n{"port":45678,"host":"127.0.0.1"}\r\n'

function put(directory, name, data) {
  const target = path.join(directory, name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, data)
}

function snapshot(directory) {
  const files = {}
  function visit(current) {
    if (!fs.existsSync(current)) return
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, item.name)
      if (item.isDirectory()) visit(target)
      else files[path.relative(directory, target).replaceAll(path.sep, '/')] = fs.readFileSync(target).toString('hex')
    }
  }
  visit(directory)
  return files
}

function withFixture(callback) {
  fs.mkdirSync(testRoot, { recursive: true })
  const directory = fs.mkdtempSync(path.join(testRoot, 'installer-upgrade-'))
  const installed = path.join(directory, 'installed-1.0.0')
  const payload = path.join(directory, 'payload')
  const oldFiles = {
    'server.js': 'old-server',
    'start.js': 'old-launcher',
    'obsolete.js': 'removed-after-success',
    'package.json': packageData('1.0.0'),
    'package-lock.json': '{"lockfileVersion":3,"fixture":"old"}',
    'config.json': userConfig,
    'data/db.json': '{"users":[{"id":"retained-user"}]}',
    'data/uploads/photo.bin': Buffer.from([0, 255, 128, 42]),
    'logs/runtime.log': 'keep runtime log\r\n',
    'node_modules/old-package/index.js': 'old-dependency',
    'node_modules/.bin/vite.cmd': 'old-vite-launcher',
    'dist/index.html': 'old-built-html',
    'dist/assets/old.js': 'old-built-javascript',
    'assets/local-custom.txt': 'user asset',
    '.install-version': '{"version":"1.0.0","payloadHash":"old-fingerprint","installedAt":"2000-01-01T00:00:00"}'
  }
  const newFiles = {
    'server.js': 'new-server',
    'start.js': 'new-launcher',
    'package.json': packageData('2.0.0'),
    'package-lock.json': '{"lockfileVersion":3,"fixture":"new"}',
    'config.json': '{"port":3000}',
    'utils/new.js': 'new-helper'
  }
  for (const [name, data] of Object.entries(oldFiles)) put(installed, name, data)
  for (const [name, data] of Object.entries(newFiles)) put(payload, name, data)
  try {
    return callback({ directory, installed, payload, before: snapshot(installed) })
  } finally {
    const resolved = path.resolve(directory)
    assert.ok(resolved.startsWith(path.resolve(testRoot) + path.sep))
    assert.ok(path.basename(resolved).startsWith('installer-upgrade-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  }
}

// Load only top-level functions. Interactive initialization, the main block,
// process termination, firewall configuration and downloads never execute.
const harness = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
  "$Root = $env:INSTALLER_FIXTURE_ROOT",
  "$projDir = Join-Path $Root 'installed-1.0.0'",
  "$payloadDir = Join-Path $Root 'payload'",
  "$BatFile = Join-Path $Root 'fixture.bat'",
  "$BackupRoot = Join-Path $Root 'data-backup'",
  "$AppVersion = '2.0.0'",
  "$PayloadSha = 'new-fingerprint'",
  "$AppBuilt = '2026-10-11'",
  "$cfg = @{ backupKeep = 3 }",
  "$source = [IO.File]::ReadAllText($env:INSTALLER_TEMPLATE, [Text.Encoding]::UTF8)",
  "$begin = $source.IndexOf('__NODECHAT_PS_BEGIN__') + '__NODECHAT_PS_BEGIN__'.Length",
  "$end = $source.IndexOf('__NODECHAT_PS_END__', $begin)",
  "if ($begin -lt '__NODECHAT_PS_BEGIN__'.Length -or $end -le $begin) { throw 'PowerShell template block missing' }",
  "$tokens = $null",
  "$errors = $null",
  "$ast = [Management.Automation.Language.Parser]::ParseInput($source.Substring($begin, $end - $begin), [ref]$tokens, [ref]$errors)",
  "if ($errors.Count -ne 0) { throw ($errors | Out-String) }",
  "foreach ($statement in $ast.EndBlock.Statements) {",
  "  if ($statement -is [Management.Automation.Language.FunctionDefinitionAst]) {",
  "    . ([ScriptBlock]::Create($statement.Extent.Text))",
  "  }",
  "}",
  "$script:events = New-Object 'Collections.Generic.List[string]'",
  "function Ln($message) {}",
  "function Progress($message) {}",
  "function Info($message) {}",
  "function Hint($message) {}",
  "function Ok($message) {}",
  "function Warn($message) {}",
  "function Bad($message) {}",
  "function Stop-Service($directory) { $script:events.Add('stop') }",
  "function Finish-Update($directory) { throw 'Interactive completion must not run in this fixture' }",
  "function Invoke-NpmInstall($directory, $configuration) {",
  "  $script:events.Add('install')",
  "  if ($directory -eq $projDir) { throw 'Install must be prepared outside the installed project' }",
  "  $module = Join-Path $directory 'node_modules/new-package'",
  "  New-Item -ItemType Directory -Path $module -Force | Out-Null",
  "  Write-Utf8 (Join-Path $module 'index.js') 'new-dependency'",
  "}",
  "function Invoke-NpmBuild($directory) {",
  "  $script:events.Add('build')",
  "  if ($directory -eq $projDir) { throw 'Build must be prepared outside the installed project' }",
  "  $dist = Join-Path $directory 'dist'",
  "  New-Item -ItemType Directory -Path $dist -Force | Out-Null",
  "  Write-Utf8 (Join-Path $dist 'index.html') 'new-built-html'",
  "}",
  "function Write-FixturePayload {",
  "  Add-Type -AssemblyName System.IO.Compression.FileSystem",
  "  $zip = Join-Path $Root 'fixture.zip'",
  "  [IO.Compression.ZipFile]::CreateFromDirectory($payloadDir, $zip)",
  "  $launcher = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $payloadDir 'start.js')))",
  "  $archive = [Convert]::ToBase64String([IO.File]::ReadAllBytes($zip))",
  "  $newline = [Environment]::NewLine",
  "  $blocks = '__NODECHAT_STARTJS_B64_BEGIN__' + $newline + $launcher + $newline + '__NODECHAT_STARTJS_B64_END__' + $newline + '__NODECHAT_ZIP_B64_BEGIN__' + $newline + $archive + $newline + '__NODECHAT_ZIP_B64_END__'",
  "  Write-Utf8 $BatFile $blocks",
  "}",
  "Write-FixturePayload",
  "$PayloadSha = Compute-PayloadSha $payloadDir"
].join('\n')

function runPowerShell(fixture, lines) {
  const script = path.join(fixture.directory, 'run.ps1')
  fs.writeFileSync(script, '\ufeff' + harness + '\n' + lines.join('\n') + "\nWrite-Output ('__RESULT__' + ($result | ConvertTo-Json -Compress -Depth 20))\n")
  const child = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    cwd: fixture.directory,
    env: { ...process.env, DATA_DIR: '', LOG_DIR: '', INSTALLER_FIXTURE_ROOT: fixture.directory, INSTALLER_TEMPLATE: template },
    encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024
  })
  assert.ifError(child.error)
  assert.equal(child.status, 0, child.stdout + child.stderr)
  const result = child.stdout.split(/\r?\n/).find(line => line.startsWith('__RESULT__'))
  assert.ok(result, child.stdout + child.stderr)
  return JSON.parse(result.slice('__RESULT__'.length))
}

function assertUserFilesRetained(fixture) {
  const after = snapshot(fixture.installed)
  for (const name of ['config.json', 'data/db.json', 'data/uploads/photo.bin', 'logs/runtime.log', 'assets/local-custom.txt']) {
    assert.equal(after[name], fixture.before[name], name)
  }
}

function actualBuildFingerprint(entries) {
  const source = fs.readFileSync(path.join(project, 'scripts', 'build-single.js'), 'utf8')
  const definition = source.match(/^(?:export )?function computePayloadSha\(entries\) \{[\s\S]*?^\}/m)?.[0]?.replace(/^export /, '')
  assert.ok(definition, 'actual build fingerprint function exists')
  return vm.runInNewContext(definition + '\ncomputePayloadSha(entries)', { crypto, Buffer, entries })
}

test('安装端内容指纹与构建端一致，版本号独立且启动器与锁文件变化可见', windows, () => withFixture(fixture => {
  put(fixture.payload, '目录/资料.txt', '中文内容\r\n')
  put(fixture.payload, 'A.bin', Buffer.from([0, 1, 255]))
  const entries = Object.entries(snapshot(fixture.payload)).map(([name, hex]) => ({ name, data: Buffer.from(hex, 'hex') }))
  const expected = actualBuildFingerprint(entries.reverse())
  const result = runPowerShell(fixture, [
    "$initial = Compute-PayloadSha $payloadDir",
    "Write-Utf8 (Join-Path $payloadDir 'package.json') '{\"name\":\"different-name\",\"version\":\"999.0.0\"}'",
    "$versionOnly = Compute-PayloadSha $payloadDir",
    "Write-Utf8 (Join-Path $payloadDir 'start.js') 'launcher-changed'",
    "$launcherChanged = Compute-PayloadSha $payloadDir",
    "Write-Utf8 (Join-Path $payloadDir 'start.js') 'new-launcher'",
    "Write-Utf8 (Join-Path $payloadDir 'package-lock.json') '{\"lockfileVersion\":3,\"fixture\":\"changed\"}'",
    "$lockChanged = Compute-PayloadSha $payloadDir",
    "$result = @{ initial = $initial; versionOnly = $versionOnly; launcherChanged = $launcherChanged; lockChanged = $lockChanged }"
  ])
  assert.equal(result.initial, expected)
  assert.equal(result.versionOnly, expected)
  assert.notEqual(result.launcherChanged, expected)
  assert.notEqual(result.lockChanged, expected)
}))

test('依赖键忽略版本和属性顺序，但检测生产及开发依赖变化', windows, () => withFixture(fixture => {
  const result = runPowerShell(fixture, [
    "$pkg = Join-Path $payloadDir 'package.json'",
    "$initial = Get-DepsKey $pkg",
    "Write-Utf8 $pkg '{\"version\":\"9.0.0\",\"devDependencies\":{\"compiler\":\"3.0.0\"},\"dependencies\":{\"alpha\":\"1.0.0\",\"beta\":\"2.0.0\"}}'",
    "$reordered = Get-DepsKey $pkg",
    "Write-Utf8 $pkg '{\"dependencies\":{\"alpha\":\"1.0.1\",\"beta\":\"2.0.0\"},\"devDependencies\":{\"compiler\":\"3.0.0\"}}'",
    "$productionChanged = Get-DepsKey $pkg",
    "Write-Utf8 $pkg '{\"dependencies\":{\"alpha\":\"1.0.0\",\"beta\":\"2.0.0\"},\"devDependencies\":{\"compiler\":\"3.0.1\"}}'",
    "$developmentChanged = Get-DepsKey $pkg",
    "Write-Utf8 $pkg 'not-json'",
    "$invalid = Get-DepsKey $pkg",
    "$missing = Get-DepsKey (Join-Path $Root 'absent-package.json')",
    "$result = @{ initial = $initial; reordered = $reordered; productionChanged = $productionChanged; developmentChanged = $developmentChanged; invalid = $invalid; missing = $missing }"
  ])
  assert.equal(result.initial, 'dependencies:alpha@1.0.0|dependencies:beta@2.0.0|devDependencies:compiler@3.0.0')
  assert.equal(result.reordered, result.initial)
  assert.notEqual(result.productionChanged, result.initial)
  assert.notEqual(result.developmentChanged, result.initial)
  assert.equal(result.invalid, '')
  assert.equal(result.missing, '')
}))

test('损坏安装包解压失败不会改动旧启动器、配置或安装标记', windows, () => withFixture(fixture => {
  const result = runPowerShell(fixture, [
    "$broken = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('not-a-zip'))",
    "$launcher = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('new-launcher'))",
    "$newline = [Environment]::NewLine",
    "Write-Utf8 $BatFile ('__NODECHAT_STARTJS_B64_BEGIN__' + $newline + $launcher + $newline + '__NODECHAT_STARTJS_B64_END__' + $newline + '__NODECHAT_ZIP_B64_BEGIN__' + $newline + $broken + $newline + '__NODECHAT_ZIP_B64_END__')",
    "$failed = $false",
    "try { Write-Project $projDir $true } catch { $failed = $true }",
    "$result = @{ failed = $failed }"
  ])
  assert.equal(result.failed, true)
  assert.deepEqual(snapshot(fixture.installed), fixture.before)
}))

test('快速升级保留真实 dist、依赖与用户资料，并提交新代码及指纹', windows, () => withFixture(fixture => {
  const result = runPowerShell(fixture, [
    "Invoke-ProjectUpdate $projDir $cfg $true 'same-fingerprint' | Out-Null",
    "$result = @{ events = @($script:events.ToArray()); marker = (Get-Content -LiteralPath (Join-Path $projDir '.install-version') -Raw | ConvertFrom-Json) }"
  ])
  assertUserFilesRetained(fixture)
  assert.equal(fs.readFileSync(path.join(fixture.installed, 'server.js'), 'utf8'), 'new-server')
  assert.equal(fs.readFileSync(path.join(fixture.installed, 'start.js'), 'utf8'), 'new-launcher')
  assert.equal(fs.existsSync(path.join(fixture.installed, 'obsolete.js')), false)
  assert.deepEqual(snapshot(path.join(fixture.installed, 'dist')), {
    'index.html': Buffer.from('old-built-html').toString('hex'),
    'assets/old.js': Buffer.from('old-built-javascript').toString('hex')
  })
  assert.equal(fs.readFileSync(path.join(fixture.installed, 'node_modules/old-package/index.js'), 'utf8'), 'old-dependency')
  assert.deepEqual(result.events, ['stop'])
  assert.equal(result.marker.version, '2.0.0')
  assert.equal(result.marker.payloadHash, 'same-fingerprint')
  assert.equal(fs.existsSync(path.join(fixture.directory, 'data-backup')), false)
}))

test('完整升级先准备依赖及构建，再备份和提交；资料与配置保持原样', windows, () => withFixture(fixture => {
  const result = runPowerShell(fixture, [
    "Invoke-ProjectUpdate $projDir $cfg $false 'complete-fingerprint' | Out-Null",
    "$backups = @(Get-ChildItem -LiteralPath $BackupRoot -Directory)",
    "$backup = ''",
    "if ($backups.Count -eq 1) { $backup = [IO.File]::ReadAllText((Join-Path $backups[0].FullName 'db.json')) }",
    "$result = @{ events = @($script:events.ToArray()); backups = $backups.Count; backup = $backup; marker = (Get-Content -LiteralPath (Join-Path $projDir '.install-version') -Raw | ConvertFrom-Json) }"
  ])
  assertUserFilesRetained(fixture)
  assert.deepEqual(result.events, ['install', 'build', 'stop'])
  assert.equal(result.backups, 1)
  assert.equal(result.backup, '{"users":[{"id":"retained-user"}]}')
  assert.equal(fs.readFileSync(path.join(fixture.installed, 'server.js'), 'utf8'), 'new-server')
  assert.equal(fs.readFileSync(path.join(fixture.installed, 'dist/index.html'), 'utf8'), 'new-built-html')
  assert.equal(fs.readFileSync(path.join(fixture.installed, 'node_modules/new-package/index.js'), 'utf8'), 'new-dependency')
  assert.equal(fs.existsSync(path.join(fixture.installed, 'obsolete.js')), false)
  assert.equal(result.marker.payloadHash, 'complete-fingerprint')
}))

test('完整升级保留相对自定义数据和日志，备份包含隐藏密钥且仅清理已识别的旧备份', windows, () => withFixture(fixture => {
  put(fixture.installed, 'config.json', '// custom storage\n{"port":45678,"dataDir":"runtime/persistent"}')
  put(fixture.installed, 'runtime/persistent/db.json', '{"users":[{"id":"custom-data-user"}]}')
  put(fixture.installed, 'runtime/persistent/.upload-secret', 'preserved-hidden-key')
  put(fixture.installed, 'runtime/persistent/uploads/item.bin', Buffer.from([32, 127, 255]))
  put(fixture.installed, 'custom-logs/events/current.log', 'custom-log-retained')
  put(fixture.directory, 'data-backup/backup-20000101-000000000/db.json', 'expired-backup')
  put(fixture.directory, 'data-backup/backup-20010101-000000000/db.json', 'expired-backup-2')
  put(fixture.directory, 'data-backup/unrelated-storage/do-not-delete.txt', 'unrelated-backup-folder')
  fixture.before = snapshot(fixture.installed)
  const result = runPowerShell(fixture, [
    "$cfg['backupKeep'] = 1",
    "$env:LOG_DIR = 'custom-logs/events'",
    "Invoke-ProjectUpdate $projDir $cfg $false 'custom-storage-fingerprint' | Out-Null",
    "$backups = @(Get-ChildItem -LiteralPath $BackupRoot -Directory | Where-Object { $_.Name -match '^backup-\\d{8}-\\d{9}$' })",
    "$backup = $backups[0].FullName",
    "$result = @{ backups = $backups.Count; data = [IO.File]::ReadAllText((Join-Path $backup 'db.json')); secret = [IO.File]::ReadAllText((Join-Path $backup '.upload-secret')) }"
  ])
  assertUserFilesRetained(fixture)
  for (const name of ['runtime/persistent/db.json', 'runtime/persistent/.upload-secret', 'runtime/persistent/uploads/item.bin', 'custom-logs/events/current.log']) {
    assert.equal(snapshot(fixture.installed)[name], fixture.before[name], name)
  }
  assert.equal(result.backups, 1)
  assert.equal(result.data, '{"users":[{"id":"custom-data-user"}]}')
  assert.equal(result.secret, 'preserved-hidden-key')
  assert.equal(fs.readFileSync(path.join(fixture.directory, 'data-backup/unrelated-storage/do-not-delete.txt'), 'utf8'), 'unrelated-backup-folder')
}))

test('绝对 ENV 数据目录在项目外保持原样，并以实际目录备份隐藏文件', windows, () => withFixture(fixture => {
  const external = path.join(fixture.directory, 'external-runtime')
  put(external, 'db.json', '{"source":"environment-data"}')
  put(external, '.upload-secret', 'external-hidden-key')
  const original = snapshot(external)
  const result = runPowerShell(fixture, [
    "$env:DATA_DIR = Join-Path $Root 'external-runtime'",
    "Invoke-ProjectUpdate $projDir $cfg $false 'environment-fingerprint' | Out-Null",
    "$backups = @(Get-ChildItem -LiteralPath $BackupRoot -Directory)",
    "$result = @{ data = [IO.File]::ReadAllText((Join-Path $backups[0].FullName 'db.json')); secret = [IO.File]::ReadAllText((Join-Path $backups[0].FullName '.upload-secret')) }"
  ])
  assertUserFilesRetained(fixture)
  assert.deepEqual(snapshot(external), original)
  assert.equal(result.data, '{"source":"environment-data"}')
  assert.equal(result.secret, 'external-hidden-key')
}))

test('升级目录重命名返回非终止错误时，保留实际目录与启动偏好', windows, () => withFixture(fixture => {
  const result = runPowerShell(fixture, [
    "$ErrorActionPreference = 'Continue'",
    "$ConfigFile = Join-Path $Root '.install-config.json'",
    "$script:recordedProject = ''",
    "$script:launchedProject = ''",
    "$finish = $ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -eq 'Finish-Update' }",
    '. ([ScriptBlock]::Create($finish.Extent.Text))',
    'function Rename-Item {',
    '  [CmdletBinding()] param([string]$Path, [string]$LiteralPath, [string]$NewName)',
    "  Write-Error 'controlled-nonterminating-rename-denied'",
    '}',
    'function Separator {}',
    'function KeyValue($key, $value) {}',
    "function Read-Host($prompt) { return '' }",
    'function Set-BatPreferenceSafe($key, $value) {',
    "  if ($key -eq 'LAST_PROJECT') { $script:recordedProject = $value }",
    '  return $true',
    '}',
    'function Run($directory, [bool]$directUse = $false) { $script:launchedProject = $directory }',
    'Finish-Update $projDir',
    '$result = @{ recordedProject = $script:recordedProject; launchedProject = $script:launchedProject; exists = (Test-Path -LiteralPath $script:launchedProject -PathType Container) }'
  ])
  assert.equal(result.recordedProject, path.basename(fixture.installed))
  assert.equal(path.resolve(result.launchedProject), path.resolve(fixture.installed))
  assert.equal(result.exists, true)
  assert.deepEqual(snapshot(fixture.installed), fixture.before)
}))

for (const phase of ['install', 'build']) {
  test('完整升级 ' + phase + ' 失败不停止服务，也不修改旧安装', windows, () => withFixture(fixture => {
    const functionName = phase === 'install' ? 'Invoke-NpmInstall' : 'Invoke-NpmBuild'
    const result = runPowerShell(fixture, [
      'function ' + functionName + '($directory, $configuration) {',
      "  $script:events.Add('" + phase + "')",
      "  throw 'controlled-" + phase + "-failure'",
      '}',
      '$failed = $false',
      "try { Invoke-ProjectUpdate $projDir $cfg $false 'failed-fingerprint' | Out-Null } catch { $failed = $true }",
      '$result = @{ failed = $failed; events = @($script:events.ToArray()) }'
    ])
    assert.equal(result.failed, true)
    assert.deepEqual(result.events, phase === 'install' ? ['install'] : ['install', 'build'])
    assert.deepEqual(snapshot(fixture.installed), fixture.before)
    assert.equal(fs.existsSync(path.join(fixture.directory, 'data-backup')), false)
  }))
}

for (const fast of [true, false]) {
test((fast ? '快速' : '完整') + '升级提交文件移动失败，旧代码、依赖、dist 和标记全部恢复', windows, () => withFixture(fixture => {
  const result = runPowerShell(fixture, [
    '$script:moveFailureInjected = $false',
    'function Move-Item {',
    '  param([string]$Path, [string]$Destination, [switch]$Force, [string]$ErrorAction, [string]$LiteralPath)',
    '  $sourcePath = $Path',
    '  if ($LiteralPath) { $sourcePath = $LiteralPath }',
    "  if (-not $script:moveFailureInjected -and (Split-Path $sourcePath -Leaf) -eq 'server.js' -and $sourcePath -ne (Join-Path $projDir 'server.js') -and ($Destination -eq $projDir -or $Destination -eq (Join-Path $projDir 'server.js'))) {",
    '    $script:moveFailureInjected = $true',
    "    throw 'controlled-commit-move-failure'",
    '  }',
    '  Microsoft.PowerShell.Management\\Move-Item @PSBoundParameters',
    '}',
    '$failed = $false',
    "try { Invoke-ProjectUpdate $projDir $cfg " + (fast ? '$true' : '$false') + " 'failed-fingerprint' | Out-Null } catch { $failed = $true }",
    '$result = @{ failed = $failed; injected = $script:moveFailureInjected; events = @($script:events.ToArray()) }'
  ])
  assert.equal(result.injected, true, 'a real commit boundary must be reached')
  assert.equal(result.failed, true)
  assert.deepEqual(result.events, fast ? ['stop'] : ['install', 'build', 'stop'])
  assert.deepEqual(snapshot(fixture.installed), fixture.before)
}))
}

for (const runtimeKind of ['config.dataDir', 'DATA_DIR', 'LOG_DIR']) {
  test('升级保留 ' + runtimeKind + ' 的项目内部绝对目录，收尾不改变目录名或配置', windows, () => withFixture(fixture => {
    const runtime = path.join(fixture.installed, 'absolute-runtime', 'persistent')
    if (runtimeKind === 'config.dataDir') {
      put(fixture.installed, 'config.json', '// preserve absolute runtime path\n' + JSON.stringify({ port: 45678, dataDir: runtime }))
    }
    put(runtime, 'db.json', '{"source":"absolute-internal-runtime"}')
    put(runtime, '.upload-secret', 'absolute-runtime-hidden-key')
    put(runtime, 'uploads/item.bin', Buffer.from([1, 128, 255]))
    put(runtime, 'runtime.log', 'absolute-runtime-log')
    const originalConfig = fs.readFileSync(path.join(fixture.installed, 'config.json'))
    const originalRuntime = snapshot(runtime)
    const commands = [
      "$ErrorActionPreference = 'Continue'",
      "$ConfigFile = Join-Path $Root '.install-config.json'"
    ]
    if (runtimeKind !== 'config.dataDir') {
      commands.push('$env:' + runtimeKind + " = Join-Path $projDir 'absolute-runtime/persistent'")
    }
    commands.push(
      "Invoke-ProjectUpdate $projDir $cfg $false 'absolute-runtime-fingerprint' | Out-Null",
      "$script:recordedProject = ''",
      "$script:launchedProject = ''",
      "$finish = $ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -eq 'Finish-Update' }",
      '. ([ScriptBlock]::Create($finish.Extent.Text))',
      'function Separator {}',
      'function KeyValue($key, $value) {}',
      "function Read-Host($prompt) { return '' }",
      'function Set-BatPreferenceSafe($key, $value) {',
      "  if ($key -eq 'LAST_PROJECT') { $script:recordedProject = $value }",
      '  return $true',
      '}',
      'function Run($directory, [bool]$directUse = $false) { $script:launchedProject = $directory }',
      'Finish-Update $projDir',
      "$result = @{ recordedProject = $script:recordedProject; launchedProject = $script:launchedProject; code = [IO.File]::ReadAllText((Join-Path $script:launchedProject 'server.js')); marker = (Get-Content -LiteralPath (Join-Path $script:launchedProject '.install-version') -Raw | ConvertFrom-Json); runtimeExists = (Test-Path -LiteralPath (Join-Path $projDir 'absolute-runtime/persistent') -PathType Container) }"
    )
    const result = runPowerShell(fixture, commands)
    assert.equal(result.code, 'new-server', 'the new application must already be committed')
    assert.equal(result.marker.version, '2.0.0')
    assert.equal(result.marker.payloadHash, 'absolute-runtime-fingerprint')
    assert.deepEqual(fs.readFileSync(path.join(result.launchedProject, 'config.json')), originalConfig)
    assert.equal(result.recordedProject, path.basename(fixture.installed))
    assert.equal(path.resolve(result.launchedProject), path.resolve(fixture.installed))
    assert.equal(result.runtimeExists, true)
    assert.deepEqual(snapshot(runtime), originalRuntime)
  }))
}

test('提交失败且恢复被文件占用阻断时保留 rollback，旧文件仍可完整找回', windows, () => withFixture(fixture => {
  const result = runPowerShell(fixture, [
    '$script:commitFailure = $false',
    '$script:restoreFailure = $false',
    'function Move-Item {',
    '  param([string]$Path, [string]$Destination, [switch]$Force, [string]$ErrorAction, [string]$LiteralPath)',
    '  $sourcePath = $Path',
    '  if ($LiteralPath) { $sourcePath = $LiteralPath }',
    "  $targetIsInstalled = ($Destination -eq $projDir -or $Destination -eq (Join-Path $projDir 'server.js'))",
    "  if ((Split-Path $sourcePath -Leaf) -eq 'server.js' -and $targetIsInstalled) {",
    "    if (-not $script:commitFailure -and $sourcePath -match '\\.update-stage-') {",
    '      $script:commitFailure = $true',
    "      throw 'controlled-commit-failure'",
    '    }',
    "    if ($script:commitFailure -and $sourcePath -match '\\.project-rollback-') {",
    '      $script:restoreFailure = $true',
    "      throw 'controlled-restore-file-locked'",
    '    }',
    '  }',
    '  Microsoft.PowerShell.Management\\Move-Item @PSBoundParameters',
    '}',
    "$message = ''",
    "try { Invoke-ProjectUpdate $projDir $cfg $false 'failed-fingerprint' | Out-Null } catch { $message = $_.Exception.Message }",
    "$rollback = @(Get-ChildItem -LiteralPath $Root -Directory | Where-Object { $_.Name.StartsWith('.project-rollback-') })",
    "$result = @{ commitFailure = $script:commitFailure; restoreFailure = $script:restoreFailure; message = $message; rollback = @($rollback | ForEach-Object { $_.FullName }) }"
  ])
  assert.equal(result.commitFailure, true)
  assert.equal(result.restoreFailure, true)
  assert.match(result.message, /自动恢复未完成/)
  assert.equal(result.rollback.length, 1)
  const rollback = path.resolve(result.rollback[0])
  assert.equal(path.dirname(rollback), path.resolve(fixture.directory))
  assert.ok(path.basename(rollback).startsWith('.project-rollback-'))
  assert.ok(result.message.includes(rollback))
  assert.deepEqual({ ...snapshot(fixture.installed), ...snapshot(rollback) }, fixture.before)
}))
