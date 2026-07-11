import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
for chunk in (b"prefix\x1b]7;file://WIN/C%3A/Users/gi", b"sen/work%20tree\x07suffix"):
    values.extend(reporter.feed(chunk))
print(json.dumps(values))
`;
  const result = spawnSync("python3", ["-c", source], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["C:/Users/gisen/work tree"]);
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
