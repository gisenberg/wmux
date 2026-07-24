import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { streamPathForMachine } from "./streams.js";
import { resolveHelperUrl } from "./helper-url.js";
import type { MachineConfig } from "./types.js";
import { wmuxReleaseVersion } from "./version.js";

const psSingleQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
const windowsBootstrapEnvKeys = new Set([
  "WMUX_WORKSPACE_ID",
  "WMUX_WORKSPACE_NAME",
  "WMUX_TAB_ID",
  "WMUX_TAB_TITLE",
  "WMUX_PANE_ID",
  "WMUX_COLOR_SCHEME",
  "WMUX_COLOR_MODE",
  "WMUX_TERMINAL_FOREGROUND",
  "WMUX_TERMINAL_BACKGROUND",
  "WMUX_TERMINAL_ANSI_PALETTE",
  "KITTY_WINDOW_ID",
  "WMUX_BROWSER_AUTH_MODE",
]);
const windowsPowerShellHelperBaseNames = [
  "wmux-agent-event",
  "wmux-console-theme",
  "wmux-copy",
  "wmux-heartbeat",
  "wmux-hooks",
  "wmux-media",
  "wmux-notify",
  "wmux-run",
  "wmux-stream-agent-service",
  "wmux-title",
  "wmux-windows-agent-service",
  "wmux-windows-setup",
];
const windowsRequiredHelperFiles = [
  ...windowsPowerShellHelperBaseNames.map((name) => `${name}.ps1`),
  "wmux-agent-run.cmd",
  "wmux-agent-run.py",
  "wmux_agent_contract.py",
];
const windowsClipboardAliasNames = ["wmux-clip", "wclip", "wmclip"];
const WINDOWS_AGENT_RELEASE_PLACEHOLDER = "__WMUX_WINDOWS_AGENT_RELEASE_VERSION__";

export const encodePowerShellCommand = (script: string): string =>
  Buffer.from(script, "utf16le").toString("base64");

export interface WindowsHelperBundle {
  // Content hash over every helper file; the bootstrap records it in
  // bundle-version.json and the health probe reports it back so wmux can
  // tell current helpers from stale ones instead of just counting files.
  bundleVersion: string;
  files: Array<{ name: string; dataBase64: string; sha256: string }>;
  streamConfig: Record<string, unknown>;
  agentConfig: Record<string, unknown>;
}

const sha256Hex = (data: Buffer): string => crypto.createHash("sha256").update(data).digest("hex");

const windowsHelperBundleFiles = (): WindowsHelperBundle["files"] =>
  windowsHelperFiles().map(({ name, content }) => {
    const buffer = Buffer.from(content, "utf8");
    return { name, dataBase64: buffer.toString("base64"), sha256: sha256Hex(buffer) };
  });

export const windowsHelperBundleVersion = (): string => {
  const manifest = windowsHelperBundleFiles()
    .map((file) => `${file.name}:${file.sha256}`)
    .sort()
    .join("\n");
  return sha256Hex(Buffer.from(manifest, "utf8")).slice(0, 16);
};

export const buildWindowsHelperBundle = (machine: MachineConfig, bindHost = "127.0.0.1"): WindowsHelperBundle => ({
  bundleVersion: windowsHelperBundleVersion(),
  files: windowsHelperBundleFiles(),
  streamConfig: windowsStreamConfig(machine, bindHost),
  agentConfig: windowsAgentConfig(machine),
});

export const buildWindowsPowerShellBootstrapUrl = (
  machine: MachineConfig,
  startCwd: string | undefined,
  extraEnv: Record<string, string>,
  bootstrapToken?: string,
): string => {
  const streamHost = process.env.WMUX_STREAM_HOST ?? process.env.WMUX_HOST ?? "127.0.0.1";
  const wmuxPort = process.env.WMUX_PORT ?? "3478";
  const wmuxUrl = resolveHelperUrl(`http://${streamHost}:${wmuxPort}`);
  const url = new URL(`${wmuxUrl.replace(/\/+$/, "")}/api/helpers/windows/${encodeURIComponent(machine.id)}/bootstrap`);
  if (startCwd) url.searchParams.set("WMUX_START_CWD", startCwd);
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value && windowsBootstrapEnvKeys.has(key)) url.searchParams.set(key, value);
  }
  // The helper endpoints are token-gated; the WS/one-liner fetch can only carry
  // the token on the query string.
  const effectiveBootstrapToken = bootstrapToken || extraEnv.WMUX_TOKEN;
  if (effectiveBootstrapToken) url.searchParams.set("token", effectiveBootstrapToken);
  return url.toString();
};

export const buildWindowsPowerShellBootstrap = (
  machine: MachineConfig,
  startCwd: string | undefined,
  extraEnv: Record<string, string>,
  bootstrapToken?: string,
  inlineBundle?: WindowsHelperBundle,
): string => {
  const streamHost = process.env.WMUX_STREAM_HOST ?? process.env.WMUX_HOST ?? "127.0.0.1";
  const wmuxPort = process.env.WMUX_PORT ?? "3478";
  const wmuxUrl = resolveHelperUrl(`http://${streamHost}:${wmuxPort}`);
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
  const bundleLoad = inlineBundle
    ? `$BundleJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psSingleQuote(
        Buffer.from(JSON.stringify(inlineBundle), "utf8").toString("base64"),
      )}))\n  $Bundle = $BundleJson | ConvertFrom-Json`
    : "$Bundle = Invoke-RestMethod -Method Get -Uri $BundleUrl -Headers $WmuxHeaders -TimeoutSec 20";

  return `
$WmuxOriginalErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
${envLines}

$LocalAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\\Local' }
$HelperDir = Join-Path $LocalAppData 'wmux\\bin'
$StateDir = Join-Path $HOME '.wmux'
$LogDir = Join-Path $StateDir 'logs'
New-Item -ItemType Directory -Force -Path $HelperDir, $StateDir, $LogDir | Out-Null
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
if ($env:WMUX_TOKEN) {
  [System.IO.File]::WriteAllText((Join-Path $StateDir 'token'), [string]::Concat($env:WMUX_TOKEN, [Environment]::NewLine), $Utf8NoBom)
}
if ($env:WMUX_HELPER_TOKEN) {
  [System.IO.File]::WriteAllText((Join-Path $StateDir 'helper-token'), [string]::Concat($env:WMUX_HELPER_TOKEN, [Environment]::NewLine), $Utf8NoBom)
}
if ($env:WMUX_URL) {
  [System.IO.File]::WriteAllText((Join-Path $StateDir 'url'), [string]::Concat($env:WMUX_URL, [Environment]::NewLine), $Utf8NoBom)
}

$BundleUrl = ${psSingleQuote(bundleUrl)}
$WmuxHeaders = @{}
$WmuxBootstrapToken = ${psSingleQuote(bootstrapToken ?? "")}
if ($WmuxBootstrapToken) {
  $WmuxHeaders['Authorization'] = "Bearer $WmuxBootstrapToken"
} elseif ($env:WMUX_HELPER_TOKEN) {
  $WmuxHeaders['Authorization'] = "Bearer $($env:WMUX_HELPER_TOKEN)"
} elseif ($env:WMUX_TOKEN) {
  $WmuxHeaders['Authorization'] = "Bearer $($env:WMUX_TOKEN)"
}
try {
  ${bundleLoad}
  # Stage-verify-swap: decode everything into a scratch directory, check each
  # file's SHA-256 against the manifest, and only then move files into place.
  # A truncated download or mid-write failure never leaves a broken helper.
  $Staging = Join-Path $HelperDir (".staging-" + $PID)
  New-Item -ItemType Directory -Force -Path $Staging | Out-Null
  $Sha256 = [System.Security.Cryptography.SHA256]::Create()
  $StagedOk = $true
  foreach ($File in @($Bundle.files)) {
    $Bytes = [Convert]::FromBase64String([string]$File.dataBase64)
    if ($File.sha256) {
      $Hash = ([System.BitConverter]::ToString($Sha256.ComputeHash($Bytes)) -replace '-', '').ToLowerInvariant()
      if ($Hash -ne ([string]$File.sha256).ToLowerInvariant()) {
        Write-Warning "wmux helper $($File.name) failed hash verification; keeping existing helpers"
        $StagedOk = $false
        break
      }
    }
    [System.IO.File]::WriteAllBytes((Join-Path $Staging ([string]$File.name)), $Bytes)
  }
  if ($StagedOk) {
    foreach ($File in @($Bundle.files)) {
      Move-Item -LiteralPath (Join-Path $Staging ([string]$File.name)) -Destination (Join-Path $HelperDir ([string]$File.name)) -Force
    }
    if ($Bundle.bundleVersion) {
      $VersionPath = Join-Path $HelperDir 'bundle-version.json'
      [System.IO.File]::WriteAllText($VersionPath, ((@{ bundleVersion = [string]$Bundle.bundleVersion } | ConvertTo-Json) + [Environment]::NewLine), $Utf8NoBom)
    }
  }
  Remove-Item -Recurse -Force -LiteralPath $Staging -ErrorAction SilentlyContinue
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
  foreach ($Key in @('machine', 'host', 'port', 'shell', 'cwd', 'helperDir', 'maxReplayBytes', 'backend', 'heartbeatOwner', 'heartbeatEnabled', 'heartbeatIntervalSeconds')) {
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

${windowsCwdPromptSnippet()}
$ConsoleThemeHelper = Join-Path $HelperDir 'wmux-console-theme.ps1'
if (Test-Path -LiteralPath $ConsoleThemeHelper -PathType Leaf) {
  & $ConsoleThemeHelper
}
$AgentProfileHelper = Join-Path $HelperDir 'wmux-agent-profile.cmd'
if (Test-Path -LiteralPath $AgentProfileHelper -PathType Leaf) {
  & $AgentProfileHelper apply --quiet${machine.source === "registered" ? " --optional-auth" : ""}
}
$StartCwd = __wmuxNormalizeStartCwd $env:WMUX_START_CWD
if ($StartCwd) {
  Set-Location -LiteralPath $StartCwd -ErrorAction SilentlyContinue
}
__wmuxInstallPrompt ${machine.loadPowerShellProfile === true ? "$true" : "$false"}
__wmuxEmitCwd
$ErrorActionPreference = $WmuxOriginalErrorActionPreference
`;
};

export const buildWindowsHealthProbeScript = (wmuxUrl: string): string => `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$HelperDir = Join-Path $env:LOCALAPPDATA 'wmux\\bin'
$ExpectedBundleVersion = ${psSingleQuote(windowsHelperBundleVersion())}
$BundleVersion = $null
try {
  $VersionDoc = Get-Content -LiteralPath (Join-Path $HelperDir 'bundle-version.json') -Raw | ConvertFrom-Json
  $BundleVersion = [string]$VersionDoc.bundleVersion
} catch {}
$HelperNames = @(${windowsRequiredHelperFiles.map((name) => psSingleQuote(name)).join(", ")})
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
$LegacyHeartbeatTask = Get-ScheduledTask -TaskName 'wmux-heartbeat' -ErrorAction SilentlyContinue
$RegistrationStateDir = Join-Path $HOME '.wmux'
$SunshineCommand = Get-Command sunshine.exe -ErrorAction SilentlyContinue
if (-not $SunshineCommand) {
  $SunshineCandidates = @()
  foreach ($Root in @(\${env:ProgramFiles}, \${env:ProgramFiles(x86)})) {
    if (-not $Root) { continue }
    $SunshineCandidates += Join-Path $Root 'Sunshine\\sunshine.exe'
    $SunshineCandidates += Join-Path $Root 'LizardByte\\Sunshine\\sunshine.exe'
  }
  foreach ($Candidate in $SunshineCandidates) {
    if ($Candidate -and (Test-Path -LiteralPath $Candidate -PathType Leaf)) {
      $SunshineCommand = [pscustomobject]@{ Source = $Candidate }
      break
    }
  }
}
$SunshineReachable = $false
try {
  $SunshineUrl = if ($env:WMUX_SUNSHINE_URL) { $env:WMUX_SUNSHINE_URL.TrimEnd('/') } else { 'https://127.0.0.1:47990' }
  $Response = Invoke-WebRequest -UseBasicParsing -Method Get -Uri "$SunshineUrl/api/configLocale" -SkipCertificateCheck -TimeoutSec 3
  $SunshineReachable = [int]$Response.StatusCode -ge 200 -and [int]$Response.StatusCode -lt 500
} catch {}
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
  bundleVersion = $BundleVersion
  expectedBundleVersion = $ExpectedBundleVersion
  helpersCurrent = ($BundleVersion -eq $ExpectedBundleVersion)
  wmuxUrl = ${psSingleQuote(wmuxUrl)}
  wmuxReachable = $WmuxReachable
  ffmpeg = [bool](Get-Command ffmpeg.exe -ErrorAction SilentlyContinue)
  python = [bool](Get-Command python.exe -ErrorAction SilentlyContinue)
  py = [bool](Get-Command py.exe -ErrorAction SilentlyContinue)
  pywinpty = $Pywinpty
  winget = [bool](Get-Command winget.exe -ErrorAction SilentlyContinue)
  sunshine = [bool]$SunshineCommand
  sunshinePath = $(if ($SunshineCommand) { [string]$SunshineCommand.Source } else { $null })
  sunshineApiReachable = $SunshineReachable
  streamConfigExists = [bool]$StreamConfig
  streamTaskState = $(if ($Task) { [string]$Task.State } else { 'missing' })
  streamTaskLastRunTime = $(if ($TaskInfo) { $TaskInfo.LastRunTime.ToString('o') } else { $null })
  streamTaskLastTaskResult = $(if ($TaskInfo) { $TaskInfo.LastTaskResult } else { $null })
  agentConfigExists = [bool](Test-Path -LiteralPath (Join-Path $HOME '.wmux\\windows-agent.json') -PathType Leaf)
  agentTaskState = $(if ($AgentTask) { [string]$AgentTask.State } else { 'missing' })
  agentTaskLastRunTime = $(if ($AgentTaskInfo) { $AgentTaskInfo.LastRunTime.ToString('o') } else { $null })
  agentTaskLastTaskResult = $(if ($AgentTaskInfo) { $AgentTaskInfo.LastTaskResult } else { $null })
  heartbeatManagedByAgent = $true
  heartbeatConfigExists = [bool](Test-Path -LiteralPath (Join-Path $RegistrationStateDir 'heartbeat.json') -PathType Leaf)
  heartbeatUrlExists = [bool](Test-Path -LiteralPath (Join-Path $RegistrationStateDir 'url') -PathType Leaf)
  heartbeatRegistrationTokenExists = [bool](Test-Path -LiteralPath (Join-Path $RegistrationStateDir 'registration-token') -PathType Leaf)
  legacyHeartbeatTaskState = $(if ($LegacyHeartbeatTask) { [string]$LegacyHeartbeatTask.State } else { 'missing' })
} | ConvertTo-Json -Depth 8 -Compress
`;

const windowsPowerShellHelperNames = (): string[] => [
  ...windowsPowerShellHelperBaseNames,
  ...windowsClipboardAliasNames,
];
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
    content: windowsAgentSource(),
  },
  {
    name: "wmux-windows-agent.cmd",
    content: pythonCmdShim("wmux-windows-agent.py"),
  },
  {
    name: "wmux-agent-profile.py",
    content: localScript("wmux-agent-profile"),
  },
  {
    name: "wmux-agent-profile.cmd",
    content: pythonCmdShim("wmux-agent-profile.py"),
  },
  {
    name: "wmux-agent-run.py",
    content: localScript("wmux-agent-run"),
  },
  {
    name: "wmux-agent-run.cmd",
    content: pythonCmdShim("wmux-agent-run.py"),
  },
  {
    name: "wmux_agent_contract.py",
    content: localScript("wmux_agent_contract.py"),
  },
];

const windowsStreamConfig = (machine: MachineConfig, bindHost: string): Record<string, unknown> => {
  const streamHost = process.env.WMUX_STREAM_HOST ?? process.env.WMUX_HOST ?? bindHost;
  const wmuxPort = process.env.WMUX_PORT ?? "3478";
  const wmuxUrl = resolveHelperUrl(`http://${streamHost}:${wmuxPort}`);
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
  backend: "auto",
  heartbeatOwner: true,
  heartbeatEnabled: true,
  heartbeatIntervalSeconds: 30,
  // When set, the agent requires this bearer token on every request, closing
  // the unauthenticated-RCE exposure to other hosts on the tailnet.
  ...(machine.agentToken ? { token: machine.agentToken } : {}),
});

// Canonical OSC 7 cwd-reporting prompt snippet. scripts/wmux-windows-agent
// embeds a byte-identical copy (it must run standalone on the Windows host);
// test/osc7.test.ts asserts the two never drift.
export const windowsCwdPromptSnippet = (): string => localWindowsHelperScript("wmux-cwd-prompt.ps1");

export const expectedWindowsAgentReleaseVersion = (): string => wmuxReleaseVersion("win");

export const expectedWindowsAgentProtocolVersion = (): number => {
  const match = localScript("wmux-windows-agent").match(/^PROTOCOL_VERSION = (\d+)/m);
  return Number(match?.[1] ?? 0);
};

const windowsAgentSource = (): string =>
  localScript("wmux-windows-agent").replaceAll(
    WINDOWS_AGENT_RELEASE_PLACEHOLDER,
    expectedWindowsAgentReleaseVersion(),
  );

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
