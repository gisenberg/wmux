import assert from "node:assert/strict";
import test from "node:test";
import {
  TERMINAL_OUTPUT_BATCH_MS,
  createAlternateScreenState,
  createTouchScrollGesture,
  createWheelScrollCoalescer,
  pushAlternateScreenState,
  resetAlternateScreenState,
  terminalOutputDelay,
} from "../src/client/src/terminal-pane-runtime.js";

const createFrameScheduler = () => {
  let nextFrame = 1;
  const callbacks = new Map<number, () => void>();
  return {
    requestFrame: (callback: () => void) => {
      const frame = nextFrame++;
      callbacks.set(frame, callback);
      return frame;
    },
    cancelFrame: (frame: number) => callbacks.delete(frame),
    runFrame: () => {
      const queued = [...callbacks.values()];
      callbacks.clear();
      for (const callback of queued) callback();
    },
    pendingFrames: () => callbacks.size,
  };
};

test("alternate-screen tracking handles split DEC sequences without changing bytes", () => {
  const state = createAlternateScreenState();
  const first = "before\x1b[?10";
  const second = "49hafter";
  assert.equal(pushAlternateScreenState(state, first), false);
  assert.equal(pushAlternateScreenState(state, second), true);
  assert.equal(pushAlternateScreenState(state, "\x1b[?1049l"), false);
  resetAlternateScreenState(state);
  assert.deepEqual(state, { active: false, carry: "" });
});

test("output delay keeps normal output low latency and follows mutable alternate-screen frame rates", () => {
  assert.equal(terminalOutputDelay(false, 15, 0, 1), TERMINAL_OUTPUT_BATCH_MS);
  assert.equal(terminalOutputDelay(false, 15, 100, 120, 110), 0);
  assert.equal(terminalOutputDelay(true, 15, 100, 120, 110), 0);
  assert.equal(terminalOutputDelay(true, 15, 0, 300), 0);
  assert.equal(terminalOutputDelay(true, 15, 100, 120), 67);
  assert.equal(terminalOutputDelay(true, 30, 100, 120), 33);
  assert.equal(terminalOutputDelay(true, 60, 100, 120), 17);
});

test("wheel scrolling coalesces deltas and preserves fractional residuals", () => {
  const scheduler = createFrameScheduler();
  const scrolls: number[] = [];
  const coalescer = createWheelScrollCoalescer({
    scrollLines: (lines) => scrolls.push(lines),
    ...scheduler,
  });

  coalescer.push(0.6);
  coalescer.push(0.6);
  assert.equal(scheduler.pendingFrames(), 1);
  scheduler.runFrame();
  assert.deepEqual(scrolls, [1]);
  coalescer.push(0.8);
  scheduler.runFrame();
  assert.deepEqual(scrolls, [1, 1]);
});

test("wheel scrolling cancels opposite-direction pending deltas and disposes frames", () => {
  const scheduler = createFrameScheduler();
  const scrolls: number[] = [];
  const coalescer = createWheelScrollCoalescer({
    scrollLines: (lines) => scrolls.push(lines),
    ...scheduler,
  });

  coalescer.push(0);
  coalescer.push(Number.NaN);
  coalescer.push(Number.POSITIVE_INFINITY);
  assert.equal(scheduler.pendingFrames(), 0);
  coalescer.push(1);
  coalescer.push(-1);
  assert.equal(scheduler.pendingFrames(), 0);
  coalescer.push(2);
  assert.equal(scheduler.pendingFrames(), 1);
  coalescer.dispose();
  assert.equal(scheduler.pendingFrames(), 0);
  scheduler.runFrame();
  coalescer.push(3);
  assert.deepEqual(scrolls, []);
});

test("touch scrolling distinguishes taps and converts swipes into terminal lines", () => {
  const gesture = createTouchScrollGesture();

  gesture.start(1, 100);
  assert.deepEqual(gesture.move(1, 95, 20), { handled: false, lines: 0 });
  assert.deepEqual(gesture.end(1), { handled: true, tap: true });

  gesture.start(2, 100);
  assert.deepEqual(gesture.move(2, 60, 20), { handled: true, lines: 2 });
  assert.deepEqual(gesture.move(2, 50, 20), { handled: true, lines: 0 });
  assert.deepEqual(gesture.move(2, 40, 20), { handled: true, lines: 1 });
  assert.deepEqual(gesture.end(2), { handled: true, tap: false });
});

test("touch scrolling ignores unrelated pointers and resets cancelled gestures", () => {
  const gesture = createTouchScrollGesture();
  gesture.start(3, 20);
  assert.deepEqual(gesture.move(4, 60, 20), { handled: false, lines: 0 });
  assert.deepEqual(gesture.end(4), { handled: false, tap: false });
  assert.deepEqual(gesture.move(3, 60, 20), { handled: true, lines: -2 });
  gesture.cancel();
  assert.deepEqual(gesture.end(3), { handled: false, tap: false });
});
