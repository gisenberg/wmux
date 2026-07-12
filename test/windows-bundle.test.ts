import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import {
  buildWindowsHelperBundle,
  buildWindowsPowerShellBootstrap,
  buildWindowsHealthProbeScript,
  expectedWindowsAgentVersion,
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

test("bundle stages heartbeat helpers and reports them as required", () => {
  const bundle = buildWindowsHelperBundle(machine);
  for (const name of ["wmux-heartbeat.ps1", "wmux-heartbeat.cmd", "wmux-heartbeat-service.ps1"]) {
    assert.ok(bundle.files.some((file) => file.name === name), `bundle includes ${name}`);
  }
  const healthProbe = buildWindowsHealthProbeScript("http://127.0.0.1:3478");
  assert.match(healthProbe, /wmux-heartbeat\.ps1/);
  assert.match(healthProbe, /wmux-heartbeat-service\.ps1/);
});

test("Windows agent config prefers ConPTY with stdio fallback", () => {
  assert.equal(buildWindowsHelperBundle(machine).agentConfig.backend, "auto");
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
  assert.ok(content.includes(".wmux\\url"), "agent-event helper must fall back to the staged URL");
  assert.ok(content.includes("$HookEvent -eq 'UserPromptSubmit'"), "Claude start hooks must be recognized");
  assert.ok(content.includes("$Summary = 'claude running'"), "Claude start hooks must emit a fresh running summary");
  assert.ok(content.includes("$Message = ''"), "start hooks must discard the previous assistant response");
  assert.ok(content.includes("-TimeoutSec 10"), "agent events must not hang indefinitely during delivery");
  assert.ok(content.includes("hook is missing WMUX_PANE_ID"), "missing hook context must be observable");
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
  const script = buildWindowsPowerShellBootstrap(machine, undefined, { WMUX_TOKEN: "fixed-token" });
  assert.ok(script.includes("Join-Path $StateDir 'token'"), "bootstrap must write the token fallback file");
  assert.ok(script.includes("Join-Path $StateDir 'url'"), "bootstrap must write the URL fallback file");
});

test("health probe reports the staged and expected bundle versions", () => {
  const script = buildWindowsHealthProbeScript("http://10.0.0.1:3478");
  assert.ok(script.includes(`'${windowsHelperBundleVersion()}'`), "probe must bake in the expected version");
  assert.ok(script.includes("bundleVersion"));
  assert.ok(script.includes("helpersCurrent"));
});

test("expected agent version reads the shipped script's VERSION constant", () => {
  assert.match(expectedWindowsAgentVersion(), /^\d+\.\d+$/);
});

test("Windows agent service drains staged updates and refuses unsafe restarts", () => {
  const bundle = buildWindowsHelperBundle(machine);
  const helper = bundle.files.find((file) => file.name === "wmux-windows-agent-service.ps1");
  assert.ok(helper, "bundle includes wmux-windows-agent-service.ps1");
  const content = Buffer.from(helper.dataBase64, "base64").toString("utf8");
  assert.ok(content.includes("'activate-update'"));
  assert.ok(content.includes("'/drain'"));
  assert.ok(content.includes("restartWhenIdle"));
  assert.ok(content.includes("Refusing to restart"));
  assert.ok(content.includes("restart --force"));
  assert.ok(content.includes("$RestartTaskName"));
  assert.ok(content.includes("Register-ScheduledTask -TaskName $RestartTaskName"));
  assert.ok(!content.includes("Start-Process -FilePath $PowerShell"));
});
