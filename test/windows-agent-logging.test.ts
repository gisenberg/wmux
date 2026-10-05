import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
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

const runAgentModuleScript = (python: { command: string; args: string[] }, body: string, env: NodeJS.ProcessEnv = {}) => {
  const script = String.raw`
import importlib.machinery
import importlib.util
import os

path = os.environ["WMUX_AGENT_PATH"]
loader = importlib.machinery.SourceFileLoader("wmux_agent_logging_test", path)
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)
` + body;
  return spawnSync(python.command, [...python.args, "-c", script], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
      WMUX_AGENT_PATH: agentPath,
      WMUX_AGENT_ERR: "",
      WMUX_AGENT_OUT: "",
      ...env,
    },
  });
};

test("agent rotating log timestamps lines and caps size with bounded backups", (t) => {
  const python = findPython();
  if (!python) {
    t.skip("python not available");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-agent-log-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = runAgentModuleScript(python, String.raw`
import re
log_path = os.path.join(os.environ["LOG_DIR"], "windows-agent.log")
log = module.RotatingLog(log_path, max_bytes=400, backup_count=2)
log.write("first part ")
log.write("same line\nsecond\n")
with open(log_path, encoding="utf-8") as handle:
    lines = handle.read().splitlines()
stamp = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z "
assert re.match(stamp + r"first part same line$", lines[0]), lines
assert re.match(stamp + r"second$", lines[1]), lines
for index in range(200):
    log.write(f"line {index:04d} " + "x" * 40 + "\n")
log.close()
names = sorted(os.listdir(os.environ["LOG_DIR"]))
assert names == ["windows-agent.1.log", "windows-agent.2.log", "windows-agent.log"], names
for name in names:
    size = os.path.getsize(os.path.join(os.environ["LOG_DIR"], name))
    assert 0 < size <= 400, (name, size)
with open(log_path, encoding="utf-8") as handle:
    assert "line 0199" in handle.read()
print("ok")
`, { LOG_DIR: dir });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "ok");
});

test("agent log retention prunes by age, run count, and total size without touching unrelated files", (t) => {
  const python = findPython();
  if (!python) {
    t.skip("python not available");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-agent-retention-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = runAgentModuleScript(python, String.raw`
log_dir = os.environ["LOG_DIR"]
now = 2_000_000_000.0
day = 24 * 60 * 60

def make(name, age_seconds, size=10):
    path = os.path.join(log_dir, name)
    with open(path, "wb") as handle:
        handle.write(b"x" * size)
    os.utime(path, (now - age_seconds, now - age_seconds))
    return path

active = make("windows-agent.log", 30 * day)
make("windows-agent.1.log", 15 * day)
make("windows-agent-3482.log", 10)
make("stream-agent.err.log", 20 * day)
make("unrelated.log", 400 * day)
make("windows-agent-notes.txt", 400 * day)
for run in range(50):
    make(f"windows-agent-{run}-{run}.err.log", 60 + run)

module.LOG_RETENTION_MAX_RUN_FILES = 40
removed, removed_bytes = module.prune_agent_logs(log_dir, {active}, now=now)
names = set(os.listdir(log_dir))
assert "windows-agent.log" in names, "protected active log must survive"
assert "windows-agent.1.log" not in names, "expired backup removed"
assert "stream-agent.err.log" not in names, "expired legacy stream log removed"
assert "windows-agent-3482.log" in names
assert "unrelated.log" in names and "windows-agent-notes.txt" in names, "non-agent files untouched"
runs = sorted(name for name in names if module.RUN_LOG_NAME_PATTERN.search(name))
assert len(runs) == 40, runs
assert "windows-agent-0-0.err.log" in names, "newest run logs kept"
assert "windows-agent-49-49.err.log" not in names, "oldest run logs pruned"
assert removed == 12 and removed_bytes == 120, (removed, removed_bytes)

module.LOG_RETENTION_MAX_TOTAL_BYTES = 100
module.prune_agent_logs(log_dir, {active}, now=now)
remaining = [name for name in os.listdir(log_dir) if module.MANAGED_LOG_NAME_PATTERN.match(name) and name != "windows-agent.log"]
assert sum(os.path.getsize(os.path.join(log_dir, name)) for name in remaining) <= 100, remaining
assert "windows-agent-3482.log" in remaining, "newest files survive the byte budget"
print("ok")
`, { LOG_DIR: dir });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "ok");
});

test("agent log path prefers --log-file and derives one beside legacy wrapper captures", (t) => {
  const python = findPython();
  if (!python) {
    t.skip("python not available");
    return;
  }
  const logs = path.join(os.tmpdir(), "wmux-legacy-logs");
  const result = runAgentModuleScript(python, String.raw`
explicit = module.agent_log_path("~/explicit.log", "C:/state/windows-agent.json")
assert explicit == os.path.abspath(os.path.expanduser("~/explicit.log")), explicit
os.environ["WMUX_AGENT_ERR"] = ""
assert module.agent_log_path("", "/state/windows-agent-3483.json") == ""
os.environ["WMUX_AGENT_ERR"] = os.path.join(os.environ["LEGACY_DIR"], "windows-agent-1-2.err.log")
derived = module.agent_log_path("", "/state/windows-agent-3483.json")
assert derived == os.path.join(os.path.abspath(os.environ["LEGACY_DIR"]), "windows-agent-3483.log"), derived
print("ok")
`, { LEGACY_DIR: logs });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "ok");
});

test("agent suppresses successful request lines and condenses client disconnects", (t) => {
  const python = findPython();
  if (!python) {
    t.skip("python not available");
    return;
  }
  const result = runAgentModuleScript(python, String.raw`
import io
import sys
from http import HTTPStatus

captured = io.StringIO()
sys.stderr = captured
handler = module.Handler.__new__(module.Handler)
handler.requestline = "GET /health HTTP/1.1"
handler.client_address = ("100.64.0.1", 1234)
handler.log_request(200)
handler.log_request(HTTPStatus.NO_CONTENT)
assert captured.getvalue() == "", captured.getvalue()
handler.log_request(HTTPStatus.NOT_FOUND)
assert '"GET /health HTTP/1.1" 404' in captured.getvalue(), captured.getvalue()

captured.truncate(0)
captured.seek(0)
server = module.AgentHTTPServer.__new__(module.AgentHTTPServer)
try:
    raise ConnectionAbortedError(10053, "aborted")
except ConnectionAbortedError:
    server.handle_error(None, ("100.64.0.1", 4321))
output = captured.getvalue()
assert output.count("\n") == 1 and "100.64.0.1 disconnected before the response completed" in output, output
assert "Traceback" not in output
print("ok", file=sys.__stdout__)
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "ok");
});

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("no port"))));
  });
});

test("agent started with --log-file logs startup to the managed file and omits health polls", async (t) => {
  const python = findPython();
  if (!python) {
    t.skip("python not available");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-agent-run-"));
  const logDir = path.join(dir, "logs");
  fs.mkdirSync(logDir);
  const stale = path.join(logDir, "windows-agent-1-1.err.log");
  fs.writeFileSync(stale, "old");
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  fs.utimesSync(stale, longAgo, longAgo);
  const port = await freePort();
  const configPath = path.join(dir, "windows-agent.json");
  fs.writeFileSync(configPath, JSON.stringify({
    host: "127.0.0.1",
    port,
    backend: "stdio",
    heartbeatEnabled: false,
    streamEnabled: false,
  }));
  const logPath = path.join(logDir, "windows-agent.log");
  // Spawn the real interpreter rather than the Windows py.exe launcher so
  // killing the child stops the process that holds the log file open.
  const interpreter = spawnSync(python.command, [...python.args, "-c", "import sys; print(sys.executable)"], {
    encoding: "utf8",
  }).stdout.trim();
  const child = spawn(interpreter, [agentPath, "--config", configPath, "--log-file", logPath], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", WMUX_AGENT_ERR: "", WMUX_AGENT_OUT: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let consoleOutput = "";
  child.stdout.on("data", (chunk) => { consoleOutput += String(chunk); });
  child.stderr.on("data", (chunk) => { consoleOutput += String(chunk); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const deadline = Date.now() + 15_000;
  let healthy = false;
  while (!healthy && Date.now() < deadline) {
    try {
      healthy = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.ok(healthy, `agent did not become healthy: ${consoleOutput}`);
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/missing`)).status, 404);

  const log = fs.readFileSync(logPath, "utf8");
  assert.match(log, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z wmux-(windows|session)-agent: log retention removed 1 file\(s\)/m);
  assert.match(log, /listening on http:\/\/127\.0\.0\.1:/);
  assert.doesNotMatch(log, /GET \/health/);
  assert.match(log, /"GET \/missing HTTP\/1\.1" 404/);
  assert.equal(fs.existsSync(stale), false, "startup sweep removed the expired run log");
  assert.equal(consoleOutput, "", "nothing should reach the inherited console streams");
});

test("Windows agent task wrapper passes a per-config managed log file", () => {
  const bundle = buildWindowsHelperBundle({ id: "winbox", name: "winbox", kind: "powershell-ssh", host: "win.ts.net" });
  const helper = bundle.files.find((file) => file.name === "wmux-windows-agent-service.ps1");
  assert.ok(helper);
  const source = Buffer.from(helper.dataBase64, "base64").toString("utf8");
  assert.match(source, /function Get-AgentLogPath/);
  assert.match(source, /GetFileNameWithoutExtension\(\$TargetConfig\)\)\.log/);
  assert.match(source, /'--log-file'\s+\(ConvertTo-CmdArgument \(Get-AgentLogPath \$TargetConfig\)\)/);
});
