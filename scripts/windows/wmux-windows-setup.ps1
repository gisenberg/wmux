$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$global:ProgressPreference = 'SilentlyContinue'

function Get-CommandPath([string]$Name) {
  $Command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($Command) { return [string]$Command.Source }
  return $null
}

function Get-WmuxHelperDir {
  if ($env:WMUX_HELPER_DIR) { return $env:WMUX_HELPER_DIR }
  return (Join-Path $env:LOCALAPPDATA 'wmux\bin')
}

function Invoke-WmuxHelper([string]$Name, [string[]]$HelperArgs) {
  $Command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($Command) {
    & $Command.Source @HelperArgs
    return
  }
  $ScriptPath = Join-Path (Get-WmuxHelperDir) "$Name.ps1"
  if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
    Write-Error "$Name was not found in PATH or at $ScriptPath"
    exit 127
  }
  & $ScriptPath @HelperArgs
}

function Test-WmuxUrl([string]$Url) {
  try {
    $Response = Invoke-WebRequest -UseBasicParsing -Method Get -Uri ($Url.TrimEnd('/') + '/api/health') -TimeoutSec 5
    return [ordered]@{
      reachable = $true
      statusCode = [int]$Response.StatusCode
    }
  } catch {
    return [ordered]@{
      reachable = $false
      error = $_.Exception.Message
    }
  }
}

function Get-WindowsWmuxReport {
  $WmuxUrl = $env:WMUX_URL
  if (-not $WmuxUrl) { $WmuxUrl = 'http://127.0.0.1:3478' }
  $HelperDir = Get-WmuxHelperDir
  $HelperNames = @(
    'wmux-agent-event',
    'wmux-copy',
    'wmux-hooks',
    'wmux-media',
    'wmux-notify',
    'wmux-run',
    'wmux-stream-agent-service',
    'wmux-title',
    'wmux-windows-setup'
  )
  $Helpers = [ordered]@{}
  foreach ($Helper in $HelperNames) {
    $Helpers[$Helper] = [ordered]@{
      ps1 = Test-Path -LiteralPath (Join-Path $HelperDir "$Helper.ps1") -PathType Leaf
      cmd = Test-Path -LiteralPath (Join-Path $HelperDir "$Helper.cmd") -PathType Leaf
      command = Get-CommandPath $Helper
    }
  }
  $ConfigPath = Join-Path $HOME '.wmux\stream-agent.json'
  $Task = Get-ScheduledTask -TaskName 'wmux-stream-agent' -ErrorAction SilentlyContinue
  $TaskInfo = if ($Task) { Get-ScheduledTaskInfo -TaskName 'wmux-stream-agent' -ErrorAction SilentlyContinue } else { $null }
  [ordered]@{
    computerName = $env:COMPUTERNAME
    userName = $env:USERNAME
    powerShellVersion = $PSVersionTable.PSVersion.ToString()
    wmuxUrl = $WmuxUrl
    wmuxApi = Test-WmuxUrl $WmuxUrl
    helperDir = $HelperDir
    helperDirExists = Test-Path -LiteralPath $HelperDir -PathType Container
    helperDirInProcessPath = (($env:PATH -split ';') -contains $HelperDir)
    helperDirInUserPath = (((( [Environment]::GetEnvironmentVariable('Path', 'User') ) -split ';') | Where-Object { $_ }) -contains $HelperDir)
    helpers = $Helpers
    streamConfigPath = $ConfigPath
    streamConfigExists = Test-Path -LiteralPath $ConfigPath -PathType Leaf
    streamTaskState = if ($Task) { [string]$Task.State } else { 'missing' }
    streamTaskLastRunTime = if ($TaskInfo) { $TaskInfo.LastRunTime.ToString('o') } else { $null }
    streamTaskLastTaskResult = if ($TaskInfo) { $TaskInfo.LastTaskResult } else { $null }
    commands = [ordered]@{
      ffmpeg = Get-CommandPath 'ffmpeg.exe'
      python = Get-CommandPath 'python.exe'
      py = Get-CommandPath 'py.exe'
      winget = Get-CommandPath 'winget.exe'
      sshd = Get-CommandPath 'sshd.exe'
    }
    hookConfig = [ordered]@{
      claudeSettings = Test-Path -LiteralPath (Join-Path $HOME '.claude\settings.json') -PathType Leaf
      codexHooks = Test-Path -LiteralPath (Join-Path $HOME '.codex\hooks.json') -PathType Leaf
      codexConfig = Test-Path -LiteralPath (Join-Path $HOME '.codex\config.toml') -PathType Leaf
    }
  }
}

function Add-HelperDirToUserPath {
  $HelperDir = Get-WmuxHelperDir
  New-Item -ItemType Directory -Force -Path $HelperDir | Out-Null
  $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $Parts = @($UserPath -split ';' | Where-Object { $_ })
  if ($Parts -notcontains $HelperDir) {
    $Parts += $HelperDir
    [Environment]::SetEnvironmentVariable('Path', ($Parts -join ';'), 'User')
    Write-Output "Added $HelperDir to the user PATH. Start a new shell to inherit it."
  } else {
    Write-Output "$HelperDir is already on the user PATH."
  }
}

function Install-WmuxDependencies {
  $Winget = Get-CommandPath 'winget.exe'
  if (-not $Winget) {
    Write-Error 'winget.exe is required for install-deps. Install ffmpeg and Python manually, then rerun validate.'
    exit 127
  }
  if (-not (Get-CommandPath 'ffmpeg.exe')) {
    & $Winget install --id Gyan.FFmpeg --exact --accept-package-agreements --accept-source-agreements
  } else {
    Write-Output 'ffmpeg.exe is already available.'
  }
  if (-not (Get-CommandPath 'python.exe') -and -not (Get-CommandPath 'py.exe')) {
    & $Winget install --id Python.Python.3.12 --exact --accept-package-agreements --accept-source-agreements
  } else {
    Write-Output 'Python is already available.'
  }
}

function Show-Usage {
  Write-Error @'
usage: wmux-windows-setup [validate|persist-path|install-deps|install-stream|stream-status|install-hooks|status]

validate       Print a JSON report for Windows wmux prerequisites and helper state.
persist-path   Add %LOCALAPPDATA%\wmux\bin to the persistent user PATH.
install-deps   Install ffmpeg and Python with winget when missing.
install-stream Install/start the per-user wmux stream-agent Scheduled Task.
stream-status  Show the wmux stream-agent Scheduled Task status.
install-hooks  Install Claude and Codex hooks using wmux-hooks.
status         Alias for validate.
'@
}

$Action = if ($args.Count -gt 0) { [string]$args[0] } else { 'validate' }

switch ($Action) {
  'validate' {
    Get-WindowsWmuxReport | ConvertTo-Json -Depth 12
  }
  'status' {
    Get-WindowsWmuxReport | ConvertTo-Json -Depth 12
  }
  'persist-path' {
    Add-HelperDirToUserPath
  }
  'install-deps' {
    Install-WmuxDependencies
  }
  'install-stream' {
    Invoke-WmuxHelper 'wmux-stream-agent-service' @('install')
  }
  'stream-status' {
    Invoke-WmuxHelper 'wmux-stream-agent-service' @('status')
  }
  'install-hooks' {
    Invoke-WmuxHelper 'wmux-hooks' @('install', 'claude')
    Invoke-WmuxHelper 'wmux-hooks' @('install', 'codex')
  }
  default {
    Show-Usage
    exit 2
  }
}
