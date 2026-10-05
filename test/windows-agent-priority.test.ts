import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { buildWindowsHelperBundle } from "../src/server/windows-helpers.js";

const agentPath = path.resolve("scripts/wmux-windows-agent");

const findPython = (): { command: string; args: string[] } | null => {
  const candidates =
    process.platform === "win32"
      ? [
          { command: "py", args: ["-3"] },
          { command: "python", args: [] },
        ]
      : [
          { command: "python3", args: [] },
          { command: "python", args: [] },
        ];
  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, [...candidate.args, "--version"], { stdio: "ignore" });
    if (result.status === 0) return candidate;
  }
  return null;
};

const runAgentModuleScript = (python: { command: string; args: string[] }, body: string) => {
  const script = String.raw`
import importlib.machinery
import importlib.util
import os

path = os.environ["WMUX_AGENT_PATH"]
loader = importlib.machinery.SourceFileLoader("wmux_agent_priority_test", path)
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)
` + body;
  return spawnSync(python.command, [...python.args, "-c", script], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", WMUX_AGENT_PATH: agentPath },
  });
};

test(
  "Windows agent raises its CPU priority, restores normal I/O and memory priority, and keeps children normal",
  { skip: process.platform !== "win32" ? "Windows process priority" : false },
  (t) => {
    const python = findPython();
    if (!python) {
      t.skip("python not available");
      return;
    }
    const result = runAgentModuleScript(python, String.raw`
import ctypes
import subprocess
import sys
from ctypes import wintypes

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
ntdll = ctypes.WinDLL("ntdll")
kernel32.GetCurrentProcess.restype = wintypes.HANDLE
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
for name in ("GetProcessInformation", "SetProcessInformation"):
    getattr(kernel32, name).argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
kernel32.GetPriorityClass.argtypes = [wintypes.HANDLE]
kernel32.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
for name in ("NtQueryInformationProcess", "NtSetInformationProcess"):
    getattr(ntdll, name).restype = ctypes.c_long
ntdll.NtQueryInformationProcess.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.ULONG, ctypes.c_void_p]
ntdll.NtSetInformationProcess.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.ULONG]

def priorities(handle):
    memory = wintypes.ULONG(0)
    assert kernel32.GetProcessInformation(handle, 0, ctypes.byref(memory), 4)
    io = wintypes.ULONG(0)
    assert ntdll.NtQueryInformationProcess(handle, 33, ctypes.byref(io), 4, None) == 0
    return kernel32.GetPriorityClass(handle), memory.value, io.value

current = kernel32.GetCurrentProcess()
# Reproduce a Scheduled Task launched at the default priority 7.
assert kernel32.SetPriorityClass(current, 0x4000)
low_memory = wintypes.ULONG(2)
assert kernel32.SetProcessInformation(current, 0, ctypes.byref(low_memory), 4)
low_io = wintypes.ULONG(1)
assert ntdll.NtSetInformationProcess(current, 33, ctypes.byref(low_io), 4) == 0
assert priorities(current) == (0x4000, 2, 1), priorities(current)

assert module.apply_process_priority({"processPriority": "inherit"}) == ""
assert priorities(current) == (0x4000, 2, 1), "inherit leaves priority untouched"

report = module.apply_process_priority({})
assert report.endswith("process priority cpu=aboveNormal memory=normal io=normal"), report
assert priorities(current) == (0x8000, 5, 2), priorities(current)

child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(10)"])
try:
    handle = kernel32.OpenProcess(0x1000, False, child.pid)
    assert handle
    assert priorities(handle) == (0x20, 5, 2), priorities(handle)
    kernel32.CloseHandle(handle)
finally:
    child.kill()
    child.wait()

report = module.apply_process_priority({"processPriority": "normal"})
assert "cpu=normal" in report, report
assert priorities(current)[0] == 0x20
report = module.apply_process_priority({"processPriority": "realtime"})
assert "unknown processPriority 'realtime'; using aboveNormal" in report, report
assert priorities(current)[0] == 0x8000
print("ok")
`);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), "ok");
  },
);

test("session agent leaves process priority alone outside Windows", { skip: process.platform === "win32" ? "POSIX behavior" : false }, (t) => {
  const python = findPython();
  if (!python) {
    t.skip("python not available");
    return;
  }
  const result = runAgentModuleScript(python, String.raw`
assert module.apply_process_priority({}) == ""
print("ok")
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "ok");
});

test("every packaged Windows scheduled task runs at normal Task Scheduler priority", () => {
  const bundle = buildWindowsHelperBundle({ id: "winbox", name: "winbox", kind: "powershell-ssh", host: "win.ts.net" });
  for (const name of ["wmux-windows-agent-service.ps1", "wmux-stream-agent-service.ps1"]) {
    const helper = bundle.files.find((file) => file.name === name);
    assert.ok(helper, `bundle includes ${name}`);
    const source = Buffer.from(helper.dataBase64, "base64").toString("utf8");
    const definitions = source.split("New-ScheduledTaskSettingsSet").slice(1);
    assert.ok(definitions.length > 0, `${name} defines task settings`);
    for (const definition of definitions) {
      // Without -Priority, Task Scheduler uses 7: below-normal CPU, low I/O, and low memory priority.
      assert.match(definition, /^ `\r?\n\s+-Priority 4 `/, `${name} task settings must set -Priority 4`);
    }
  }
});
