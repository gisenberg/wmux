import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BootstrapRecovery } from "../src/client/src/bootstrap-recovery.js";

test("bootstrap recovery serializes and coalesces reconnect and revision-gap requests", async () => {
  const resolvers: ((value: number) => void)[] = [];
  const applied: number[] = [];
  const recovery = new BootstrapRecovery({
    fetch: () => new Promise<number>((resolve) => resolvers.push(resolve)),
    apply: (value) => { applied.push(value); return true; },
    failed: () => false,
  });
  const done = recovery.request();
  void recovery.request();
  void recovery.request();
  assert.equal(resolvers.length, 1);
  resolvers[0](1);
  await Promise.resolve();
  assert.equal(resolvers.length, 2);
  resolvers[1](2);
  await done;
  assert.deepEqual(applied, [1, 2]);
  recovery.stop();
});

test("disposed recovery never applies a late response or schedules another fetch", async () => {
  let resolve!: (value: number) => void;
  const recovery = new BootstrapRecovery({
    fetch: () => new Promise<number>((done) => { resolve = done; }),
    apply: () => assert.fail("disposed response applied"),
    failed: () => assert.fail("disposed failure applied"),
  });
  const done = recovery.request();
  void recovery.request();
  recovery.stop();
  resolve(1);
  await done;
});

test("transient recovery retries with backoff; auth failure ends pending requests", async () => {
  let calls = 0;
  const attempts: number[] = [];
  const recovery = new BootstrapRecovery({
    fetch: async () => { calls += 1; throw new Error(calls === 1 ? "network" : "auth"); },
    apply: () => true,
    failed: (error) => (error as Error).message === "network",
    delay: (attempt) => { attempts.push(attempt); return 1; },
  });
  await recovery.request();
  await delay(25);
  assert.equal(calls, 2);
  assert.deepEqual(attempts, [1]);
  recovery.stop();
});
