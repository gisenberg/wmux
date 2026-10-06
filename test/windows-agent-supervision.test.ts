import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { windowsAgentSupervisionDetail } from "../src/server/machine-health.js";
import { buildWindowsHealthProbeScript, buildWindowsHelperBundle } from "../src/server/windows-helpers.js";
import type { MachineConfig } from "../src/server/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const machine: MachineConfig = { id: "winbox", name: "winbox", kind: "powershell-ssh", host: "win.ts.net" };
const shellAvailable = (shell: string): boolean => process.platform === "win32"
  && spawnSync(shell, ["-NoLogo", "-NoProfile", "-Command", "exit 0"], { encoding: "utf8" }).status === 0;
const windowsPwsh = shellAvailable("pwsh");
// Task wrappers run under Windows PowerShell 5.1, whose native-argument
// quoting differs from PowerShell 7.
const windowsPowerShell = shellAvailable("powershell.exe");

const readScript = (name: string): string =>
  fs.readFileSync(path.join(repoRoot, "scripts", "windows", name), "utf8");

const bundleFile = (name: string): string => {
  const file = buildWindowsHelperBundle(machine).files.find((candidate) => candidate.name === name);
  assert.ok(file, `bundle includes ${name}`);
  return Buffer.from(file.dataBase64, "base64").toString("utf8");
};

const runPwsh = (script: string, shell = "pwsh"): { status: number | null; stdout: string; stderr: string } => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-supervision-script-"));
  const scriptPath = path.join(directory, "run.ps1");
  fs.writeFileSync(scriptPath, script);
  try {
    const result = spawnSync(
      shell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { encoding: "utf8" },
    );
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

const imageResolverSource = (): string => {
  const service = readScript("wmux-windows-agent-service.ps1");
  const match = /\$AgentImageResolver = @'\r?\n([\s\S]*?)\r?\n'@/.exec(service);
  assert.ok(match, "service script defines the embedded image resolver");
  return match[1];
};

test("the helper bundle ships the shared supervision policy that both helpers load", () => {
  const policy = bundleFile("wmux-agent-task-supervision.ps1");
  assert.match(policy, /function Get-WmuxAgentTaskSupervision/);
  assert.equal(policy, readScript("wmux-agent-task-supervision.ps1"));
  assert.ok(!buildWindowsHelperBundle(machine).files.some((file) => file.name === "wmux-agent-task-supervision.cmd"));
  assert.match(bundleFile("wmux-windows-agent-service.ps1"), /\. \(Join-Path \$PSScriptRoot 'wmux-agent-task-supervision\.ps1'\)/);
  assert.match(bundleFile("wmux-windows-setup.ps1"), /Join-Path \$PSScriptRoot 'wmux-agent-task-supervision\.ps1'/);
});

test("task helpers make CDXML task and firewall failures fatal even when stderr is merged", () => {
  for (const name of ["wmux-windows-agent-service.ps1", "wmux-windows-setup.ps1", "wmux-stream-agent-service.ps1"]) {
    assert.match(
      readScript(name),
      /\$PSDefaultParameterValues\['\*-ScheduledTask\*:ErrorAction'\] = 'Stop'/,
      `${name} defaults ScheduledTasks cmdlets to -ErrorAction Stop`,
    );
  }
  assert.match(readScript("wmux-windows-setup.ps1"), /\$PSDefaultParameterValues\['\*-NetFirewall\*:ErrorAction'\] = 'Stop'/);
  const service = readScript("wmux-windows-agent-service.ps1");
  assert.match(service, /FullyQualifiedErrorId -notlike 'HRESULT 0x80070005,\*'/);
  assert.match(service, /owned by Administrators; rerun install-agent over SSH or from an elevated PowerShell/);
});

test("agent updates reconcile task supervision and launch wrappers before touching agents", () => {
  const service = readScript("wmux-windows-agent-service.ps1");
  for (const action of ["'activate-update'", "'rollout-update'", "'repair-supervision'"]) {
    const start = service.indexOf(`  ${action} {`);
    assert.ok(start > 0, `${action} exists`);
    const body = service.slice(start, service.indexOf("\n  }", start));
    const wrappers = body.indexOf("Update-AgentWrappers");
    const repair = body.indexOf("Repair-AgentTaskSupervision");
    assert.ok(wrappers > 0 && repair > wrappers, `${action} rewrites wrappers, then repairs supervision`);
  }
  const activate = service.slice(service.indexOf("  'activate-update' {"));
  assert.ok(activate.indexOf("Repair-AgentTaskSupervision") < activate.indexOf("Invoke-AgentRequest"));
  const rollout = service.slice(service.indexOf("  'rollout-update' {"));
  assert.ok(rollout.indexOf("Repair-AgentTaskSupervision") < rollout.indexOf("Start-AgentGeneration"));
  assert.match(service, /\$Settings\.Enabled = \$Task\.Settings\.Enabled/);
  assert.match(service, /\$Task \| Set-ScheduledTask -ErrorAction Stop/);
  assert.match(readScript("wmux-windows-setup.ps1"), /'repair-agent-supervision' \{\r?\n\s+Invoke-WmuxHelper 'wmux-windows-agent-service' @\('repair-supervision'\)/);
});

test("task wrappers launch the agent through its own staged image", () => {
  const service = readScript("wmux-windows-agent-service.ps1");
  assert.match(service, /\$AgentImageResolver\r?\n`\$Interpreter = Resolve-WmuxAgentInterpreter -Launcher/);
  const resolver = imageResolverSource();
  assert.match(resolver, /\$ImageName = 'wmux-windows-agent\.exe'/);
  assert.match(resolver, /'Local\\wmux-windows-agent-image'/);
  assert.ok(!resolver.includes("'@"), "resolver must stay embeddable in a single-quoted here-string");
});

test("the health probe reports agent supervision with the shared policy", () => {
  const script = buildWindowsHealthProbeScript("http://100.64.0.1:3478");
  assert.ok(script.includes(readScript("wmux-agent-task-supervision.ps1")));
  assert.match(script, /agentTaskSupervised = /);
  assert.match(script, /agentTaskSupervisionIssues = /);
  assert.match(script, /agentGenerationTasksUnsupervised = \$AgentGenerationTasksUnsupervised/);
  assert.match(script, /'\^wmux-windows-agent-\\d\+\$'/);
  assert.match(script, /agentExecutable = /);
  assert.match(script, /-Headers \$AgentHeaders -TimeoutSec 3/);
});

test("host detail warns about agent tasks without crash supervision", () => {
  assert.equal(windowsAgentSupervisionDetail({ agentTaskSupervised: true, agentExecutable: "wmux-windows-agent.exe" }), "");
  assert.equal(windowsAgentSupervisionDetail({}), "");
  assert.equal(
    windowsAgentSupervisionDetail({
      agentTaskSupervised: false,
      agentTaskSupervisionIssues: ["no-restart-trigger", "priority-7"],
      agentGenerationTasksUnsupervised: ["wmux-windows-agent-3482", "wmux-windows-agent-3483"],
      agentExecutable: "python.exe",
    }),
    " as python.exe [WARN] no crash supervision for base (no-restart-trigger, priority-7) and ports 3482 3483"
      + " (run wmux-windows-setup repair-agent-supervision)",
  );
  assert.doesNotMatch(
    windowsAgentSupervisionDetail({ agentTaskSupervised: false, agentTaskSupervisionIssues: ["no-restart-trigger"] }),
    /;/,
    "backend detail segments are semicolon-delimited",
  );
});

test("supervision policy classifies real Scheduled Task definitions", { skip: !windowsPwsh }, () => {
  const policyPath = path.join(repoRoot, "scripts", "windows", "wmux-agent-task-supervision.ps1").replace(/'/g, "''");
  const result = runPwsh(`
$ErrorActionPreference = 'Stop'
. '${policyPath}'
$Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$Action = New-ScheduledTaskAction -Execute 'cmd.exe'
$Good = New-ScheduledTask -Action $Action -Trigger @(
  New-ScheduledTaskTrigger -AtLogOn -User $Identity
  New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
) -Settings (New-ScheduledTaskSettingsSet -Priority 4 -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew)
$Legacy = New-ScheduledTask -Action $Action -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $Identity) -Settings (New-ScheduledTaskSettingsSet -MultipleInstances Parallel)
$Bounded = New-ScheduledTask -Action $Action -Trigger @(
  New-ScheduledTaskTrigger -AtLogOn -User $Identity
  New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 1)
) -Settings (New-ScheduledTaskSettingsSet -Priority 4 -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew)
[ordered]@{
  good = Get-WmuxAgentTaskSupervision $Good
  legacy = Get-WmuxAgentTaskSupervision $Legacy
  bounded = Get-WmuxAgentTaskSupervision $Bounded
  missing = Get-WmuxAgentTaskSupervision $null
} | ConvertTo-Json -Depth 4 -Compress
`);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.deepEqual(report.good, { supervised: true, issues: [] });
  assert.equal(report.legacy.supervised, false);
  assert.deepEqual(
    [...report.legacy.issues].sort(),
    ["execution-time-limit", "multiple-instances", "no-restart-trigger", "priority-7"].sort(),
  );
  assert.deepEqual(report.bounded, { supervised: false, issues: ["no-restart-trigger"] });
  assert.deepEqual(report.missing, { supervised: false, issues: ["missing"] });
});

for (const shell of ["powershell.exe", "pwsh"]) test(
  `the image resolver stages, refreshes, and falls back without losing a launch (${shell})`,
  { skip: !(shell === "pwsh" ? windowsPwsh : windowsPowerShell) },
  () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-agent-image-"));
  try {
    const pythonDir = path.join(directory, "python");
    fs.mkdirSync(pythonDir);
    const source = path.join(pythonDir, "python.exe");
    fs.writeFileSync(source, "interpreter-v1");
    const launcher = path.join(directory, "fake-py.cmd");
    const launcherArgs = path.join(directory, "launcher-args.txt");
    fs.writeFileSync(launcher, `@echo %*> "${launcherArgs}"\r\n@echo ${source}\r\n`);
    const missingLauncher = path.join(directory, "missing-py.cmd");
    fs.writeFileSync(missingLauncher, `@echo ${path.join(directory, "absent", "python.exe")}\r\n`);
    const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
    const result = runPwsh(`
$ErrorActionPreference = 'Stop'
${imageResolverSource()}
$Source = ${literal(source)}
$Image = Join-Path (Split-Path -Parent $Source) 'wmux-windows-agent.exe'
$Launcher = ${literal(launcher)}
$Report = [ordered]@{}
$First = Resolve-WmuxAgentInterpreter -Launcher $Launcher -LauncherArgs @('-3')
$Report.first = $First.exe
$Report.firstArgs = @($First.args).Count
$Report.copied = [string](Get-Content -LiteralPath $Image -Raw)
$Stamp = (Get-Item -LiteralPath $Image).LastWriteTimeUtc
Start-Sleep -Milliseconds 50
$null = Resolve-WmuxAgentInterpreter -Launcher $Launcher -LauncherArgs @()
$Report.unchangedWhenCurrent = ((Get-Item -LiteralPath $Image).LastWriteTimeUtc -eq $Stamp)
# A running agent maps its image: no overwrite, but renames are allowed.
# (A real mapped image also refuses deletion, so its retired copy lingers
# until a later launch; this handle only models the rename.)
$Running = [System.IO.File]::Open($Image, 'Open', 'Read', [System.IO.FileShare]'Read, Delete')
Set-Content -LiteralPath $Source -Value 'interpreter-v2' -NoNewline
$Swapped = Resolve-WmuxAgentInterpreter -Launcher $Launcher -LauncherArgs @()
$Report.swapped = $Swapped.exe
$Report.swappedContent = [string](Get-Content -LiteralPath $Image -Raw)
$Running.Dispose()
$null = Resolve-WmuxAgentInterpreter -Launcher $Launcher -LauncherArgs @()
$Report.retiredAfterExit = @(Get-ChildItem -LiteralPath (Split-Path -Parent $Image) -Filter '*.old').Count
# An image that cannot even be renamed falls back to the real interpreter.
$Locked = [System.IO.File]::Open($Image, 'Open', 'Read', [System.IO.FileShare]'Read')
Set-Content -LiteralPath $Source -Value 'interpreter-v3' -NoNewline
$Fallback = Resolve-WmuxAgentInterpreter -Launcher $Launcher -LauncherArgs @()
$Locked.Dispose()
$Report.lockedFallback = $Fallback.exe
$Report.strayStaging = @(Get-ChildItem -LiteralPath (Split-Path -Parent $Image) -Filter '*.new').Count
$Missing = Resolve-WmuxAgentInterpreter -Launcher ${literal(missingLauncher)} -LauncherArgs @('-3')
$Report.missingLauncher = $Missing.exe
$Report.missingArgs = @($Missing.args)
$Report | ConvertTo-Json -Compress
`, shell);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fs.readFileSync(launcherArgs, "utf8").trim(),
      `-c "import sys; print(getattr(sys, '_base_executable', None) or sys.executable)"`,
      "the interpreter probe reaches the launcher intact",
    );
    const report = JSON.parse(result.stdout.trim());
    const image = path.join(pythonDir, "wmux-windows-agent.exe");
    assert.equal(report.first, image);
    assert.equal(report.firstArgs, 0, "the staged image runs directly, without the py.exe launcher");
    assert.equal(report.copied, "interpreter-v1");
    assert.equal(report.unchangedWhenCurrent, true);
    assert.equal(report.swapped, image);
    assert.equal(report.swappedContent, "interpreter-v2");
    assert.equal(report.retiredAfterExit, 0);
    assert.equal(report.lockedFallback, source);
    assert.equal(report.strayStaging, 0);
    assert.equal(report.missingLauncher, missingLauncher);
    assert.deepEqual(report.missingArgs, ["-3"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  },
);
