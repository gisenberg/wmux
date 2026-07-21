import assert from "node:assert/strict";
import test from "node:test";
import type { Terminal } from "ghostty-web";
import { createTerminalFitter } from "../src/client/src/terminal-pane-runtime.js";

test("passive terminal fit proposals do not replace the authoritative grid", () => {
  const globals = globalThis as typeof globalThis & {
    ResizeObserver?: typeof ResizeObserver;
    window?: Window & typeof globalThis;
  };
  const previousWindow = globals.window;
  const previousResizeObserver = globals.ResizeObserver;
  const element = { clientWidth: 1_000, clientHeight: 600 } as HTMLElement;
  const resizes: Array<[number, number]> = [];
  const terminal = {
    cols: 80,
    rows: 24,
    renderer: { getMetrics: () => ({ width: 10, height: 20 }) },
    resize: (cols: number, rows: number) => {
      terminal.cols = cols;
      terminal.rows = rows;
      resizes.push([cols, rows]);
    },
  } as unknown as Terminal;
  const proposals: Array<{ cols: number; rows: number }> = [];

  class StubResizeObserver {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  }

  globals.window = {
    getComputedStyle: () => ({
      paddingLeft: "0",
      paddingRight: "0",
      paddingTop: "0",
      paddingBottom: "0",
    }),
  } as unknown as Window & typeof globalThis;
  globals.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;

  const fitter = createTerminalFitter(terminal, element, (dimensions) => proposals.push(dimensions));
  try {
    fitter.fit();
    assert.deepEqual(proposals, [{ cols: 100, rows: 30 }]);
    assert.deepEqual(resizes, [[100, 30]]);

    fitter.setAuthoritativeSize(80, 24, false);
    assert.deepEqual(resizes.at(-1), [80, 24]);

    Object.defineProperty(element, "clientWidth", { configurable: true, value: 1_100 });
    fitter.fit();
    assert.deepEqual(proposals.at(-1), { cols: 110, rows: 30 });
    assert.deepEqual(resizes.at(-1), [80, 24]);

    fitter.setForeground(true);
    fitter.setAuthoritativeSize(110, 30, true);
    assert.deepEqual(resizes.at(-1), [110, 30]);

    fitter.setForeground(false);
    Object.defineProperty(element, "clientWidth", { configurable: true, value: 1_200 });
    fitter.fit();
    assert.deepEqual(proposals.at(-1), { cols: 120, rows: 30 });
    assert.deepEqual(resizes.at(-1), [110, 30]);
  } finally {
    fitter.dispose();
    if (previousWindow === undefined) delete globals.window;
    else globals.window = previousWindow;
    if (previousResizeObserver === undefined) delete globals.ResizeObserver;
    else globals.ResizeObserver = previousResizeObserver;
  }
});
