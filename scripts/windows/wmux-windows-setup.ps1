$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$global:ProgressPreference = 'SilentlyContinue'

function Get-CommandPath([string]$Name) {
  $Command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($Command) { return [string]$Command.Source }
  return $null
}

function Get-SunshineCommand {
  $Command = Get-CommandPath 'sunshine.exe'
  if ($Command) { return $Command }
  $Candidates = @()
  foreach ($Root in @(${env:ProgramFiles}, ${env:ProgramFiles(x86)})) {
    if (-not $Root) { continue }
    $Candidates += Join-Path $Root 'Sunshine\sunshine.exe'
    $Candidates += Join-Path $Root 'LizardByte\Sunshine\sunshine.exe'
  }
  foreach ($Candidate in $Candidates) {
    if (Test-Path -LiteralPath $Candidate -PathType Leaf) { return $Candidate }
  }
  return $null
}

function Update-ProcessPath {
  $MachinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:PATH = @($MachinePath, $UserPath, $env:PATH) -join ';'
}

function Invoke-Python([string[]]$PythonArgs, [switch]$Quiet) {
  $Py = Get-CommandPath 'py.exe'
  if ($Py) {
    if ($Quiet) {
      & $Py -3 @PythonArgs *> $null
    } else {
      & $Py -3 @PythonArgs
    }
    $script:WmuxLastPythonExitCode = [int]$LASTEXITCODE
    return
  }
  $Python = Get-CommandPath 'python.exe'
  if ($Python) {
    if ($Quiet) {
      & $Python @PythonArgs *> $null
    } else {
      & $Python @PythonArgs
    }
    $script:WmuxLastPythonExitCode = [int]$LASTEXITCODE
    return
  }
  if (-not $Quiet) {
    Write-Error 'Python was not found. Run wmux-windows-setup install-deps after installing winget or Python.'
  }
  $script:WmuxLastPythonExitCode = 127
}

function Test-PythonModule([string]$ModuleName) {
  if (-not (Get-CommandPath 'py.exe') -and -not (Get-CommandPath 'python.exe')) {
    return $false
  }
  $Code = "import $ModuleName"
  Invoke-Python -PythonArgs @('-c', $Code) -Quiet
  return ($script:WmuxLastPythonExitCode -eq 0)
}

function Install-PythonPackage([string]$PackageName, [string]$ImportName) {
  if (Test-PythonModule $ImportName) {
    Write-Output "$PackageName is already available."
    return
  }
  Invoke-Python -PythonArgs @('-m', 'pip', 'install', '--user', '--upgrade', $PackageName)
  if ($script:WmuxLastPythonExitCode -ne 0) {
    Write-Error "Failed to install $PackageName with pip."
    exit $script:WmuxLastPythonExitCode
  }
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

function Test-SunshineApi([string]$Url, [string]$User, [string]$Password) {
  if (-not $Url) { $Url = 'https://127.0.0.1:47990' }
  $Headers = @{}
  if ($User -and $Password) {
    $Bytes = [Text.Encoding]::UTF8.GetBytes("${User}:${Password}")
    $Headers['Authorization'] = 'Basic ' + [Convert]::ToBase64String($Bytes)
  }
  try {
    $Response = Invoke-WebRequest -UseBasicParsing -Method Get -Uri ($Url.TrimEnd('/') + '/api/configLocale') -Headers $Headers -SkipCertificateCheck -TimeoutSec 5
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
    'wmux-clip',
    'wmux-hooks',
    'wmux-media',
    'wmux-notify',
    'wmux-run',
    'wmux-stream-agent-service',
    'wmux-title',
    'wclip',
    'wmclip',
    'wmux-windows-agent-service',
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
  $AgentConfigPath = Join-Path $HOME '.wmux\windows-agent.json'
  $Task = Get-ScheduledTask -TaskName 'wmux-stream-agent' -ErrorAction SilentlyContinue
  $TaskInfo = if ($Task) { Get-ScheduledTaskInfo -TaskName 'wmux-stream-agent' -ErrorAction SilentlyContinue } else { $null }
  $AgentTask = Get-ScheduledTask -TaskName 'wmux-windows-agent' -ErrorAction SilentlyContinue
  $AgentTaskInfo = if ($AgentTask) { Get-ScheduledTaskInfo -TaskName 'wmux-windows-agent' -ErrorAction SilentlyContinue } else { $null }
  $SunshineCommand = Get-SunshineCommand
  $SunshineUrl = if ($env:WMUX_SUNSHINE_URL) { $env:WMUX_SUNSHINE_URL } else { 'https://127.0.0.1:47990' }
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
    agentConfigPath = $AgentConfigPath
    agentConfigExists = Test-Path -LiteralPath $AgentConfigPath -PathType Leaf
    agentTaskState = if ($AgentTask) { [string]$AgentTask.State } else { 'missing' }
    agentTaskLastRunTime = if ($AgentTaskInfo) { $AgentTaskInfo.LastRunTime.ToString('o') } else { $null }
    agentTaskLastTaskResult = if ($AgentTaskInfo) { $AgentTaskInfo.LastTaskResult } else { $null }
    commands = [ordered]@{
      ffmpeg = Get-CommandPath 'ffmpeg.exe'
      python = Get-CommandPath 'python.exe'
      py = Get-CommandPath 'py.exe'
      winget = Get-CommandPath 'winget.exe'
      sshd = Get-CommandPath 'sshd.exe'
      sunshine = $SunshineCommand
    }
    sunshine = [ordered]@{
      installed = [bool]$SunshineCommand
      command = $SunshineCommand
      url = $SunshineUrl
      api = Test-SunshineApi $SunshineUrl $env:WMUX_SUNSHINE_USER $env:WMUX_SUNSHINE_PASSWORD
    }
    pythonModules = [ordered]@{
      pywinpty = Test-PythonModule 'winpty'
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
    Update-ProcessPath
  } else {
    Write-Output 'ffmpeg.exe is already available.'
  }
  if (-not (Get-CommandPath 'python.exe') -and -not (Get-CommandPath 'py.exe')) {
    & $Winget install --id Python.Python.3.12 --exact --accept-package-agreements --accept-source-agreements
    Update-ProcessPath
  } else {
    Write-Output 'Python is already available.'
  }
  Install-PythonPackage 'pywinpty' 'winpty'
}

function Install-Sunshine {
  if (Get-SunshineCommand) {
    Write-Output 'Sunshine is already installed.'
    return
  }
  $Winget = Get-CommandPath 'winget.exe'
  if (-not $Winget) {
    Write-Error 'winget.exe is required for install-sunshine. Install Sunshine manually, then rerun sunshine-status.'
    exit 127
  }
  & $Winget install --id LizardByte.Sunshine --exact --accept-package-agreements --accept-source-agreements
  Update-ProcessPath
  if (-not (Get-SunshineCommand)) {
    Write-Error 'Sunshine install completed but sunshine.exe was not found.'
    exit 1
  }
  Write-Output 'Sunshine installed.'
}

function Set-SunshineCredentials {
  $Sunshine = Get-SunshineCommand
  if (-not $Sunshine) {
    Write-Error 'sunshine.exe was not found. Run wmux-windows-setup install-sunshine first.'
    exit 127
  }
  $User = $env:WMUX_SUNSHINE_USER
  $Password = $env:WMUX_SUNSHINE_PASSWORD
  if (-not $User -or -not $Password) {
    Write-Error 'Set WMUX_SUNSHINE_USER and WMUX_SUNSHINE_PASSWORD before running configure-sunshine.'
    exit 2
  }
  & $Sunshine --creds $User $Password
  if ($LASTEXITCODE -ne 0) {
    Write-Error "sunshine.exe --creds failed with exit code $LASTEXITCODE."
    exit $LASTEXITCODE
  }
  Write-Output 'Sunshine credentials configured.'
}

function Start-Sunshine {
  $Sunshine = Get-SunshineCommand
  if (-not $Sunshine) {
    Write-Error 'sunshine.exe was not found. Run wmux-windows-setup install-sunshine first.'
    exit 127
  }
  $Existing = Get-Process -Name 'sunshine' -ErrorAction SilentlyContinue
  if ($Existing) {
    Write-Output 'Sunshine is already running.'
    return
  }
  Start-Process -FilePath $Sunshine -WindowStyle Hidden
  Start-Sleep -Seconds 2
  Write-Output 'Sunshine start requested.'
}

function Show-Usage {
  Write-Error @'
usage: wmux-windows-setup [validate|persist-path|install-deps|install-sunshine|configure-sunshine|start-sunshine|sunshine-status|install-stream|stream-status|install-agent|agent-status|agent-logs|install-hooks|status]

validate       Print a JSON report for Windows wmux prerequisites and helper state.
persist-path   Add %LOCALAPPDATA%\wmux\bin to the persistent user PATH.
install-deps   Install ffmpeg, Python, and pywinpty when missing.
install-sunshine Install Sunshine with winget when missing.
configure-sunshine Set Sunshine credentials from WMUX_SUNSHINE_USER/WMUX_SUNSHINE_PASSWORD.
start-sunshine Start sunshine.exe for the current logged-in user session.
sunshine-status Print the Sunshine section of the validation report.
install-stream Install/start the per-user wmux stream-agent Scheduled Task.
stream-status  Show the wmux stream-agent Scheduled Task status.
install-agent  Install/start the per-user wmux Windows session agent Scheduled Task.
agent-status   Show the wmux Windows session agent Scheduled Task status.
agent-logs     Show the wmux Windows session agent logs.
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
  'install-sunshine' {
    Install-Sunshine
  }
  'configure-sunshine' {
    Set-SunshineCredentials
  }
  'start-sunshine' {
    Start-Sunshine
  }
  'sunshine-status' {
    (Get-WindowsWmuxReport).sunshine | ConvertTo-Json -Depth 8
  }
  'install-stream' {
    Invoke-WmuxHelper 'wmux-stream-agent-service' @('install')
  }
  'stream-status' {
    Invoke-WmuxHelper 'wmux-stream-agent-service' @('status')
  }
  'install-agent' {
    Invoke-WmuxHelper 'wmux-windows-agent-service' @('install')
  }
  'agent-status' {
    Invoke-WmuxHelper 'wmux-windows-agent-service' @('status')
  }
  'agent-logs' {
    Invoke-WmuxHelper 'wmux-windows-agent-service' @('logs')
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
