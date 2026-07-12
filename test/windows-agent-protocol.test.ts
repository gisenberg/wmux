import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { windowsAgentUrl } from "../src/server/windows-agent.js";
import type { MachineConfig } from "../src/server/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Windows agent URLs bracket IPv6 callback addresses", () => {
  const machine: MachineConfig = {
    id: "dynamic-v6",
    name: "Dynamic IPv6",
    kind: "powershell-ssh",
    host: "fd7a:115c:a1e0::8",
    agentPort: 3481,
  };
  assert.equal(windowsAgentUrl(machine), "http://[fd7a:115c:a1e0::8]:3481");
});

test("Windows agent recognizes fixed terminal queries across output chunks", () => {
  const source = String.raw`
import json
import runpy

module = runpy.run_path("scripts/wmux-windows-agent")
responder = module["TerminalQueryResponder"]()
replies = []
for chunk in (b"prefix\x1b[", b"csuffix\x1b[5", b"n\x1b[0", b"c"):
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
backend.query_responder = module["TerminalQueryResponder"]()
backend.locally_answered = set()
backend._answer_terminal_queries(b"\x1b[c")
backend.write_terminal_response(b"\x1b[?62;22c")
backend.write_terminal_response(b"\x1b[?62;22c")
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
  assert.deepEqual(JSON.parse(result.stdout), {
    replies: ["\x1b[?62;22c", "\x1b[0n", "\x1b[?62;22c"],
    writes: ["\x1b[?62;22c", "user-input"],
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
    payload = {"helperBundle": {"bundleVersion": "bundle123", "files": [{
        "name": "wmux-test.ps1",
        "dataBase64": base64.b64encode(data).decode("ascii"),
        "sha256": hashlib.sha256(data).hexdigest(),
    }]}}
    module["stage_helper_bundle"]({"helperDir": root}, payload)
    with open(os.path.join(root, "wmux-test.ps1"), "rb") as handle:
        staged = handle.read().decode("utf-8")
    print(json.dumps({"content": staged, "version": module["helper_bundle_version"]({"helperDir": root})}))
`;
  const result = spawnSync("python3", ["-c", source], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { content: "Write-Output staged", version: "bundle123" });
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
    drain: { sessions: 1, activeSessions: 1, draining: true, restartWhenIdle: true },
    sameSession: "pane_one",
    blocked: true,
    callbacks: ["restart"],
    restartRequested: true,
  });
});
