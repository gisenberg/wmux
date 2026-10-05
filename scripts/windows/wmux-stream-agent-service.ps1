$ErrorActionPreference = 'Stop'

$ActionName = if ($args.Count -gt 0) { [string]$args[0] } else { 'install' }
$TaskName = if ($env:WMUX_STREAM_AGENT_TASK) { $env:WMUX_STREAM_AGENT_TASK } else { 'wmux-stream-agent' }
$StateDir = Join-Path $HOME '.wmux'
$LogDir = Join-Path $StateDir 'logs'
$Config = if ($env:WMUX_STREAM_AGENT_CONFIG) { $env:WMUX_STREAM_AGENT_CONFIG } else { Join-Path $StateDir 'stream-agent.json' }
$HelperDir = if ($env:WMUX_HELPER_DIR) { $env:WMUX_HELPER_DIR } else { Join-Path $env:LOCALAPPDATA 'wmux\bin' }
$Agent = Join-Path $HelperDir 'wmux-stream-agent.cmd'
$Wrapper = Join-Path $HelperDir 'wmux-stream-agent-task.ps1'
$OutLog = Join-Path $LogDir 'stream-agent.out.log'
$ErrLog = Join-Path $LogDir 'stream-agent.err.log'

function ConvertTo-PowerShellLiteral {
  param([string]$Value)
  return "'$($Value -replace "'", "''")'"
}

function ConvertTo-CmdArgument {
  param([string]$Value)
  return '"' + ($Value -replace '"', '\"') + '"'
}

function Write-Wrapper {
  New-Item -ItemType Directory -Force -Path $StateDir, $LogDir, $HelperDir | Out-Null
  $CommandParts = @(
    (ConvertTo-CmdArgument $Agent)
    '--config',
    (ConvertTo-CmdArgument $Config)
    '>>',
    (ConvertTo-CmdArgument $OutLog)
    '2>>',
    (ConvertTo-CmdArgument $ErrLog)
  )
  $Command = $CommandParts -join ' '
  $CommandLiteral = ConvertTo-PowerShellLiteral $Command
  $Content = @"
`$ErrorActionPreference = 'Continue'
`$Command = $CommandLiteral
& `$env:ComSpec /d /s /c `$Command
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
    -Priority 4 `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew
}

function Stop-StreamProcesses {
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.ProcessId -ne $PID -and
        $_.CommandLine -and
        ($_.CommandLine -like '*wmux-stream-agent.py*' -or $_.CommandLine -like '*wmux-stream-agent.cmd*')
    } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Show-Usage {
  Write-Error 'usage: wmux-stream-agent-service [install|restart|stop|uninstall|status|logs|diagnose]'
}

switch ($ActionName) {
  'install' {
    if (-not (Test-Path -LiteralPath $Agent -PathType Leaf)) {
      Write-Error "wmux-stream-agent was not found at $Agent"
      exit 127
    }
    Write-Wrapper
    $TaskAction = New-HiddenPowerShellAction
    $TaskTrigger = New-ScheduledTaskTrigger -AtLogOn
    $TaskPrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
    $TaskSettings = New-WmuxTaskSettings
    $Task = New-ScheduledTask -Action $TaskAction -Trigger $TaskTrigger -Principal $TaskPrincipal -Settings $TaskSettings
    Register-ScheduledTask -TaskName $TaskName -InputObject $Task -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Write-Output "Installed $TaskName"
    Write-Output "Logs:"
    Write-Output "  $OutLog"
    Write-Output "  $ErrLog"
  }
  'restart' {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Stop-StreamProcesses
    Start-ScheduledTask -TaskName $TaskName
  }
  'stop' {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Stop-StreamProcesses
  }
  'uninstall' {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Stop-StreamProcesses
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
  'diagnose' {
    Write-Output "task=$TaskName"
    Write-Output "agent=$Agent"
    Write-Output "wrapper=$Wrapper"
    Write-Output "config=$Config"
    Write-Output "logs=$LogDir"
    Write-Output '--- commands ---'
    Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
    Get-Command python.exe -ErrorAction SilentlyContinue
    Get-Command py.exe -ErrorAction SilentlyContinue
    Write-Output '--- task ---'
    Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Format-List *
    Write-Output '--- processes ---'
    Get-Process | Where-Object { $_.ProcessName -match 'ffmpeg|python|py|pwsh' } | Select-Object Id, ProcessName, Path
    Write-Output '--- logs ---'
    & $PSCommandPath logs
  }
  default {
    Show-Usage
    exit 2
  }
}
