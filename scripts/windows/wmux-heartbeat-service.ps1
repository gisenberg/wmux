$ErrorActionPreference = 'Stop'

$ActionName = if ($args.Count -gt 0) { [string]$args[0] } else { 'install' }
$TaskName = if ($env:WMUX_HEARTBEAT_TASK) { $env:WMUX_HEARTBEAT_TASK } else { 'wmux-heartbeat' }
$StateDir = if ($env:WMUX_STATE_DIR) { $env:WMUX_STATE_DIR } else { Join-Path $HOME '.wmux' }
$LogDir = Join-Path $StateDir 'logs'
$HelperDir = if ($env:WMUX_HELPER_DIR) { $env:WMUX_HELPER_DIR } else { Join-Path $env:LOCALAPPDATA 'wmux\bin' }
$Heartbeat = Join-Path $HelperDir 'wmux-heartbeat.ps1'
$Wrapper = Join-Path $HelperDir 'wmux-heartbeat-task.ps1'
$OutLog = Join-Path $LogDir 'heartbeat.out.log'
$ErrLog = Join-Path $LogDir 'heartbeat.err.log'

function ConvertTo-PowerShellLiteral {
  param([string]$Value)
  return "'$($Value -replace "'", "''")'"
}

function Write-Wrapper {
  New-Item -ItemType Directory -Force -Path $StateDir, $LogDir, $HelperDir | Out-Null
  $HeartbeatLiteral = ConvertTo-PowerShellLiteral $Heartbeat
  $StateDirLiteral = ConvertTo-PowerShellLiteral $StateDir
  $OutLogLiteral = ConvertTo-PowerShellLiteral $OutLog
  $ErrLogLiteral = ConvertTo-PowerShellLiteral $ErrLog
  $Content = @"
`$ErrorActionPreference = 'Continue'
& $HeartbeatLiteral -StateDir $StateDirLiteral 1>> $OutLogLiteral 2>> $ErrLogLiteral
exit `$LASTEXITCODE
"@
  [System.IO.File]::WriteAllText($Wrapper, $Content, [System.Text.UTF8Encoding]::new($false))
}

function New-HiddenPowerShellAction {
  $PowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (-not (Test-Path -LiteralPath $PowerShell -PathType Leaf)) {
    $PowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
  }
  $QuotedWrapper = '"' + ($Wrapper -replace '"', '\"') + '"'
  New-ScheduledTaskAction `
    -Execute $PowerShell `
    -Argument "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File $QuotedWrapper"
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

function Assert-HeartbeatState {
  if (-not (Test-Path -LiteralPath $Heartbeat -PathType Leaf)) {
    Write-Error "wmux-heartbeat was not found at $Heartbeat"
    exit 127
  }
  foreach ($Name in @('heartbeat.json', 'registration-token', 'url')) {
    $Path = Join-Path $StateDir $Name
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
      Write-Error "missing $Path; provision it before installing the task"
      exit 1
    }
  }
}

function Show-Usage {
  Write-Error 'usage: wmux-heartbeat-service [install|restart|stop|uninstall|status|logs]'
}

switch ($ActionName) {
  'install' {
    Assert-HeartbeatState
    Write-Wrapper
    $TaskAction = New-HiddenPowerShellAction
    $TaskTrigger = New-ScheduledTaskTrigger -AtLogOn
    $TaskPrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
    $TaskSettings = New-WmuxTaskSettings
    $Task = New-ScheduledTask -Action $TaskAction -Trigger $TaskTrigger -Principal $TaskPrincipal -Settings $TaskSettings
    Register-ScheduledTask -TaskName $TaskName -InputObject $Task -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Write-Output "Installed $TaskName"
    Write-Output "Logs: $OutLog and $ErrLog"
  }
  'restart' {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $TaskName
  }
  'stop' {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  }
  'uninstall' {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "Uninstalled $TaskName"
  }
  'status' {
    Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Format-List *
    Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue | Format-List *
  }
  'logs' {
    if (Test-Path -LiteralPath $OutLog) { Get-Content -LiteralPath $OutLog -Tail 120 }
    if (Test-Path -LiteralPath $ErrLog) { Get-Content -LiteralPath $ErrLog -Tail 120 }
  }
  default {
    Show-Usage
    exit 2
  }
}
