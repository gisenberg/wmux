import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const run = promisify(execFile);

test("observer installer renders quoted special-character paths using a mocked user systemctl", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux observer % & | "));
  const home = path.join(directory, "home % & |"), bin = path.join(directory, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const calls = path.join(directory, "systemctl.calls");
  const mock = path.join(bin, "systemctl");
  fs.writeFileSync(mock, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$WMUX_TEST_CALLS"\n`, { mode: 0o700 });
  try {
    const script = path.resolve("scripts/install-codex-observer-service.sh");
    // Exercise both supported destinations without inheriting a runner's XDG
    // directory and accidentally installing the fixture outside this sandbox.
    for (const configHome of ["", path.join(directory, "config % & |")]) {
      await run("bash", [script], { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, PATH: `${bin}${path.delimiter}${process.env.PATH}`, WMUX_TEST_CALLS: calls, NODE_BIN: path.join(directory, "node % & |") } });
      const unit = path.join(configHome || path.join(home, ".config"), "systemd", "user", "wmux-codex-observer.service");
      const content = fs.readFileSync(unit, "utf8");
      assert.match(content, /ExecStart=".*node %% & \\|" ".*wmux-observer\.mjs" --service/);
      assert.equal(fs.statSync(unit).mode & 0o777, 0o600);
    }
    assert.deepEqual(fs.readFileSync(calls, "utf8").trim().split("\n"), ["--user daemon-reload", "--user daemon-reload"]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
