param(
  [switch]$Once,
  [int]$IntervalSeconds = 30,
  [string]$StateDir = (Join-Path $HOME '.wmux')
)

$ErrorActionPreference = 'Stop'

if ($IntervalSeconds -lt 5) { throw 'IntervalSeconds must be at least 5 seconds' }

$WmuxUrl = $env:WMUX_URL
if (-not $WmuxUrl) {
  $UrlFile = Join-Path $StateDir 'url'
  if (Test-Path -LiteralPath $UrlFile) { $WmuxUrl = (Get-Content -LiteralPath $UrlFile -Raw).Trim() }
}
if (-not $WmuxUrl) { $WmuxUrl = 'http://127.0.0.1:3478' }
$WmuxUrl = $WmuxUrl.TrimEnd('/')

$Token = $env:WMUX_REGISTRATION_TOKEN
if (-not $Token) {
  $TokenFile = Join-Path $StateDir 'registration-token'
  if (Test-Path -LiteralPath $TokenFile) { $Token = (Get-Content -LiteralPath $TokenFile -Raw).Trim() }
}
if (-not $Token) {
  throw "no registration token: set WMUX_REGISTRATION_TOKEN or create $StateDir\registration-token"
}
if ($Token -match "[\r\n]") { throw 'registration token must not contain a newline' }

$ConfigFile = if ($env:WMUX_HEARTBEAT_CONFIG) { $env:WMUX_HEARTBEAT_CONFIG } else { Join-Path $StateDir 'heartbeat.json' }
if (-not (Test-Path -LiteralPath $ConfigFile -PathType Leaf)) { throw "missing $ConfigFile" }

while ($true) {
  $Failed = $false
  try {
    $Body = Get-Content -LiteralPath $ConfigFile -Raw
    Invoke-RestMethod -Method Post -Uri "$WmuxUrl/api/registry/hosts" `
      -Headers @{ Authorization = "Bearer $Token" } `
      -ContentType 'application/json' -Body $Body -TimeoutSec 15 | Out-Null
  } catch {
    $Failed = $true
    Write-Warning "wmux-heartbeat: $($_.Exception.Message)"
  }
  if ($Once) {
    if ($Failed) { exit 1 }
    exit 0
  }
  Start-Sleep -Seconds $IntervalSeconds
}
