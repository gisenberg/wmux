import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openCodexCliView } from "../src/server/codex-tasks.js";
import { CodexCliViewUncertainError } from "../src/server/codex-task-launches.js";

test("CLI controller retains exact pane on a safety gate and never supplies a prompt or approval override", { skip: process.platform === "win32" }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-codex-cli-view-"));
  const previous = process.env.PATH;
  process.env.PATH = `${directory}:${previous}`;
  t.after(() => { process.env.PATH = previous; fs.rmSync(directory, { recursive: true, force: true }); });
  const target = { workspaceId: "ws_test", tabId: "tab_test", paneId: "pane_test" };
  const output = path.join(directory, "args");
  fs.writeFileSync(path.join(directory, "python3"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${output}'\nprintf '%s\\n' '${JSON.stringify({ ...target, state: "failed", error: "repository-trust prompt detected" })}'\nexit 1\n`, { mode: 0o700 });
  await assert.rejects(openCodexCliView({ baseUrl: "http://127.0.0.1:1234", token: "test".repeat(10), machineId: "local", socketPath: "/private/native.sock", cwd: "/repo with spaces" }), error => {
    assert.ok(error instanceof CodexCliViewUncertainError);
    assert.deepEqual(error.target, target);
    return true;
  });
  const args = fs.readFileSync(output, "utf8").trim().split("\n");
  assert.deepEqual(args.slice(1), ["tui", "codex", "local", "--directory", "/repo with spaces", "--no-prompt", "--codex-remote", "unix:///private/native.sock"]);
});
