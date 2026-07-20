import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import {
  buildWindowsHelperBundle,
  buildWindowsPowerShellBootstrap,
  buildWindowsPowerShellBootstrapUrl,
  buildWindowsHealthProbeScript,
  expectedWindowsAgentProtocolVersion,
  expectedWindowsAgentReleaseVersion,
  windowsHelperBundleVersion,
} from "../src/server/windows-helpers.js";
import type { MachineConfig } from "../src/server/types.js";

const machine: MachineConfig = { id: "winbox", name: "winbox", kind: "powershell-ssh", host: "win.ts.net" };

test("bundle files carry correct sha256 digests and a stable version", () => {
  const bundle = buildWindowsHelperBundle(machine);
  assert.ok(bundle.files.length > 0);
  for (const file of bundle.files) {
    const digest = crypto.createHash("sha256").update(Buffer.from(file.dataBase64, "base64")).digest("hex");
    assert.equal(file.sha256, digest, `sha256 mismatch for ${file.name}`);
  }
  assert.match(bundle.bundleVersion, /^[0-9a-f]{16}$/);
  assert.equal(bundle.bundleVersion, windowsHelperBundleVersion());
  assert.equal(buildWindowsHelperBundle(machine).bundleVersion, bundle.bundleVersion);
});

test("bundle stages the one-shot heartbeat diagnostic without a standalone service", () => {
  const bundle = buildWindowsHelperBundle(machine);
  for (const name of ["wmux-heartbeat.ps1", "wmux-heartbeat.cmd"]) {
    assert.ok(bundle.files.some((file) => file.name === name), `bundle includes ${name}`);
  }
  assert.equal(bundle.files.some((file) => file.name === "wmux-heartbeat-service.ps1"), false);
  const healthProbe = buildWindowsHealthProbeScript("http://127.0.0.1:3478");
  assert.match(healthProbe, /wmux-heartbeat\.ps1/);
  assert.doesNotMatch(healthProbe, /wmux-heartbeat-service\.ps1/);
  assert.match(healthProbe, /heartbeatManagedByAgent/);
});

test("bundle stages and runs the agent profile helper", () => {
  const bundle = buildWindowsHelperBundle(machine);
  assert.ok(bundle.files.some((file) => file.name === "wmux-agent-profile.py"));
  assert.ok(bundle.files.some((file) => file.name === "wmux-agent-profile.cmd"));
  const bootstrap = buildWindowsPowerShellBootstrap(machine, undefined, {});
  assert.match(bootstrap, /wmux-agent-profile\.cmd/);
  assert.match(bootstrap, /apply --quiet/);
});

test("registered Windows bootstrap makes missing profile auth optional", () => {
  const bootstrap = buildWindowsPowerShellBootstrap({ ...machine, source: "registered" }, undefined, {});
  assert.match(bootstrap, /wmux-agent-profile\.cmd/);
  assert.match(bootstrap, /apply --quiet --optional-auth/);
});

test("Windows bootstrap wraps profile prompts only when profile loading is enabled", () => {
  const defaultBootstrap = buildWindowsPowerShellBootstrap(machine, undefined, {});
  const profileBootstrap = buildWindowsPowerShellBootstrap(
    { ...machine, loadPowerShellProfile: true },
    undefined,
    {},
  );
  assert.match(defaultBootstrap, /__wmuxInstallPrompt \$false/);
  assert.match(profileBootstrap, /__wmuxInstallPrompt \$true/);
  assert.match(profileBootstrap, /__wmuxOriginalPrompt/);
  assert.match(profileBootstrap, /Set-PSReadLineOption -PredictionSource None/);
  assert.match(profileBootstrap, /\$ErrorActionPreference = \$WmuxOriginalErrorActionPreference/);
});

test("Windows agent config prefers ConPTY with stdio fallback", () => {
  assert.equal(buildWindowsHelperBundle(machine).agentConfig.backend, "auto");
  assert.equal(buildWindowsHelperBundle(machine).agentConfig.heartbeatOwner, true);
  assert.equal(buildWindowsHelperBundle(machine).agentConfig.heartbeatEnabled, true);
  assert.equal(buildWindowsHelperBundle(machine).agentConfig.heartbeatIntervalSeconds, 30);
});

test("clipboard helper sends bearer auth and reads staged fallback files", () => {
  const bundle = buildWindowsHelperBundle(machine);
  const helper = bundle.files.find((file) => file.name === "wmux-copy.ps1");
  assert.ok(helper, "bundle includes wmux-copy.ps1");
  const content = Buffer.from(helper.dataBase64, "base64").toString("utf8");
  assert.ok(content.includes("Authorization"), "clipboard helper must send an auth header");
  assert.ok(content.includes("WMUX_TOKEN_PATH"), "clipboard helper must respect token path overrides");
  assert.ok(content.includes(".wmux\\token"), "clipboard helper must fall back to the staged token");
  assert.ok(content.includes(".wmux\\url"), "clipboard helper must fall back to the staged URL");
});

test("agent-event helper sends bearer auth and maps Claude start hooks to running", () => {
  const bundle = buildWindowsHelperBundle(machine);
  const helper = bundle.files.find((file) => file.name === "wmux-agent-event.ps1");
  assert.ok(helper, "bundle includes wmux-agent-event.ps1");
  const content = Buffer.from(helper.dataBase64, "base64").toString("utf8");
  assert.ok(content.includes("Authorization"), "agent-event helper must send an auth header");
  assert.ok(content.includes("WMUX_TOKEN_PATH"), "agent-event helper must respect token path overrides");
  assert.ok(content.includes(".wmux\\token"), "agent-event helper must fall back to the staged token");
  assert.ok(content.indexOf("$StateToken") < content.indexOf("return $env:WMUX_TOKEN"), "agent-event helper must prefer the refreshed token file");
  assert.ok(content.includes(".wmux\\url"), "agent-event helper must fall back to the staged URL");
  const stateIndex = content.indexOf("$StateUrl");
  const helperIndex = content.indexOf("WMUX_HELPER_URL");
  const publicIndex = content.indexOf("WMUX_PUBLIC_URL");
  const legacyIndex = content.indexOf("WMUX_URL");
  assert.ok(stateIndex >= 0 && stateIndex < helperIndex && helperIndex < publicIndex && publicIndex < legacyIndex, "agent-event URL precedence must favor refreshed state, helper, public, then legacy");
  assert.ok(content.includes("$HookEvent -eq 'UserPromptSubmit'"), "Claude start hooks must be recognized");
  assert.ok(content.includes("$Summary = 'claude running'"), "Claude start hooks must emit a fresh running summary");
  assert.ok(content.includes("$Message = ''"), "start hooks must discard the previous assistant response");
  assert.ok(content.includes("-TimeoutSec 10"), "agent events must not hang indefinitely during delivery");
  const contextGuardIndex = content.indexOf("if (-not $Force -and -not $PaneId -and -not $WorkspaceId)");
  const hookInputIndex = content.indexOf("$HookInput = if ($ClaudeHook -or $CodexHook)");
  assert.ok(contextGuardIndex >= 0 && contextGuardIndex < hookInputIndex, "missing hook context must return before hook input is processed");
  assert.ok(content.slice(contextGuardIndex, hookInputIndex).includes("exit 0"), "missing hook context must be a successful no-op");
});

test("Windows Codex hooks bypass the cmd shim and migrate wmux-owned entries", () => {
  const bundle = buildWindowsHelperBundle(machine);
  const helper = bundle.files.find((file) => file.name === "wmux-hooks.ps1");
  assert.ok(helper, "bundle includes wmux-hooks.ps1");
  const content = Buffer.from(helper.dataBase64, "base64").toString("utf8");
  assert.ok(content.includes("commandWindows"), "Codex hook must provide a Windows command override");
  assert.ok(content.includes("wmux-agent-event.ps1"), "Codex hook must invoke PowerShell directly");
  assert.ok(content.includes("$OwnedCommand"), "installer must migrate existing wmux hook entries");
});

test("bootstrap stages, verifies, then swaps and records the bundle version", () => {
  const script = buildWindowsPowerShellBootstrap(machine, undefined, {});
  assert.ok(script.includes(".staging-"), "bootstrap must stage into a scratch directory");
  assert.ok(script.includes("failed hash verification"), "bootstrap must verify file hashes");
  assert.ok(script.includes("bundle-version.json"), "bootstrap must record the staged bundle version");
});

test("bootstrap persists wmux auth fallback files for Windows helpers", () => {
  const script = buildWindowsPowerShellBootstrap(machine, undefined, { WMUX_TOKEN: "fixed-token", WMUX_HELPER_TOKEN: "H".repeat(43) });
  assert.ok(script.includes("Join-Path $StateDir 'token'"), "bootstrap must write the token fallback file");
  assert.ok(script.includes("Join-Path $StateDir 'helper-token'"), "bootstrap must write the scoped helper fallback file");
  assert.match(script, /elseif \(\$env:WMUX_HELPER_TOKEN\)/);
  assert.ok(script.includes("Join-Path $StateDir 'url'"), "bootstrap must write the URL fallback file");
});

test("bootstrap URL falls back from an empty capability to the static wmux token", () => {
  const url = new URL(buildWindowsPowerShellBootstrapUrl(machine, undefined, { WMUX_TOKEN: "static-token" }, ""));
  assert.equal(url.searchParams.get("token"), "static-token");
});

test("bootstrap URL prefers a registered-host capability over the broad wmux token", () => {
  const url = new URL(
    buildWindowsPowerShellBootstrapUrl(machine, undefined, { WMUX_TOKEN: "broad-token" }, "bootstrap-capability"),
  );
  assert.equal(url.searchParams.get("token"), "bootstrap-capability");
});

test("bootstrap URL omits credentials when neither token path is available", () => {
  const url = new URL(buildWindowsPowerShellBootstrapUrl(machine, undefined, {}, ""));
  assert.equal(url.searchParams.has("token"), false);
});

test("bootstrap URL carries terminal theme metadata into PowerShell", () => {
  const url = new URL(buildWindowsPowerShellBootstrapUrl(machine, undefined, {
    WMUX_COLOR_SCHEME: "tokyo-night",
    WMUX_COLOR_MODE: "dark",
    WMUX_TERMINAL_FOREGROUND: "#c0caf5",
    WMUX_TERMINAL_BACKGROUND: "#1a1b26",
    WMUX_TERMINAL_ANSI_PALETTE: "#15161e,#f7768e",
  }));
  assert.equal(url.searchParams.get("WMUX_COLOR_SCHEME"), "tokyo-night");
  assert.equal(url.searchParams.get("WMUX_COLOR_MODE"), "dark");
  assert.equal(url.searchParams.get("WMUX_TERMINAL_FOREGROUND"), "#c0caf5");
  assert.equal(url.searchParams.get("WMUX_TERMINAL_BACKGROUND"), "#1a1b26");
  assert.equal(url.searchParams.get("WMUX_TERMINAL_ANSI_PALETTE"), "#15161e,#f7768e");
  const script = buildWindowsPowerShellBootstrap(machine, undefined, {
    WMUX_COLOR_SCHEME: "tokyo-night",
    WMUX_COLOR_MODE: "dark",
    WMUX_TERMINAL_FOREGROUND: "#c0caf5",
    WMUX_TERMINAL_BACKGROUND: "#1a1b26",
    WMUX_TERMINAL_ANSI_PALETTE: "#15161e,#f7768e",
  });
  assert.match(script, /\$env:WMUX_COLOR_SCHEME = 'tokyo-night'/);
  assert.match(script, /\$env:WMUX_COLOR_MODE = 'dark'/);
  assert.match(script, /wmux-console-theme\.ps1/);
});

test("Windows console theme helper applies the pane-local ConPTY color table", () => {
  const bundle = buildWindowsHelperBundle(machine);
  const helper = bundle.files.find((file) => file.name === "wmux-console-theme.ps1");
  assert.ok(helper, "bundle includes wmux-console-theme.ps1");
  const content = Buffer.from(helper.dataBase64, "base64").toString("utf8");
  assert.match(content, /GetConsoleScreenBufferInfoEx/);
  assert.match(content, /SetConsoleScreenBufferInfoEx/);
  assert.match(content, /\$AnsiForWindows = @\(0, 4, 2, 6, 1, 5, 3, 7, 8, 12, 10, 14, 9, 13, 11, 15\)/);
  assert.match(content, /\$Colors\[0\] = __wmuxColorRef \$env:WMUX_TERMINAL_BACKGROUND/);
  assert.match(content, /\$Colors\[7\] = __wmuxColorRef \$env:WMUX_TERMINAL_FOREGROUND/);
});

test("Windows bootstrap stages the helper callback URL ahead of the public URL", () => {
  const saved = { ...process.env };
  try {
    process.env.WMUX_HELPER_URL = "http://10.0.0.2:3478";
    process.env.WMUX_PUBLIC_URL = "https://wmux.tailnet.ts.net";
    const script = buildWindowsPowerShellBootstrap(machine, undefined, {});
    assert.ok(script.includes("http://10.0.0.2:3478"));
    assert.equal(script.includes("https://wmux.tailnet.ts.net"), false);
  } finally {
    process.env = saved;
  }
});

test("health probe reports the staged and expected bundle versions", () => {
  const script = buildWindowsHealthProbeScript("http://10.0.0.1:3478");
  assert.ok(script.includes(`'${windowsHelperBundleVersion()}'`), "probe must bake in the expected version");
  assert.ok(script.includes("bundleVersion"));
  assert.ok(script.includes("helpersCurrent"));
});

test("agent bundle uses the platform release and exposes protocol compatibility separately", () => {
  assert.match(expectedWindowsAgentReleaseVersion(), /^v\d+\.\d+\.\d+-win$/);
  assert.equal(expectedWindowsAgentProtocolVersion(), 5);
  const agent = buildWindowsHelperBundle(machine).files.find((file) => file.name === "wmux-windows-agent.py");
  assert.ok(agent);
  const content = Buffer.from(agent.dataBase64, "base64").toString("utf8");
  assert.ok(content.includes(`RELEASE_VERSION = "${expectedWindowsAgentReleaseVersion()}"`));
  assert.ok(content.includes(`PROTOCOL_VERSION = ${expectedWindowsAgentProtocolVersion()}`));
  assert.ok(content.includes('"paste-images-v1"'));
  assert.ok(content.includes('"registration-heartbeat-v1"'));
  assert.ok(content.includes("MAX_PASTE_IMAGE_BYTES = 8 * 1024 * 1024"));
  assert.ok(!content.includes("__WMUX_WINDOWS_AGENT_RELEASE_VERSION__"));
});

test("Windows agent service drains staged updates and refuses unsafe restarts", () => {
  const bundle = buildWindowsHelperBundle(machine);
  const helper = bundle.files.find((file) => file.name === "wmux-windows-agent-service.ps1");
  assert.ok(helper, "bundle includes wmux-windows-agent-service.ps1");
  const content = Buffer.from(helper.dataBase64, "base64").toString("utf8");
  assert.ok(content.includes("'activate-update'"));
  assert.ok(content.includes("'/drain'"));
  assert.ok(content.includes("restartWhenIdle"));
  assert.ok(content.includes("Start-UpdateRestartWatcher"));
  assert.ok(content.includes("[string]$Main.State -ne 'Running'"));
  assert.ok(content.includes("allowNewSessions = $true"));
  assert.ok(content.includes("New panes remain available"));
  assert.ok(content.includes("Refusing to restart"));
  assert.ok(content.includes("restart --force"));
  assert.ok(content.includes("$RestartTaskName"));
  assert.ok(content.includes("Register-ScheduledTask -TaskName $RestartTaskName"));
  assert.ok(content.includes("New-WmuxTaskTriggers"));
  assert.ok(content.includes("New-ScheduledTaskTrigger -AtLogOn -User $Identity"));
  assert.ok(content.includes("RepetitionInterval (New-TimeSpan -Minutes 1)"));
  assert.ok(content.includes("-MultipleInstances IgnoreNew"));
  assert.ok(content.includes("Disable-ScheduledTask -TaskName $TaskName"));
  assert.ok(content.includes("Get-AgentGenerationTasks"));
  assert.ok(content.includes("Remove-LegacyHeartbeatTask"));
  assert.ok(content.includes("heartbeatEnabled -NotePropertyValue $false"));
  assert.ok(content.includes("heartbeatOwner -NotePropertyValue $false"));
  assert.ok(content.includes("'retire-generation'"));
  assert.ok(content.includes("function Remove-AgentGeneration"));
  assert.ok(content.includes("the base agent cannot be retired"));
  assert.ok(content.includes("restartWhenIdle = $false"));
  assert.ok(content.includes("refusing to retire generation $Port with $ActiveSessions active pane session(s)"));
  assert.ok(!content.includes("Start-Process -FilePath $PowerShell"));
});

test("Windows setup manages the bounded agent firewall range", () => {
  const bundle = buildWindowsHelperBundle(machine);
  const helper = bundle.files.find((file) => file.name === "wmux-windows-setup.ps1");
  assert.ok(helper, "bundle includes wmux-windows-setup.ps1");
  const content = Buffer.from(helper.dataBase64, "base64").toString("utf8");
  assert.ok(content.includes("$AgentRolloutPortCount = 8"));
  assert.ok(content.includes("'configure-agent-firewall'"));
  assert.ok(content.includes("$BasePort + $AgentRolloutPortCount"));
  assert.ok(content.includes("Test-IsInternalAddress"));
  assert.ok(content.includes("Test-AreExactInternalAddresses $RemoteAddresses"));
  assert.ok(content.includes("-RemoteAddress $ValidatedAddresses"));
  assert.ok(content.includes("Windows agent rollouts require inbound TCP"));
});
