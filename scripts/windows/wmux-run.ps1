$ErrorActionPreference = 'Continue'

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

function Get-UtcNow {
  return [DateTimeOffset]::UtcNow.ToString('o').Replace('+00:00', 'Z')
}

function Clean-Command([string[]]$CommandParts) {
  return (($CommandParts -join ' ') -replace '\s+', ' ').Trim().Substring(0, [Math]::Min(500, (($CommandParts -join ' ') -replace '\s+', ' ').Trim().Length))
}

function Post-WmuxJson([string]$Url, [hashtable]$Payload) {
  $WmuxToken = Get-WmuxToken
  try {
    $Json = $Payload | ConvertTo-Json -Depth 8 -Compress
    $Headers = @{}
    if ($WmuxToken) { $Headers['Authorization'] = "Bearer $WmuxToken" }
    Invoke-RestMethod -Method Post -Uri ($Url.TrimEnd('/') + '/api/run-events') -Headers $Headers -ContentType 'application/json' -Body $Json | Out-Null
  } catch {}
}

$WmuxUrl = $env:WMUX_URL
if (-not $WmuxUrl) { $WmuxUrl = 'http://127.0.0.1:3478' }
$PaneId = $env:WMUX_PANE_ID
$WorkspaceId = $env:WMUX_WORKSPACE_ID
$TabId = $env:WMUX_TAB_ID
$Command = @()

for ($Index = 0; $Index -lt $args.Count; $Index++) {
  $Arg = [string]$args[$Index]
  switch ($Arg) {
    '--url' { $Index++; $WmuxUrl = [string]$args[$Index]; continue }
    '--pane' { $Index++; $PaneId = [string]$args[$Index]; continue }
    '--workspace' { $Index++; $WorkspaceId = [string]$args[$Index]; continue }
    '--tab' { $Index++; $TabId = [string]$args[$Index]; continue }
    '--' {
      if ($Index + 1 -lt $args.Count) {
        $Command = @($args[($Index + 1)..($args.Count - 1)])
      }
      $Index = $args.Count
      continue
    }
    default {
      $Command = @($args[$Index..($args.Count - 1)])
      $Index = $args.Count
      continue
    }
  }
}

if (-not $Command -or $Command.Count -eq 0) {
  Write-Error 'wmux-run: command is required'
  exit 2
}

$StartedAt = Get-UtcNow
$RunId = 'run_' + ([guid]::NewGuid().ToString('N').Substring(0, 18))
$Payload = [ordered]@{
  runId = $RunId
  command = Clean-Command $Command
  status = 'started'
  startedAt = $StartedAt
}
if ($PaneId) { $Payload.paneId = $PaneId }
if ($WorkspaceId) { $Payload.workspaceId = $WorkspaceId }
if ($TabId) { $Payload.tabId = $TabId }
if ($PaneId -or $WorkspaceId) { Post-WmuxJson $WmuxUrl $Payload }

try {
  & ([string]$Command[0]) @($Command | Select-Object -Skip 1)
  $ExitCode = if ($null -ne $global:LASTEXITCODE) { [int]$global:LASTEXITCODE } else { 0 }
} catch {
  Write-Error $_
  $ExitCode = 1
}

if ($PaneId -or $WorkspaceId) {
  $Payload.status = if ($ExitCode -eq 0) { 'completed' } else { 'failed' }
  $Payload.exitCode = $ExitCode
  $Payload.completedAt = Get-UtcNow
  Post-WmuxJson $WmuxUrl $Payload
}

exit $ExitCode
