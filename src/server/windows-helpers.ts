import fs from "node:fs";
import path from "node:path";
import { streamPathForMachine } from "./streams.js";
import type { MachineConfig } from "./types.js";

const psSingleQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
const windowsBootstrapEnvKeys = new Set([
  "WMUX_WORKSPACE_ID",
  "WMUX_WORKSPACE_NAME",
  "WMUX_TAB_ID",
  "WMUX_TAB_TITLE",
  "WMUX_PANE_ID",
  "KITTY_WINDOW_ID",
]);
const windowsRequiredHelperNames = [
  "wmux-agent-event",
  "wmux-copy",
  "wmux-hooks",
  "wmux-media",
  "wmux-notify",
  "wmux-run",
  "wmux-stream-agent-service",
  "wmux-title",
  "wmux-windows-agent-service",
  "wmux-windows-setup",
];
const windowsClipboardAliasNames = ["wmux-clip", "wclip", "wmclip"];

export const encodePowerShellCommand = (script: string): string =>
  Buffer.from(script, "utf16le").toString("base64");

export interface WindowsHelperBundle {
  files: Array<{ name: string; dataBase64: string }>;
  streamConfig: Record<string, unknown>;
  agentConfig: Record<string, unknown>;
}

export const buildWindowsHelperBundle = (machine: MachineConfig, bindHost = "127.0.0.1"): WindowsHelperBundle => ({
  files: windowsHelperFiles().map(({ name, content }) => ({
    name,
    dataBase64: Buffer.from(content, "utf8").toString("base64"),
  })),
  streamConfig: windowsStreamConfig(machine, bindHost),
  agentConfig: windowsAgentConfig(machine),
});

export const buildWindowsPowerShellBootstrapUrl = (
  machine: MachineConfig,
  startCwd: string | undefined,
  extraEnv: Record<string, string>,
): string => {
  const streamHost = process.env.WMUX_STREAM_HOST ?? process.env.WMUX_HOST ?? "127.0.0.1";
  const wmuxPort = process.env.WMUX_PORT ?? "3478";
  const wmuxUrl = process.env.WMUX_PUBLIC_URL ?? process.env.WMUX_URL ?? `http://${streamHost}:${wmuxPort}`;
  const url = new URL(`${wmuxUrl.replace(/\/+$/, "")}/api/helpers/windows/${encodeURIComponent(machine.id)}/bootstrap`);
  if (startCwd) url.searchParams.set("WMUX_START_CWD", startCwd);
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value && windowsBootstrapEnvKeys.has(key)) url.searchParams.set(key, value);
  }
  return url.toString();
};

export const buildWindowsPowerShellBootstrap = (
  machine: MachineConfig,
  startCwd: string | undefined,
  extraEnv: Record<string, string>,
): string => {
  const streamHost = process.env.WMUX_STREAM_HOST ?? process.env.WMUX_HOST ?? "127.0.0.1";
  const wmuxPort = process.env.WMUX_PORT ?? "3478";
  const wmuxUrl = process.env.WMUX_PUBLIC_URL ?? process.env.WMUX_URL ?? `http://${streamHost}:${wmuxPort}`;
  const streamPath = streamPathForMachine(machine.id);
  const remoteEnv = {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    WMUX_MACHINE_ID: machine.id,
    WMUX_MACHINE_NAME: machine.name,
    WMUX_START_CWD: startCwd ?? "",
    WMUX_URL: wmuxUrl,
    WMUX_STREAM_HOST: streamHost,
    WMUX_STREAM_PATH: streamPath,
    WMUX_STREAM_RTSP_URL: `rtsp://${streamHost}:8554/${streamPath}`,
    WMUX_STREAM_WHIP_URL: `${process.env.WMUX_MEDIAMTX_WEBRTC_ORIGIN ?? `http://${streamHost}:8889`}/${streamPath}/whip`,
    ...extraEnv,
  };
  const envLines = Object.entries(remoteEnv)
    .filter(([, value]) => value)
    .map(([key, value]) => `$env:${key} = ${psSingleQuote(value)}`)
    .join("\n");
  const bundleUrl = `${wmuxUrl.replace(/\/+$/, "")}/api/helpers/windows/${encodeURIComponent(machine.id)}`;

  return `
$ErrorActionPreference = 'Continue'
${envLines}

$LocalAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\\Local' }
$HelperDir = Join-Path $LocalAppData 'wmux\\bin'
$StateDir = Join-Path $HOME '.wmux'
$LogDir = Join-Path $StateDir 'logs'
New-Item -ItemType Directory -Force -Path $HelperDir, $StateDir, $LogDir | Out-Null
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

$BundleUrl = ${psSingleQuote(bundleUrl)}
try {
  $Bundle = Invoke-RestMethod -Method Get -Uri $BundleUrl -TimeoutSec 20
  foreach ($File in @($Bundle.files)) {
    $Target = Join-Path $HelperDir ([string]$File.name)
    [System.IO.File]::WriteAllBytes($Target, [Convert]::FromBase64String([string]$File.dataBase64))
  }
  $StreamDefaultsPath = Join-Path $StateDir 'stream-agent.defaults.json'
  [System.IO.File]::WriteAllText($StreamDefaultsPath, (($Bundle.streamConfig | ConvertTo-Json -Depth 8) + [Environment]::NewLine), $Utf8NoBom)
  $AgentDefaultsPath = Join-Path $StateDir 'windows-agent.defaults.json'
  [System.IO.File]::WriteAllText($AgentDefaultsPath, (($Bundle.agentConfig | ConvertTo-Json -Depth 8) + [Environment]::NewLine), $Utf8NoBom)
} catch {
  Write-Warning "wmux helper staging failed from \${BundleUrl}: $($_.Exception.Message)"
}

$StreamConfigPath = Join-Path $StateDir 'stream-agent.json'
if ((Test-Path -LiteralPath $StreamDefaultsPath) -and -not (Test-Path -LiteralPath $StreamConfigPath)) {
  Copy-Item -LiteralPath $StreamDefaultsPath -Destination $StreamConfigPath -Force
} elseif (Test-Path -LiteralPath $StreamDefaultsPath) {
  try {
    $ExistingConfig = Get-Content -LiteralPath $StreamConfigPath -Raw | ConvertFrom-Json -AsHashtable
    if ($null -eq $ExistingConfig) { $ExistingConfig = @{} }
  } catch {
    $ExistingConfig = @{}
  }
  $DefaultConfig = Get-Content -LiteralPath $StreamDefaultsPath -Raw | ConvertFrom-Json -AsHashtable
  $ChangedConfig = $false
  foreach ($Key in @('machine', 'server', 'wmuxUrl', 'rtspUrl', 'onDemand', 'pollInterval')) {
    if (-not $ExistingConfig.ContainsKey($Key)) {
      $ExistingConfig[$Key] = $DefaultConfig[$Key]
      $ChangedConfig = $true
    }
  }
  if ($ChangedConfig) {
    [System.IO.File]::WriteAllText($StreamConfigPath, (($ExistingConfig | ConvertTo-Json -Depth 8) + [Environment]::NewLine), $Utf8NoBom)
  }
}

$AgentConfigPath = Join-Path $StateDir 'windows-agent.json'
if ((Test-Path -LiteralPath $AgentDefaultsPath) -and -not (Test-Path -LiteralPath $AgentConfigPath)) {
  Copy-Item -LiteralPath $AgentDefaultsPath -Destination $AgentConfigPath -Force
} elseif (Test-Path -LiteralPath $AgentDefaultsPath) {
  try {
    $ExistingAgentConfig = Get-Content -LiteralPath $AgentConfigPath -Raw | ConvertFrom-Json -AsHashtable
    if ($null -eq $ExistingAgentConfig) { $ExistingAgentConfig = @{} }
  } catch {
    $ExistingAgentConfig = @{}
  }
  $DefaultAgentConfig = Get-Content -LiteralPath $AgentDefaultsPath -Raw | ConvertFrom-Json -AsHashtable
  $ChangedAgentConfig = $false
  foreach ($Key in @('machine', 'host', 'port', 'shell', 'cwd', 'helperDir', 'maxReplayBytes', 'backend')) {
    if (-not $ExistingAgentConfig.ContainsKey($Key)) {
      $ExistingAgentConfig[$Key] = $DefaultAgentConfig[$Key]
      $ChangedAgentConfig = $true
    }
  }
  if ($ChangedAgentConfig) {
    [System.IO.File]::WriteAllText($AgentConfigPath, (($ExistingAgentConfig | ConvertTo-Json -Depth 8) + [Environment]::NewLine), $Utf8NoBom)
  }
}

if (($env:PATH -split ';') -notcontains $HelperDir) {
  $env:PATH = "$HelperDir;$env:PATH"
}
$env:WMUX_HELPER_DIR = $HelperDir

function global:__wmuxNormalizeStartCwd([string]$PathValue) {
  if ([string]::IsNullOrWhiteSpace($PathValue)) { return '' }
  if ($PathValue -match '^/[A-Za-z]:[\\\\/]') { return $PathValue.Substring(1) }
  return $PathValue
}

function global:__wmuxFileUriPath([string]$PathValue) {
  $Normalized = $PathValue -replace '\\\\', '/'
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

function global:prompt {
  __wmuxEmitCwd
  "PS $($executionContext.SessionState.Path.CurrentLocation)> "
}

try {
  Set-PSReadLineOption -PredictionSource None -ErrorAction SilentlyContinue
} catch {}

$StartCwd = __wmuxNormalizeStartCwd $env:WMUX_START_CWD
if ($StartCwd) {
  Set-Location -LiteralPath $StartCwd -ErrorAction SilentlyContinue
}
__wmuxEmitCwd
`;
};

export const buildWindowsHealthProbeScript = (wmuxUrl: string): string => `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$HelperDir = Join-Path $env:LOCALAPPDATA 'wmux\\bin'
$HelperNames = @(${windowsRequiredHelperNames.map((name) => psSingleQuote(`${name}.ps1`)).join(", ")})
$Helpers = [ordered]@{}
$HelperCount = 0
foreach ($Helper in $HelperNames) {
  $Exists = Test-Path -LiteralPath (Join-Path $HelperDir $Helper) -PathType Leaf
  $Helpers[$Helper] = $Exists
  if ($Exists) { $HelperCount += 1 }
}
$ConfigPath = Join-Path $HOME '.wmux\\stream-agent.json'
$StreamConfig = $null
if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
  try { $StreamConfig = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json -AsHashtable } catch {}
}
$Task = Get-ScheduledTask -TaskName 'wmux-stream-agent' -ErrorAction SilentlyContinue
$TaskInfo = if ($Task) { Get-ScheduledTaskInfo -TaskName 'wmux-stream-agent' -ErrorAction SilentlyContinue } else { $null }
$AgentTask = Get-ScheduledTask -TaskName 'wmux-windows-agent' -ErrorAction SilentlyContinue
$AgentTaskInfo = if ($AgentTask) { Get-ScheduledTaskInfo -TaskName 'wmux-windows-agent' -ErrorAction SilentlyContinue } else { $null }
$WmuxReachable = $false
try {
  $Response = Invoke-WebRequest -UseBasicParsing -Method Get -Uri ${psSingleQuote(`${wmuxUrl.replace(/\/+$/, "")}/api/health`)} -TimeoutSec 3
  $WmuxReachable = [int]$Response.StatusCode -ge 200 -and [int]$Response.StatusCode -lt 500
} catch {}
$Pywinpty = $false
try {
  if (Get-Command py.exe -ErrorAction SilentlyContinue) {
    & py.exe -3 -c 'import winpty' *> $null
    $Pywinpty = ($LASTEXITCODE -eq 0)
  } elseif (Get-Command python.exe -ErrorAction SilentlyContinue) {
    & python.exe -c 'import winpty' *> $null
    $Pywinpty = ($LASTEXITCODE -eq 0)
  }
} catch {}
[ordered]@{
  computerName = $env:COMPUTERNAME
  userName = $env:USERNAME
  powerShellVersion = $PSVersionTable.PSVersion.ToString()
  helperDir = $HelperDir
  helpersReady = ($HelperCount -eq $HelperNames.Count)
  helperCount = $HelperCount
  helperTotal = $HelperNames.Count
  helpers = $Helpers
  wmuxUrl = ${psSingleQuote(wmuxUrl)}
  wmuxReachable = $WmuxReachable
  ffmpeg = [bool](Get-Command ffmpeg.exe -ErrorAction SilentlyContinue)
  python = [bool](Get-Command python.exe -ErrorAction SilentlyContinue)
  py = [bool](Get-Command py.exe -ErrorAction SilentlyContinue)
  pywinpty = $Pywinpty
  winget = [bool](Get-Command winget.exe -ErrorAction SilentlyContinue)
  streamConfigExists = [bool]$StreamConfig
  streamTaskState = $(if ($Task) { [string]$Task.State } else { 'missing' })
  streamTaskLastRunTime = $(if ($TaskInfo) { $TaskInfo.LastRunTime.ToString('o') } else { $null })
  streamTaskLastTaskResult = $(if ($TaskInfo) { $TaskInfo.LastTaskResult } else { $null })
  agentConfigExists = [bool](Test-Path -LiteralPath (Join-Path $HOME '.wmux\\windows-agent.json') -PathType Leaf)
  agentTaskState = $(if ($AgentTask) { [string]$AgentTask.State } else { 'missing' })
  agentTaskLastRunTime = $(if ($AgentTaskInfo) { $AgentTaskInfo.LastRunTime.ToString('o') } else { $null })
  agentTaskLastTaskResult = $(if ($AgentTaskInfo) { $AgentTaskInfo.LastTaskResult } else { $null })
} | ConvertTo-Json -Depth 8 -Compress
`;

const windowsPowerShellHelperNames = (): string[] => [...windowsRequiredHelperNames, ...windowsClipboardAliasNames];
const windowsPowerShellSourceName = (name: string): string =>
  windowsClipboardAliasNames.includes(name) ? "wmux-copy.ps1" : `${name}.ps1`;

const windowsHelperFiles = (): Array<{ name: string; content: string }> => [
  ...windowsPowerShellHelperNames().map((name) => ({
    name: `${name}.ps1`,
    content: localWindowsHelperScript(windowsPowerShellSourceName(name)),
  })),
  ...windowsPowerShellHelperNames().map((name) => ({
    name: `${name}.cmd`,
    content: powerShellCmdShim(`${name}.ps1`),
  })),
  {
    name: "wmux-stream-agent.py",
    content: localScript("wmux-stream-agent"),
  },
  {
    name: "wmux-stream-agent.cmd",
    content: pythonCmdShim("wmux-stream-agent.py"),
  },
  {
    name: "wmux-windows-agent.py",
    content: localScript("wmux-windows-agent"),
  },
  {
    name: "wmux-windows-agent.cmd",
    content: pythonCmdShim("wmux-windows-agent.py"),
  },
];

const windowsStreamConfig = (machine: MachineConfig, bindHost: string): Record<string, unknown> => {
  const streamHost = process.env.WMUX_STREAM_HOST ?? process.env.WMUX_HOST ?? bindHost;
  const wmuxPort = process.env.WMUX_PORT ?? "3478";
  const wmuxUrl = process.env.WMUX_PUBLIC_URL ?? process.env.WMUX_URL ?? `http://${streamHost}:${wmuxPort}`;
  const streamPath = streamPathForMachine(machine.id);
  return {
    machine: machine.id,
    server: streamHost,
    wmuxUrl,
    rtspUrl: `rtsp://${streamHost}:8554/${streamPath}`,
    onDemand: true,
    pollInterval: 2,
    backend: "auto",
    framerate: 15,
    maxWidth: 1920,
    bitrate: "3500k",
  };
};

const windowsAgentConfig = (machine: MachineConfig): Record<string, unknown> => ({
  machine: machine.id,
  host: machine.host ?? "127.0.0.1",
  port: machine.agentPort ?? 3481,
  shell: machine.shell ?? "pwsh",
  cwd: machine.cwd ?? "",
  helperDir: "%LOCALAPPDATA%\\wmux\\bin",
  maxReplayBytes: 2 * 1024 * 1024,
  backend: "conpty",
});

const localWindowsHelperScript = (name: string): string => {
  try {
    return fs.readFileSync(path.join(process.cwd(), "scripts", "windows", name), "utf8");
  } catch {
    return `Write-Error '${name} is unavailable on this host'\nexit 127\n`;
  }
};

const localScript = (name: string): string => {
  try {
    return fs.readFileSync(path.join(process.cwd(), "scripts", name), "utf8");
  } catch {
    return `#!/usr/bin/env python3\nimport sys\nprint('${name} is unavailable on this host', file=sys.stderr)\nsys.exit(127)\n`;
  }
};

const powerShellCmdShim = (target: string): string => `@echo off
pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0${target}" %*
exit /b %ERRORLEVEL%
`;

const pythonCmdShim = (target: string): string => `@echo off
where py >nul 2>nul
if %ERRORLEVEL%==0 (
  py -3 "%~dp0${target}" %*
  exit /b %ERRORLEVEL%
)
python "%~dp0${target}" %*
exit /b %ERRORLEVEL%
`;
