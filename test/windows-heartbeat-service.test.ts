import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildWindowsHelperBundle } from "../src/server/windows-helpers.js";
import type { MachineConfig } from "../src/server/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const machine: MachineConfig = {
  id: "winbox",
  name: "winbox",
  kind: "powershell-ssh",
  host: "win.ts.net",
};

test("packaged Windows agent owns heartbeat and retires the legacy task", () => {
  const bundle = buildWindowsHelperBundle(machine);
  assert.equal(bundle.files.some((file) => file.name === "wmux-heartbeat-service.ps1"), false);
  const helper = bundle.files.find((file) => file.name === "wmux-windows-agent-service.ps1");
  assert.ok(helper, "bundle includes wmux-windows-agent-service.ps1");
  const source = Buffer.from(helper.dataBase64, "base64").toString("utf8");

  assert.match(source, /function Remove-LegacyHeartbeatTask/);
  assert.match(source, /Unregister-ScheduledTask -TaskName \$LegacyHeartbeatTaskName/);
  assert.match(source, /CommandLine -like '\*wmux-heartbeat\*\.ps1\*'/);
  assert.match(source, /heartbeatEnabled -NotePropertyValue \$false/);
  assert.match(source, /function Remove-LegacyStreamTask/);
  assert.match(source, /Unregister-ScheduledTask -TaskName \$LegacyStreamTaskName/);
  assert.match(source, /streamOwner -NotePropertyValue \$false/);
  const stopBlock = source.slice(source.indexOf("'stop' {"), source.indexOf("'status' {"));
  assert.match(stopBlock, /Remove-LegacyHeartbeatTask/);

  const agent = bundle.files.find((file) => file.name === "wmux-windows-agent.py");
  assert.ok(agent);
  const agentSource = Buffer.from(agent.dataBase64, "base64").toString("utf8");
  assert.match(agentSource, /def retire_legacy_heartbeat_task/);
  assert.match(agentSource, /retire_legacy_heartbeat_task\(config\)/);
  assert.match(agentSource, /wmux-heartbeat-service\.ps1/);

  const setup = fs.readFileSync(path.join(repoRoot, "scripts/windows/wmux-windows-setup.ps1"), "utf8");
  assert.doesNotMatch(setup, /'install-heartbeat' \{/);
  assert.match(setup, /heartbeatManagedByAgent = \$true/);
});

test("Windows setup propagates helper process exit codes", () => {
  const source = fs.readFileSync(path.join(repoRoot, "scripts/windows/wmux-windows-setup.ps1"), "utf8");
  const invokeHelper = source.slice(
    source.indexOf("function Invoke-WmuxHelper"),
    source.indexOf("function Test-WmuxUrl"),
  );

  assert.match(invokeHelper, /\$global:LASTEXITCODE = 0/);
  assert.match(invokeHelper, /& \$HelperPath @HelperArgs/);
  assert.match(invokeHelper, /\$ExitCode = \[int\]\$global:LASTEXITCODE/);
  assert.match(invokeHelper, /if \(\$ExitCode -ne 0\) \{\s*exit \$ExitCode\s*\}/);
});

test("Windows setup exposes password-mode installation and redacted readiness diagnostics", () => {
  const source = fs.readFileSync(path.join(repoRoot, "scripts/windows/wmux-windows-setup.ps1"), "utf8");

  assert.match(source, /install-agent \[--logon-type Interactive\|S4U\|Password\]/);
  assert.match(source, /'refresh-agent-credentials' \{/);
  assert.match(source, /Invoke-WmuxHelper 'wmux-windows-agent-service' \(@\('install'\) \+ \$ActionArgs\)/);
  assert.match(source, /agentTaskLogonType = \$AgentLogonType/);
  assert.match(source, /agentStartsWithoutLogin = \$AgentLogonType -in @\('Password', 'S4U'\)/);
  assert.match(source, /agentNetworkCredentialsAvailable = \$AgentLogonType -eq 'Password'/);
  assert.match(source, /agentGenerationSlotsReady/);
  assert.doesNotMatch(source, /WMUX_WINDOWS_AGENT_PASSWORD/);
});

test(
  "Windows setup returns the agent helper's native exit code",
  { skip: process.platform !== "win32" },
  () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-helper-exit-"));
    try {
      fs.writeFileSync(path.join(tempDir, "wmux-windows-agent-service.cmd"), "@echo off\r\nexit /b 23\r\n");
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(repoRoot, "scripts/windows/wmux-windows-setup.ps1"),
          "install-agent",
        ],
        {
          encoding: "utf8",
          env: { ...process.env, PATH: `${tempDir};${process.env.PATH ?? ""}` },
        },
      );
      assert.equal(result.status, 23, result.stderr || result.stdout);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
);
