function global:__wmuxFileUriPath([string]$PathValue) {
  $Normalized = $PathValue -replace '\\', '/'
  if ($Normalized -match '^[A-Za-z]:') {
    $Normalized = '/' + $Normalized
  }
  $Segments = $Normalized.Split([char]'/', [System.StringSplitOptions]::None)
  return (($Segments | ForEach-Object { [System.Uri]::EscapeDataString($_) }) -join '/')
}

function global:__wmuxEmitCwd {
  try {
    if ($PWD.Provider.Name -ne 'FileSystem') { return }
    $HostName = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { 'windows' }
    $PathPart = __wmuxFileUriPath $PWD.ProviderPath
    [Console]::Write("$([char]27)]7;file://$HostName$PathPart$([char]7)")
  } catch {}
}

function global:__wmuxClearPromptTail {
  try {
    # ConPTY console coordinates can lag terminal output, so never reposition here.
    [Console]::Write("$([char]27)[0K")
  } catch {}
}

function global:__wmuxInstallPrompt([bool]$PreserveExisting) {
  if (-not (Test-Path variable:global:__wmuxPromptInstalled)) {
    $ExistingPrompt = Get-Command prompt -CommandType Function -ErrorAction SilentlyContinue
    $global:__wmuxOriginalPrompt = if ($ExistingPrompt) { $ExistingPrompt.ScriptBlock } else { $null }
  }
  $global:__wmuxPreserveOriginalPrompt = $PreserveExisting
  function global:prompt {
    __wmuxClearPromptTail
    __wmuxEmitCwd
    if ($global:__wmuxPreserveOriginalPrompt -and $global:__wmuxOriginalPrompt) {
      try {
        & $global:__wmuxOriginalPrompt
        return
      } catch {}
    }
    "PS $($executionContext.SessionState.Path.CurrentLocation)> "
  }
  $global:__wmuxPromptInstalled = $true
}

try {
  # Native tools write UTF-8; without this conhost decodes them with the OEM
  # code page and the browser sees mojibake. Applies to stdio sessions too.
  $WmuxUtf8 = [System.Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = $WmuxUtf8
  [Console]::InputEncoding = $WmuxUtf8
  $global:OutputEncoding = $WmuxUtf8
} catch {}

try {
  Set-PSReadLineOption -PredictionSource None -ErrorAction SilentlyContinue
} catch {}
