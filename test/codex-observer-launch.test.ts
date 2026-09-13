import assert from "node:assert/strict";
import test from "node:test";
import { startCodexObserver } from "../plugins/wmux/scripts/wmux-observer.mjs";

test("twenty concurrent hook launches coalesce behind one acknowledged observer", async () => {
  let locked = false, serviceAlive = false, spawned = 0;
  const acquire = async () => {
    while (locked) await new Promise(resolve => setTimeout(resolve, 1));
    locked = true;
    return { release: async () => { locked = false; } };
  };
  const probe = async () => serviceAlive ? null : async () => {};
  const spawnChild = () => {
    spawned += 1; serviceAlive = true;
    const handlers = new Map<string, Function>();
    queueMicrotask(() => handlers.get("message")?.({ wmuxObserver: "acquired" }));
    return { on: (event: string, handler: Function) => handlers.set(event, handler), once: () => {}, off: () => {}, disconnect() {}, unref() {} };
  };
  await Promise.all(Array.from({ length: 20 }, () => startCodexObserver("root", "b".repeat(22), {
    load: () => ({ sessionId: "root" }), acquire, probe, spawnChild,
  })));
  assert.equal(spawned, 1);
});
