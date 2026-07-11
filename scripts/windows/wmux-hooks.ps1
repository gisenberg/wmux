$ErrorActionPreference = 'Stop'

function Read-JsonFile([string]$PathValue) {
  if (-not (Test-Path -LiteralPath $PathValue -PathType Leaf)) {
    return [ordered]@{}
  }
  $Raw = Get-Content -LiteralPath $PathValue -Raw
  if (-not $Raw) { return [ordered]@{} }
  return $Raw | ConvertFrom-Json -AsHashtable
}

function Write-JsonFile([string]$PathValue, $Value) {
  $Directory = Split-Path -Parent $PathValue
  New-Item -ItemType Directory -Force -Path $Directory | Out-Null
  $Json = $Value | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($PathValue, $Json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
}

function Test-HookCommand($Items, [string]$Command, [string]$WindowsCommand = '') {
  if (-not $Items) { return $false }
  foreach ($Entry in $Items) {
    foreach ($Hook in @($Entry.hooks)) {
      if ($Hook.type -eq 'command' -and $Hook.command -eq $Command -and (-not $WindowsCommand -or $Hook.commandWindows -eq $WindowsCommand)) {
        return $true
      }
    }
  }
  return $false
}

function Set-HookCommand($Settings, [string]$EventName, [string]$Command, [hashtable]$Options, [string]$AgentName) {
  if (-not $Settings.Contains('hooks') -or $null -eq $Settings.hooks) {
    $Settings.hooks = [ordered]@{}
  }
  if (-not $Settings.hooks.Contains($EventName) -or $null -eq $Settings.hooks[$EventName]) {
    $Settings.hooks[$EventName] = @()
  }
  foreach ($Entry in @($Settings.hooks[$EventName])) {
    foreach ($Hook in @($Entry.hooks)) {
      $ExistingCommand = [string]$Hook.command
      $OwnedCommand = $Hook.type -eq 'command' -and $ExistingCommand -match 'wmux-agent-event\.(cmd|ps1)' -and $ExistingCommand -match "--agent\s+$AgentName(?:\s|$)"
      if ($ExistingCommand -eq $Command -or $OwnedCommand) {
        $Changed = $false
        if ($ExistingCommand -ne $Command) { $Hook.command = $Command; $Changed = $true }
        if ($Hook.timeout -ne 30) { $Hook.timeout = 30; $Changed = $true }
        foreach ($Key in $Options.Keys) {
          if ($Hook[$Key] -ne $Options[$Key]) { $Hook[$Key] = $Options[$Key]; $Changed = $true }
        }
        return $Changed
      }
    }
  }
  $Hook = [ordered]@{
    type = 'command'
    command = $Command
    timeout = 30
  }
  foreach ($Key in $Options.Keys) {
    $Hook[$Key] = $Options[$Key]
  }
  $Settings.hooks[$EventName] = @($Settings.hooks[$EventName]) + @([ordered]@{ hooks = @($Hook) })
  return $true
}

function Show-Usage {
  Write-Error @'
Usage:
  wmux-hooks install claude
  wmux-hooks install codex
  wmux-hooks status
'@
}

$Command = if ($args.Count -gt 0) { [string]$args[0] } else { '' }
$Target = if ($args.Count -gt 1) { [string]$args[1] } else { '' }
$HelperDir = if ($env:WMUX_HELPER_DIR) { $env:WMUX_HELPER_DIR } else { Join-Path $env:LOCALAPPDATA 'wmux\bin' }
$AgentEvent = Join-Path $HelperDir 'wmux-agent-event.cmd'
$AgentEventScript = Join-Path $HelperDir 'wmux-agent-event.ps1'
$ClaudeHookCommand = "`"$AgentEvent`" --agent claude --claude-hook"
$CodexHookCommand = "pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$AgentEventScript`" --agent codex --codex-hook"

if ($Command -eq 'install' -and $Target -eq 'claude') {
  $SettingsPath = Join-Path $HOME '.claude\settings.json'
  $Settings = Read-JsonFile $SettingsPath
  $Changed = @(
    Set-HookCommand $Settings 'UserPromptSubmit' $ClaudeHookCommand @{} 'claude'
    Set-HookCommand $Settings 'Stop' $ClaudeHookCommand @{} 'claude'
    Set-HookCommand $Settings 'Notification' $ClaudeHookCommand @{} 'claude'
  ) -contains $true
  if ($Changed) { Write-JsonFile $SettingsPath $Settings }
  Write-Output ("{0} Claude hooks in {1}" -f ($(if ($Changed) { 'Installed' } else { 'Already installed' })), $SettingsPath)
  Write-Output "Hook command: $ClaudeHookCommand"
  exit 0
}

if ($Command -eq 'install' -and $Target -eq 'codex') {
  $SettingsPath = Join-Path $HOME '.codex\hooks.json'
  $Settings = Read-JsonFile $SettingsPath
  $Changed = @(
    Set-HookCommand $Settings 'UserPromptSubmit' $CodexHookCommand @{ commandWindows = $CodexHookCommand; statusMessage = 'Updating wmux workspace' } 'codex'
    Set-HookCommand $Settings 'Stop' $CodexHookCommand @{ commandWindows = $CodexHookCommand; statusMessage = 'Summarizing wmux workspace' } 'codex'
  ) -contains $true
  if ($Changed) { Write-JsonFile $SettingsPath $Settings }
  Write-Output ("{0} Codex hooks in {1}" -f ($(if ($Changed) { 'Installed' } else { 'Already installed' })), $SettingsPath)
  Write-Output "Hook command: $CodexHookCommand"
  Write-Output 'Run /hooks inside Codex to review and trust this hook before expecting it to run.'
  exit 0
}

if ($Command -eq 'status') {
  $ClaudePath = Join-Path $HOME '.claude\settings.json'
  $ClaudeSettings = Read-JsonFile $ClaudePath
  $CodexPath = Join-Path $HOME '.codex\hooks.json'
  $CodexSettings = Read-JsonFile $CodexPath
  $ClaudeInstalled = (Test-HookCommand $ClaudeSettings.hooks.UserPromptSubmit $ClaudeHookCommand) -and (Test-HookCommand $ClaudeSettings.hooks.Stop $ClaudeHookCommand) -and (Test-HookCommand $ClaudeSettings.hooks.Notification $ClaudeHookCommand)
  $CodexInstalled = (Test-HookCommand $CodexSettings.hooks.UserPromptSubmit $CodexHookCommand $CodexHookCommand) -and (Test-HookCommand $CodexSettings.hooks.Stop $CodexHookCommand $CodexHookCommand)
  [ordered]@{
    claude = if ($ClaudeInstalled) { 'installed' } else { 'not_installed' }
    codex = if ($CodexInstalled) { 'installed' } else { 'not_installed' }
    claudeHookCommand = $ClaudeHookCommand
    codexHookCommand = $CodexHookCommand
  } | ConvertTo-Json -Depth 8
  exit 0
}

Show-Usage
exit 2
