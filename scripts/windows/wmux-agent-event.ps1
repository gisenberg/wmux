$ErrorActionPreference = 'Stop'

function Read-WmuxFileValue([string]$PathValue) {
  if (-not $PathValue) { return '' }
  try {
    if (Test-Path -LiteralPath $PathValue -PathType Leaf) {
      return ([System.IO.File]::ReadAllText($PathValue)).Trim()
    }
  } catch {}
  return ''
}

function Get-WmuxUrl {
  $StateUrl = Read-WmuxFileValue (Join-Path $HOME '.wmux\url')
  if ($StateUrl) { return $StateUrl }
  if (-not [string]::IsNullOrWhiteSpace($env:WMUX_HELPER_URL)) { return $env:WMUX_HELPER_URL.Trim() }
  if (-not [string]::IsNullOrWhiteSpace($env:WMUX_PUBLIC_URL)) { return $env:WMUX_PUBLIC_URL.Trim() }
  if (-not [string]::IsNullOrWhiteSpace($env:WMUX_URL)) { return $env:WMUX_URL.Trim() }
  return 'http://127.0.0.1:3478'
}

function Get-WmuxToken {
  $EnvValue = [Environment]::GetEnvironmentVariable('WMUX_HELPER_TOKEN', 'Process')
  $EnvConfigured = $null -ne $EnvValue
  $EnvToken = ([string]$EnvValue).Trim()
  if ($EnvConfigured -and $EnvToken -notmatch '^[A-Za-z0-9_-]{32,256}$') { throw 'configured helper token is empty or malformed' }
  $PathValue = [Environment]::GetEnvironmentVariable('WMUX_HELPER_TOKEN_PATH', 'Process')
  $PathConfigured = $null -ne $PathValue
  if ($PathConfigured -and [string]::IsNullOrWhiteSpace($PathValue)) { throw 'configured helper token path is empty' }
  $TokenPath = if ($PathConfigured -and $PathValue) { $PathValue } else { Join-Path $HOME '.wmux\helper-token' }
  if ($PathConfigured -or (Test-Path -LiteralPath $TokenPath)) {
    $StateToken = Read-WmuxFileValue $TokenPath
    if ($StateToken -notmatch '^[A-Za-z0-9_-]{32,256}$') { throw 'configured helper token file is unreadable or malformed' }
    return $StateToken
  }
  if ($EnvConfigured) { return $EnvToken }
  if ($env:WMUX_BROWSER_AUTH_MODE -eq 'login-only') { return '' }
  $LegacyPath = if ($env:WMUX_TOKEN_PATH) { $env:WMUX_TOKEN_PATH } else { Join-Path $HOME '.wmux\token' }
  $LegacyToken = Read-WmuxFileValue $LegacyPath
  if ($LegacyToken) { return $LegacyToken }
  return $env:WMUX_TOKEN
}

function Clean-Text([string]$Value, [int]$Limit) {
  if (-not $Value) { return '' }
  $Cleaned = ($Value -replace '\s+', ' ').Trim()
  if ($Cleaned.Length -gt $Limit) { return $Cleaned.Substring(0, $Limit) }
  return $Cleaned
}

function Clean-Message([string]$Value, [int]$Limit = 12000) {
  if (-not $Value) { return '' }
  $Cleaned = $Value -replace "`r`n?", "`n"
  $Cleaned = $Cleaned -replace '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', ''
  $Cleaned = $Cleaned -replace '[ \t]+\n', "`n"
  $Cleaned = ($Cleaned -replace '\n{4,}', "`n`n`n").Trim()
  if ($Cleaned.Length -gt $Limit) { return $Cleaned.Substring(0, $Limit) }
  return $Cleaned
}

function Get-ContentText($Content) {
  if ($null -eq $Content) { return '' }
  if ($Content -is [string]) { return $Content }
  if ($Content -is [System.Collections.IEnumerable]) {
    $Parts = @()
    foreach ($Item in $Content) {
      if ($Item -is [string]) {
        $Parts += $Item
      } elseif ($Item.type -in @('text', 'input_text', 'output_text')) {
        $Parts += [string]$Item.text
      }
    }
    return ($Parts -join "`n")
  }
  if ($Content.text) { return [string]$Content.text }
  if ($Content.content) { return Get-ContentText $Content.content }
  return ''
}

function Get-TitleFromPrompt([string]$Prompt) {
  $Prompt = Clean-Text $Prompt 300
  $Prompt = ($Prompt -replace '^(please|can you|could you|let''?s|we need to|i want to)\s+', '').TrimEnd('.?!:; ')
  if (-not $Prompt) { return '' }
  $Words = $Prompt -split '\s+'
  return Clean-Text (($Words | Select-Object -First 8) -join ' ') 50
}

function Get-SummaryFromOutput([string]$Output) {
  $Output = Clean-Text $Output 600
  if (-not $Output) { return '' }
  $First = ($Output -split '(?<=[.!?])\s+|\n+', 2)[0]
  return Clean-Text $First 120
}

function Read-HookInput {
  $Raw = $env:HOOK_INPUT
  if (-not $Raw -and [Console]::IsInputRedirected) {
    $Raw = [Console]::In.ReadToEnd()
  }
  if (-not $Raw) { return $null }
  try {
    return $Raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Read-TranscriptSummary([string]$PathValue) {
  $Result = @{ title = ''; summary = ''; message = '' }
  if (-not $PathValue -or -not (Test-Path -LiteralPath $PathValue -PathType Leaf)) { return $Result }
  $LastUser = ''
  $LastAssistant = ''
  Get-Content -LiteralPath $PathValue -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $Entry = $_ | ConvertFrom-Json
    } catch {
      return
    }
    $Message = if ($Entry.message) { $Entry.message } elseif ($Entry.item) { $Entry.item } elseif ($Entry.payload) { $Entry.payload } else { $Entry }
    $Role = $Message.role
    if (-not $Role -and $Message.type -eq 'user_message') { $Role = 'user' }
    if (-not $Role -and $Message.type -in @('assistant_message', 'agent_message')) { $Role = 'assistant' }
    $Text = Get-ContentText $Message.content
    if (-not $Text) { $Text = Get-ContentText $Message.text }
    if (-not $Text) { $Text = Get-ContentText $Message.message }
    if ($Role -eq 'user' -and $Text) { $LastUser = $Text }
    if ($Role -eq 'assistant' -and $Text) { $LastAssistant = $Text }
  }
  $Result.title = Get-TitleFromPrompt $LastUser
  $Result.summary = Get-SummaryFromOutput $LastAssistant
  $Result.message = Clean-Message $LastAssistant
  return $Result
}

function Read-CodexLifecycle([string]$PathValue, [long]$Start = -1) {
  $Events = @()
  if (-not $PathValue -or -not (Test-Path -LiteralPath $PathValue -PathType Leaf)) { return $Events }
  try {
    $Sharing = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
    $Stream = [IO.FileStream]::new($PathValue, [IO.FileMode]::Open, [IO.FileAccess]::Read, $Sharing)
    try {
      if ($Start -lt 0) { $Start = [Math]::Max(0, $Stream.Length - 1048576) }
      [void]$Stream.Seek([Math]::Min($Start, $Stream.Length), [IO.SeekOrigin]::Begin)
      $Reader = [IO.StreamReader]::new($Stream, [Text.Encoding]::UTF8, $true, 4096, $true)
      try {
        if ($Start -gt 0) { [void]$Reader.ReadLine() }
        while ($null -ne ($Line = $Reader.ReadLine())) {
          try {
            $Entry = $Line | ConvertFrom-Json
          } catch {
            continue
          }
          if ($Entry.type -ne 'event_msg' -or $Entry.payload.type -notin @('task_started', 'task_complete')) { continue }
          $TurnId = [string]$Entry.payload.turn_id
          if ($TurnId) {
            $Events += [pscustomobject]@{ type = [string]$Entry.payload.type; turnId = $TurnId }
          }
        }
      } finally {
        $Reader.Dispose()
      }
    } finally {
      $Stream.Dispose()
    }
  } catch {}
  return $Events
}

function Get-CodexTransition($Events, [string]$TurnId) {
  $Completed = $false
  foreach ($Event in @($Events)) {
    if ($Event.type -eq 'task_complete' -and $Event.turnId -eq $TurnId) {
      $Completed = $true
      continue
    }
    if ($Completed -and $Event.type -eq 'task_started' -and $Event.turnId -ne $TurnId) {
      return 'running'
    }
  }
  return $(if ($Completed) { 'completed' } else { 'unknown' })
}

function Get-DurationMilliseconds([string]$Name, [int]$DefaultValue) {
  $RawValue = [Environment]::GetEnvironmentVariable($Name, 'Process')
  $Value = 0
  if (-not [int]::TryParse($RawValue, [ref]$Value)) { return $DefaultValue }
  return [Math]::Max(10, [Math]::Min($Value, 30000))
}

function Send-AgentEventPayload([string]$Url, $Payload) {
  $Json = $Payload | ConvertTo-Json -Depth 8 -Compress
  $Headers = @{}
  $WmuxToken = Get-WmuxToken
  if ($WmuxToken) { $Headers['Authorization'] = "Bearer $WmuxToken" }
  Invoke-RestMethod -Method Post -Uri ($Url.TrimEnd('/') + '/api/agent-events') -Headers $Headers -ContentType 'application/json' -Body $Json -TimeoutSec 10 | Out-Null
}

function Invoke-CodexReconcile($Data) {
  $Stopwatch = [Diagnostics.Stopwatch]::StartNew()
  $Timeout = Get-DurationMilliseconds 'WMUX_CODEX_RECONCILE_TIMEOUT_MS' 3000
  $Grace = Get-DurationMilliseconds 'WMUX_CODEX_RECONCILE_GRACE_MS' 1500
  $CompletedAt = $null
  $Status = 'completed'
  while ($Data.transcript -and $Data.turnId -and $Stopwatch.ElapsedMilliseconds -lt $Timeout) {
    $Transition = Get-CodexTransition (Read-CodexLifecycle ([string]$Data.transcript) ([long]$Data.transcriptOffset)) ([string]$Data.turnId)
    if ($Transition -eq 'running') {
      $Status = 'running'
      break
    }
    if ($Transition -eq 'completed') {
      if ($null -eq $CompletedAt) { $CompletedAt = $Stopwatch.ElapsedMilliseconds }
      if ($Stopwatch.ElapsedMilliseconds - $CompletedAt -ge $Grace) { break }
    }
    Start-Sleep -Milliseconds 50
  }

  $TranscriptResult = Read-TranscriptSummary ([string]$Data.transcript)
  $Payload = [ordered]@{
    agent = Clean-Text ([string]$Data.agent) 50
    status = $Status
    title = if ($Status -eq 'running') { '' } else { Clean-Text ([string]$TranscriptResult.title) 80 }
    summary = if ($Status -eq 'running') { 'codex running' } elseif ($TranscriptResult.summary) { Clean-Text ([string]$TranscriptResult.summary) 500 } else { 'codex completed' }
    body = ''
  }
  if ($Status -eq 'running') { $Payload.coalesce = $true }
  if ($Status -eq 'completed' -and $TranscriptResult.message) { $Payload.message = Clean-Message ([string]$TranscriptResult.message) }
  if ($Data.paneId) { $Payload.paneId = [string]$Data.paneId }
  if ($Data.workspaceId) { $Payload.workspaceId = [string]$Data.workspaceId }
  if ($Data.tabId) { $Payload.tabId = [string]$Data.tabId }
  try {
    Send-AgentEventPayload ([string]$Data.url) $Payload
  } catch {
    # Reconciliation is telemetry and must never keep a Codex turn alive.
  }
}

function Start-CodexReconciler(
  [string]$Url,
  [string]$Transcript,
  [string]$TurnId,
  [string]$AgentName,
  [string]$Pane,
  [string]$Workspace,
  [string]$Tab
) {
  if (-not $Transcript -or -not $TurnId -or -not $PSCommandPath) { return $false }
  try {
    $TranscriptOffset = [Math]::Max(0, (Get-Item -LiteralPath $Transcript -ErrorAction Stop).Length - 1048576)
    $Data = [ordered]@{
      url = $Url
      transcript = $Transcript
      transcriptOffset = $TranscriptOffset
      turnId = $TurnId
      agent = $AgentName
      paneId = $Pane
      workspaceId = $Workspace
      tabId = $Tab
    }
    $DataJson = $Data | ConvertTo-Json -Depth 4 -Compress
    $DataBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($DataJson))
    $ScriptPath = $PSCommandPath.Replace("'", "''")
    $Command = "& '$ScriptPath' --codex-reconcile '$DataBase64'"
    $EncodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Command))
    $Executable = Join-Path $PSHOME 'pwsh.exe'
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
      $Executable = (Get-Process -Id $PID).Path
    }
    Start-Process -FilePath $Executable -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $EncodedCommand) -WindowStyle Hidden | Out-Null
    return $true
  } catch {
    return $false
  }
}

$WmuxUrl = Get-WmuxUrl
$Agent = $env:WMUX_AGENT_NAME
if (-not $Agent) { $Agent = 'agent' }
$Status = 'completed'
$Title = ''
$Summary = ''
$Message = ''
$Body = ''
$PaneId = $env:WMUX_PANE_ID
$WorkspaceId = $env:WMUX_WORKSPACE_ID
$TabId = $env:WMUX_TAB_ID
$Transcript = ''
$ClaudeHook = $false
$CodexHook = $false
$CodexReconcileData = ''
$Force = $false

for ($Index = 0; $Index -lt $args.Count; $Index++) {
  $Arg = [string]$args[$Index]
  switch ($Arg) {
    '--url' { $Index++; $WmuxUrl = [string]$args[$Index]; continue }
    '--agent' { $Index++; $Agent = [string]$args[$Index]; continue }
    '--status' { $Index++; $Status = [string]$args[$Index]; continue }
    '--title' { $Index++; $Title = [string]$args[$Index]; continue }
    '--summary' { $Index++; $Summary = [string]$args[$Index]; continue }
    '--message' { $Index++; $Message = [string]$args[$Index]; continue }
    '--body' { $Index++; $Body = [string]$args[$Index]; continue }
    '--pane' { $Index++; $PaneId = [string]$args[$Index]; continue }
    '--workspace' { $Index++; $WorkspaceId = [string]$args[$Index]; continue }
    '--tab' { $Index++; $TabId = [string]$args[$Index]; continue }
    '--transcript' { $Index++; $Transcript = [string]$args[$Index]; continue }
    '--claude-hook' { $ClaudeHook = $true; continue }
    '--codex-hook' { $CodexHook = $true; continue }
    '--codex-reconcile' { $Index++; $CodexReconcileData = [string]$args[$Index]; continue }
    '--force' { $Force = $true; continue }
    default { throw "unknown argument: $Arg" }
  }
}

if ($CodexReconcileData) {
  try {
    $Decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($CodexReconcileData))
    Invoke-CodexReconcile ($Decoded | ConvertFrom-Json)
  } catch {}
  exit 0
}

if (-not $Force -and -not $PaneId -and -not $WorkspaceId) {
  exit 0
}

$HookInput = if ($ClaudeHook -or $CodexHook) { Read-HookInput } else { $null }
if ($HookInput) {
  if (-not $Transcript) {
    $Transcript = if ($HookInput.transcript_path) { [string]$HookInput.transcript_path } else { [string]$HookInput.agent_transcript_path }
  }
  if (-not $Title -and $HookInput.prompt) { $Title = Get-TitleFromPrompt ([string]$HookInput.prompt) }
  if (-not $Summary -and $HookInput.last_assistant_message) { $Summary = Get-SummaryFromOutput ([string]$HookInput.last_assistant_message) }
  if (-not $Message -and $HookInput.last_assistant_message) { $Message = Clean-Message ([string]$HookInput.last_assistant_message) }
}
$HookEvent = if ($HookInput) { [string]$HookInput.hook_event_name } else { '' }
$TurnId = if ($HookInput) { [string]$HookInput.turn_id } else { '' }
$DeferCodexStop = $CodexHook -and $HookEvent -eq 'Stop' -and $Transcript -and $TurnId
$TranscriptResult = if ($DeferCodexStop) { @{ title = ''; summary = ''; message = '' } } else { Read-TranscriptSummary $Transcript }
if (-not $Title) { $Title = $TranscriptResult.title }
if (-not $Summary) { $Summary = if ($Body) { $Body } else { $TranscriptResult.summary } }
if (-not $Message) { $Message = $TranscriptResult.message }

if ($ClaudeHook -and $HookInput) {
  if ($HookEvent -eq 'UserPromptSubmit') {
    $Status = 'running'
    $Summary = 'claude running'
    $Message = ''
  } elseif ($HookEvent -eq 'Notification') {
    $Status = 'updated'
    $Summary = if ($HookInput.message) { Clean-Text ([string]$HookInput.message) 500 } else { 'claude notification' }
    $Message = ''
  } elseif ($HookEvent) {
    $Status = 'completed'
    if (-not $Summary) { $Summary = 'claude completed' }
  }
} elseif ($ClaudeHook) {
  $Status = 'completed'
}
if ($CodexHook -and $HookInput) {
  if ($HookEvent -in @('UserPromptSubmit', 'PreToolUse')) {
    $Status = 'running'
    $Summary = 'codex running'
    $Message = ''
  } elseif ($HookEvent) {
    $Status = 'completed'
    if (-not $Summary) { $Summary = 'codex completed' }
  }
}

$Payload = [ordered]@{
  agent = Clean-Text $Agent 50
  status = Clean-Text $Status 50
  title = Clean-Text $Title 80
  summary = Clean-Text $Summary 500
  body = Clean-Text $Body 500
}
if ($Message) { $Payload.message = Clean-Message $Message }
if ($CodexHook -and $HookEvent -eq 'PreToolUse') { $Payload.coalesce = $true }
if ($PaneId) { $Payload.paneId = $PaneId }
if ($WorkspaceId) { $Payload.workspaceId = $WorkspaceId }
if ($TabId) { $Payload.tabId = $TabId }

if (
  $CodexHook -and
  $HookEvent -eq 'Stop' -and
  (Start-CodexReconciler $WmuxUrl $Transcript $TurnId $Agent $PaneId $WorkspaceId $TabId)
) {
  exit 0
}

try {
  Send-AgentEventPayload $WmuxUrl $Payload
} catch {
  [Console]::Error.WriteLine("wmux-agent-event: delivery failed: $($_.Exception.Message)")
  exit 1
}
