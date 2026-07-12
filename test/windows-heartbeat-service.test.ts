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

test("packaged heartbeat task uses the full identity and verifies installation before reporting success", () => {
  const bundle = buildWindowsHelperBundle(machine);
  const helper = bundle.files.find((file) => file.name === "wmux-heartbeat-service.ps1");
  assert.ok(helper, "bundle includes wmux-heartbeat-service.ps1");
  const source = Buffer.from(helper.dataBase64, "base64").toString("utf8");

  assert.match(source, /WindowsIdentity\]::GetCurrent\(\)\.Name/);
  assert.match(source, /New-ScheduledTaskTrigger -AtLogOn -User \$Identity/);
  assert.match(source, /New-ScheduledTaskPrincipal -UserId \$Identity -LogonType Interactive/);
  assert.doesNotMatch(source, /New-ScheduledTaskPrincipal -UserId \$env:USERNAME/);
  const identityAt = source.indexOf("$Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name");
  const triggerAt = source.indexOf("New-ScheduledTaskTrigger -AtLogOn -User $Identity");
  assert.ok(identityAt >= 0 && identityAt < triggerAt, "identity is resolved before constructing the trigger");
  assert.match(
    source,
    /Register-ScheduledTask -TaskName \$TaskName -InputObject \$Task -Force -ErrorAction Stop/,
  );
  assert.equal(
    source.match(/Start-ScheduledTask -TaskName \$TaskName -ErrorAction Stop/g)?.length,
    2,
    "install and restart both make task-start failures terminating",
  );

  const registerAt = source.indexOf("Register-ScheduledTask -TaskName $TaskName");
  const startAt = source.indexOf("Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop", registerAt);
  const verifyAt = source.indexOf("Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop", startAt);
  const installedAt = source.indexOf('Write-Output "Installed $TaskName"', verifyAt);
  assert.ok(registerAt >= 0 && registerAt < startAt, "registration precedes task start");
  assert.ok(startAt < verifyAt, "task start precedes verification");
  assert.ok(verifyAt < installedAt, "verification precedes the success message");
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

test(
  "Windows setup returns a native helper's exit code",
  { skip: process.platform !== "win32" },
  () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-helper-exit-"));
    try {
      fs.writeFileSync(path.join(tempDir, "wmux-heartbeat-service.cmd"), "@echo off\r\nexit /b 23\r\n");
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
          "install-heartbeat",
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
