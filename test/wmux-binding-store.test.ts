import assert from "node:assert/strict";
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
  return { schemaVersion: 2, sessionId, bindingId: index.toString(36).padStart(22, "a"), receipt, expiresAt: new Date(createdAt + 86_400_000).toISOString(), createdAt, promptTurnId: turn, lastName: null };
}
test.after(() => { delete process.env.WMUX_CODEX_PLUGIN_RUNTIME_DIR; fs.rmSync(runtime, { recursive: true, force: true }); });

test("binding store caps valid records, removes expired records, and selects only an exact turn", () => {
  for (let index = 0; index < 513; index++) bindings.saveBinding(binding(index));
  const files = fs.readdirSync(runtime).filter(name => name.endsWith(".json"));
  assert.ok(files.length <= 512);
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

test("same-session bindings serialize the full action despite distinct receipts", async () => {
  const first = binding(700, "first"), second = binding(701, "second"), events: string[] = [];
  bindings.saveBinding(first); bindings.saveBinding(second);
  await Promise.all([
    bindings.withBinding(first, async () => { events.push("first:start"); await delay(60); events.push("first:end"); }),
    bindings.withBinding(second, async () => { events.push("second:start"); await delay(1); events.push("second:end"); }),
  ]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});
