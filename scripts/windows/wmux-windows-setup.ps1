$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$global:ProgressPreference = 'SilentlyContinue'
$AgentFirewallRuleName = 'wmux-windows-agent-from-server'
$AgentRolloutPortCount = 8

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

function Test-PythonRuntime {
  Invoke-Python -PythonArgs @('--version') -Quiet
  return ($script:WmuxLastPythonExitCode -eq 0)
}

function Get-WorkingPythonPath([string]$Name, [string[]]$PrefixArgs) {
  $Command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $Command) { return $null }
  & $Command.Source @PrefixArgs --version *> $null
  if ($LASTEXITCODE -ne 0) { return $null }
  return [string]$Command.Source
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

function Get-WindowsAgentPortRange {
  $ConfigPath = if ($env:WMUX_WINDOWS_AGENT_CONFIG) {
    $env:WMUX_WINDOWS_AGENT_CONFIG
  } else {
    Join-Path $HOME '.wmux\windows-agent.json'
  }
  $Document = if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
    Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  } else {
    [pscustomobject]@{}
  }
  $BasePort = if ($Document.port) { [int]$Document.port } else { 3481 }
  $LastPort = $BasePort + $AgentRolloutPortCount
  if ($BasePort -lt 1 -or $LastPort -gt 65535) {
    throw "The Windows agent base port must leave room for $AgentRolloutPortCount rollout ports (maximum base port: $([int](65535 - $AgentRolloutPortCount)))."
  }
  [pscustomobject]@{
    basePort = $BasePort
    lastPort = $LastPort
    localPort = "$BasePort-$LastPort"
  }
}

function Test-IsInternalAddress([System.Net.IPAddress]$Address) {
  $Bytes = $Address.GetAddressBytes()
  if ($Bytes.Length -eq 4) {
    return (
      $Bytes[0] -eq 10 -or
      ($Bytes[0] -eq 172 -and $Bytes[1] -ge 16 -and $Bytes[1] -le 31) -or
      ($Bytes[0] -eq 192 -and $Bytes[1] -eq 168) -or
      ($Bytes[0] -eq 100 -and $Bytes[1] -ge 64 -and $Bytes[1] -le 127)
    )
  }
  return ($Bytes.Length -eq 16 -and (($Bytes[0] -band 0xfe) -eq 0xfc))
}

function Test-IsAdministrator {
  $Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $Principal = [System.Security.Principal.WindowsPrincipal]::new($Identity)
  return $Principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-WindowsAgentFirewallReport {
  $PortRange = Get-WindowsAgentPortRange
  $Rule = Get-NetFirewallRule -Name $AgentFirewallRuleName -ErrorAction SilentlyContinue
  $PortFilter = if ($Rule) { $Rule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue | Select-Object -First 1 } else { $null }
  $AddressFilter = if ($Rule) { $Rule | Get-NetFirewallAddressFilter -ErrorAction SilentlyContinue | Select-Object -First 1 } else { $null }
  [ordered]@{
    ruleName = $AgentFirewallRuleName
    expectedLocalPort = $PortRange.localPort
    configured = [bool](
      $Rule -and
      [string]$Rule.Enabled -eq 'True' -and
      [string]$Rule.Direction -eq 'Inbound' -and
      [string]$Rule.Action -eq 'Allow' -and
      [string]$PortFilter.Protocol -eq 'TCP' -and
      [string]$PortFilter.LocalPort -eq $PortRange.localPort
    )
    enabled = if ($Rule) { [string]$Rule.Enabled } else { $null }
    localPort = if ($PortFilter) { [string]$PortFilter.LocalPort } else { $null }
    remoteAddress = if ($AddressFilter) { @($AddressFilter.RemoteAddress) } else { @() }
  }
}

function Set-WindowsAgentFirewall([string[]]$RemoteAddresses) {
  if (-not (Test-IsAdministrator)) {
    throw 'Configuring the Windows agent firewall requires an elevated PowerShell session.'
  }
  if (-not $RemoteAddresses -or $RemoteAddresses.Count -eq 0) {
    $RemoteAddresses = @($env:WMUX_WINDOWS_AGENT_REMOTE_ADDRESSES -split ',' | Where-Object { $_ })
  }
  $ValidatedAddresses = @()
  foreach ($Value in $RemoteAddresses) {
    $Text = ([string]$Value).Trim()
    $Parsed = $null
    if (-not [System.Net.IPAddress]::TryParse($Text, [ref]$Parsed) -or -not (Test-IsInternalAddress $Parsed)) {
      throw "Windows agent firewall addresses must be exact Tailscale, RFC1918, or IPv6 ULA literals; rejected: $Text"
    }
    $ValidatedAddresses += $Parsed.ToString()
  }
  if ($ValidatedAddresses.Count -eq 0) {
    throw 'Pass the wmux server internal IP, or set WMUX_WINDOWS_AGENT_REMOTE_ADDRESSES, before configuring the agent firewall.'
  }

  $PortRange = Get-WindowsAgentPortRange
  $Existing = Get-NetFirewallRule -Name $AgentFirewallRuleName -ErrorAction SilentlyContinue
  if ($Existing) {
    Set-NetFirewallRule `
      -Name $AgentFirewallRuleName `
      -Enabled True `
      -Direction Inbound `
      -Profile Any `
      -Action Allow `
      -ErrorAction Stop | Out-Null
    $Existing | Get-NetFirewallPortFilter -ErrorAction Stop | Set-NetFirewallPortFilter `
      -Protocol TCP `
      -LocalPort $PortRange.localPort `
      -ErrorAction Stop | Out-Null
    $Existing | Get-NetFirewallAddressFilter -ErrorAction Stop | Set-NetFirewallAddressFilter `
      -RemoteAddress $ValidatedAddresses `
      -ErrorAction Stop | Out-Null
  } else {
    New-NetFirewallRule `
      -Name $AgentFirewallRuleName `
      -DisplayName 'wmux Windows session agent' `
      -Enabled True `
      -Direction Inbound `
      -Protocol TCP `
      -LocalPort $PortRange.localPort `
      -RemoteAddress $ValidatedAddresses `
      -Profile Any `
      -Action Allow | Out-Null
  }
  Write-Output "Allowed Windows agent TCP ports $($PortRange.localPort) from $($ValidatedAddresses -join ', ') in $AgentFirewallRuleName."
}

function Invoke-WmuxHelper([string]$Name, [string[]]$HelperArgs) {
  $Command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($Command) {
    $HelperPath = $Command.Source
  } else {
    $HelperPath = Join-Path (Get-WmuxHelperDir) "$Name.ps1"
    if (-not (Test-Path -LiteralPath $HelperPath -PathType Leaf)) {
      Write-Error "$Name was not found in PATH or at $HelperPath"
      exit 127
    }
  }
  $global:LASTEXITCODE = 0
  & $HelperPath @HelperArgs
  $ExitCode = [int]$global:LASTEXITCODE
  if ($ExitCode -ne 0) {
    exit $ExitCode
  }
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
    'wmux-heartbeat',
    'wmux-heartbeat-service',
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
  $HeartbeatTask = Get-ScheduledTask -TaskName 'wmux-heartbeat' -ErrorAction SilentlyContinue
  $HeartbeatTaskInfo = if ($HeartbeatTask) { Get-ScheduledTaskInfo -TaskName 'wmux-heartbeat' -ErrorAction SilentlyContinue } else { $null }
  $AgentTask = Get-ScheduledTask -TaskName 'wmux-windows-agent' -ErrorAction SilentlyContinue
  $AgentTaskInfo = if ($AgentTask) { Get-ScheduledTaskInfo -TaskName 'wmux-windows-agent' -ErrorAction SilentlyContinue } else { $null }
  $AgentFirewall = Get-WindowsAgentFirewallReport
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
    heartbeatTaskState = if ($HeartbeatTask) { [string]$HeartbeatTask.State } else { 'missing' }
    heartbeatTaskLastRunTime = if ($HeartbeatTaskInfo) { $HeartbeatTaskInfo.LastRunTime.ToString('o') } else { $null }
    heartbeatTaskLastTaskResult = if ($HeartbeatTaskInfo) { $HeartbeatTaskInfo.LastTaskResult } else { $null }
    agentConfigPath = $AgentConfigPath
    agentConfigExists = Test-Path -LiteralPath $AgentConfigPath -PathType Leaf
    agentTaskState = if ($AgentTask) { [string]$AgentTask.State } else { 'missing' }
    agentTaskLastRunTime = if ($AgentTaskInfo) { $AgentTaskInfo.LastRunTime.ToString('o') } else { $null }
    agentTaskLastTaskResult = if ($AgentTaskInfo) { $AgentTaskInfo.LastTaskResult } else { $null }
    agentFirewall = $AgentFirewall
    commands = [ordered]@{
      ffmpeg = Get-CommandPath 'ffmpeg.exe'
      python = Get-WorkingPythonPath 'python.exe' @()
      py = Get-WorkingPythonPath 'py.exe' @('-3')
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
  if (-not (Test-PythonRuntime)) {
    & $Winget install --id Python.Python.3.12 --exact --accept-package-agreements --accept-source-agreements
    Update-ProcessPath
    if (-not (Test-PythonRuntime)) {
      Write-Error 'Python installation completed, but a working Python runtime was not found on PATH.'
      exit 1
    }
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
usage: wmux-windows-setup [validate|persist-path|install-deps|install-sunshine|configure-sunshine|start-sunshine|sunshine-status|install-heartbeat|heartbeat-status|heartbeat-logs|install-stream|stream-status|install-agent|configure-agent-firewall|agent-firewall-status|agent-status|agent-logs|install-hooks|status]

validate       Print a JSON report for Windows wmux prerequisites and helper state.
persist-path   Add %LOCALAPPDATA%\wmux\bin to the persistent user PATH.
install-deps   Install ffmpeg, Python, and pywinpty when missing.
install-sunshine Install Sunshine with winget when missing.
configure-sunshine Set Sunshine credentials from WMUX_SUNSHINE_USER/WMUX_SUNSHINE_PASSWORD.
start-sunshine Start sunshine.exe for the current logged-in user session.
sunshine-status Print the Sunshine section of the validation report.
install-heartbeat Install/start the per-user wmux heartbeat Scheduled Task.
heartbeat-status Show the wmux heartbeat Scheduled Task status.
heartbeat-logs Show the wmux heartbeat logs.
install-stream Install/start the per-user wmux stream-agent Scheduled Task.
stream-status  Show the wmux stream-agent Scheduled Task status.
install-agent  Install/start the per-user wmux Windows session agent Scheduled Task.
configure-agent-firewall IP... Allow the base and eight rollout ports from exact internal wmux server IPs (requires elevation).
agent-firewall-status Show the managed Windows agent firewall rule as JSON.
agent-status   Show the wmux Windows session agent Scheduled Task status.
agent-logs     Show the wmux Windows session agent logs.
install-hooks  Install Claude and Codex hooks using wmux-hooks.
status         Alias for validate.
'@
}

$Action = if ($args.Count -gt 0) { [string]$args[0] } else { 'validate' }
$ActionArgs = if ($args.Count -gt 1) { @($args[1..($args.Count - 1)]) } else { @() }

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
  'install-heartbeat' {
    Invoke-WmuxHelper 'wmux-heartbeat-service' @('install')
  }
  'heartbeat-status' {
    Invoke-WmuxHelper 'wmux-heartbeat-service' @('status')
  }
  'heartbeat-logs' {
    Invoke-WmuxHelper 'wmux-heartbeat-service' @('logs')
  }
  'install-stream' {
    Invoke-WmuxHelper 'wmux-stream-agent-service' @('install')
  }
  'stream-status' {
    Invoke-WmuxHelper 'wmux-stream-agent-service' @('status')
  }
  'install-agent' {
    Invoke-WmuxHelper 'wmux-windows-agent-service' @('install')
    $Firewall = Get-WindowsAgentFirewallReport
    if (-not $Firewall.configured) {
      Write-Warning "Windows agent rollouts require inbound TCP $($Firewall.expectedLocalPort). From an elevated shell, run: wmux-windows-setup configure-agent-firewall <wmux-server-internal-ip>"
    }
  }
  'configure-agent-firewall' {
    Set-WindowsAgentFirewall $ActionArgs
  }
  'agent-firewall-status' {
    Get-WindowsAgentFirewallReport | ConvertTo-Json -Depth 6
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
