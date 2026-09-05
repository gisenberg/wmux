import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import runnerModule from "../scripts/verification-runner.cjs";

test("external verification guards checkout ownership, cleanliness, leases and exact-commit completion", { skip: process.platform === "win32" }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-verifier-"));
  try {
    const checkout = path.join(temp, "checkout");
    const bin = path.join(temp, "bin");
    fs.mkdirSync(checkout);
    fs.mkdirSync(bin);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: checkout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "Fixture");
    fs.writeFileSync(path.join(checkout, ".gitignore"), "node_modules/\n");
    git("add", ".gitignore");
    git("commit", "-m", "fixture");
    const commit = git("rev-parse", "HEAD");
    git("remote", "add", "owner", "https://github.com/gisenberg/wmux.git");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\nif [ "$1" = fetch ]; then exec '${realGit}' fetch "$WMUX_FIXTURE_SOURCE" "$3"; fi\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
    fs.mkdirSync(path.join(checkout, "node_modules"));
    fs.writeFileSync(path.join(bin, "npm"), '#!/bin/sh\nprintf "fixture npm %s %s\\n" "$1" "$2"\nexit "${FIXTURE_EXIT:-0}"\n', { mode: 0o755 });
    const execute = (extraEnv: Record<string, string> = {}, options: Record<string, string> = {}) => spawnSync(process.execPath, ["-e", `(${runnerModule.remoteMain.toString()})(${JSON.stringify({ checkout, commit, id: "fixture", script: "check", ...options })})`], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, WMUX_FIXTURE_SOURCE: checkout, ...extraEnv },
    });
    const lock = path.join(checkout, ".git/wmux-verification.lock");
    const passed = execute();
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(passed.stdout, new RegExp(`WMUX:VERIFY:fixture:${commit}:0:\\d+`));
    assert.match(passed.stdout, /fixture npm run check/);
    assert.equal(fs.existsSync(lock), false);
    assert.equal(git("rev-parse", "HEAD"), commit);

    fs.writeFileSync(path.join(checkout, "unrelated.txt"), "user work");
    const dirty = execute();
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /contains changes/);
    assert.equal(fs.readFileSync(path.join(checkout, "unrelated.txt"), "utf8"), "user work");
    assert.doesNotMatch(dirty.stdout, /fixture npm/);
    fs.unlinkSync(path.join(checkout, "unrelated.txt"));

    fs.mkdirSync(lock);
    const busy = execute();
    assert.equal(busy.status, 1);
    assert.equal(fs.existsSync(lock), true, "a competing lease must not be removed");
    fs.rmdirSync(lock);

    const failed = execute({ FIXTURE_EXIT: "7" });
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, new RegExp(`WMUX:VERIFY:fixture:${commit}:1:\\d+`));
    assert.equal(fs.existsSync(lock), false);

    const environmentFile = path.join(temp, "environment.json");
    fs.writeFileSync(environmentFile, "invalid sensitive fixture data");
    const invalidEnvironment = execute({}, { environmentFile });
    assert.equal(invalidEnvironment.status, 1);
    assert.match(invalidEnvironment.stderr, /environment file is missing or invalid/);
    assert.doesNotMatch(invalidEnvironment.stderr, /sensitive fixture data/);
    const missingFixture = execute({ WMUX_E2E_BASE_URL: "", WMUX_E2E_TOKEN: "" }, { script: "test:e2e:browser:chromium" });
    assert.equal(missingFixture.status, 1);
    assert.match(missingFixture.stderr, /provisioned external fixture/);

    git("remote", "set-url", "owner", "https://github.com/unrelated/wmux.git");
    const wrongOwner = execute();
    assert.equal(wrongOwner.status, 1);
    assert.match(wrongOwner.stderr, /No remote points to the owner/);
    assert.doesNotMatch(wrongOwner.stdout, /fixture npm/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
