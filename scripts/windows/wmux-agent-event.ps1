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
  $TokenPath = if ($env:WMUX_TOKEN_PATH) { $env:WMUX_TOKEN_PATH } else { Join-Path $HOME '.wmux\token' }
  $StateToken = Read-WmuxFileValue $TokenPath
  if ($StateToken) { return $StateToken }
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
    '--force' { $Force = $true; continue }
    default { throw "unknown argument: $Arg" }
  }
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
$TranscriptResult = Read-TranscriptSummary $Transcript
if (-not $Title) { $Title = $TranscriptResult.title }
if (-not $Summary) { $Summary = if ($Body) { $Body } else { $TranscriptResult.summary } }
if (-not $Message) { $Message = $TranscriptResult.message }

if ($ClaudeHook -and $HookInput) {
  $HookEvent = [string]$HookInput.hook_event_name
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
  $HookEvent = [string]$HookInput.hook_event_name
  if ($HookEvent -eq 'UserPromptSubmit') {
    $Status = 'running'
    $Summary = 'codex running'
    $Message = ''
  } elseif ($HookEvent) {
    $Status = 'completed'
    if (-not $Summary) { $Summary = 'codex completed' }
  }
}

if (-not $Force -and -not $PaneId -and -not $WorkspaceId) {
  if ($ClaudeHook -or $CodexHook) {
    [Console]::Error.WriteLine('wmux-agent-event: hook is missing WMUX_PANE_ID and WMUX_WORKSPACE_ID; start the agent from a newly bootstrapped wmux pane')
    exit 2
  }
  exit 0
}

$Payload = [ordered]@{
  agent = Clean-Text $Agent 50
  status = Clean-Text $Status 50
  title = Clean-Text $Title 80
  summary = Clean-Text $Summary 500
  body = Clean-Text $Body 500
}
if ($Message) { $Payload.message = Clean-Message $Message }
if ($PaneId) { $Payload.paneId = $PaneId }
if ($WorkspaceId) { $Payload.workspaceId = $WorkspaceId }
if ($TabId) { $Payload.tabId = $TabId }

$Json = $Payload | ConvertTo-Json -Depth 8 -Compress
$Headers = @{}
$WmuxToken = Get-WmuxToken
if ($WmuxToken) { $Headers['Authorization'] = "Bearer $WmuxToken" }
try {
  Invoke-RestMethod -Method Post -Uri ($WmuxUrl.TrimEnd('/') + '/api/agent-events') -Headers $Headers -ContentType 'application/json' -Body $Json -TimeoutSec 10 | Out-Null
} catch {
  [Console]::Error.WriteLine("wmux-agent-event: delivery failed: $($_.Exception.Message)")
  exit 1
}
