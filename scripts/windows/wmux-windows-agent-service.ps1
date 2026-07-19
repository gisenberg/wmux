$ErrorActionPreference = 'Stop'

$ActionName = if ($args.Count -gt 0) { [string]$args[0] } else { 'install' }
$TaskName = if ($env:WMUX_WINDOWS_AGENT_TASK) { $env:WMUX_WINDOWS_AGENT_TASK } else { 'wmux-windows-agent' }
$StateDir = Join-Path $HOME '.wmux'
$LogDir = Join-Path $StateDir 'logs'
$Config = if ($env:WMUX_WINDOWS_AGENT_CONFIG) { $env:WMUX_WINDOWS_AGENT_CONFIG } else { Join-Path $StateDir 'windows-agent.json' }
$HelperDir = if ($env:WMUX_HELPER_DIR) { $env:WMUX_HELPER_DIR } else { Join-Path $env:LOCALAPPDATA 'wmux\bin' }
$Agent = Join-Path $HelperDir 'wmux-windows-agent.py'
$Wrapper = Join-Path $HelperDir 'wmux-windows-agent-task.ps1'
$RestartTaskName = "$TaskName-update"
$OutLog = Join-Path $LogDir 'windows-agent.out.log'
$ErrLog = Join-Path $LogDir 'windows-agent.err.log'
$LegacyHeartbeatTaskName = if ($env:WMUX_HEARTBEAT_TASK) { $env:WMUX_HEARTBEAT_TASK } else { 'wmux-heartbeat' }
$Force = @($args) -contains '--force'
$GenerationPort = 0
for ($Index = 0; $Index -lt $args.Count - 1; $Index += 1) {
  if ([string]$args[$Index] -eq '--port') { $GenerationPort = [int]$args[$Index + 1] }
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
    [string]$TargetWrapper = $Wrapper
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
  $Content = @"
`$ErrorActionPreference = 'Continue'
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

function Get-AgentLogonType {
  if ($env:WMUX_WINDOWS_AGENT_LOGON_TYPE) {
    if ($env:WMUX_WINDOWS_AGENT_LOGON_TYPE -notin @('Interactive', 'S4U')) {
      Write-Error 'WMUX_WINDOWS_AGENT_LOGON_TYPE must be Interactive or S4U.'
      exit 2
    }
    return $env:WMUX_WINDOWS_AGENT_LOGON_TYPE
  }
  $InteractiveUser = (Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue).UserName
  if ($InteractiveUser) { return 'Interactive' }
  return 'S4U'
}

function Show-Usage {
  Write-Error 'usage: wmux-windows-agent-service [install|rollout-update --port PORT|retire-generation --port PORT|activate-update|cancel-update|restart [--force]|stop|uninstall|status|logs|diagnose]'
}

function Start-AgentGeneration {
  param([int]$Port)
  if ($Port -lt 1 -or $Port -gt 65535) { throw 'rollout-update requires a valid --port' }
  $GenerationTaskName = "$TaskName-$Port"
  $GenerationConfig = Join-Path $StateDir "windows-agent-$Port.json"
  $GenerationWrapper = Join-Path $HelperDir "wmux-windows-agent-task-$Port.ps1"
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
  [System.IO.File]::WriteAllText(
    $GenerationConfig,
    ($Document | ConvertTo-Json -Depth 20),
    [System.Text.UTF8Encoding]::new($false)
  )
  Write-Wrapper -TargetConfig $GenerationConfig -TargetWrapper $GenerationWrapper

  $ExistingTask = Get-ScheduledTask -TaskName $GenerationTaskName -ErrorAction SilentlyContinue
  if ($ExistingTask) {
    Stop-ScheduledTask -TaskName $GenerationTaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $GenerationTaskName -Confirm:$false -ErrorAction SilentlyContinue
    Get-CimInstance Win32_Process |
      Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -like "*$GenerationConfig*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }

  $MainTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $GenerationAction = New-HiddenPowerShellAction -ScriptPath $GenerationWrapper
  $GenerationTrigger = New-WmuxTaskTriggers
  $GenerationSettings = New-WmuxTaskSettings
  $GenerationTask = New-ScheduledTask -Action $GenerationAction -Trigger $GenerationTrigger -Principal $MainTask.Principal -Settings $GenerationSettings
  Register-ScheduledTask -TaskName $GenerationTaskName -InputObject $GenerationTask -Force | Out-Null
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
  if (-not (Test-Path -LiteralPath $GenerationConfig -PathType Leaf)) {
    if ($GenerationTask) { throw "refusing to retire generation $Port without its health configuration" }
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
    Unregister-ScheduledTask -TaskName $GenerationTaskName -Confirm:$false -ErrorAction Stop
  }
  $AgentPid = if ($Health.pid) { [int]$Health.pid } else { 0 }
  if ($AgentPid -gt 0 -and $AgentPid -ne $PID) {
    Stop-Process -Id $AgentPid -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $GenerationConfig -Force
  Remove-Item -LiteralPath $GenerationWrapper -Force -ErrorAction SilentlyContinue
  [pscustomobject]@{ port = $Port; retired = $true; activeSessions = 0 } | ConvertTo-Json -Compress
}

function Start-UpdateRestartWatcher {
  # This task is deliberately outside the agent process. Current agents own an
  # atomic update-pending state; legacy agents are polled until idle before the
  # watcher requests their hard drain. In both cases, the watcher restarts the
  # main task only after the old process exits.
  $ExistingWatcher = Get-ScheduledTask -TaskName $RestartTaskName -ErrorAction SilentlyContinue
  if ($ExistingWatcher) {
    Stop-ScheduledTask -TaskName $RestartTaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $RestartTaskName -Confirm:$false -ErrorAction SilentlyContinue
  }
  $RestartScript = Join-Path $HelperDir 'wmux-windows-agent-update.ps1'
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
  $MainTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $RestartAction = New-HiddenPowerShellAction -ScriptPath $RestartScript
  $RestartSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew
  $RestartTask = New-ScheduledTask -Action $RestartAction -Principal $MainTask.Principal -Settings $RestartSettings
  Register-ScheduledTask -TaskName $RestartTaskName -InputObject $RestartTask -Force | Out-Null
  Start-ScheduledTask -TaskName $RestartTaskName
}

switch ($ActionName) {
  'install' {
    if (-not (Test-Path -LiteralPath $Agent -PathType Leaf)) {
      Write-Error "wmux-windows-agent was not found at $Agent"
      exit 127
    }
    Write-Wrapper
    $TaskAction = New-HiddenPowerShellAction
    $TaskTrigger = New-WmuxTaskTriggers
    $Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $LogonType = Get-AgentLogonType
    $TaskPrincipal = New-ScheduledTaskPrincipal -UserId $Identity -LogonType $LogonType
    $TaskSettings = New-WmuxTaskSettings
    $Task = New-ScheduledTask -Action $TaskAction -Trigger $TaskTrigger -Principal $TaskPrincipal -Settings $TaskSettings
    Register-ScheduledTask -TaskName $TaskName -InputObject $Task -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Write-Output "Installed $TaskName"
    Write-Output "Logon type: $LogonType"
    Write-Output "Logs: $LogDir"
    Write-HeartbeatConfigurationStatus
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
    $RestartScript = Join-Path $HelperDir 'wmux-windows-agent-restart.ps1'
    $Sequence = @"
Stop-ScheduledTask -TaskName '$($TaskName -replace "'", "''")' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process |
  Where-Object { `$_.ProcessId -ne `$PID -and `$_.CommandLine -and `$_.CommandLine -like '*wmux-windows-agent.py*' } |
  ForEach-Object { Stop-Process -Id `$_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1
Start-ScheduledTask -TaskName '$($TaskName -replace "'", "''")'
"@
    [System.IO.File]::WriteAllText($RestartScript, $Sequence, [System.Text.UTF8Encoding]::new($false))
    $MainTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $RestartAction = New-HiddenPowerShellAction -ScriptPath $RestartScript
    $RestartSettings = New-ScheduledTaskSettingsSet `
      -AllowStartIfOnBatteries `
      -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
      -MultipleInstances IgnoreNew
    $RestartTask = New-ScheduledTask -Action $RestartAction -Principal $MainTask.Principal -Settings $RestartSettings
    Register-ScheduledTask -TaskName $RestartTaskName -InputObject $RestartTask -Force | Out-Null
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
      Unregister-ScheduledTask -TaskName $RestartTaskName -Confirm:$false -ErrorAction SilentlyContinue
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
    Unregister-ScheduledTask -TaskName $RestartTaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "Drain cancelled; active pane sessions: $(Get-ActiveSessionCount $Drain)"
  }
  'stop' {
    Remove-LegacyHeartbeatTask
    Stop-ScheduledTask -TaskName $RestartTaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $RestartTaskName -Confirm:$false -ErrorAction SilentlyContinue
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
    Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Format-List *
    Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue | Format-List *
    try {
      Invoke-AgentRequest -Method GET -Path '/health' | Select-Object version, releaseVersion, protocolVersion, backend, processTree, activeSessions, draining, restartWhenIdle, heartbeat | Format-List
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
