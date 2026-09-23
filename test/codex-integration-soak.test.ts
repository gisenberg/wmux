import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

test("isolated catalog and display-association soak is engineering-only when shortened", { timeout: 60_000, skip: process.platform === "win32" }, () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-codex-integration-soak-test-"));
  const output = path.join(parent, "report");
  fs.chmodSync(parent, 0o700);
  try {
    const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/codex-integration-soak.mjs", "--source-modules", "--out", output, "--duration-seconds", "8", "--fault-period-seconds", "2", "--fault-duration-seconds", "1"], { cwd: root, encoding: "utf8", timeout: 30_000 });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const report = JSON.parse(fs.readFileSync(path.join(output, "report.json"), "utf8"));
    assert.equal(report.accepted, false);
    assert.equal(report.sourceMode, true);
    assert.equal(report.qualification, "engineering_only_not_24h");
    assert.equal(report.metrics.launchCalls, 1);
    assert.ok(report.metrics.faults > 0);
    assert.ok(report.assertions.every((entry: { passed: boolean }) => entry.passed));
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});
