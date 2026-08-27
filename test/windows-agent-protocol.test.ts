import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { windowsAgentUrl } from "../src/server/windows-agent.js";
import type { MachineConfig } from "../src/server/types.js";
import {
  WINDOWS_AGENT_LONG_POLL,
  WINDOWS_AGENT_PATHS,
  WINDOWS_AGENT_PROTOCOL_VERSION,
} from "../src/shared/windows-agent-protocol.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pwshAvailable = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
  encoding: "utf8",
}).status === 0;

test("Windows agent protocol exports stable paths and bounded polling semantics", () => {
  assert.equal(WINDOWS_AGENT_PROTOCOL_VERSION, 6);
  assert.equal(WINDOWS_AGENT_PATHS.session("pane one"), "/sessions/pane%20one");
  assert.equal(
    WINDOWS_AGENT_PATHS.output("pane one", 42, WINDOWS_AGENT_LONG_POLL.defaultTimeoutMs),
    "/sessions/pane%20one/output?cursor=42&timeoutMs=15000",
  );
  assert.ok(WINDOWS_AGENT_LONG_POLL.requestTimeoutMs > WINDOWS_AGENT_LONG_POLL.defaultTimeoutMs);
  assert.ok(WINDOWS_AGENT_LONG_POLL.maximumTimeoutMs >= WINDOWS_AGENT_LONG_POLL.defaultTimeoutMs);
});

test("Windows agent conditionally loads PowerShell profiles for interactive sessions", () => {
  const source = String.raw`
import json
import runpy

module = runpy.run_path("scripts/wmux-windows-agent")
without_profile = module["powershell_command"]("pwsh", "C:/work", False)
with_profile = module["powershell_command"]("pwsh", "C:/work", True)
profile_owned_cwd = module["session_command"](
    {},
    {"shell": "pwsh", "loadPowerShellProfile": True},
    "C:/Users/wmux",
)
explicit_cwd = module["session_command"](
    {},
    {"shell": "pwsh", "loadPowerShellProfile": True, "cwd": "C:/work"},
    "C:/Users/wmux",
)
configured_cwd = module["session_command"](
    {"cwd": "D:/configured"},
    {"shell": "pwsh", "loadPowerShellProfile": True},
    "C:/Users/wmux",
)
print(json.dumps({
    "withoutProfile": without_profile,
    "withProfile": with_profile,
    "profileOwnedCwd": profile_owned_cwd,
    "explicitCwd": explicit_cwd,
    "configuredCwd": configured_cwd,
}))
`;
  const result = spawnSync("python3", ["-c", source], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const commands = JSON.parse(result.stdout);
  assert.ok(commands.withoutProfile.includes("-NoProfile"));
  assert.equal(commands.withProfile.includes("-NoProfile"), false);
  assert.match(commands.withProfile.at(-1), /__wmuxInstallPrompt \$true/);
  assert.match(commands.withoutProfile.at(-1), /__wmuxInstallPrompt \$false/);
  assert.doesNotMatch(commands.profileOwnedCwd.at(-1), /Set-Location/);
  assert.match(commands.explicitCwd.at(-1), /Set-Location -LiteralPath 'C:\/work'/);
  assert.match(commands.configuredCwd.at(-1), /Set-Location -LiteralPath 'D:\/configured'/);
});

test("session-agent URLs reject unsupported IPv6 callback addresses", () => {
  const machine: MachineConfig = {
    id: "dynamic-v6",
    name: "Dynamic IPv6",
    kind: "powershell-ssh",
    host: "fd7a:115c:a1e0::8",
    sessionBackend: "agent",
    agentPort: 3481,
  };
  assert.equal(windowsAgentUrl(machine), undefined);
});

test("session-agent URL construction rejects public and DNS fallbacks", () => {
  assert.equal(windowsAgentUrl({
    id: "public",
    name: "Public",
    kind: "ssh",
    host: "203.0.113.8",
    sessionBackend: "agent",
    agentPort: 3481,
  }), undefined);
  assert.equal(windowsAgentUrl({
    id: "dns",
    name: "DNS",
    kind: "ssh",
    host: "changed.internal",
    sessionBackend: "agent",
    agentPort: 3481,
  }), undefined);
  assert.equal(windowsAgentUrl({
    id: "pinned",
    name: "Pinned",
    kind: "ssh",
    host: "changed.internal",
    sessionBackend: "agent",
    agentUrl: "http://100.64.0.8:3481",
    agentPort: 3481,
  }), "http://100.64.0.8:3481");
});

test("agent hard-drain and pending-update fences are atomic against concurrent creates", () => {
  const source = String.raw`
import json
import runpy
import threading

module = runpy.run_path("scripts/wmux-windows-agent")

class FakeSession:
    def __init__(self, session_id, config, payload, on_exit):
        self.id = session_id
        self.exited = False
        self.on_exit = on_exit
    def snapshot(self):
        return {"id": self.id, "status": "exited" if self.exited else "running"}
    def terminate(self):
        self.exited = True

module["AgentState"].get_or_create.__globals__["Session"] = FakeSession
hard_create_wins = 0
hard_fence_wins = 0
pending_create_wins = 0
pending_fence_wins = 0

for index in range(100):
    state = module["AgentState"]({"backend": "stdio"})
    barrier = threading.Barrier(2)
    result = {}
    def create():
        barrier.wait()
        try:
            state.get_or_create("pane", {})
            result["created"] = True
        except module["AgentDrainingError"]:
            result["created"] = False
    def fence():
        barrier.wait()
        result["health"] = state.begin_drain(False, False)
    threads = [threading.Thread(target=create), threading.Thread(target=fence)]
    for thread in threads: thread.start()
    for thread in threads: thread.join()
    health = state.health()
    if result["created"]:
        hard_create_wins += 1
        assert health["activeSessions"] == 1
    else:
        hard_fence_wins += 1
        assert health["activeSessions"] == 0 and health["draining"] is True

for index in range(100):
    state = module["AgentState"]({"backend": "stdio"})
    old = state.get_or_create("old", {})
    old.exited = True
    with state.lock:
        state.update_pending = True
        state.restart_when_idle = True
    barrier = threading.Barrier(2)
    result = {}
    def create_pending():
        barrier.wait()
        try:
            state.get_or_create("new", {})
            result["created"] = True
        except module["AgentDrainingError"]:
            result["created"] = False
    def transition_pending():
        barrier.wait()
        state._restart_if_still_idle()
    threads = [threading.Thread(target=create_pending), threading.Thread(target=transition_pending)]
    for thread in threads: thread.start()
    for thread in threads: thread.join()
    health = state.health()
    if result["created"]:
        pending_create_wins += 1
        assert health["activeSessions"] == 1 and state.restart_requested is False
    else:
        pending_fence_wins += 1
        assert health["activeSessions"] == 0 and health["draining"] is True and state.restart_requested is True

print(json.dumps({
    "hardCreateWins": hard_create_wins,
    "hardFenceWins": hard_fence_wins,
    "pendingCreateWins": pending_create_wins,
    "pendingFenceWins": pending_fence_wins,
}))
`;
  const result = spawnSync("python3", ["-c", source], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const outcomes = JSON.parse(result.stdout);
  assert.equal(outcomes.hardCreateWins + outcomes.hardFenceWins, 100);
  assert.equal(outcomes.pendingCreateWins + outcomes.pendingFenceWins, 100);
});

test("rollout slot activation is owner-serialized and reuses an already-current generation", () => {
  const service = fs.readFileSync(
    path.join(repoRoot, "scripts/windows/wmux-windows-agent-service.ps1"),
    "utf8",
  );
  const lockFunction = service.indexOf("function Open-GenerationLock");
  const exclusive = service.indexOf("[System.IO.FileShare]::None", lockFunction);
  const acquire = service.indexOf("$GenerationLock = Open-GenerationLock -Port $Port", exclusive);
  const currentCheck = service.indexOf("$ExistingRelease -eq $ExpectedRelease", acquire);
  const reuse = service.indexOf("reused = $true", currentCheck);
  const stop = service.indexOf("Stop-ScheduledTask -TaskName $GenerationTaskName", reuse);
  const release = service.indexOf("$GenerationLock.Dispose()", stop);
  const retire = service.indexOf("function Remove-AgentGeneration", release);
  const retireLock = service.indexOf("$GenerationLock = Open-GenerationLock -Port $Port", retire);
  const retireDrain = service.indexOf("$Drain = Invoke-RestMethod", retireLock);
  const retireFence = service.indexOf("$FencedHealth = Invoke-RestMethod", retireLock);
  const retireIdentity = service.indexOf("$FencedPid -ne $OriginalPid", retireFence);
  const retireRelease = service.indexOf("$GenerationLock.Dispose()", retireIdentity);
  assert.ok(lockFunction > 0);
  assert.ok(exclusive > lockFunction);
  assert.ok(acquire > exclusive);
  assert.ok(currentCheck > acquire);
  assert.ok(reuse > currentCheck);
  assert.ok(stop > reuse);
  assert.ok(release > stop);
  assert.ok(retire > release);
  assert.ok(retireLock > retire);
  assert.ok(retireDrain > retireLock);
  assert.ok(retireFence > retireDrain);
  assert.ok(retireIdentity > retireFence);
  assert.ok(retireRelease > retireIdentity);
  assert.match(service.slice(acquire, reuse), /ExistingHealth\.draining/);
  assert.match(service, /DrainEstablished -and -not \$GenerationActivated/);
  assert.match(service, /RetirementDrainEstablished -and -not \$RetirementCompleted/);
  assert.match(service, /--expected-release/);
  assert.match(service, /--expected-protocol/);
  assert.match(service, /--expected-helpers/);
});

test("real PowerShell helper processes serialize one rollout slot", { skip: !pwshAvailable }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-generation-lock-"));
  const tracePath = path.join(directory, "trace.log");
  const servicePath = path.join(repoRoot, "scripts/windows/wmux-windows-agent-service.ps1");
  const run = () => new Promise<void>((resolve, reject) => {
    const child = spawn("pwsh", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      servicePath,
      "generation-lock-test",
      "--port",
      "3482",
      "--hold-ms",
      "300",
      "--trace",
      tracePath,
    ], {
      env: {
        ...process.env,
        LOCALAPPDATA: directory,
        WMUX_WINDOWS_AGENT_STATE_DIR: directory,
        WMUX_WINDOWS_AGENT_LOCK_TEST: "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`PowerShell lock helper exited ${code}: ${stderr}`));
    });
  });
  try {
    const first = run();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const second = run();
    await Promise.all([first, second]);
    const entries = fs.readFileSync(tracePath, "utf8").trim().split("\n").map((line) => {
      const [event, pid, ticks] = line.split("|");
      return { event, pid, ticks: BigInt(ticks) };
    });
    assert.deepEqual(entries.map(({ event }) => event), ["start", "end", "start", "end"]);
    assert.notEqual(entries[0].pid, entries[2].pid);
    assert.ok(entries[2].ticks >= entries[1].ticks);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows agent heartbeat advertises its live callback credentials", () => {
  const source = String.raw`
import json
import os
import runpy
import tempfile

module = runpy.run_path("scripts/wmux-windows-agent")
for name in ("WMUX_URL", "WMUX_REGISTRATION_TOKEN", "WMUX_HEARTBEAT_CONFIG", "WMUX_STATE_DIR", "WMUX_AGENT_TOKEN"):
    os.environ.pop(name, None)
captured = {}

class FakeResponse:
    status = 204
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False
    def read(self, limit):
        return b""

def fake_urlopen(request, timeout):
    captured["url"] = request.full_url
    captured["headers"] = dict(request.header_items())
    captured["body"] = json.loads(request.data.decode("utf-8"))
    captured["timeout"] = timeout
    return FakeResponse()

module["RegistrationHeartbeat"].send_once.__globals__["urlopen"] = fake_urlopen
with tempfile.TemporaryDirectory() as state_dir:
    config_path = os.path.join(state_dir, "windows-agent.json")
    with open(config_path, "w", encoding="utf-8") as handle:
        json.dump({}, handle)
    with open(os.path.join(state_dir, "url"), "w", encoding="utf-8") as handle:
        handle.write("https://wmux.internal.example/\n")
    with open(os.path.join(state_dir, "registration-token"), "w", encoding="utf-8") as handle:
        handle.write("catalog-token\n")
    with open(os.path.join(state_dir, "heartbeat.json"), "w", encoding="utf-8") as handle:
        json.dump({
            "machine": {
                "id": "winbox",
                "name": "Windows Box",
                "kind": "powershell-ssh",
                "user": "operator",
                "sessionBackend": "auto",
                "agentPort": 9999,
                "agentToken": "stale-agent-token",
            },
            "ttlMs": 90000,
        }, handle)
    heartbeat = module["RegistrationHeartbeat"](
        {"machine": "winbox", "token": "live-agent-token", "heartbeatIntervalSeconds": 12},
        config_path,
        3481,
    )
    ok = heartbeat.send_once()
    snapshot = heartbeat.snapshot()

print(json.dumps({"ok": ok, "captured": captured, "snapshot": snapshot}))
`;
  const result = spawnSync("python3", ["-c", source], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.captured.url, "https://wmux.internal.example/api/registry/hosts");
  assert.equal(payload.captured.headers.Authorization, "Bearer catalog-token");
  assert.equal(payload.captured.headers["Content-type"], "application/json");
  assert.equal(payload.captured.timeout, 15);
  assert.equal(payload.captured.body.machine.sessionBackend, "agent");
  assert.equal(payload.captured.body.machine.agentPort, 3481);
  assert.equal(payload.captured.body.machine.agentToken, "live-agent-token");
  assert.equal(payload.snapshot.enabled, true);
  assert.equal(payload.snapshot.configured, true);
  assert.equal(payload.snapshot.intervalSeconds, 12);
  assert.ok(payload.snapshot.lastSuccessAt);
  assert.equal(payload.snapshot.lastError, null);
  assert.equal(JSON.stringify(payload.snapshot).includes("catalog-token"), false);
  assert.equal(JSON.stringify(payload.snapshot).includes("live-agent-token"), false);
});

test("Windows agent heartbeat stays optional until registration files are provisioned", () => {
  const source = String.raw`
import json
import os
import runpy
import tempfile

module = runpy.run_path("scripts/wmux-windows-agent")
for name in ("WMUX_URL", "WMUX_REGISTRATION_TOKEN", "WMUX_HEARTBEAT_CONFIG", "WMUX_STATE_DIR", "WMUX_AGENT_TOKEN"):
    os.environ.pop(name, None)
with tempfile.TemporaryDirectory() as state_dir:
    config_path = os.path.join(state_dir, "windows-agent.json")
    heartbeat = module["RegistrationHeartbeat"]({"machine": "winbox", "token": "agent-token"}, config_path, 3481)
    ok = heartbeat.send_once()
    snapshot = heartbeat.snapshot()
print(json.dumps({"ok": ok, "snapshot": snapshot}))
`;
  const result = spawnSync("python3", ["-c", source], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.snapshot.enabled, true);
  assert.equal(payload.snapshot.configured, false);
  assert.match(payload.snapshot.lastError, /url, registration-token, heartbeat\.json/);
  assert.equal(payload.snapshot.consecutiveFailures, 0);
});

test("native agents restart the owned stream worker and disable rollout ownership", () => {
  const source = String.raw`
import json
import os
import runpy
import tempfile
import time

module = runpy.run_path("scripts/wmux-windows-agent")
with tempfile.TemporaryDirectory() as state_dir:
    agent_config_path = os.path.join(state_dir, "windows-agent.json")
    stream_config_path = os.path.join(state_dir, "stream-agent.json")
    worker_path = os.path.join(state_dir, "fake-stream-worker.py")
    counter_path = os.path.join(state_dir, "starts.txt")
    with open(agent_config_path, "w", encoding="utf-8") as handle:
        json.dump({}, handle)
    with open(stream_config_path, "w", encoding="utf-8") as handle:
        json.dump({"machine": "test", "onDemand": True}, handle)
    with open(worker_path, "w", encoding="utf-8") as handle:
        handle.write(
            "import os,sys\n"
            "counter = os.path.join(os.path.dirname(__file__), 'starts.txt')\n"
            "with open(counter, 'a', encoding='utf-8') as output: output.write('start\\n')\n"
            "raise SystemExit(7)\n"
        )
    supervisor = module["StreamSupervisor"](
        {"streamAgentPath": worker_path},
        agent_config_path,
    )
    supervisor.start()
    deadline = time.monotonic() + 5
    starts = 0
    settled = False
    while time.monotonic() < deadline:
        try:
            with open(counter_path, "r", encoding="utf-8") as handle:
                starts = len(handle.readlines())
        except OSError:
            starts = 0
        current = supervisor.snapshot()
        settled = (
            starts >= 2
            and current["restartCount"] >= 2
            and current["lastExitCode"] == 7
            and not current["running"]
        )
        if settled:
            break
        time.sleep(0.05)
    while time.monotonic() < deadline:
        snapshot = supervisor.snapshot()
        if snapshot["restartCount"] >= 2 and snapshot["lastExitCode"] == 7:
            break
        time.sleep(0.05)
    supervisor.stop()
    snapshot = supervisor.snapshot()
    rollout = module["StreamSupervisor"](
        {"streamOwner": False, "streamAgentPath": worker_path},
        agent_config_path,
    )
    rollout.start()
    rollout_snapshot = rollout.snapshot()
print(json.dumps({
    "starts": starts,
    "settled": settled,
    "snapshot": snapshot,
    "rollout": rollout_snapshot,
}))
`;
  const result = spawnSync("python3", ["-c", source], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.starts, 2);
  assert.equal(payload.settled, true);
  assert.ok(payload.snapshot.restartCount >= 1);
  assert.equal(payload.snapshot.running, false);
  assert.equal(payload.snapshot.lastExitCode, 7);
  assert.equal(payload.rollout.owner, false);
  assert.equal(payload.rollout.running, false);
});

test("Windows agent filters delayed browser duplicates from bundled terminal replies", () => {
  const source = String.raw`
import json
import runpy

module = runpy.run_path("scripts/wmux-windows-agent")
environment = {
    "WMUX_TERMINAL_FOREGROUND": "#c0caf5",
    "WMUX_TERMINAL_BACKGROUND": "#1a1b26",
}
responses = module["local_terminal_query_responses"](environment)
responder = module["TerminalQueryResponder"](responses)
replies = []
for chunk in (
    b"prefix\x1b[",
    b"csuffix\x1b[5",
    b"n\x1b[0",
    b"c\x1b]10;?\x1b",
    b"\\\x1b]11;?\x07",
):
    replies.extend(responder.feed(chunk))

class FakeProcess:
    def __init__(self):
        self.writes = []
    def write(self, value):
        self.writes.append(value)

backend = object.__new__(module["ConptyBackend"])
backend.process = FakeProcess()
backend.lock = __import__("threading").Lock()
backend.closed = False
backend.query_responder = module["TerminalQueryResponder"](responses)
backend.locally_answered = set()
backend._answer_terminal_queries(b"\x1b[c\x1b]10;?\x1b\\\x1b]11;?\x07")
backend.write_terminal_response(b"\x1b[?62;22c")
backend.write_terminal_response(b"\x1b[?62;22c")
backend.write_terminal_response(b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\")
backend.write_terminal_response(b"\x1b]11;rgb:0000/0000/0000\x1b\\")
backend.write_terminal_response(
    b"\x1b[?62;22c\x1b[>1;0;0c\x1bP>|libghostty 0.1.0-dev\x1b\\"
)
backend.write_terminal_response(
    b"\x1b]10;rgb:c0c0/caca/f5f5\x1b\\\x1b[24;80R"
)
backend.write_terminal_response(b"\x1b[4;1007;1305t\x1b[8;53;145t")
backend.write_terminal_response(b"\x1b[?62;22cuser-input")
__import__("time").sleep(0.01)
backend.write_terminal_response(b"\x1b[?62;22c")
backend.write_terminal_response(b"user-input")

print(json.dumps({
    "replies": [reply.decode("ascii") for reply in replies],
    "writes": backend.process.writes,
}))
`;
  const result = spawnSync("python3", ["-c", source], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const foreground = "\x1b]10;rgb:c0c0/caca/f5f5\x1b\\";
  const background = "\x1b]11;rgb:1a1a/1b1b/2626\x1b\\";
  assert.deepEqual(JSON.parse(result.stdout), {
    replies: ["\x1b[?62;22c", "\x1b[0n", "\x1b[?62;22c", foreground, background],
    writes: [
      "\x1b[?62;22c",
      foreground,
      background,
      "\x1b[>1;0;0c\x1bP>|libghostty 0.1.0-dev\x1b\\",
      "\x1b[24;80R",
      "\x1b[4;1007;1305t\x1b[8;53;145t",
      "\x1b[?62;22cuser-input",
      "user-input",
    ],
  });
});

test("Windows agent enables local color replies only for valid pane theme metadata", () => {
  const source = String.raw`
import json
import runpy

module = runpy.run_path("scripts/wmux-windows-agent")
build = module["local_terminal_query_responses"]
responder = module["TerminalQueryResponder"](build({
    "WMUX_TERMINAL_FOREGROUND": "not-a-color",
    "WMUX_TERMINAL_BACKGROUND": "#1a1b26",
}))
print(json.dumps({
    "replies": [value.decode("ascii") for value in responder.feed(b"\x1b]10;?\x1b\\\x1b]11;?\x07")],
    "ownsForegroundResponse": responder.owns_response(b"\x1b]10;rgb:c0c0/caca/f5f5\x1b\\"),
    "ownsBackgroundResponse": responder.owns_response(b"\x1b]11;rgb:1a1a/1b1b/2626\x1b\\"),
}))
`;
  const result = spawnSync("python3", ["-c", source], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    replies: ["\x1b]11;rgb:1a1a/1b1b/2626\x1b\\"],
    ownsForegroundResponse: false,
    ownsBackgroundResponse: true,
  });
});

test("Windows agent tracks OSC 7 cwd reports across output chunks", () => {
  const source = String.raw`
import json
import runpy

module = runpy.run_path("scripts/wmux-windows-agent")
reporter = module["CwdReporter"]()
values = []
for chunk in (b"prefix\x1b]7;file://WIN/C%3A/Users/oper", b"ator/work%20tree\x07suffix"):
    values.extend(reporter.feed(chunk))
print(json.dumps(values))
`;
  const result = spawnSync("python3", ["-c", source], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["C:/Users/operator/work tree"]);
});

test("Windows agent reports replay geometry at exact byte boundaries", () => {
  const source = String.raw`
import json
import runpy
import threading

module = runpy.run_path("scripts/wmux-windows-agent")

class FakeBackend:
    name = "conpty"
    pid = 123
    def __init__(self):
        self.resizes = []
    def resize(self, cols, rows):
        self.resizes.append([cols, rows])

session = object.__new__(module["Session"])
session.id = "pane_geometry"
session.backend = FakeBackend()
session.buffer = bytearray(b"abc")
session.base = 0
session.condition = threading.Condition()
session.cols = 80
session.rows = 24
session.resize_events = [{"cursor": 0, "cols": 80, "rows": 24}]
session.exited = False
session.exit_code = None
session.cwd = "C:/work"
session.cwd_reporter = module["CwdReporter"]()
session.max_replay = 65536

session.resize(100, 40)
session._append(b"def")
print(json.dumps({
    "snapshot": session.snapshot(),
    "full": session.read_from(0, 0),
    "tail": session.read_from(3, 0),
    "backendResizes": session.backend.resizes,
}))
`;
  const result = spawnSync("python3", ["-c", source], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.snapshot.cols, 100);
  assert.equal(payload.snapshot.rows, 40);
  assert.deepEqual(payload.backendResizes, [[100, 40]]);
  assert.deepEqual(payload.full.resizes, [{ cursor: 3, cols: 100, rows: 40 }]);
  assert.equal(payload.full.cols, 80);
  assert.equal(payload.full.rows, 24);
  assert.equal(payload.tail.cols, 100);
  assert.equal(payload.tail.rows, 40);
  assert.deepEqual(payload.tail.resizes, []);
});

test("Windows agent reports the staged helper bundle version", () => {
  const source = String.raw`
import json
import os
import runpy
import tempfile

module = runpy.run_path("scripts/wmux-windows-agent")
with tempfile.TemporaryDirectory() as root:
    with open(os.path.join(root, "bundle-version.json"), "w", encoding="utf-8") as handle:
        json.dump({"bundleVersion": "abc123"}, handle)
    print(module["helper_bundle_version"]({"helperDir": root}))
`;
  const result = spawnSync("python3", ["-c", source], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "abc123");
});

test("Windows agent keeps its startup bundle identity after replacement files are staged", () => {
  const source = String.raw`
import json
import os
import runpy
import tempfile

module = runpy.run_path("scripts/wmux-windows-agent")
with tempfile.TemporaryDirectory() as root:
    version_path = os.path.join(root, "bundle-version.json")
    with open(version_path, "w", encoding="utf-8") as handle:
        json.dump({"bundleVersion": "running"}, handle)
    state = module["AgentState"]({"helperDir": root})
    with open(version_path, "w", encoding="utf-8") as handle:
        json.dump({"bundleVersion": "staged"}, handle)
    print(json.dumps({
        "running": state.helper_bundle_version,
        "files": module["helper_bundle_version"]({"helperDir": root}),
    }))
`;
  const result = spawnSync("python3", ["-c", source], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { running: "running", files: "staged" });
});

test("Windows agent stages private validated paste images and sweeps only generated files", () => {
  const source = String.raw`
import json
import os
import runpy
import tempfile
import time

module = runpy.run_path("scripts/wmux-windows-agent")
stage_one = "paste-" + ("a" * 36)
stage_two = "paste-" + ("b" * 36)
png = b"\x89PNG\r\n\x1a\nbody"
with tempfile.TemporaryDirectory() as root:
    config = {"pasteImageDir": root}
    first = module["stage_paste_image"](config, "pane-one", stage_one, "png", png)
    first_mode = oct(os.stat(first["targetPath"]).st_mode & 0o777)
    unrelated = os.path.join(root, "keep.txt")
    with open(unrelated, "wb") as handle:
        handle.write(b"keep")
    old = time.time() - module["PASTE_IMAGE_TTL_SECONDS"] - 10
    os.utime(first["targetPath"], (old, old))
    os.utime(unrelated, (old, old))
    module["sweep_paste_images"](config)
    swept = not os.path.exists(first["targetPath"])
    kept = os.path.exists(unrelated)
    second = module["stage_paste_image"](config, "pane-one", stage_two, "png", png)
    module["delete_session_paste_images"](config, "pane-one")
    pane_cleaned = not os.path.exists(second["targetPath"])
    try:
        module["stage_paste_image"](config, "pane-one", stage_one, "png", b"not-an-image")
    except ValueError:
        invalid_rejected = True
    else:
        invalid_rejected = False
    print(json.dumps({
        "mode": first_mode,
        "swept": swept,
        "kept": kept,
        "paneCleaned": pane_cleaned,
        "invalidRejected": invalid_rejected,
    }))
`;
  const result = spawnSync("python3", ["-c", source], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    mode: process.platform === "win32" ? "0o666" : "0o600",
    swept: true,
    kept: true,
    paneCleaned: true,
    invalidRejected: true,
  });
});

test("Windows agent binary paste endpoint is authenticated and session scoped", () => {
  const source = String.raw`
import http.client
import json
import os
import runpy
import tempfile
import threading

module = runpy.run_path("scripts/wmux-windows-agent")

class FakeSession:
    exited = False

with tempfile.TemporaryDirectory() as root:
    state = module["AgentState"]({"pasteImageDir": root, "token": "agent-token"})
    state.sessions["pane-one"] = FakeSession()
    module["Handler"].state = state
    server = module["ThreadingHTTPServer"](("127.0.0.1", 0), module["Handler"])
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    stage_id = "paste-" + ("c" * 36)
    path = "/sessions/pane-one/paste-images/" + stage_id + "?extension=png"
    png = b"\x89PNG\r\n\x1a\nbody"

    unauthorized = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
    unauthorized.request("POST", path, body=png, headers={"content-type": "application/octet-stream"})
    unauthorized_status = unauthorized.getresponse().status
    unauthorized.close()

    accepted = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
    accepted.request("POST", path, body=png, headers={
        "authorization": "Bearer agent-token",
        "content-type": "application/octet-stream",
    })
    response = accepted.getresponse()
    staged = json.loads(response.read())
    accepted_status = response.status
    accepted.close()

    health_connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
    health_connection.request("GET", "/health")
    health = json.loads(health_connection.getresponse().read())
    health_connection.close()

    deleted_connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
    deleted_connection.request("DELETE", "/sessions/pane-one/paste-images/" + stage_id, headers={
        "authorization": "Bearer agent-token",
    })
    deleted = json.loads(deleted_connection.getresponse().read())
    deleted_connection.close()
    remains = os.path.exists(staged["targetPath"])
    server.shutdown()
    server.server_close()
    print(json.dumps({
        "unauthorized": unauthorized_status,
        "accepted": accepted_status,
        "capabilities": health["capabilities"],
        "protocol": health["protocolVersion"],
        "deleted": deleted["removed"],
        "remains": remains,
    }))
`;
  const result = spawnSync("python3", ["-c", source], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    unauthorized: 401,
    accepted: 201,
    capabilities: ["paste-images-v1", "registration-heartbeat-v1", "stream-supervision-v1", "posix-runtime-files-v1"],
    protocol: 6,
    deleted: true,
    remains: false,
  });
});

test("Windows agent verifies and stages helper bundles supplied with pane creation", () => {
  const source = String.raw`
import base64
import hashlib
import json
import os
import runpy
import tempfile

module = runpy.run_path("scripts/wmux-windows-agent")
data = b"Write-Output staged"
with tempfile.TemporaryDirectory() as root:
    home = os.path.join(root, "home")
    os.makedirs(home)
    os.environ["HOME"] = home
    os.environ["USERPROFILE"] = home
    payload = {"helperBundle": {"bundleVersion": "bundle123", "files": [{
        "name": "wmux-test.ps1",
        "dataBase64": base64.b64encode(data).decode("ascii"),
        "sha256": hashlib.sha256(data).hexdigest(),
    }]}, "env": {"WMUX_URL": "http://current-wmux:3478", "WMUX_TOKEN": "current-token"}}
    module["stage_helper_bundle"]({"helperDir": root}, payload)
    with open(os.path.join(root, "wmux-test.ps1"), "rb") as handle:
        staged = handle.read().decode("utf-8")
    with open(os.path.join(home, ".wmux", "url"), encoding="utf-8") as handle:
        callback_url = handle.read().strip()
    with open(os.path.join(home, ".wmux", "token"), encoding="utf-8") as handle:
        callback_token = handle.read().strip()
    print(json.dumps({
        "content": staged,
        "version": module["helper_bundle_version"]({"helperDir": root}),
        "callbackUrl": callback_url,
        "callbackToken": callback_token,
        "tokenMode": oct(os.stat(os.path.join(home, ".wmux", "token")).st_mode & 0o777),
    }))
`;
  const result = spawnSync("python3", ["-c", source], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    content: "Write-Output staged",
    version: "bundle123",
    callbackUrl: "http://current-wmux:3478",
    callbackToken: "current-token",
    tokenMode: process.platform === "win32" ? "0o666" : "0o600",
  });
});

test("Windows agent refreshes callback state even when its helper bundle is current", () => {
  const source = String.raw`
import json
import os
import runpy
import tempfile

module = runpy.run_path("scripts/wmux-windows-agent")
with tempfile.TemporaryDirectory() as home:
    os.environ["HOME"] = home
    os.environ["USERPROFILE"] = home
    module["stage_helper_bundle"]({}, {"env": {
        "WMUX_URL": "http://reattached-wmux:3478",
        "WMUX_TOKEN": "rotated-token",
    }})
    with open(os.path.join(home, ".wmux", "url"), encoding="utf-8") as handle:
        callback_url = handle.read().strip()
    with open(os.path.join(home, ".wmux", "token"), encoding="utf-8") as handle:
        callback_token = handle.read().strip()
    print(json.dumps({"url": callback_url, "token": callback_token}))
`;
  const result = spawnSync("python3", ["-c", source], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    url: "http://reattached-wmux:3478",
    token: "rotated-token",
  });
});

test("Windows agent job ownership kills the full pane process tree on close", () => {
  const source = String.raw`
import json
import runpy

module = runpy.run_path("scripts/wmux-windows-agent")

class FakeJobApi:
    def __init__(self):
        self.events = []
    def create_kill_on_close_job(self):
        self.events.append(["create"])
        return 42
    def assign_process(self, handle, pid):
        self.events.append(["assign", handle, pid])
    def close(self, handle):
        self.events.append(["close", handle])

api = FakeJobApi()
tree = module["WindowsProcessTree"](1234, api)
tree.terminate()
tree.terminate()
print(json.dumps(api.events))
`;
  const result = spawnSync("python3", ["-c", source], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [["create"], ["assign", 42, 1234], ["close", 42]]);
});

test("Windows agent closes an unassigned job when process containment fails", () => {
  const source = String.raw`
import json
import runpy

module = runpy.run_path("scripts/wmux-windows-agent")

class FakeJobApi:
    def __init__(self):
        self.events = []
    def create_kill_on_close_job(self):
        self.events.append(["create"])
        return 84
    def assign_process(self, handle, pid):
        self.events.append(["assign", handle, pid])
        raise RuntimeError("assignment failed")
    def close(self, handle):
        self.events.append(["close", handle])

api = FakeJobApi()
try:
    module["WindowsProcessTree"](5678, api)
except RuntimeError as error:
    message = str(error)
else:
    message = "missing error"
print(json.dumps({"events": api.events, "message": message}))
`;
  const result = spawnSync("python3", ["-c", source], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    events: [["create"], ["assign", 84, 5678], ["close", 84]],
    message: "assignment failed",
  });
});

test("Windows ConPTY closure releases pane job ownership before closing the pseudoconsole", () => {
  const source = String.raw`
import json
import runpy
import threading

module = runpy.run_path("scripts/wmux-windows-agent")
events = []

class FakeTree:
    def terminate(self):
        events.append("tree")

class FakeProcess:
    def terminate(self, force=False):
        events.append("terminate")
    def close(self, force=False):
        events.append("close")

backend = object.__new__(module["ConptyBackend"])
backend.process_tree = FakeTree()
backend.process = FakeProcess()
backend.lock = threading.Lock()
backend.closed = False
backend.terminate()
backend.terminate()
print(json.dumps({"events": events, "closed": backend.closed}))
`;
  const result = spawnSync("python3", ["-c", source], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    events: ["tree", "terminate", "close"],
    closed: true,
  });
});

test("Windows agent drain preserves existing sessions and restarts only after the last pane closes", () => {
  const source = String.raw`
import json
import runpy
import time

module = runpy.run_path("scripts/wmux-windows-agent")
callbacks = []

class FakeSession:
    def __init__(self, session_id, config, payload, on_exit):
        self.id = session_id
        self.exited = False
        self.on_exit = on_exit
    def snapshot(self):
        return {"id": self.id, "status": "exited" if self.exited else "running"}
    def terminate(self):
        self.exited = True
        self.on_exit()

state = module["AgentState"]({})
state.set_shutdown_callback(lambda: callbacks.append("restart"))
module["AgentState"].get_or_create.__globals__["Session"] = FakeSession
state.get_or_create("pane_one", {})
drain = state.begin_drain(True)
same = state.get_or_create("pane_one", {})
try:
    state.get_or_create("pane_two", {})
except module["AgentDrainingError"] as error:
    blocked = str(error)
else:
    blocked = ""
state.delete("pane_one")
time.sleep(0.4)
print(json.dumps({
    "drain": drain,
    "sameSession": same.id,
    "blocked": bool(blocked),
    "callbacks": callbacks,
    "restartRequested": state.restart_requested,
}))
`;
  const result = spawnSync("python3", ["-c", source], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    drain: { sessions: 1, activeSessions: 1, draining: true, updatePending: false, restartWhenIdle: true },
    sameSession: "pane_one",
    blocked: true,
    callbacks: ["restart"],
    restartRequested: true,
  });
});

test("Windows agent pending updates accept panes until the final session closes", () => {
  const source = String.raw`
import json
import runpy
import time

module = runpy.run_path("scripts/wmux-windows-agent")
callbacks = []

class FakeSession:
    def __init__(self, session_id, config, payload, on_exit):
        self.id = session_id
        self.exited = False
        self.on_exit = on_exit
    def snapshot(self):
        return {"id": self.id, "status": "exited" if self.exited else "running"}
    def terminate(self):
        self.exited = True
        self.on_exit()

state = module["AgentState"]({})
state.set_shutdown_callback(lambda: callbacks.append("restart"))
module["AgentState"].get_or_create.__globals__["Session"] = FakeSession
state.get_or_create("pane_one", {})
pending = state.begin_drain(True, True)
state.get_or_create("pane_two", {})
state.delete("pane_one")
time.sleep(0.3)
before_final_close = list(callbacks)
state.delete("pane_two")
time.sleep(0.4)
print(json.dumps({
    "pending": pending,
    "beforeFinalClose": before_final_close,
    "callbacks": callbacks,
    "health": state.health(),
    "restartRequested": state.restart_requested,
}))
`;
  const result = spawnSync("python3", ["-c", source], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    pending: { sessions: 1, activeSessions: 1, draining: false, updatePending: true, restartWhenIdle: true },
    beforeFinalClose: [],
    callbacks: ["restart"],
    health: { sessions: 0, activeSessions: 0, draining: true, updatePending: false, restartWhenIdle: true },
    restartRequested: true,
  });
});
