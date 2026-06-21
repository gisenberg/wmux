$ErrorActionPreference = 'Stop'

$ActionName = if ($args.Count -gt 0) { [string]$args[0] } else { 'install' }
$TaskName = if ($env:WMUX_WINDOWS_AGENT_TASK) { $env:WMUX_WINDOWS_AGENT_TASK } else { 'wmux-windows-agent' }
$StateDir = Join-Path $HOME '.wmux'
$LogDir = Join-Path $StateDir 'logs'
$Config = if ($env:WMUX_WINDOWS_AGENT_CONFIG) { $env:WMUX_WINDOWS_AGENT_CONFIG } else { Join-Path $StateDir 'windows-agent.json' }
$HelperDir = if ($env:WMUX_HELPER_DIR) { $env:WMUX_HELPER_DIR } else { Join-Path $env:LOCALAPPDATA 'wmux\bin' }
$Agent = Join-Path $HelperDir 'wmux-windows-agent.py'
$Wrapper = Join-Path $HelperDir 'wmux-windows-agent-task.cmd'
$OutLog = Join-Path $LogDir 'windows-agent.out.log'
$ErrLog = Join-Path $LogDir 'windows-agent.err.log'

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
  New-Item -ItemType Directory -Force -Path $StateDir, $LogDir, $HelperDir | Out-Null
  $Python = Get-PythonLaunch
  if (-not $Python) {
    Write-Error 'Python was not found. Run wmux-windows-setup install-deps, then retry install-agent.'
    exit 127
  }
  $Content = @"
@echo off
setlocal
set "PATH=$HelperDir;%PATH%"
set "WMUX_AGENT_RUN=%RANDOM%-%RANDOM%"
set "WMUX_AGENT_OUT=$LogDir\windows-agent-%WMUX_AGENT_RUN%.out.log"
set "WMUX_AGENT_ERR=$LogDir\windows-agent-%WMUX_AGENT_RUN%.err.log"
"$($Python.exe)" $($Python.prefix)"$Agent" --config "$Config" >> "%WMUX_AGENT_OUT%" 2>> "%WMUX_AGENT_ERR%"
exit /b %ERRORLEVEL%
"@
  [System.IO.File]::WriteAllText($Wrapper, $Content, [System.Text.UTF8Encoding]::new($false))
}

function Stop-AgentProcesses {
  Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*wmux-windows-agent.py*' } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Show-Usage {
  Write-Error 'usage: wmux-windows-agent-service [install|restart|stop|uninstall|status|logs|diagnose]'
}

switch ($ActionName) {
  'install' {
    if (-not (Test-Path -LiteralPath $Agent -PathType Leaf)) {
      Write-Error "wmux-windows-agent was not found at $Agent"
      exit 127
    }
    Write-Wrapper
    $TaskAction = New-ScheduledTaskAction -Execute $Wrapper
    $TaskTrigger = New-ScheduledTaskTrigger -AtLogOn
    $TaskPrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
    $Task = New-ScheduledTask -Action $TaskAction -Trigger $TaskTrigger -Principal $TaskPrincipal
    Register-ScheduledTask -TaskName $TaskName -InputObject $Task -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Write-Output "Installed $TaskName"
    Write-Output "Logs: $LogDir"
  }
  'restart' {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Stop-AgentProcesses
    Start-ScheduledTask -TaskName $TaskName
  }
  'stop' {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Stop-AgentProcesses
  }
  'uninstall' {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Stop-AgentProcesses
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "Uninstalled $TaskName"
  }
  'status' {
    Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Format-List *
    Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue | Format-List *
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
