#requires -Version 5.1
<#
  aimarket.hncig.cn daily sign-in (元筑AI集市)

  - Reads token from config.json (kept fresh by renew-token.js).
  - token invalid/expired  -> silently renews via the enterprise-WeChat SSO
    session in the dedicated Chrome profile (headless).
  - SSO session also gone  -> with -Interactive a Chrome window opens, scan the
    QR code with WeCom once, and the script finishes the sign-in automatically.
  - After each run a Windows toast shows the result (points earned / balance).

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File signin.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File signin.ps1 -Status
    powershell -NoProfile -ExecutionPolicy Bypass -File signin.ps1 -Interactive
    powershell -NoProfile -ExecutionPolicy Bypass -File signin.ps1 -AutoOpenOnNeedRelogin    (used by the scheduled task)
    add -NoToast to suppress the notification

  Exit codes:
    0 signed / already signed / nothing to do
    2 token bad and could not be renewed automatically
    3 request or tooling failure
    4 login (QR scan) required
#>
param(
  [switch]$Status,
  [switch]$Interactive,
  [switch]$AutoOpenOnNeedRelogin,
  [switch]$NoRenew,
  [switch]$NoToast,
  [int]$WaitSec = 1800,
  [string]$ConfigPath = (Join-Path $PSScriptRoot 'config.json'),
  [string]$LogPath    = (Join-Path $PSScriptRoot 'signin.log')
)

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$ErrorActionPreference = 'Stop'

function Write-Log([string]$msg) {
  $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '  ' + $msg
  Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
  Write-Host $line
}

function Show-Toast {
  param([string]$Title, [string]$Message)
  if ($NoToast) { return }
  # primary: Windows 10/11 toast via WinRT (shows in notification center too)
  try {
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $texts = $xml.GetElementsByTagName('text')
    $null = $texts.Item(0).AppendChild($xml.CreateTextNode($Title))
    $null = $texts.Item(1).AppendChild($xml.CreateTextNode($Message))
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
    return
  } catch { }
  # fallback: balloon tip (older systems / toast blocked)
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $ni = New-Object System.Windows.Forms.NotifyIcon
    $ni.Icon = [System.Drawing.SystemIcons]::Information
    $ni.Visible = $true
    $ni.BalloonTipTitle = $Title
    $ni.BalloonTipText  = $Message
    $ni.ShowBalloonTip(10000)
    Start-Sleep -Seconds 10
    $ni.Visible = $false
    $ni.Dispose()
  } catch { Write-Log ('toast failed: ' + $_.Exception.Message) }
}

function Get-BodyCode($err) {
  try {
    $m = $err.ErrorDetails.Message
    if (-not $m) { return $null }
    return (($m | ConvertFrom-Json).code)
  } catch { return $null }
}

function Get-JwtExpMs([string]$token) {
  if (-not $token) { return 0 }
  try {
    $parts = $token.Split('.')
    if ($parts.Length -lt 2) { return 0 }
    $p = $parts[1].Replace('-', '+').Replace('_', '/')
    switch ($p.Length % 4) { 2 { $p += '==' } 3 { $p += '=' } }
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p)) | ConvertFrom-Json
    return ([int64]$json.exp * 1000)
  } catch { return 0 }
}

function Find-Node {
  if ($cfg.nodePath -and (Test-Path -LiteralPath $cfg.nodePath)) { return $cfg.nodePath }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $globs = @(
    (Join-Path $env:USERPROFILE '.cache\codex-runtimes\*\dependencies\node\bin\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
    'C:\Program Files\nodejs\node.exe',
    'C:\Program Files (x86)\nodejs\node.exe'
  )
  foreach ($g in $globs) {
    $hit = Get-ChildItem -Path $g -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}

function Read-Config {
  if (-not (Test-Path -LiteralPath $ConfigPath)) { return $null }
  return (Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json)
}

# ---- load config ----
$cfg = Read-Config
if (-not $cfg) { Write-Log 'config.json not found. Run set-token.ps1 once (or run-signin.cmd) to bootstrap.'; exit 2 }
if (-not $cfg.baseUrl) { $cfg | Add-Member -NotePropertyName baseUrl -NotePropertyValue 'https://aimarket.hncig.cn:4090' -Force }

function Invoke-Renewal {
  $node = Find-Node
  if (-not $node) {
    Write-Log 'renewal skipped: node.exe not found (install Node.js or set nodePath in config.json).'
    return $null
  }
  $js = Join-Path $PSScriptRoot 'renew-token.js'
  if (-not (Test-Path -LiteralPath $js)) { Write-Log 'renew-token.js missing next to signin.ps1.'; return $null }

  $rargs = @($js)
  if ($Interactive) {
    $rargs += @('--visible', '--wait', [string]$WaitSec)
    Write-Log ('renewing token in a browser window (waiting up to ' + $WaitSec + 's for a WeCom QR scan if needed)...')
  } else {
    $rargs += @('--wait', '60')
    Write-Log 'renewing token silently (headless)...'
  }

  $out = & $node @rargs 2>&1
  $code = $LASTEXITCODE
  if ($code -eq 0) {
    $cfg2 = Read-Config
    $tok = $cfg2.token
    $exp = Get-JwtExpMs $tok
    Write-Log ('token renewed, valid until ' + ([DateTimeOffset]::FromUnixTimeMilliseconds($exp).ToLocalTime().ToString('yyyy-MM-dd HH:mm')))
    return $tok
  }
  if ($code -eq 2) {
    $script:needRelogin = $true
    Write-Log 'session expired: the enterprise-WeChat (企业微信) login must be confirmed once.'
    return $null
  }
  $detail = ($out | Select-Object -Last 3) -join ' | '
  Write-Log ('renewal failed (exit ' + $code + '): ' + $detail)
  $script:renewHardFail = $true
  return $null
}

$script:needRelogin = $false
$script:renewHardFail = $false

# ---- make sure we have a usable token ----
$token = $cfg.token
$expMs = Get-JwtExpMs $token
if (-not $token -or $expMs -lt ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 120000)) {
  if ($NoRenew) {
    Write-Log 'token missing/expired and -NoRenew was given.'
    if (-not $token) { exit 2 }
  } else {
    Write-Log 'token missing or about to expire, attempting renewal...'
    $token = Invoke-Renewal
    if (-not $token) {
      if ($script:needRelogin) {
        if ($AutoOpenOnNeedRelogin) {
          Write-Log 'opening the interactive sign-in window (scan the QR code with WeCom)...'
          Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', ('"' + (Join-Path $PSScriptRoot 'run-signin.cmd') + '"')) -WindowStyle Normal | Out-Null
        }
        exit 4
      }
      exit 3
    }
  }
}

$baseUrl = $cfg.baseUrl.TrimEnd('/')
function New-Headers([string]$t) {
  return @{ Authorization = 'Bearer ' + $t; 'x-request-id' = [guid]::NewGuid().ToString() }
}

function Invoke-SignFlow {
  # returns @{ status = OK_DONE|OK_NONE|OK_STATUS|TOKEN_BAD|FAIL; awardedToday = n }
  param([string]$t)
  try {
    $st = Invoke-RestMethod -Method Get -Uri ($baseUrl + '/api/task-award/sign-status') -Headers (New-Headers $t) -TimeoutSec 30
  } catch {
    $code = Get-BodyCode $_
    if ($code -eq 40201 -or $code -eq 40202 -or $code -eq 40200) { return @{ status = 'TOKEN_BAD' } }
    Write-Log ('sign-status request failed: ' + $_.Exception.Message)
    return @{ status = 'FAIL' }
  }
  $d = $st.data
  if ($null -eq $d -or [int]$st.code -ne 20000) {
    Write-Log ('unexpected sign-status response: ' + ($st | ConvertTo-Json -Compress))
    return @{ status = 'FAIL' }
  }
  if (-not $d.enabled) { Write-Log 'sign-in task is disabled on the server. Nothing to do.'; return @{ status = 'OK_NONE' } }
  if ($d.signedToday) {
    Write-Log ('already signed today (award ' + $d.signAward + ').')
    if ($Status) { Write-Host ($d | ConvertTo-Json -Compress) }
    $awarded = if ($null -ne $d.awarded) { [int64]$d.awarded } else { [int64]$d.signAward }
    return @{ status = 'OK_DONE'; granted = $false; awardedToday = $awarded }
  }
  if ($Status) { Write-Host ($d | ConvertTo-Json -Compress); return @{ status = 'OK_STATUS' } }

  try {
    $sg = Invoke-RestMethod -Method Post -Uri ($baseUrl + '/api/task-award/sign') -Headers (New-Headers $t) -TimeoutSec 30 -ContentType 'application/json'
  } catch {
    $code = Get-BodyCode $_
    if ($code -eq 40201 -or $code -eq 40202 -or $code -eq 40200) { return @{ status = 'TOKEN_BAD' } }
    Write-Log ('sign request failed: ' + $_.Exception.Message)
    return @{ status = 'FAIL' }
  }
  $r = $sg.data
  if ([int]$sg.code -eq 20000 -and $r) {
    if ($r.granted) {
      Write-Log ('signed OK, awarded ' + $r.awarded + ' points.')
      return @{ status = 'OK_DONE'; granted = $true; awardedToday = [int64]$r.awarded }
    }
    Write-Log 'already signed today (server said not granted).'
    return @{ status = 'OK_DONE'; granted = $false; awardedToday = [int64]$r.awarded }
  }
  Write-Log ('unexpected sign response: ' + ($sg | ConvertTo-Json -Compress))
  return @{ status = 'FAIL' }
}

function Get-Balance([string]$t) {
  # current points balance from /api/user/info (power), $null on failure
  try {
    $ui = Invoke-RestMethod -Method Get -Uri ($baseUrl + '/api/user/info') -Headers (New-Headers $t) -TimeoutSec 30
    if ([int]$ui.code -eq 20000 -and $null -ne $ui.data.power) { return [int64]$ui.data.power }
  } catch { Write-Log ('balance query failed: ' + $_.Exception.Message) }
  return $null
}

$outcome = Invoke-SignFlow $token
if ($outcome.status -eq 'TOKEN_BAD' -and -not $NoRenew) {
  Write-Log 'server rejected the token; renewing once and retrying...'
  $token = Invoke-Renewal -Force
  if ($token) {
    $outcome = Invoke-SignFlow $token
  } elseif ($script:needRelogin) {
    if ($AutoOpenOnNeedRelogin) {
      Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', ('"' + (Join-Path $PSScriptRoot 'run-signin.cmd') + '"')) -WindowStyle Normal | Out-Null
    }
    exit 4
  }
}

if ($outcome.status -eq 'OK_DONE' -and -not $Status) {
  $balance = Get-Balance $token
  $balanceTxt = if ($null -ne $balance) { '，当前余额 ' + $balance + ' 积分' } else { '' }
  if ($outcome.granted) {
    $msg = '今日签到成功，获得 ' + $outcome.awardedToday + ' 积分' + $balanceTxt
  } else {
    $msg = '今日已签到，已获 ' + $outcome.awardedToday + ' 积分' + $balanceTxt
  }
  Write-Log $msg
  Show-Toast -Title '元筑AI集市自动签到' -Message $msg
}

switch ($outcome.status) {
  'OK_DONE'   { exit 0 }
  'OK_NONE'   { exit 0 }
  'OK_STATUS' { exit 0 }
  'TOKEN_BAD' { Write-Log 'token rejected by the server and auto-renewal is unavailable.'
                Show-Toast -Title '元筑AI集市自动签到' -Message '自动签到失败：登录令牌失效，请重新扫码（双击 login-once.cmd）'
                exit 2 }
  default     { Write-Log 'sign-in flow failed, see log above.'
                Show-Toast -Title '元筑AI集市自动签到' -Message '自动签到失败：请求异常，详见 signin.log'
                exit 3 }
}