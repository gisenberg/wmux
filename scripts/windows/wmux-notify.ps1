$ErrorActionPreference = 'Stop'

function Read-WmuxFileValue([string]$PathValue) {
  try { if (Test-Path -LiteralPath $PathValue -PathType Leaf) { return ([System.IO.File]::ReadAllText($PathValue)).Trim() } } catch {}
  return ''
}

function Get-WmuxToken {
  $EnvValue = [Environment]::GetEnvironmentVariable('WMUX_HELPER_TOKEN', 'Process')
  $EnvConfigured = $null -ne $EnvValue
  $EnvToken = ([string]$EnvValue).Trim()
  if ($EnvConfigured -and $EnvToken -notmatch '^[A-Za-z0-9_-]{32,256}$') { throw 'configured helper token is empty or malformed' }
  $PathValue = [Environment]::GetEnvironmentVariable('WMUX_HELPER_TOKEN_PATH', 'Process')
  $PathConfigured = $null -ne $PathValue
  if ($PathConfigured -and [string]::IsNullOrWhiteSpace($PathValue)) { throw 'configured helper token path is empty' }
  $HelperPath = if ($PathConfigured -and $PathValue) { $PathValue } else { Join-Path $HOME '.wmux\helper-token' }
  if ($PathConfigured -or (Test-Path -LiteralPath $HelperPath)) {
    $Token = Read-WmuxFileValue $HelperPath
    if ($Token -notmatch '^[A-Za-z0-9_-]{32,256}$') { throw 'configured helper token file is unreadable or malformed' }
    return $Token
  }
  if ($EnvConfigured) { return $EnvToken }
  if ($env:WMUX_BROWSER_AUTH_MODE -eq 'login-only') { return '' }
  if ($env:WMUX_TOKEN) { return $env:WMUX_TOKEN }
  $LegacyPath = if ($env:WMUX_TOKEN_PATH) { $env:WMUX_TOKEN_PATH } else { Join-Path $HOME '.wmux\token' }
  return Read-WmuxFileValue $LegacyPath
}

$WmuxUrl = $env:WMUX_URL
if (-not $WmuxUrl) { $WmuxUrl = 'http://127.0.0.1:3478' }
$Title = 'wmux'
$Subtitle = ''
$Body = ''
$PaneId = $env:WMUX_PANE_ID
$WorkspaceId = $env:WMUX_WORKSPACE_ID
$TabId = $env:WMUX_TAB_ID

for ($Index = 0; $Index -lt $args.Count; $Index++) {
  $Arg = [string]$args[$Index]
  switch ($Arg) {
    '--url' { $Index++; $WmuxUrl = [string]$args[$Index]; continue }
    '--title' { $Index++; $Title = [string]$args[$Index]; continue }
    '--subtitle' { $Index++; $Subtitle = [string]$args[$Index]; continue }
    '--body' { $Index++; $Body = [string]$args[$Index]; continue }
    '--pane' { $Index++; $PaneId = [string]$args[$Index]; continue }
    '--workspace' { $Index++; $WorkspaceId = [string]$args[$Index]; continue }
    '--tab' { $Index++; $TabId = [string]$args[$Index]; continue }
    default {
      if (-not $Body) {
        $Body = $Arg
      } else {
        throw "unknown argument: $Arg"
      }
    }
  }
}

$Payload = [ordered]@{
  title = $Title
  subtitle = $Subtitle
  body = $Body
}
if ($PaneId) { $Payload.paneId = $PaneId }
if ($WorkspaceId) { $Payload.workspaceId = $WorkspaceId }
if ($TabId) { $Payload.tabId = $TabId }

$Json = $Payload | ConvertTo-Json -Depth 8 -Compress
$Headers = @{}
$WmuxToken = Get-WmuxToken
if ($WmuxToken) { $Headers['Authorization'] = "Bearer $WmuxToken" }
Invoke-RestMethod -Method Post -Uri ($WmuxUrl.TrimEnd('/') + '/api/notifications') -Headers $Headers -ContentType 'application/json' -Body $Json | Out-Null
