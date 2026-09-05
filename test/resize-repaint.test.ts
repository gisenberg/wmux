import assert from "node:assert/strict";
import test from "node:test";
import { ResizeRepaint } from "../src/server/resize-repaint.js";

test("resize repair expires during continuous output and cannot fire when that output stops", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  let paints = 0;
  const repair = new ResizeRepaint(() => paints++);
  repair.arm();
  for (let i = 0; i < 20; i++) {
    repair.output();
    t.mock.timers.tick(100);
  }
  t.mock.timers.tick(5000);
  assert.equal(paints, 0);
});

test("resize repair paints once after a quiet frame or a silent resize", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  let paints = 0;
  const repair = new ResizeRepaint(() => paints++);
  repair.arm();
  repair.output();
  t.mock.timers.tick(119);
  assert.equal(paints, 0);
  t.mock.timers.tick(1);
  assert.equal(paints, 1);
  repair.output();
  t.mock.timers.tick(2000);
  assert.equal(paints, 1);
  repair.arm();
  t.mock.timers.tick(999);
  assert.equal(paints, 1);
  t.mock.timers.tick(1);
  assert.equal(paints, 2);
});

test("a new resize or detach cancels the previous repair", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  let paints = 0;
  const repair = new ResizeRepaint(() => paints++);
  repair.arm();
  repair.output();
  t.mock.timers.tick(100);
  repair.cancel();
  t.mock.timers.tick(2000);
  assert.equal(paints, 0);
  repair.arm();
  t.mock.timers.tick(500);
  repair.arm();
  t.mock.timers.tick(500);
  assert.equal(paints, 0);
  t.mock.timers.tick(500);
  assert.equal(paints, 1);
});
