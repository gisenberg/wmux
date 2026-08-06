$ErrorActionPreference = 'Stop'

$ActionName = if ($args.Count -gt 0) { [string]$args[0] } else { 'install' }
$TaskName = if ($env:WMUX_WINDOWS_AGENT_TASK) { $env:WMUX_WINDOWS_AGENT_TASK } else { 'wmux-windows-agent' }
$StateDir = if ($env:WMUX_WINDOWS_AGENT_STATE_DIR) { $env:WMUX_WINDOWS_AGENT_STATE_DIR } else { Join-Path $HOME '.wmux' }
$LogDir = Join-Path $StateDir 'logs'
$Config = if ($env:WMUX_WINDOWS_AGENT_CONFIG) { $env:WMUX_WINDOWS_AGENT_CONFIG } else { Join-Path $StateDir 'windows-agent.json' }
$HelperDir = if ($env:WMUX_HELPER_DIR) { $env:WMUX_HELPER_DIR } else { Join-Path $env:LOCALAPPDATA 'wmux\bin' }
$Agent = Join-Path $HelperDir 'wmux-windows-agent.py'
$Wrapper = Join-Path $HelperDir 'wmux-windows-agent-task.ps1'
$RestartTaskName = "$TaskName-update"
$SupervisorWrapper = Join-Path $HelperDir 'wmux-windows-agent-supervisor.ps1'
$OutLog = Join-Path $LogDir 'windows-agent.out.log'
$ErrLog = Join-Path $LogDir 'windows-agent.err.log'
$LegacyHeartbeatTaskName = if ($env:WMUX_HEARTBEAT_TASK) { $env:WMUX_HEARTBEAT_TASK } else { 'wmux-heartbeat' }
$LegacyStreamTaskName = if ($env:WMUX_STREAM_AGENT_TASK) { $env:WMUX_STREAM_AGENT_TASK } else { 'wmux-stream-agent' }
$Force = @($args) -contains '--force'
$GenerationPort = 0
$RequestedLogonType = ''
$ExpectedRelease = ''
$ExpectedProtocol = 0
$ExpectedHelpers = ''
$LockHoldMs = 0
$LockTracePath = ''
if (@($args | Where-Object { [string]$_ -like '--password*' }).Count -gt 0) {
  Write-Error 'Passwords must be entered at the private interactive prompt; --password is not supported.'
  exit 2
}
for ($Index = 0; $Index -lt $args.Count - 1; $Index += 1) {
  if ([string]$args[$Index] -eq '--port') { $GenerationPort = [int]$args[$Index + 1] }
  if ([string]$args[$Index] -eq '--logon-type') { $RequestedLogonType = [string]$args[$Index + 1] }
  if ([string]$args[$Index] -eq '--expected-release') { $ExpectedRelease = [string]$args[$Index + 1] }
  if ([string]$args[$Index] -eq '--expected-protocol') { $ExpectedProtocol = [int]$args[$Index + 1] }
  if ([string]$args[$Index] -eq '--expected-helpers') { $ExpectedHelpers = [string]$args[$Index + 1] }
  if ([string]$args[$Index] -eq '--hold-ms') { $LockHoldMs = [int]$args[$Index + 1] }
  if ([string]$args[$Index] -eq '--trace') { $LockTracePath = [string]$args[$Index + 1] }
}

function ConvertTo-PowerShellLiteral {
  param([string]$Value)
  return "'$($Value -replace "'", "''")'"
}

function ConvertTo-CmdArgument {
  param([string]$Value)
  return '"' + ($Value -replace '"', '\"') + '"'
}

function Get-PythonLaunch {
  $Py = Get-Command py.exe -ErrorAction SilentlyContinue
  if ($Py) {
    return [ordered]@{
      exe = [string]$Py.Source
      prefix = '-3 '
    }
  }
  $Python = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($Python) {
    return [ordered]@{
      exe = [string]$Python.Source
      prefix = ''
    }
  }
  return $null
}

function Write-Wrapper {
  param(
    [string]$TargetConfig = $Config,
    [string]$TargetWrapper = $Wrapper,
    [switch]$RequireConfig
  )
  New-Item -ItemType Directory -Force -Path $StateDir, $LogDir, $HelperDir | Out-Null
  $Python = Get-PythonLaunch
  if (-not $Python) {
    Write-Error 'Python was not found. Run wmux-windows-setup install-deps, then retry install-agent.'
    exit 127
  }
  $HelperDirLiteral = ConvertTo-PowerShellLiteral $HelperDir
  $LogDirLiteral = ConvertTo-PowerShellLiteral $LogDir
  $PythonArgText = $Python.prefix.Trim()
  $PythonArgs = @()
  if ($PythonArgText) { $PythonArgs += $PythonArgText }
  $CommandParts = @(
    (ConvertTo-CmdArgument $Python.exe)
  )
  $CommandParts += $PythonArgs
  $CommandParts += @(
    (ConvertTo-CmdArgument $Agent)
    '--config'
    (ConvertTo-CmdArgument $TargetConfig)
    '>>'
    '"%WMUX_AGENT_OUT%"'
    '2>>'
    '"%WMUX_AGENT_ERR%"'
  )
  $Command = $CommandParts -join ' '
  $CommandLiteral = ConvertTo-PowerShellLiteral $Command
  $ConfigGuard = if ($RequireConfig) {
    "if (-not (Test-Path -LiteralPath $(ConvertTo-PowerShellLiteral $TargetConfig) -PathType Leaf)) { exit 0 }"
  } else {
    ''
  }
  $Content = @"
`$ErrorActionPreference = 'Continue'
$ConfigGuard
`$env:PATH = $HelperDirLiteral + ';' + `$env:PATH
`$env:WMUX_AGENT_RUN = "`$(Get-Random)-`$(Get-Random)"
`$env:WMUX_AGENT_OUT = Join-Path $LogDirLiteral "windows-agent-`$(`$env:WMUX_AGENT_RUN).out.log"
`$env:WMUX_AGENT_ERR = Join-Path $LogDirLiteral "windows-agent-`$(`$env:WMUX_AGENT_RUN).err.log"
`$Command = $CommandLiteral
& `$env:ComSpec /d /s /c `$Command
exit `$LASTEXITCODE
"@
  [System.IO.File]::WriteAllText($TargetWrapper, $Content, [System.Text.UTF8Encoding]::new($false))
}

function New-HiddenPowerShellAction {
  param([string]$ScriptPath = $Wrapper)
  $PowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (-not (Test-Path -LiteralPath $PowerShell -PathType Leaf)) {
    $PowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
  }
  $QuotedScript = '"' + ($ScriptPath -replace '"', '\"') + '"'
  New-ScheduledTaskAction `
    -Execute $PowerShell `
    -Argument "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File $QuotedScript"
}

function Stop-AgentProcesses {
  Get-CimInstance Win32_Process |
    Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -like '*wmux-windows-agent.py*' } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Remove-LegacyHeartbeatTask {
  Stop-ScheduledTask -TaskName $LegacyHeartbeatTaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $LegacyHeartbeatTaskName -Confirm:$false -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.ProcessId -ne $PID -and
      $_.CommandLine -and
      $_.CommandLine -like '*wmux-heartbeat*.ps1*'
    } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Remove-LegacyStreamTask {
  Stop-ScheduledTask -TaskName $LegacyStreamTaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $LegacyStreamTaskName -Confirm:$false -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.ProcessId -ne $PID -and
      $_.CommandLine -and
      $_.CommandLine -like '*wmux-stream-agent.py*' -and
      $_.CommandLine -notlike '*wmux-windows-agent.py*'
    } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Write-HeartbeatConfigurationStatus {
  $Document = if (Test-Path -LiteralPath $Config -PathType Leaf) {
    Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
  } else {
    [pscustomobject]@{}
  }
  if ($Document.PSObject.Properties.Name -contains 'heartbeatEnabled' -and $Document.heartbeatEnabled -eq $false) {
    Write-Output 'Registration heartbeat disabled in windows-agent.json'
    return
  }
  $Missing = @('url', 'registration-token', 'heartbeat.json') |
    Where-Object { -not (Test-Path -LiteralPath (Join-Path $StateDir $_) -PathType Leaf) }
  if ($Missing.Count -gt 0) {
    Write-Warning "Agent installed, but registration heartbeat is waiting for: $($Missing -join ', ')"
  } else {
    Write-Output 'Registration heartbeat is managed by the Windows agent'
  }
}

function Get-AgentEndpoint {
  $Document = if (Test-Path -LiteralPath $Config -PathType Leaf) {
    Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
  } else {
    [pscustomobject]@{}
  }
  $HostValue = if ($Document.host) { [string]$Document.host } else { '127.0.0.1' }
  if ($HostValue -in @('0.0.0.0', '::')) { $HostValue = '127.0.0.1' }
  $PortValue = if ($Document.port) { [int]$Document.port } else { 3481 }
  [pscustomobject]@{
    url = "http://${HostValue}:$PortValue"
    token = if ($Document.token) { [string]$Document.token } elseif ($env:WMUX_AGENT_TOKEN) { $env:WMUX_AGENT_TOKEN } else { '' }
  }
}

function Invoke-AgentRequest {
  param(
    [ValidateSet('GET', 'POST', 'DELETE')][string]$Method,
    [string]$Path,
    [hashtable]$Body
  )
  $Endpoint = Get-AgentEndpoint
  $Headers = @{}
  if ($Endpoint.token) { $Headers.Authorization = "Bearer $($Endpoint.token)" }
  $Arguments = @{
    Method = $Method
    Uri = "$($Endpoint.url)$Path"
    Headers = $Headers
    TimeoutSec = 5
  }
  if ($Body) {
    $Arguments.ContentType = 'application/json'
    $Arguments.Body = $Body | ConvertTo-Json -Compress
  }
  Invoke-RestMethod @Arguments
}

function Get-ActiveSessionCount {
  param($Health)
  if ($null -ne $Health.activeSessions) { return [int]$Health.activeSessions }
  if ($null -ne $Health.sessions) { return [int]$Health.sessions }
  return 0
}

function New-WmuxTaskSettings {
  New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew
}

function New-WmuxTaskTriggers {
  $Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  @(
    New-ScheduledTaskTrigger -AtLogOn -User $Identity
    New-ScheduledTaskTrigger `
      -Once `
      -At (Get-Date).AddMinutes(1) `
      -RepetitionInterval (New-TimeSpan -Minutes 1)
  )
}

function Get-AgentGenerationTasks {
  $GenerationPattern = '^' + [regex]::Escape($TaskName) + '-\d+$'
  @(Get-ScheduledTask -TaskName "$TaskName-*" -ErrorAction SilentlyContinue |
    Where-Object { $_.TaskName -match $GenerationPattern })
}

function Get-AgentBasePort {
  $Document = if (Test-Path -LiteralPath $Config -PathType Leaf) {
    Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
  } else {
    [pscustomobject]@{}
  }
  if ($Document.port) { return [int]$Document.port }
  return 3481
}

function Get-TaskLogonType {
  param([string]$Name = $TaskName)
  $Task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  if (-not $Task) { return '' }
  return [string]$Task.Principal.LogonType
}

function Test-PasswordTaskPool {
  return ((Get-TaskLogonType) -eq 'Password')
}

function Get-AgentLogonType {
  $Value = if ($RequestedLogonType) {
    $RequestedLogonType
  } elseif ($env:WMUX_WINDOWS_AGENT_LOGON_TYPE) {
    [string]$env:WMUX_WINDOWS_AGENT_LOGON_TYPE
  } else {
    ''
  }
  if ($Value) {
    switch ($Value.ToLowerInvariant()) {
      'interactive' { return 'Interactive' }
      's4u' { return 'S4U' }
      'password' { return 'Password' }
      default {
        Write-Error 'The Windows agent logon type must be Interactive, S4U, or Password.'
        exit 2
      }
    }
  }
  $InteractiveUser = (Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue).UserName
  if ($InteractiveUser) { return 'Interactive' }
  return 'S4U'
}

function Read-AgentTaskPassword {
  param([string]$Identity)
  if ($env:WMUX_WINDOWS_AGENT_PASSWORD) {
    throw 'WMUX_WINDOWS_AGENT_PASSWORD is not accepted; enter the password at the private interactive prompt.'
  }
  try {
    $SecurePassword = Read-Host "Enter the Windows password for $Identity" -AsSecureString
  } catch {
    throw 'Password logon mode requires an interactive private prompt. No password was read or stored.'
  }
  if (-not $SecurePassword -or $SecurePassword.Length -eq 0) {
    throw 'A non-empty Windows password is required for Password logon mode.'
  }
  $Credential = [System.Management.Automation.PSCredential]::new($Identity, $SecurePassword)
  return $Credential.GetNetworkCredential().Password
}

function Register-AgentTaskDefinition {
  param(
    [string]$Name,
    $Definition,
    [string]$Identity,
    [string]$LogonType,
    [AllowEmptyString()][string]$Password
  )
  if ($LogonType -eq 'Password') {
    Register-ScheduledTask -TaskName $Name -InputObject $Definition -User $Identity -Password $Password -Force | Out-Null
  } else {
    Register-ScheduledTask -TaskName $Name -InputObject $Definition -Force | Out-Null
  }
}

function Test-AgentTaskCredential {
  param([string]$Identity, [string]$Password)
  $CanaryName = "$TaskName-credential-check"
  $PowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $Action = New-ScheduledTaskAction -Execute $PowerShell -Argument '-NoLogo -NoProfile -NonInteractive -Command "exit 0"'
  $Principal = New-ScheduledTaskPrincipal -UserId $Identity -LogonType Password
  $Definition = New-ScheduledTask -Action $Action -Principal $Principal -Settings (New-WmuxTaskSettings)
  try {
    Register-AgentTaskDefinition -Name $CanaryName -Definition $Definition -Identity $Identity -LogonType Password -Password $Password
  } finally {
    Unregister-ScheduledTask -TaskName $CanaryName -Confirm:$false -ErrorAction SilentlyContinue
  }
}

function Get-AgentConfigSessionCount {
  param([string]$ConfigPath, [int]$Port)
  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { return 0 }
  try {
    $Document = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    $HostValue = if ($Document.host) { [string]$Document.host } else { '127.0.0.1' }
    if ($HostValue -in @('0.0.0.0', '::')) { $HostValue = '127.0.0.1' }
    $Headers = @{}
    if ($Document.token) { $Headers.Authorization = "Bearer $($Document.token)" }
    $Health = Invoke-RestMethod -Method GET -Uri "http://${HostValue}:$Port/health" -Headers $Headers -TimeoutSec 2
    return (Get-ActiveSessionCount $Health)
  } catch {
    return $null
  }
}

function Assert-AgentTaskPoolCanChange {
  $BasePort = Get-AgentBasePort
  $Candidates = @(
    [pscustomobject]@{ task = $TaskName; config = $Config; port = $BasePort }
  )
  for ($Offset = 1; $Offset -le 8; $Offset += 1) {
    $Port = $BasePort + $Offset
    $Candidates += [pscustomobject]@{
      task = "$TaskName-$Port"
      config = Join-Path $StateDir "windows-agent-$Port.json"
      port = $Port
    }
  }
  foreach ($Candidate in $Candidates) {
    $Task = Get-ScheduledTask -TaskName $Candidate.task -ErrorAction SilentlyContinue
    if (-not $Task) { continue }
    $Count = Get-AgentConfigSessionCount -ConfigPath $Candidate.config -Port $Candidate.port
    if ($null -eq $Count -and [string]$Task.State -eq 'Running' -and -not $Force) {
      throw "Cannot verify whether $($Candidate.task) owns live panes. Restore agent health or rerun with --force only if terminating its panes is acceptable."
    }
    if ($null -ne $Count -and $Count -gt 0 -and -not $Force) {
      throw "Refusing to replace the agent task pool while $($Candidate.task) owns $Count active pane session(s). Close them first or rerun with --force."
    }
  }
}

function Install-PasswordTaskPool {
  param([string]$Identity, [string]$Password)
  Test-AgentTaskCredential -Identity $Identity -Password $Password
  Stop-ScheduledTask -TaskName $RestartTaskName -ErrorAction SilentlyContinue
  $Principal = New-ScheduledTaskPrincipal -UserId $Identity -LogonType Password
  $Settings = New-WmuxTaskSettings
  $Triggers = New-WmuxTaskTriggers
  $BasePort = Get-AgentBasePort

  for ($Offset = 1; $Offset -le 8; $Offset += 1) {
    $Port = $BasePort + $Offset
    $GenerationTaskName = "$TaskName-$Port"
    $GenerationConfig = Join-Path $StateDir "windows-agent-$Port.json"
    $GenerationWrapper = Join-Path $HelperDir "wmux-windows-agent-task-$Port.ps1"
    Write-Wrapper -TargetConfig $GenerationConfig -TargetWrapper $GenerationWrapper -RequireConfig
    $Definition = New-ScheduledTask `
      -Action (New-HiddenPowerShellAction -ScriptPath $GenerationWrapper) `
      -Trigger $Triggers `
      -Principal $Principal `
      -Settings $Settings
    Register-AgentTaskDefinition -Name $GenerationTaskName -Definition $Definition -Identity $Identity -LogonType Password -Password $Password
    if (Test-Path -LiteralPath $GenerationConfig -PathType Leaf) {
      Enable-ScheduledTask -TaskName $GenerationTaskName | Out-Null
    } else {
      Disable-ScheduledTask -TaskName $GenerationTaskName | Out-Null
    }
  }

  if (-not (Test-Path -LiteralPath $SupervisorWrapper -PathType Leaf)) {
    [System.IO.File]::WriteAllText($SupervisorWrapper, "exit 0`r`n", [System.Text.UTF8Encoding]::new($false))
  }
  $SupervisorDefinition = New-ScheduledTask `
    -Action (New-HiddenPowerShellAction -ScriptPath $SupervisorWrapper) `
    -Principal $Principal `
    -Settings $Settings
  Register-AgentTaskDefinition -Name $RestartTaskName -Definition $SupervisorDefinition -Identity $Identity -LogonType Password -Password $Password
  Disable-ScheduledTask -TaskName $RestartTaskName | Out-Null

  $BaseDefinition = New-ScheduledTask `
    -Action (New-HiddenPowerShellAction) `
    -Trigger $Triggers `
    -Principal $Principal `
    -Settings $Settings
  Register-AgentTaskDefinition -Name $TaskName -Definition $BaseDefinition -Identity $Identity -LogonType Password -Password $Password
}

function Show-Usage {
  Write-Error 'usage: wmux-windows-agent-service [install [--logon-type Interactive|S4U|Password]|refresh-credentials|rollout-update --port PORT|retire-generation --port PORT|activate-update|cancel-update|restart [--force]|stop|uninstall|status|logs|diagnose]'
}

function Open-GenerationLock {
  param([int]$Port)
  [System.IO.Directory]::CreateDirectory($StateDir) | Out-Null
  $LockPath = Join-Path $StateDir "windows-agent-$Port.lock"
  $Deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    try {
      return [System.IO.File]::Open(
        $LockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
      )
    } catch [System.IO.IOException] {
      Start-Sleep -Milliseconds 50
    }
  } while ([DateTime]::UtcNow -lt $Deadline)
  throw "timed out waiting to reserve Windows agent generation $Port"
}

function Start-AgentGeneration {
  param([int]$Port)
  if ($Port -lt 1 -or $Port -gt 65535) { throw 'rollout-update requires a valid --port' }
  $GenerationTaskName = "$TaskName-$Port"
  $GenerationConfig = Join-Path $StateDir "windows-agent-$Port.json"
  $GenerationWrapper = Join-Path $HelperDir "wmux-windows-agent-task-$Port.ps1"
  $GenerationLock = Open-GenerationLock -Port $Port
  try {
  $PasswordPool = Test-PasswordTaskPool
  $ExistingTask = Get-ScheduledTask -TaskName $GenerationTaskName -ErrorAction SilentlyContinue
  if ($PasswordPool -and -not $ExistingTask) {
    throw "Password-backed rollout slot $GenerationTaskName is missing. Run wmux-windows-setup refresh-agent-credentials from an interactive shell."
  }
  if (Test-Path -LiteralPath $GenerationConfig -PathType Leaf) {
    $ExistingDocument = Get-Content -LiteralPath $GenerationConfig -Raw | ConvertFrom-Json
    $ExistingHost = if ($ExistingDocument.host) { [string]$ExistingDocument.host } else { '127.0.0.1' }
    if ($ExistingHost -in @('0.0.0.0', '::')) { $ExistingHost = '127.0.0.1' }
    $ExistingHeaders = @{}
    if ($ExistingDocument.token) { $ExistingHeaders.Authorization = "Bearer $($ExistingDocument.token)" }
    $ExistingHealthUrl = "http://${ExistingHost}:$Port/health"
    $ExistingDrainUrl = "http://${ExistingHost}:$Port/drain"
    try {
      $ExistingHealth = Invoke-RestMethod -Method GET -Uri $ExistingHealthUrl -Headers $ExistingHeaders -TimeoutSec 3
    } catch {
      if ($ExistingTask -and [string]$ExistingTask.State -eq 'Running') {
        throw "refusing to refresh generation $Port because its active sessions cannot be verified"
      }
      $ExistingHealth = $null
    }
    if ($ExistingHealth) {
      $ExistingRelease = if ($ExistingHealth.releaseVersion) { [string]$ExistingHealth.releaseVersion } else { [string]$ExistingHealth.version }
      $ExistingProtocol = if ($ExistingHealth.protocolVersion) { [int]$ExistingHealth.protocolVersion } else { 0 }
      $ExistingHelpers = [string]$ExistingHealth.helperBundleVersion
      if (
        $ExpectedRelease -and $ExpectedProtocol -gt 0 -and $ExpectedHelpers -and
        $ExistingHealth.ok -and
        $ExistingRelease -eq $ExpectedRelease -and
        $ExistingProtocol -ge $ExpectedProtocol -and
        $ExistingHelpers -eq $ExpectedHelpers
      ) {
        [pscustomobject]@{ port = $Port; releaseVersion = $ExistingRelease; protocolVersion = $ExistingProtocol; reused = $true } | ConvertTo-Json -Compress
        return
      }
      # Fence session creation under the same agent lock used by create. If a
      # create won after wmux observed idle, keep that generation intact.
      $Fence = Invoke-RestMethod `
        -Method POST `
        -Uri $ExistingDrainUrl `
        -Headers $ExistingHeaders `
        -ContentType 'application/json' `
        -Body (@{ restartWhenIdle = $false; allowNewSessions = $false } | ConvertTo-Json -Compress) `
        -TimeoutSec 3
      $ActiveSessions = Get-ActiveSessionCount $Fence
      if ($ActiveSessions -gt 0) {
        Invoke-RestMethod -Method DELETE -Uri $ExistingDrainUrl -Headers $ExistingHeaders -TimeoutSec 3 | Out-Null
        throw "generation_refresh_busy: generation $Port gained $ActiveSessions active pane session(s)"
      }
      # Creates cannot pass the hard fence, so a non-zero recheck always aborts.
      $FencedHealth = Invoke-RestMethod -Method GET -Uri $ExistingHealthUrl -Headers $ExistingHeaders -TimeoutSec 3
      $ActiveSessions = Get-ActiveSessionCount $FencedHealth
      if ($ActiveSessions -gt 0) {
        Invoke-RestMethod -Method DELETE -Uri $ExistingDrainUrl -Headers $ExistingHeaders -TimeoutSec 3 | Out-Null
        throw "generation_refresh_busy: generation $Port owns $ActiveSessions active pane session(s) after fencing"
      }
    }
  }
  $Document = if (Test-Path -LiteralPath $Config -PathType Leaf) {
    Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
  } else {
    [pscustomobject]@{}
  }
  $Document | Add-Member -NotePropertyName port -NotePropertyValue $Port -Force
  $Document | Add-Member -NotePropertyName helperDir -NotePropertyValue $HelperDir -Force
  # Only the base agent publishes presence. Side-by-side rollout generations
  # must not race the same registry record from adjacent callback ports.
  $Document | Add-Member -NotePropertyName heartbeatEnabled -NotePropertyValue $false -Force
  $Document | Add-Member -NotePropertyName heartbeatOwner -NotePropertyValue $false -Force
  $Document | Add-Member -NotePropertyName streamOwner -NotePropertyValue $false -Force
  [System.IO.File]::WriteAllText(
    $GenerationConfig,
    ($Document | ConvertTo-Json -Depth 20),
    [System.Text.UTF8Encoding]::new($false)
  )
  Write-Wrapper -TargetConfig $GenerationConfig -TargetWrapper $GenerationWrapper -RequireConfig

  if ($ExistingTask) {
    Stop-ScheduledTask -TaskName $GenerationTaskName -ErrorAction SilentlyContinue
    if (-not $PasswordPool) {
      Unregister-ScheduledTask -TaskName $GenerationTaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
    Get-CimInstance Win32_Process |
      Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -like "*$GenerationConfig*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }

  if ($PasswordPool) {
    Enable-ScheduledTask -TaskName $GenerationTaskName | Out-Null
  } else {
    $MainTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $GenerationAction = New-HiddenPowerShellAction -ScriptPath $GenerationWrapper
    $GenerationTrigger = New-WmuxTaskTriggers
    $GenerationSettings = New-WmuxTaskSettings
    $GenerationTask = New-ScheduledTask -Action $GenerationAction -Trigger $GenerationTrigger -Principal $MainTask.Principal -Settings $GenerationSettings
    Register-ScheduledTask -TaskName $GenerationTaskName -InputObject $GenerationTask -Force | Out-Null
  }
  Start-ScheduledTask -TaskName $GenerationTaskName

  $HostValue = if ($Document.host) { [string]$Document.host } else { '127.0.0.1' }
  if ($HostValue -in @('0.0.0.0', '::')) { $HostValue = '127.0.0.1' }
  $Headers = @{}
  if ($Document.token) { $Headers.Authorization = "Bearer $($Document.token)" }
  $HealthUrl = "http://${HostValue}:$Port/health"
  $Deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    try {
      $Health = Invoke-RestMethod -Method GET -Uri $HealthUrl -Headers $Headers -TimeoutSec 2
      if ($Health.ok) {
        [pscustomobject]@{ port = $Port; releaseVersion = $Health.releaseVersion; protocolVersion = $Health.protocolVersion } | ConvertTo-Json -Compress
        return
      }
    } catch {}
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $Deadline)
  throw "Windows agent generation on port $Port did not become healthy"
  } finally {
    $GenerationLock.Dispose()
  }
}

function Remove-AgentGeneration {
  param([int]$Port)
  $BaseDocument = if (Test-Path -LiteralPath $Config -PathType Leaf) {
    Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
  } else {
    [pscustomobject]@{}
  }
  $BasePort = if ($BaseDocument.port) { [int]$BaseDocument.port } else { 3481 }
  if ($Port -le $BasePort -or $Port -gt ($BasePort + 8)) {
    throw "retire-generation port must be within $($BasePort + 1)-$($BasePort + 8); the base agent cannot be retired"
  }

  $GenerationTaskName = "$TaskName-$Port"
  $GenerationConfig = Join-Path $StateDir "windows-agent-$Port.json"
  $GenerationWrapper = Join-Path $HelperDir "wmux-windows-agent-task-$Port.ps1"
  $GenerationTask = Get-ScheduledTask -TaskName $GenerationTaskName -ErrorAction SilentlyContinue
  $PasswordPool = Test-PasswordTaskPool
  if (-not (Test-Path -LiteralPath $GenerationConfig -PathType Leaf)) {
    if ($GenerationTask -and -not $PasswordPool) { throw "refusing to retire generation $Port without its health configuration" }
    [pscustomobject]@{ port = $Port; retired = $true; alreadyAbsent = $true } | ConvertTo-Json -Compress
    return
  }

  $Document = Get-Content -LiteralPath $GenerationConfig -Raw | ConvertFrom-Json
  $HostValue = if ($Document.host) { [string]$Document.host } else { '127.0.0.1' }
  if ($HostValue -in @('0.0.0.0', '::')) { $HostValue = '127.0.0.1' }
  $Headers = @{}
  if ($Document.token) { $Headers.Authorization = "Bearer $($Document.token)" }
  $HealthUrl = "http://${HostValue}:$Port/health"
  $DrainUrl = "http://${HostValue}:$Port/drain"
  $Health = Invoke-RestMethod -Method GET -Uri $HealthUrl -Headers $Headers -TimeoutSec 3
  $ActiveSessions = Get-ActiveSessionCount $Health
  if ($ActiveSessions -gt 0) {
    throw "refusing to retire generation $Port with $ActiveSessions active pane session(s)"
  }

  # Close the create/retire race in the agent before removing its supervisor.
  $Drain = Invoke-RestMethod `
    -Method POST `
    -Uri $DrainUrl `
    -Headers $Headers `
    -ContentType 'application/json' `
    -Body (@{ restartWhenIdle = $false; allowNewSessions = $false } | ConvertTo-Json -Compress) `
    -TimeoutSec 3
  $ActiveSessions = Get-ActiveSessionCount $Drain
  if ($ActiveSessions -gt 0) {
    Invoke-RestMethod -Method DELETE -Uri $DrainUrl -Headers $Headers -TimeoutSec 3 | Out-Null
    throw "refusing to retire generation $Port after $ActiveSessions pane session(s) became active"
  }

  if ($GenerationTask) {
    Disable-ScheduledTask -TaskName $GenerationTaskName -ErrorAction SilentlyContinue | Out-Null
    Stop-ScheduledTask -TaskName $GenerationTaskName -ErrorAction SilentlyContinue
    if (-not $PasswordPool) {
      Unregister-ScheduledTask -TaskName $GenerationTaskName -Confirm:$false -ErrorAction Stop
    }
  }
  $AgentPid = if ($Health.pid) { [int]$Health.pid } else { 0 }
  if ($AgentPid -gt 0 -and $AgentPid -ne $PID) {
    Stop-Process -Id $AgentPid -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $GenerationConfig -Force
  if (-not $PasswordPool) {
    Remove-Item -LiteralPath $GenerationWrapper -Force -ErrorAction SilentlyContinue
  }
  [pscustomobject]@{ port = $Port; retired = $true; activeSessions = 0 } | ConvertTo-Json -Compress
}

function Start-UpdateRestartWatcher {
  # This task is deliberately outside the agent process. Current agents own an
  # atomic update-pending state; legacy agents are polled until idle before the
  # watcher requests their hard drain. In both cases, the watcher restarts the
  # main task only after the old process exits.
  $PasswordPool = Test-PasswordTaskPool
  $ExistingWatcher = Get-ScheduledTask -TaskName $RestartTaskName -ErrorAction SilentlyContinue
  if ($ExistingWatcher) {
    Stop-ScheduledTask -TaskName $RestartTaskName -ErrorAction SilentlyContinue
    if (-not $PasswordPool) {
      Unregister-ScheduledTask -TaskName $RestartTaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
  }
  $RestartScript = if ($PasswordPool) {
    $SupervisorWrapper
  } else {
    Join-Path $HelperDir 'wmux-windows-agent-update.ps1'
  }
  $Sequence = @'
$ErrorActionPreference = 'Continue'
$ConfigPath = __WMUX_CONFIG_PATH__
$TaskName = __WMUX_TASK_NAME__

function Get-AgentEndpoint {
  $Document = if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
    Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  } else {
    [pscustomobject]@{}
  }
  $HostValue = if ($Document.host) { [string]$Document.host } else { '127.0.0.1' }
  if ($HostValue -in @('0.0.0.0', '::')) { $HostValue = '127.0.0.1' }
  $PortValue = if ($Document.port) { [int]$Document.port } else { 3481 }
  [pscustomobject]@{
    url = "http://${HostValue}:$PortValue"
    token = if ($Document.token) { [string]$Document.token } else { '' }
  }
}

function Invoke-AgentRequest {
  param([string]$Method, [string]$Path, [hashtable]$Body)
  $Endpoint = Get-AgentEndpoint
  $Headers = @{}
  if ($Endpoint.token) { $Headers.Authorization = "Bearer $($Endpoint.token)" }
  $Arguments = @{
    Method = $Method
    Uri = "$($Endpoint.url)$Path"
    Headers = $Headers
    TimeoutSec = 5
  }
  if ($Body) {
    $Arguments.ContentType = 'application/json'
    $Arguments.Body = $Body | ConvertTo-Json -Compress
  }
  Invoke-RestMethod @Arguments
}

while ($true) {
  $Main = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $Main) { exit 2 }
  if ([string]$Main.State -ne 'Running') {
    Start-ScheduledTask -TaskName $TaskName
    exit 0
  }
  try {
    $Health = Invoke-AgentRequest -Method GET -Path '/health'
    $SupportsPending = $Health.PSObject.Properties.Name -contains 'updatePending'
    $ActiveSessions = if ($null -ne $Health.activeSessions) { [int]$Health.activeSessions } else { [int]$Health.sessions }
    if ($SupportsPending) {
      if (-not $Health.updatePending -and -not $Health.draining) {
        Invoke-AgentRequest -Method POST -Path '/drain' -Body @{ restartWhenIdle = $true; allowNewSessions = $true } | Out-Null
      }
    } elseif ($ActiveSessions -eq 0 -and -not $Health.draining) {
      Invoke-AgentRequest -Method POST -Path '/drain' -Body @{ restartWhenIdle = $true } | Out-Null
    }
  } catch {}
  Start-Sleep -Seconds 1
}
'@
  $Sequence = $Sequence.Replace('__WMUX_CONFIG_PATH__', (ConvertTo-PowerShellLiteral $Config))
  $Sequence = $Sequence.Replace('__WMUX_TASK_NAME__', (ConvertTo-PowerShellLiteral $TaskName))
  [System.IO.File]::WriteAllText($RestartScript, $Sequence, [System.Text.UTF8Encoding]::new($false))
  if ($PasswordPool) {
    if (-not $ExistingWatcher) {
      throw "Password-backed update task $RestartTaskName is missing. Run wmux-windows-setup refresh-agent-credentials from an interactive shell."
    }
    Enable-ScheduledTask -TaskName $RestartTaskName | Out-Null
  } else {
    $MainTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $RestartAction = New-HiddenPowerShellAction -ScriptPath $RestartScript
    $RestartSettings = New-ScheduledTaskSettingsSet `
      -AllowStartIfOnBatteries `
      -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit ([TimeSpan]::Zero) `
      -MultipleInstances IgnoreNew
    $RestartTask = New-ScheduledTask -Action $RestartAction -Principal $MainTask.Principal -Settings $RestartSettings
    Register-ScheduledTask -TaskName $RestartTaskName -InputObject $RestartTask -Force | Out-Null
  }
  Start-ScheduledTask -TaskName $RestartTaskName
}

switch ($ActionName) {
  'generation-lock-test' {
    if ($env:WMUX_WINDOWS_AGENT_LOCK_TEST -ne '1') { throw 'generation-lock-test is disabled' }
    if ($GenerationPort -lt 1 -or $GenerationPort -gt 65535) { throw 'generation-lock-test requires --port' }
    if ($LockHoldMs -lt 1 -or $LockHoldMs -gt 5000) { throw 'generation-lock-test requires --hold-ms between 1 and 5000' }
    if (-not $LockTracePath) { throw 'generation-lock-test requires --trace' }
    $GenerationLock = Open-GenerationLock -Port $GenerationPort
    try {
      [System.IO.File]::AppendAllText($LockTracePath, "start|$PID|$([DateTime]::UtcNow.Ticks)`n")
      Start-Sleep -Milliseconds $LockHoldMs
      [System.IO.File]::AppendAllText($LockTracePath, "end|$PID|$([DateTime]::UtcNow.Ticks)`n")
    } finally {
      $GenerationLock.Dispose()
    }
  }
  'install' {
    if (-not (Test-Path -LiteralPath $Agent -PathType Leaf)) {
      Write-Error "wmux-windows-agent was not found at $Agent"
      exit 127
    }
    Remove-LegacyStreamTask
    Write-Wrapper
    $Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $LogonType = Get-AgentLogonType
    $ExistingLogonType = Get-TaskLogonType
    if ($LogonType -eq 'Password') {
      Assert-AgentTaskPoolCanChange
      $Password = Read-AgentTaskPassword -Identity $Identity
      try {
        Stop-AgentProcesses
        Install-PasswordTaskPool -Identity $Identity -Password $Password
      } finally {
        $Password = $null
      }
    } else {
      if ($ExistingLogonType -eq 'Password') {
        Assert-AgentTaskPoolCanChange
        Stop-AgentProcesses
        Stop-ScheduledTask -TaskName $RestartTaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $RestartTaskName -Confirm:$false -ErrorAction SilentlyContinue
        foreach ($GenerationTask in Get-AgentGenerationTasks) {
          Stop-ScheduledTask -TaskName $GenerationTask.TaskName -ErrorAction SilentlyContinue
          Unregister-ScheduledTask -TaskName $GenerationTask.TaskName -Confirm:$false -ErrorAction SilentlyContinue
        }
      }
      $TaskAction = New-HiddenPowerShellAction
      $TaskTrigger = New-WmuxTaskTriggers
      $TaskPrincipal = New-ScheduledTaskPrincipal -UserId $Identity -LogonType $LogonType
      $TaskSettings = New-WmuxTaskSettings
      $Task = New-ScheduledTask -Action $TaskAction -Trigger $TaskTrigger -Principal $TaskPrincipal -Settings $TaskSettings
      Register-ScheduledTask -TaskName $TaskName -InputObject $Task -Force | Out-Null
    }
    Enable-ScheduledTask -TaskName $TaskName | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    if ($LogonType -eq 'Password') {
      foreach ($GenerationTask in Get-AgentGenerationTasks) {
        $PortText = $GenerationTask.TaskName.Substring($TaskName.Length + 1)
        $GenerationConfig = Join-Path $StateDir "windows-agent-$PortText.json"
        if (Test-Path -LiteralPath $GenerationConfig -PathType Leaf) {
          Enable-ScheduledTask -TaskName $GenerationTask.TaskName | Out-Null
          Start-ScheduledTask -TaskName $GenerationTask.TaskName
        }
      }
    }
    Write-Output "Installed $TaskName"
    Write-Output "Logon type: $LogonType"
    if ($LogonType -eq 'Password') {
      Write-Output 'Password retained only by Windows Task Scheduler; use refresh-agent-credentials after the account password changes.'
    }
    Write-Output "Logs: $LogDir"
    Write-HeartbeatConfigurationStatus
  }
  'refresh-credentials' {
    if ((Get-TaskLogonType) -ne 'Password') {
      Write-Error 'refresh-credentials requires an existing Password-mode agent. Use install --logon-type Password to opt in.'
      exit 2
    }
    if (-not (Test-Path -LiteralPath $Agent -PathType Leaf)) {
      Write-Error "wmux-windows-agent was not found at $Agent"
      exit 127
    }
    Assert-AgentTaskPoolCanChange
    Write-Wrapper
    $Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $Password = Read-AgentTaskPassword -Identity $Identity
    try {
      Stop-AgentProcesses
      Install-PasswordTaskPool -Identity $Identity -Password $Password
    } finally {
      $Password = $null
    }
    Enable-ScheduledTask -TaskName $TaskName | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    foreach ($GenerationTask in Get-AgentGenerationTasks) {
      $PortText = $GenerationTask.TaskName.Substring($TaskName.Length + 1)
      $GenerationConfig = Join-Path $StateDir "windows-agent-$PortText.json"
      if (Test-Path -LiteralPath $GenerationConfig -PathType Leaf) {
        Enable-ScheduledTask -TaskName $GenerationTask.TaskName | Out-Null
        Start-ScheduledTask -TaskName $GenerationTask.TaskName
      }
    }
    Write-Output "Refreshed Task Scheduler credentials for $TaskName and its rollout slots."
  }
  'restart' {
    Enable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
    if (-not $Force) {
      $DrainStarted = $false
      try {
        $Health = Invoke-AgentRequest -Method POST -Path '/drain' -Body @{ restartWhenIdle = $false }
        $DrainStarted = $true
      } catch {
        $Health = Invoke-AgentRequest -Method GET -Path '/health'
      }
      $ActiveSessions = Get-ActiveSessionCount $Health
      if ($ActiveSessions -gt 0) {
        if ($DrainStarted) {
          try { Invoke-AgentRequest -Method DELETE -Path '/drain' | Out-Null } catch {}
        }
        Write-Error "Refusing to restart $TaskName with $ActiveSessions active pane session(s). Use activate-update to drain safely, or restart --force to terminate them."
        exit 3
      }
    }
    # Task Scheduler owns this launcher outside the agent's process tree. A
    # plain Start-Process child is still terminated with an agent-owned pane or
    # an OpenSSH session, which can leave the main task stopped and port dark.
    $PasswordPool = Test-PasswordTaskPool
    $RestartScript = if ($PasswordPool) {
      $SupervisorWrapper
    } else {
      Join-Path $HelperDir 'wmux-windows-agent-restart.ps1'
    }
    $Sequence = @"
Stop-ScheduledTask -TaskName '$($TaskName -replace "'", "''")' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process |
  Where-Object { `$_.ProcessId -ne `$PID -and `$_.CommandLine -and `$_.CommandLine -like '*wmux-windows-agent.py*' } |
  ForEach-Object { Stop-Process -Id `$_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1
Start-ScheduledTask -TaskName '$($TaskName -replace "'", "''")'
"@
    [System.IO.File]::WriteAllText($RestartScript, $Sequence, [System.Text.UTF8Encoding]::new($false))
    if ($PasswordPool) {
      if (-not (Get-ScheduledTask -TaskName $RestartTaskName -ErrorAction SilentlyContinue)) {
        throw "Password-backed restart task $RestartTaskName is missing. Run wmux-windows-setup refresh-agent-credentials from an interactive shell."
      }
      Enable-ScheduledTask -TaskName $RestartTaskName | Out-Null
    } else {
      $MainTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
      $RestartAction = New-HiddenPowerShellAction -ScriptPath $RestartScript
      $RestartSettings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
        -MultipleInstances IgnoreNew
      $RestartTask = New-ScheduledTask -Action $RestartAction -Principal $MainTask.Principal -Settings $RestartSettings
      Register-ScheduledTask -TaskName $RestartTaskName -InputObject $RestartTask -Force | Out-Null
    }
    Start-ScheduledTask -TaskName $RestartTaskName
    Write-Output "Restarting $TaskName through the independent $RestartTaskName task"
  }
  'activate-update' {
    $Health = Invoke-AgentRequest -Method GET -Path '/health'
    $SupportsPending = $Health.PSObject.Properties.Name -contains 'updatePending'
    $ActiveSessions = Get-ActiveSessionCount $Health
    if (-not $SupportsPending -and $Health.draining -and $ActiveSessions -gt 0) {
      $Health = Invoke-AgentRequest -Method DELETE -Path '/drain'
      $ActiveSessions = Get-ActiveSessionCount $Health
    }
    Start-UpdateRestartWatcher
    try {
      if ($SupportsPending) {
        $Drain = Invoke-AgentRequest -Method POST -Path '/drain' -Body @{ restartWhenIdle = $true; allowNewSessions = $true }
      } elseif ($ActiveSessions -eq 0) {
        $Drain = Invoke-AgentRequest -Method POST -Path '/drain' -Body @{ restartWhenIdle = $true }
      } else {
        $Drain = $Health
      }
    } catch {
      Stop-ScheduledTask -TaskName $RestartTaskName -ErrorAction SilentlyContinue
      if (Test-PasswordTaskPool) {
        Disable-ScheduledTask -TaskName $RestartTaskName -ErrorAction SilentlyContinue | Out-Null
      } else {
        Unregister-ScheduledTask -TaskName $RestartTaskName -Confirm:$false -ErrorAction SilentlyContinue
      }
      Write-Error "The running agent does not support safe drain activation. Stage the current helper, then restart --force only when losing active panes is acceptable. $($_.Exception.Message)"
      exit 4
    }
    $ActiveSessions = Get-ActiveSessionCount $Drain
    if ($ActiveSessions -gt 0) {
      Write-Output "Update staged; waiting for $ActiveSessions active pane session(s) to finish."
      Write-Output 'New panes remain available. The agent will restart automatically after the final pane closes.'
    } else {
      Write-Output 'Update staged; no active panes remain. Agent restart has been scheduled.'
    }
  }
  'rollout-update' {
    Start-AgentGeneration -Port $GenerationPort
  }
  'retire-generation' {
    Remove-AgentGeneration -Port $GenerationPort
  }
  'cancel-update' {
    $Drain = Invoke-AgentRequest -Method DELETE -Path '/drain'
    Stop-ScheduledTask -TaskName $RestartTaskName -ErrorAction SilentlyContinue
    if (Test-PasswordTaskPool) {
      Disable-ScheduledTask -TaskName $RestartTaskName -ErrorAction SilentlyContinue | Out-Null
    } else {
      Unregister-ScheduledTask -TaskName $RestartTaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
    Write-Output "Drain cancelled; active pane sessions: $(Get-ActiveSessionCount $Drain)"
  }
  'stop' {
    Remove-LegacyHeartbeatTask
    Stop-ScheduledTask -TaskName $RestartTaskName -ErrorAction SilentlyContinue
    if (Test-PasswordTaskPool) {
      Disable-ScheduledTask -TaskName $RestartTaskName -ErrorAction SilentlyContinue | Out-Null
    } else {
      Unregister-ScheduledTask -TaskName $RestartTaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
    Disable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
    foreach ($GenerationTask in Get-AgentGenerationTasks) {
      Disable-ScheduledTask -TaskName $GenerationTask.TaskName -ErrorAction SilentlyContinue | Out-Null
      Stop-ScheduledTask -TaskName $GenerationTask.TaskName -ErrorAction SilentlyContinue
    }
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Stop-AgentProcesses
  }
  'uninstall' {
    Remove-LegacyHeartbeatTask
    Stop-ScheduledTask -TaskName $RestartTaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $RestartTaskName -Confirm:$false -ErrorAction SilentlyContinue
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Stop-AgentProcesses
    foreach ($GenerationTask in Get-AgentGenerationTasks) {
      Unregister-ScheduledTask -TaskName $GenerationTask.TaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "Uninstalled $TaskName"
  }
  'status' {
    $MainTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $LogonType = [string]$MainTask.Principal.LogonType
    $BasePort = Get-AgentBasePort
    $ReadySlots = 0
    for ($Offset = 1; $Offset -le 8; $Offset += 1) {
      $SlotTask = Get-ScheduledTask -TaskName "$TaskName-$($BasePort + $Offset)" -ErrorAction SilentlyContinue
      if ($SlotTask -and [string]$SlotTask.Principal.LogonType -eq 'Password') {
        $ReadySlots += 1
      }
    }
    $UpdateTask = Get-ScheduledTask -TaskName $RestartTaskName -ErrorAction SilentlyContinue
    [pscustomobject]@{
      taskName = $TaskName
      state = [string]$MainTask.State
      userId = [string]$MainTask.Principal.UserId
      logonType = $LogonType
      startsWithoutLogin = $LogonType -in @('Password', 'S4U')
      networkCredentialsAvailable = $LogonType -eq 'Password'
      generationSlotsReady = if ($LogonType -eq 'Password') {
        $ReadySlots -eq 8 -and $UpdateTask -and [string]$UpdateTask.Principal.LogonType -eq 'Password'
      } else {
        $null
      }
    } | Format-List
    $MainTask | Format-List *
    Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue | Format-List *
    try {
      Invoke-AgentRequest -Method GET -Path '/health' | Select-Object version, releaseVersion, protocolVersion, backend, processTree, activeSessions, draining, restartWhenIdle, heartbeat, stream | Format-List
    } catch {
      Write-Warning "Agent health unavailable: $($_.Exception.Message)"
    }
  }
  'logs' {
    $Files = @()
    $Files += Get-Item -LiteralPath $OutLog, $ErrLog -ErrorAction SilentlyContinue
    $Files += Get-ChildItem -LiteralPath $LogDir -Filter 'windows-agent-*.out.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 2
    $Files += Get-ChildItem -LiteralPath $LogDir -Filter 'windows-agent-*.err.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 2
    foreach ($File in @($Files | Sort-Object FullName -Unique)) {
      Write-Output "--- $($File.FullName) ---"
      Get-Content -LiteralPath $File.FullName -Tail 120 -ErrorAction SilentlyContinue
    }
  }
  'diagnose' {
    Write-Output "task=$TaskName"
    Write-Output "agent=$Agent"
    Write-Output "wrapper=$Wrapper"
    Write-Output "supervisorWrapper=$SupervisorWrapper"
    Write-Output "config=$Config"
    Write-Output "logs=$LogDir"
    Write-Output '--- commands ---'
    Get-Command python.exe -ErrorAction SilentlyContinue
    Get-Command py.exe -ErrorAction SilentlyContinue
    Write-Output '--- task ---'
    Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Format-List *
    Write-Output '--- processes ---'
    Get-Process | Where-Object { $_.ProcessName -match 'python|py|pwsh' } | Select-Object Id, ProcessName, Path
    Write-Output '--- logs ---'
    & $PSCommandPath logs
  }
  default {
    Show-Usage
    exit 2
  }
}
