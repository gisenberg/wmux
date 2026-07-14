import assert from "node:assert/strict";
import test from "node:test";
import { runCommand } from "../src/server/child-process.js";

test("runCommand captures output without blocking the event loop", async () => {
  let timerFired = false;
  const timer = setTimeout(() => {
    timerFired = true;
  }, 10);
  const result = await runCommand(process.execPath, ["-e", "setTimeout(() => console.log('done'), 40)"], {
    timeoutMs: 1000,
  });
  clearTimeout(timer);

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "done");
  assert.equal(result.timedOut, false);
  assert.equal(timerFired, true);
});

test("runCommand terminates commands that exceed their deadline", async () => {
  const result = await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], {
    timeoutMs: 30,
  });

  assert.equal(result.timedOut, true);
  assert.notEqual(result.status, 0);
});
