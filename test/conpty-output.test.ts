import assert from "node:assert/strict";
import { test } from "node:test";
import { ConptyMeasurementPin } from "../src/server/conpty-output.js";

test("ConPTY output keeps grapheme clustering on after application resets", () => {
  const pin = new ConptyMeasurementPin();
  assert.equal(pin.push("before\x1bcafter"), "before\x1bc\x1b[?2027hafter");
  assert.equal(pin.push("plain"), "plain");
  assert.equal(pin.push("\x1b[31mred\x1b[0m"), "\x1b[31mred\x1b[0m");
});

test("ConPTY output pins clustering after a reset split across chunks", () => {
  const pin = new ConptyMeasurementPin();
  assert.equal(pin.push("tail\x1b"), "tail\x1b");
  assert.equal(pin.push("cnext"), "c\x1b[?2027hnext");
  assert.equal(pin.push("\x1b"), "\x1b");
  assert.equal(pin.push("[0m"), "[0m");
  pin.push("x\x1b");
  pin.reset();
  assert.equal(pin.push("c"), "c");
});
