import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pluginIdentity, probeThread, schemaCapabilities } from "../scripts/codex-baseline.mjs";

test("baseline records artifact content changes and rejects symlinked artifacts", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-baseline-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, ".codex-plugin"));
  fs.writeFileSync(path.join(directory, ".codex-plugin/plugin.json"), JSON.stringify({ version: "0.3.0" }));
  const first = pluginIdentity(directory);
  fs.writeFileSync(path.join(directory, "extra.mjs"), "export default 1;");
  assert.notEqual(pluginIdentity(directory).sha256, first.sha256);
  assert.equal(first.version, "0.3.0");
  assert.equal(JSON.stringify(first).includes(directory), false);
  if (process.platform !== "win32") {
    fs.symlinkSync(path.join(directory, "extra.mjs"), path.join(directory, "link.mjs"));
    assert.throws(() => pluginIdentity(directory), /symlinks/);
  }
});

test("baseline native probe is exact, metadata-only, sanitized, and closes on every outcome", async () => {
  for (const mode of ["readable", "wrong-root", "child", "error"]) {
    const methods: unknown[] = []; let closed = false;
    const result = await probeThread({ threadId: "explicit-root" }, async ({ threadId }) => {
      assert.equal(threadId, "explicit-root");
      return { close() { closed = true; }, async request(method, params) {
        methods.push([method, params]);
        if (mode === "error") throw new Error("private endpoint details");
        return { thread: { id: mode === "wrong-root" ? "someone-else" : threadId,
          parentThreadId: mode === "child" ? "parent" : null, name: "private task name", cwd: "/private/path", status: { type: "notLoaded" } } };
      } };
    });
    assert.deepEqual(methods, [["thread/read", { threadId: "explicit-root", includeTurns: false }]]);
    assert.equal(closed, true);
    assert.equal(result.result, mode === "readable" ? "readable" : mode === "error" ? "unavailable" : "identity_mismatch");
    assert.equal(JSON.stringify(result).includes("private"), false);
    if (mode === "readable") assert.equal(result.runtimeStatus, "notLoaded");
  }
});

test("schema evidence does not mistake a name event for an observation subscription", () => {
  const report = schemaCapabilities({ oneOf: [{ properties: { method: { enum: ["thread/read"] } } }],
    definitions: { ThreadReadParams: { properties: { includeTurns: {} } } } },
  { oneOf: [{ properties: { method: { enum: ["thread/name/updated"] } } }], definitions: { Thread: { properties: { name: {} } } } });
  assert.equal(report.nativeNameNotification, true);
  assert.equal(report.threadRead, true);
  assert.equal(report.boundedTurnListing, false);
  assert.equal(report.observationSubscriptionEstablished, false);
});
