import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { StateStore } from "../src/server/state.js";

test("background disk failure preserves live state and retries the newest snapshot", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-persistence-health-"));
  const file = path.join(directory, "state.json");
  const state = new StateStore([{ id: "local", name: "Local", kind: "local" }], file);
  const originalRename = fs.renameSync;
  let fail = true;
  context.mock.method(fs, "renameSync", (from, to) => {
    if (to === file && fail) throw Object.assign(new Error("fixture private path must not escape"), { code: "ENOSPC" });
    return originalRename(from, to);
  });
  try {
    const failed = new Promise<void>((resolve) => state.once("persistence-failed", () => resolve()));
    state.createWorkspace("local");
    await failed;
    assert.equal(state.persistenceHealth().dirty, true);
    assert.equal(state.persistenceHealth().errorCode, "ENOSPC");
    assert.doesNotMatch(JSON.stringify(state.persistenceHealth()), /private path|fixture/);
    state.createWorkspace("local");
    const expected = state.snapshot().workspaces.length;
    fail = false;
    const deadline = Date.now() + 3000;
    while (state.persistenceHealth().dirty && Date.now() < deadline) await delay(20);
    assert.equal(state.persistenceHealth().dirty, false);
    assert.equal(state.persistenceHealth().failureCount, 0);
    assert.equal(state.persistenceHealth().errorCode, undefined);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).workspaces.length, expected);
  } finally {
    fail = false;
    state.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
