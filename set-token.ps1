#requires -Version 5.1
<#  Save the aimarket login token (__user_token__ cookie) for the daily sign-in task.
    Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File set-token.ps1 -Token "xxxxx"
            powershell -NoProfile -ExecutionPolicy Bypass -File set-token.ps1          (will prompt)
#>
param(
  [string]$Token,
  [string]$BaseUrl = 'https://aimarket.hncig.cn:4090',
  [string]$ConfigPath = (Join-Path $PSScriptRoot 'config.json')
)
$ErrorActionPreference = 'Stop'
if (-not $Token) { $Token = Read-Host 'Paste the value of the __user_token__ cookie (or auth token)' }
$Token = $Token.Trim()
if ($Token.StartsWith('Bearer ')) { $Token = $Token.Substring(7).Trim() }
if ($Token -match '%') { $Token = [uri]::UnescapeDataString($Token) }
if (-not $Token) { Write-Host 'No token given, nothing saved.' -ForegroundColor Red; exit 1 }

@{ baseUrl = $BaseUrl.TrimEnd('/'); token = $Token; setAt = (Get-Date).ToString('s') } |
  ConvertTo-Json | Set-Content -LiteralPath $ConfigPath -Encoding UTF8
Write-Host ('Token saved to ' + $ConfigPath) -ForegroundColor Green
Write-Host 'Verifying with a status query...'
& (Join-Path $PSScriptRoot 'signin.ps1') -Status