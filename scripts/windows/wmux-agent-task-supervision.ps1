# Crash-supervision policy for wmux Windows agent Scheduled Tasks.
# wmux-windows-agent-service and wmux-windows-setup dot-source this file, and
# the wmux server embeds it in its SSH health probe, so it must stay a
# side-effect-free function definition.
function Get-WmuxAgentTaskSupervision {
  param($Task)
  if (-not $Task) {
    return [ordered]@{ supervised = $false; issues = @('missing') }
  }
  $Issues = @()
  $Triggers = @($Task.Triggers | Where-Object { $_ -and $_.Enabled -ne $false })
  if (-not ($Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' })) {
    $Issues += 'no-logon-trigger'
  }
  # The once-per-minute trigger is what restarts an agent that exits or is
  # killed; IgnoreNew makes it a no-op while the agent is still running.
  $RestartTriggers = $Triggers | Where-Object {
    $_.Repetition -and
    [string]$_.Repetition.Interval -eq 'PT1M' -and
    -not [string]$_.Repetition.Duration -and
    -not [string]$_.EndBoundary
  }
  if (-not $RestartTriggers) { $Issues += 'no-restart-trigger' }
  $Settings = $Task.Settings
  if ([string]$Settings.MultipleInstances -ne 'IgnoreNew') { $Issues += 'multiple-instances' }
  if ([string]$Settings.ExecutionTimeLimit -ne 'PT0S') { $Issues += 'execution-time-limit' }
  if ([int]$Settings.Priority -ne 4) { $Issues += "priority-$([int]$Settings.Priority)" }
  return [ordered]@{ supervised = ($Issues.Count -eq 0); issues = $Issues }
}
