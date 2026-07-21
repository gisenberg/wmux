import assert from "node:assert/strict";
import test from "node:test";
import {
  createTerminalPredictionEchoProbe,
  extendTerminalPredictionEchoProbe,
  layoutPredictedTerminalInput,
  predictedTerminalInput,
  terminalPredictionCellBackground,
  terminalPredictionEchoProbeMatches,
} from "../src/client/src/terminal-input-prediction.js";

test("terminal prediction accepts bounded printable input and backspace only", () => {
  assert.deepEqual(predictedTerminalInput(1, "a"), { sequence: 1, kind: "insert", text: "a" });
  assert.deepEqual(predictedTerminalInput(2, "\x7f"), { sequence: 2, kind: "backspace", text: "" });
  assert.equal(predictedTerminalInput(3, "\r"), null);
  assert.equal(predictedTerminalInput(4, "ab"), null);
  assert.equal(predictedTerminalInput(5, "λ"), null);
});

test("terminal prediction uses the cursor cell's effective background", () => {
  const cell = {
    fg_r: 210,
    fg_g: 220,
    fg_b: 230,
    bg_r: 12,
    bg_g: 34,
    bg_b: 56,
    fgIsDefault: false,
    bgIsDefault: false,
    flags: 0,
  };
  assert.equal(terminalPredictionCellBackground(cell), "rgb(12, 34, 56)");
  assert.equal(terminalPredictionCellBackground({ ...cell, flags: 1 << 4 }), "rgb(210, 220, 230)");
  assert.equal(
    terminalPredictionCellBackground({ ...cell, flags: 1 << 4, fgIsDefault: true }),
    "var(--terminal-foreground)",
  );
  assert.equal(
    terminalPredictionCellBackground({ ...cell, bgIsDefault: true }),
    "var(--terminal-background)",
  );
  assert.equal(terminalPredictionCellBackground(undefined), "var(--terminal-background)");
});

test("terminal prediction verifies an acknowledged rendered-cell echo", () => {
  const probe = createTerminalPredictionEchoProbe(
    predictedTerminalInput(1, "a")!,
    { x: 4, y: 2, visible: true },
    10,
    5,
    "normal",
    0,
  );
  assert.ok(probe);
  const cells = new Map([[
    "4:2",
    "a".codePointAt(0)!,
  ]]);
  const matches = (sequence: number | undefined, screen: "normal" | "alternate", x = 5) =>
    terminalPredictionEchoProbeMatches(
      probe,
      sequence,
      { x, y: 2, visible: true },
      10,
      5,
      screen,
      (col, row) => cells.get(`${col}:${row}`),
    );
  assert.equal(matches(1, "normal"), true);
  assert.equal(matches(undefined, "normal"), false);
  assert.equal(matches(1, "alternate"), false);
  assert.equal(matches(1, "normal", 4), false);
});

test("terminal prediction echo verification handles an acknowledged input burst", () => {
  let probe = createTerminalPredictionEchoProbe(
    predictedTerminalInput(3, "a")!,
    { x: 2, y: 1, visible: true },
    10,
    5,
    "alternate",
    0,
  );
  assert.ok(probe);
  probe = extendTerminalPredictionEchoProbe(probe, predictedTerminalInput(4, "b")!, 10, 5);
  assert.ok(probe);
  const cells = new Map([
    ["2:1", "a".codePointAt(0)!],
    ["3:1", "b".codePointAt(0)!],
  ]);
  assert.equal(terminalPredictionEchoProbeMatches(
    probe,
    4,
    { x: 4, y: 1, visible: true },
    10,
    5,
    "alternate",
    (col, row) => cells.get(`${col}:${row}`),
  ), true);
  assert.equal(terminalPredictionEchoProbeMatches(
    probe,
    3,
    { x: 4, y: 1, visible: true },
    10,
    5,
    "alternate",
    (col, row) => cells.get(`${col}:${row}`),
  ), false);
});

test("terminal prediction echo verification rejects hidden and unchanged input", () => {
  assert.equal(createTerminalPredictionEchoProbe(
    predictedTerminalInput(1, "a")!,
    { x: 4, y: 2, visible: false },
    10,
    5,
    "normal",
    0,
  ), null);
  const probe = createTerminalPredictionEchoProbe(
    predictedTerminalInput(1, "a")!,
    { x: 4, y: 2, visible: true },
    10,
    5,
    "normal",
    "a".codePointAt(0),
  );
  assert.ok(probe);
  assert.equal(terminalPredictionEchoProbeMatches(
    probe,
    1,
    { x: 5, y: 2, visible: true },
    10,
    5,
    "normal",
    () => "a".codePointAt(0),
  ), false);
});

test("terminal prediction lays out inserts and erases without mutating terminal state", () => {
  const predictions = [
    predictedTerminalInput(1, "a")!,
    predictedTerminalInput(2, "b")!,
    predictedTerminalInput(3, "\x7f")!,
    predictedTerminalInput(4, "c")!,
  ];
  assert.deepEqual(
    layoutPredictedTerminalInput({ x: 4, y: 2, visible: true }, 10, 5, predictions),
    {
      cells: [
        { col: 4, row: 2, text: "a" },
        { col: 5, row: 2, text: "c" },
      ],
      cursor: { col: 6, row: 2 },
      authoritativeCursor: { col: 4, row: 2 },
    },
  );
});

test("terminal prediction wraps inserts but refuses ambiguous wrapped backspace", () => {
  assert.deepEqual(
    layoutPredictedTerminalInput(
      { x: 3, y: 0, visible: true },
      4,
      2,
      [predictedTerminalInput(1, "x")!, predictedTerminalInput(2, "y")!],
    )?.cursor,
    { col: 1, row: 1 },
  );
  assert.equal(
    layoutPredictedTerminalInput(
      { x: 0, y: 1, visible: true },
      4,
      2,
      [predictedTerminalInput(1, "\b")!],
    ),
    null,
  );
});
