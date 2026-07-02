$ErrorActionPreference = 'Stop'

$CommandName = [System.IO.Path]::GetFileNameWithoutExtension($MyInvocation.MyCommand.Name)
if (-not $CommandName) { $CommandName = 'wmux-copy' }
$WmuxUrl = $env:WMUX_URL
if (-not $WmuxUrl) { $WmuxUrl = 'http://127.0.0.1:3478' }
$PaneId = $env:WMUX_PANE_ID
$WorkspaceId = $env:WMUX_WORKSPACE_ID
$TabId = $env:WMUX_TAB_ID
$File = ''

for ($Index = 0; $Index -lt $args.Count; $Index++) {
  $Arg = [string]$args[$Index]
  switch ($Arg) {
    '--url' { $Index++; $WmuxUrl = [string]$args[$Index]; continue }
    '--pane' { $Index++; $PaneId = [string]$args[$Index]; continue }
    '--workspace' { $Index++; $WorkspaceId = [string]$args[$Index]; continue }
    '--tab' { $Index++; $TabId = [string]$args[$Index]; continue }
    default {
      if (-not $File) {
        $File = $Arg
      } else {
        throw "unknown argument: $Arg"
      }
    }
  }
}

if ($File) {
  $ResolvedFile = (Resolve-Path -LiteralPath $File).Path
  $Text = [System.IO.File]::ReadAllText($ResolvedFile)
} elseif ([Console]::IsInputRedirected) {
  $Text = [Console]::In.ReadToEnd()
} elseif ($MyInvocation.ExpectingInput) {
  $Text = ($input | Out-String)
} else {
  Write-Error "$CommandName requires stdin or a file"
  exit 2
}

if (-not $Text) {
  Write-Error "${CommandName}: no input"
  exit 2
}

$Payload = [ordered]@{ text = $Text }
if ($PaneId) { $Payload.paneId = $PaneId }
if ($WorkspaceId) { $Payload.workspaceId = $WorkspaceId }
if ($TabId) { $Payload.tabId = $TabId }

$Json = $Payload | ConvertTo-Json -Depth 8 -Compress
Invoke-RestMethod -Method Post -Uri ($WmuxUrl.TrimEnd('/') + '/api/clipboard') -ContentType 'application/json' -Body $Json | Out-Null
