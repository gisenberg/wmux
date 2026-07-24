import assert from "node:assert/strict";
import test from "node:test";
import {
  minimumTerminalRendererDevicePixelRatio,
  terminalRendererDevicePixelRatio,
} from "../src/client/src/terminal-render-scale.ts";

test("terminal rendering supersamples low-density displays", () => {
  assert.equal(terminalRendererDevicePixelRatio(1), 2);
  assert.equal(terminalRendererDevicePixelRatio(1.25), 2);
  assert.equal(terminalRendererDevicePixelRatio(1.5), 2);
  assert.equal(terminalRendererDevicePixelRatio(2), 2);
  assert.equal(minimumTerminalRendererDevicePixelRatio, 2);
});

test("terminal rendering preserves higher browser display scales", () => {
  assert.equal(terminalRendererDevicePixelRatio(2.5), 2.5);
  assert.equal(terminalRendererDevicePixelRatio(3), 3);
});

test("terminal rendering rejects unusable browser display scales", () => {
  assert.equal(terminalRendererDevicePixelRatio(undefined), 2);
  assert.equal(terminalRendererDevicePixelRatio(0), 2);
  assert.equal(terminalRendererDevicePixelRatio(Number.NaN), 2);
  assert.equal(terminalRendererDevicePixelRatio(Number.POSITIVE_INFINITY), 2);
});
