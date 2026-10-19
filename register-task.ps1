#requires -Version 5.1
<#
  Register (or remove) automatic daily execution of signin.ps1.

  Normal use (Scheduled Task, daily at -At, wakes up even if the PC was off):
      powershell -NoProfile -ExecutionPolicy Bypass -File register-task.ps1
      powershell -NoProfile -ExecutionPolicy Bypass -File register-task.ps1 -At 09:30

  If Scheduled Task registration is blocked (needs admin on some PCs),
  use the Startup-folder alternative (runs once per logon, no admin needed):
      powershell -NoProfile -ExecutionPolicy Bypass -File register-task.ps1 -StartupFolder

  Remove everything again:
      powershell -NoProfile -ExecutionPolicy Bypass -File register-task.ps1 -Remove

  Notes
  -----
  * The scheduled run uses -AutoOpenOnNeedRelogin: normally it silently renews
    the token in the background (headless Chrome). Only when the enterprise-
    WeChat session has fully expired does it pop a window so you can scan the
    QR code once.
  * Token lifetime is 8 hours, so the daily run refreshes it automatically.
#>
param(
  [string]$At   = '08:10',
  [string]$Name = 'AimarketDailySignIn',
  [switch]$StartupFolder,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'signin.ps1'
if (-not (Test-Path -LiteralPath $script)) { Write-Host 'signin.ps1 not found next to this script.' -ForegroundColor Red; exit 1 }

$startupDir = [Environment]::GetFolderPath('Startup')
$lnkPath    = Join-Path $startupDir ($Name + '.lnk')

if ($Remove) {
  try { Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction Stop; Write-Host ('Removed scheduled task ' + $Name) -ForegroundColor Green } catch { Write-Host 'No scheduled task to remove (or removal denied).' }
  if (Test-Path -LiteralPath $lnkPath) { Remove-Item -LiteralPath $lnkPath -Force; Write-Host 'Removed startup shortcut.' -ForegroundColor Green }
  exit 0
}

$psArgs = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script + '" -AutoOpenOnNeedRelogin'

if ($StartupFolder) {
  $ws  = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut($lnkPath)
  $lnk.TargetPath       = 'powershell.exe'
  $lnk.Arguments        = $psArgs
  $lnk.WorkingDirectory = $PSScriptRoot
  $lnk.Description      = 'Daily sign-in for aimarket.hncig.cn'
  $lnk.Save()
  Write-Host ('Startup shortcut created: ' + $lnkPath) -ForegroundColor Green
  Write-Host 'It runs once per logon. If you log in several times a day it re-checks but only signs in once.'
  exit 0
}

try {
  $action    = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $psArgs -WorkingDirectory $PSScriptRoot
  $trigger   = New-ScheduledTaskTrigger -Daily -At $At
  $settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
  $principal = New-ScheduledTaskPrincipal -UserId ($env:USERDOMAIN + '\' + $env:USERNAME) -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Daily sign-in for aimarket.hncig.cn' -Force | Out-Null
  Write-Host ('Scheduled task "' + $Name + '" registered: every day at ' + $At + '.') -ForegroundColor Green
  Write-Host ('Test now:  Start-ScheduledTask -TaskName ' + $Name)
} catch {
  Write-Host 'Scheduled task registration was blocked (this usually needs an Administrator PowerShell).' -ForegroundColor Yellow
  Write-Host 'Options:' -ForegroundColor Yellow
  Write-Host ('  1. Re-run this file from an Administrator PowerShell, or')
  Write-Host ('  2. Use the logon alternative:  ... -File register-task.ps1 -StartupFolder')
  exit 1
}