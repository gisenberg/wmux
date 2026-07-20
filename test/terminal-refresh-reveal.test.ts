import assert from "node:assert/strict";
import test from "node:test";
import {
  DURABLE_REFRESH_FALLBACK_MS,
  DURABLE_REFRESH_FIRST_NUDGE_MS,
  DURABLE_REFRESH_QUIET_MS,
  createDurableRefreshRevealGate,
  shouldShieldTerminalBeforeResume,
  shouldWaitForDurableRefresh,
} from "../src/client/src/terminal-pane-runtime.js";

class FakeTimers {
  now = 0;
  private nextId = 1;
  private tasks = new Map<number, { at: number; callback: () => void }>();
  private allCallbacks: Array<() => void> = [];

  setTimer = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + delayMs, callback });
    this.allCallbacks.push(callback);
    return id;
  };

  clearTimer = (id: number): void => {
    this.tasks.delete(id);
  };

  callback(id: number): (() => void) | undefined {
    return this.tasks.get(id)?.callback;
  }

  callbacks(): Array<() => void> {
    return [...this.allCallbacks];
  }

  advance(ms: number): void {
    const target = this.now + ms;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      const [id, task] = next;
      this.tasks.delete(id);
      this.now = task.at;
      task.callback();
    }
    this.now = target;
  }
}

const createGate = (timers: FakeTimers, reveal: () => void, isReady?: () => boolean) => createDurableRefreshRevealGate({
  onReveal: reveal,
  isReady,
  now: () => timers.now,
  setTimer: timers.setTimer,
  clearTimer: timers.clearTimer,
});

test("all-early durable refresh output reveals after the first-nudge quiet window instead of fallback", () => {
  const timers = new FakeTimers();
  let reveals = 0;
  const gate = createGate(timers, () => { reveals += 1; });
  gate.begin();

  timers.advance(20);
  gate.noteOutput();
  timers.advance(80);
  gate.noteOutput();
  timers.advance(DURABLE_REFRESH_FIRST_NUDGE_MS + DURABLE_REFRESH_QUIET_MS - timers.now - 1);
  assert.equal(reveals, 0);
  timers.advance(1);
  assert.equal(reveals, 1);
  assert.equal(timers.now, DURABLE_REFRESH_FIRST_NUDGE_MS + DURABLE_REFRESH_QUIET_MS);
  assert.ok(timers.now < DURABLE_REFRESH_FALLBACK_MS);
});

test("quiet reveal retries until synchronized output is ready", () => {
  const timers = new FakeTimers();
  let ready = false;
  let reveals = 0;
  const gate = createGate(timers, () => { reveals += 1; }, () => ready);
  gate.begin();
  timers.advance(20);
  gate.noteOutput();

  timers.advance(DURABLE_REFRESH_FIRST_NUDGE_MS + DURABLE_REFRESH_QUIET_MS - timers.now);
  assert.equal(reveals, 0);
  ready = true;
  timers.advance(DURABLE_REFRESH_QUIET_MS - 1);
  assert.equal(reveals, 0);
  timers.advance(1);
  assert.equal(reveals, 1);
});

test("noteOutput calls at 40ms do not rebase fallback and only one reveal occurs at the absolute bound", () => {
  const timers = new FakeTimers();
  let reveals = 0;
  const gate = createGate(timers, () => { reveals += 1; }, () => false);
  gate.begin();

  for (let elapsed = 40; elapsed < DURABLE_REFRESH_FALLBACK_MS; elapsed += 40) {
    timers.advance(40);
    gate.noteOutput();
    assert.equal(timers.now, elapsed);
    assert.equal(reveals, 0);
  }

  const callbackCandidates = timers.callbacks();
  assert.ok(callbackCandidates.length >= 1);

  timers.advance(DURABLE_REFRESH_FALLBACK_MS - timers.now);
  assert.equal(timers.now, DURABLE_REFRESH_FALLBACK_MS);
  assert.equal(reveals, 1);

  for (const callback of callbackCandidates) {
    callback();
    assert.equal(reveals, 1);
  }
  assert.equal(reveals, 1);
});

test("flagged empty durable refresh has a bounded no-output fallback", () => {
  const timers = new FakeTimers();
  let reveals = 0;
  const gate = createGate(timers, () => { reveals += 1; }, () => false);
  gate.begin();
  timers.advance(DURABLE_REFRESH_FALLBACK_MS - 1);
  assert.equal(reveals, 0);
  timers.advance(1);
  assert.equal(reveals, 1);
});

test("nonempty raw and checkpoint ready messages keep the existing fast path", () => {
  assert.equal(shouldWaitForDurableRefresh({ replay: "prompt", replayKind: "raw", waitForRefresh: true }), false);
  assert.equal(shouldWaitForDurableRefresh({ replay: "screen", replayKind: "checkpoint", waitForRefresh: true }), false);
  assert.equal(shouldWaitForDurableRefresh({ replay: "", replayKind: "raw" }), false);
  assert.equal(shouldWaitForDurableRefresh({ replay: "", replayKind: "raw", waitForRefresh: true }), true);
});

test("a suspended terminal is shielded before its visible tab resumes", () => {
  assert.equal(shouldShieldTerminalBeforeResume("suspend", true, true), true);
  assert.equal(shouldShieldTerminalBeforeResume("suspend", false, true), false);
  assert.equal(shouldShieldTerminalBeforeResume("suspend", true, false), false);
  assert.equal(shouldShieldTerminalBeforeResume("live", true, true), false);
});

test("cancel and a new begin prevent stale pause or reconnect timers from revealing", () => {
  const timers = new FakeTimers();
  let reveals = 0;
  const gate = createGate(timers, () => { reveals += 1; });
  gate.begin();
  const staleFallback = timers.callback(1);
  assert.ok(staleFallback);

  gate.cancel();
  staleFallback();
  assert.equal(reveals, 0);

  gate.begin();
  staleFallback();
  assert.equal(reveals, 0);
  timers.advance(DURABLE_REFRESH_FALLBACK_MS);
  assert.equal(reveals, 1);
});
