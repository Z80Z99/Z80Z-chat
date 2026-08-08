# ============================================================
# restore-template.ps1 - rebuild deploy/install.template.bat
# from a built Z80Z-chat.bat artifact (reverse of build-single.js)
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restore-template.ps1
# The recovered template keeps the embedded PS block (base64),
# start.js block and zip block as placeholders so build-single.js
# can rebuild an equivalent artifact.
# ============================================================
param(
  [string]$Source = 'E:\Opencode Project\Z80Z\Z80Z-chat.bat',
  [string]$Output = 'E:\Opencode Project\Z80Z\deploy\install.template.bat'
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path -LiteralPath $Source)) { throw "source not found: $Source" }
$outDir = Split-Path -Parent $Output
if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

$lines = [System.IO.File]::ReadAllLines($Source, [System.Text.Encoding]::UTF8)

$psB = [Array]::IndexOf($lines, '__NODECHAT_PS_B64_BEGIN__')
$psE = [Array]::IndexOf($lines, '__NODECHAT_PS_B64_END__')
$sjB = [Array]::IndexOf($lines, '__NODECHAT_STARTJS_BEGIN__')
$sjE = [Array]::IndexOf($lines, '__NODECHAT_STARTJS_END__')
$zpB = [Array]::IndexOf($lines, '__NODECHAT_ZIP_B64_BEGIN__')
$zpE = [Array]::IndexOf($lines, '__NODECHAT_ZIP_B64_END__')
if ($psB -lt 0 -or $psE -lt 0 -or $sjB -lt 0 -or $sjE -lt 0 -or $zpB -lt 0 -or $zpE -lt 0) {
  throw 'embedded block markers not found in source'
}

# --- decode PS block (UTF-8 BOM + plain text) ---
$psBytes = [Convert]::FromBase64String(($lines[($psB + 1)..($psE - 1)] -join ''))
$psText = [System.Text.Encoding]::UTF8.GetString($psBytes).TrimStart([char]0xFEFF)

# --- build template ---
$sb = New-Object System.Text.StringBuilder

# 1) CMD shell head (before the embedded blocks; transform artifact values back)
for ($i = 0; $i -lt $psB; $i++) {
  $l = $lines[$i]
  if ($l -match '^set "APP_VERSION=.*"') { $l = 'set "APP_VERSION=__APP_VERSION__"' }
  elseif ($l -match '^set "APP_BUILT=.*"') { $l = 'set "APP_BUILT=__APP_BUILT__"' }
  elseif ($l -match '^set "PAYLOAD_SHA=.*"') { $l = 'set "PAYLOAD_SHA=__PAYLOAD_SHA__"' }
  elseif ($l -match '^REM _CONFIG_HASH=.*') { $l = 'REM _CONFIG_HASH=nch1' }
  elseif ($l -match '^REM _SKIP_UPDATE_PROMPT=.*') { $l = 'REM _SKIP_UPDATE_PROMPT=false' }
  elseif ($l -match '^REM _SKIP_UPDATE_PROMPT_VERSION=.*') { $l = 'REM _SKIP_UPDATE_PROMPT_VERSION=' }
  elseif ($l -match '^REM _LAST_PROJECT=.*') { $l = 'REM _LAST_PROJECT=' }
  # 关键：PAD 行必须重置为标准长度 71（'REM PAD' + 64 空格），与运行时
  # Set-BatPreferenceSafe 的等长基准（$pad = 64 - $diff）一致；否则从
  # 运行过的 bat 恢复模板会保留运行时调整后的 PAD 长度，重建后等长写入失效
  elseif ($l -match '^REM PAD') { $l = 'REM PAD' + (' ' * 64) }
  [void]$sb.Append($l); [void]$sb.Append("`r`n")
}

# 2) plaintext PS block markers (consumed by build-single.js)
[void]$sb.Append('__NODECHAT_PS_BEGIN__'); [void]$sb.Append("`r`n")
[void]$sb.Append($psText); [void]$sb.Append("`r`n")
[void]$sb.Append('__NODECHAT_PS_END__'); [void]$sb.Append("`r`n")

# 3) placeholders for base64 / start.js / zip blocks
[void]$sb.Append('__NODECHAT_PS_B64_BEGIN__'); [void]$sb.Append("`r`n")
[void]$sb.Append('__PS_B64_PLACEHOLDER__'); [void]$sb.Append("`r`n")
[void]$sb.Append('__NODECHAT_PS_B64_END__'); [void]$sb.Append("`r`n")
[void]$sb.Append('__NODECHAT_STARTJS_BEGIN__'); [void]$sb.Append("`r`n")
[void]$sb.Append('__STARTJS_PLACEHOLDER__'); [void]$sb.Append("`r`n")
[void]$sb.Append('__NODECHAT_STARTJS_END__'); [void]$sb.Append("`r`n")
[void]$sb.Append('__NODECHAT_ZIP_B64_BEGIN__'); [void]$sb.Append("`r`n")
[void]$sb.Append('__ZIP_B64_PLACEHOLDER__'); [void]$sb.Append("`r`n")
[void]$sb.Append('__NODECHAT_ZIP_B64_END__'); [void]$sb.Append("`r`n")

# 4) CMD shell tail (after the embedded blocks: :RUN / :FAIL / :MAIN / PS call)
for ($i = $zpE + 1; $i -lt $lines.Count; $i++) {
  $l = $lines[$i]
  if ($l -match '^set "APP_VERSION=.*"') { $l = 'set "APP_VERSION=__APP_VERSION__"' }
  elseif ($l -match '^set "APP_BUILT=.*"') { $l = 'set "APP_BUILT=__APP_BUILT__"' }
  elseif ($l -match '^set "PAYLOAD_SHA=.*"') { $l = 'set "PAYLOAD_SHA=__PAYLOAD_SHA__"' }
  elseif ($l -match '^REM _CONFIG_HASH=.*') { $l = 'REM _CONFIG_HASH=nch1' }
  elseif ($l -match '^REM _SKIP_UPDATE_PROMPT=.*') { $l = 'REM _SKIP_UPDATE_PROMPT=false' }
  elseif ($l -match '^REM _SKIP_UPDATE_PROMPT_VERSION=.*') { $l = 'REM _SKIP_UPDATE_PROMPT_VERSION=' }
  elseif ($l -match '^REM _LAST_PROJECT=.*') { $l = 'REM _LAST_PROJECT=' }
  elseif ($l -match '^REM PAD') { $l = 'REM PAD' + (' ' * 64) }
  [void]$sb.Append($l); [void]$sb.Append("`r`n")
}

[System.IO.File]::WriteAllText($Output, $sb.ToString(), $utf8NoBom)
Write-Host "template written: $Output ($(($sb.Length / 1024).ToString('0.0')) KB)"
