import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-binding-store-"));
process.env.WMUX_CODEX_PLUGIN_RUNTIME_DIR = runtime;
const bindings = await import("../plugins/wmux/scripts/wmux-binding.mjs");
const receipt = "r".repeat(43), sessionId = "one_session";
function binding(index: number, turn = `turn-${index}`, createdAt = Date.now()) {
  return { schemaVersion: 2, sessionId, bindingId: index.toString(36).padStart(22, "0"), receipt, expiresAt: new Date(createdAt + 86_400_000).toISOString(), createdAt, promptTurnId: turn, lastName: null };
}
function recordPath(record: { sessionId: string; bindingId: string }) {
  return path.join(runtime, `${createHash("sha256").update(`${record.sessionId}\0${record.bindingId}`).digest("hex")}.json`);
}
test.after(() => { delete process.env.WMUX_CODEX_PLUGIN_RUNTIME_DIR; fs.rmSync(runtime, { recursive: true, force: true }); });

test("binding store caps valid records, removes expired records, and selects only an exact turn", () => {
  // Seed a full store directly: every saveBinding rescans all records, so 513
  // saves cost over 100k file opens and take minutes on Windows.
  const seededAt = Date.now() - 60_000;
  for (let index = 0; index < 512; index++) {
    const record = binding(index, `turn-${index}`, seededAt + index);
    fs.writeFileSync(recordPath(record), JSON.stringify(record), { mode: 0o600 });
  }
  bindings.saveBinding(binding(512));
  const files = fs.readdirSync(runtime).filter(name => name.endsWith(".json"));
  assert.equal(files.length, 512);
  assert.equal(fs.existsSync(recordPath(binding(0))), false, "the oldest record makes room for the new one");
  assert.equal(fs.existsSync(recordPath(binding(1))), true);
  const exact = bindings.promptBinding(sessionId, "turn-512");
  assert.equal(exact?.bindingId, binding(512).bindingId);
  assert.equal(bindings.promptBinding(sessionId, "missing"), null);
  assert.equal(bindings.promptBinding(sessionId, undefined), null);

  const expiring = binding(600, "expired");
  bindings.saveBinding(expiring);
  const expiredFile = fs.readdirSync(runtime).find(name => name.endsWith(".json") && JSON.parse(fs.readFileSync(path.join(runtime, name), "utf8")).bindingId === expiring.bindingId);
  assert.ok(expiredFile);
  const expired = JSON.parse(fs.readFileSync(path.join(runtime, expiredFile), "utf8"));
  expired.createdAt = Date.now() - 86_400_001;
  fs.writeFileSync(path.join(runtime, expiredFile), JSON.stringify(expired), { mode: 0o600 });
  bindings.saveBinding(binding(601, "fresh"));
  assert.equal(fs.existsSync(path.join(runtime, expiredFile)), false);
});

test("same-session bindings serialize the full action despite distinct receipts", {
  skip: process.platform === "win32" ? "binding serialization requires POSIX flock and directory fsync" : false,
}, async () => {
  const first = binding(700, "first"), second = binding(701, "second"), events: string[] = [];
  bindings.saveBinding(first); bindings.saveBinding(second);
  await Promise.all([
    bindings.withBinding(first, async () => { events.push("first:start"); await delay(60); events.push("first:end"); }),
    bindings.withBinding(second, async () => { events.push("second:start"); await delay(1); events.push("second:end"); }),
  ]);
  assert.ok([["first:start", "first:end", "second:start", "second:end"], ["second:start", "second:end", "first:start", "first:end"]]
    .some(expected => JSON.stringify(events) === JSON.stringify(expected)));
});

test("updating an existing binding at capacity does not evict another receipt, and legacy v2 is not supervised", () => {
  // This record must exist even when the POSIX serialization test is skipped.
  bindings.saveBinding(binding(701, "second"));
  const before = fs.readdirSync(runtime).filter(name => name.endsWith(".json")).sort();
  bindings.saveBinding(binding(701, "second"));
  const after = fs.readdirSync(runtime).filter(name => name.endsWith(".json")).sort();
  assert.deepEqual(after, before);
  assert.equal(bindings.liveBindings().some((item: any) => item.schemaVersion === 2), false);
});
