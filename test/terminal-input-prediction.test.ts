import assert from "node:assert/strict";
import test from "node:test";
import { CellFlags, type GhosttyCell } from "ghostty-web";
import {
  createTerminalPredictionEchoProbe,
  effectiveTerminalPredictionCellStyle,
  extendTerminalPredictionEchoProbe,
  isPredictableTerminalCodepoint,
  layoutPredictedTerminalInput,
  predictedTerminalInput,
  settlePredictedTerminalInput,
  terminalPredictionCellPaint,
  terminalPredictionCursorMatches,
  terminalPredictionEchoProbeMatches,
  terminalPredictionStyleAtCursor,
} from "../src/client/src/terminal-input-prediction.js";
import { ghosttyCanvasFont } from "../src/client/src/terminal-prediction-renderer.js";

const terminalCell = (overrides: Partial<GhosttyCell> = {}): GhosttyCell => ({
  codepoint: 0,
  fg_r: 0,
  fg_g: 0,
  fg_b: 0,
  bg_r: 0,
  bg_g: 0,
  bg_b: 0,
  fgIsDefault: true,
  bgIsDefault: true,
  flags: 0,
  width: 1,
  hyperlink_id: 0,
  grapheme_len: 0,
  ...overrides,
});

test("terminal prediction accepts single narrow printable input and backspace only", () => {
  assert.deepEqual(predictedTerminalInput(1, "a"), { sequence: 1, kind: "insert", text: "a" });
  assert.deepEqual(predictedTerminalInput(2, "\x7f"), { sequence: 2, kind: "backspace", text: "" });
  assert.deepEqual(predictedTerminalInput(5, "λ"), { sequence: 5, kind: "insert", text: "λ" });
  assert.deepEqual(predictedTerminalInput(6, "é"), { sequence: 6, kind: "insert", text: "é" });
  assert.deepEqual(predictedTerminalInput(7, "ж"), { sequence: 7, kind: "insert", text: "ж" });
  assert.equal(predictedTerminalInput(3, "\r"), null);
  assert.equal(predictedTerminalInput(4, "ab"), null);
  assert.equal(predictedTerminalInput(8, "\x1b"), null);
  assert.equal(predictedTerminalInput(9, "\x7f\x7f"), null);
  assert.equal(predictedTerminalInput(10, "漢"), null);
  assert.equal(predictedTerminalInput(11, "😀"), null);
  assert.equal(predictedTerminalInput(12, "\u0301"), null);
  assert.equal(predictedTerminalInput(13, "\u00ad"), null);
  assert.equal(predictedTerminalInput(14, "\u200b"), null);
  assert.equal(predictedTerminalInput(15, "e\u0301"), null);
});

test("terminal prediction codepoint allowlist excludes wide, combining, and zero-width input", () => {
  assert.equal(isPredictableTerminalCodepoint(0x20), true);
  assert.equal(isPredictableTerminalCodepoint(0x7e), true);
  assert.equal(isPredictableTerminalCodepoint(0x7f), false);
  assert.equal(isPredictableTerminalCodepoint(0xa0), false);
  assert.equal(isPredictableTerminalCodepoint(0xdf), true);
  assert.equal(isPredictableTerminalCodepoint(0x300), false);
  assert.equal(isPredictableTerminalCodepoint(0x483), false);
  assert.equal(isPredictableTerminalCodepoint(0x1100), false);
  assert.equal(isPredictableTerminalCodepoint(0xfe0f), false);
  assert.equal(isPredictableTerminalCodepoint(0x1f600), false);
});

test("terminal prediction settlement confirms the longest echoed prefix of an acknowledgement", () => {
  const predictions = [
    predictedTerminalInput(1, "a")!,
    predictedTerminalInput(2, "b")!,
    predictedTerminalInput(3, "c")!,
  ];
  const anchor = { x: 4, y: 2 };
  const settle = (
    cells: Record<string, number>,
    cursor: { x: number; y: number },
    acknowledged: number,
  ) => settlePredictedTerminalInput(
    anchor,
    10,
    5,
    predictions,
    acknowledged,
    cursor,
    (col, row) => cells[`${col}:${row}`] ?? 0,
  );

  // Output tagged with a later keystroke may still carry only the first echo.
  assert.deepEqual(
    settle({ "4:2": "a".codePointAt(0)! }, { x: 5, y: 2 }, 3),
    { confirmed: 1, anchor: { x: 5, y: 2 } },
  );
  // Unrelated output tagged with the newest input has not echoed anything yet.
  assert.deepEqual(settle({}, anchor, 2), { confirmed: 0, anchor });
  // Every acknowledged echo present.
  assert.deepEqual(
    settle({ "4:2": "a".codePointAt(0)!, "5:2": "b".codePointAt(0)! }, { x: 6, y: 2 }, 2),
    { confirmed: 2, anchor: { x: 6, y: 2 } },
  );
  // Predictions past the acknowledgement never confirm, even if cells match.
  assert.equal(
    settle({ "4:2": "a".codePointAt(0)!, "5:2": "b".codePointAt(0)! }, { x: 6, y: 2 }, 1),
    null,
  );
  // A cursor no prefix explains is a divergence.
  assert.equal(settle({ "4:2": "a".codePointAt(0)! }, { x: 7, y: 2 }, 3), null);
  assert.equal(settle({ "4:2": "z".codePointAt(0)! }, { x: 5, y: 2 }, 3), null);
});

test("terminal prediction settlement confirms erased cells for acknowledged backspaces", () => {
  const predictions = [
    predictedTerminalInput(1, "a")!,
    predictedTerminalInput(2, "\x7f")!,
    predictedTerminalInput(3, "b")!,
  ];
  const anchor = { x: 3, y: 0 };
  const settled = settlePredictedTerminalInput(
    anchor,
    10,
    2,
    predictions,
    2,
    { x: 3, y: 0 },
    (col, row) => (col === 3 && row === 0 ? 32 : 0),
  );
  assert.deepEqual(settled, { confirmed: 2, anchor: { x: 3, y: 0 } });
  const stillEchoed = settlePredictedTerminalInput(
    anchor,
    10,
    2,
    predictions,
    2,
    { x: 3, y: 0 },
    (col, row) => (col === 3 && row === 0 ? "a".codePointAt(0)! : 0),
  );
  assert.deepEqual(stillEchoed, { confirmed: 0, anchor });
});

test("terminal prediction remains armed only at its verified visible cursor", () => {
  const anchor = { x: 12, y: 4 };
  assert.equal(terminalPredictionCursorMatches({ ...anchor, visible: true }, anchor), true);
  assert.equal(terminalPredictionCursorMatches({ x: 13, y: 4, visible: true }, anchor), false);
  assert.equal(terminalPredictionCursorMatches({ ...anchor, visible: false }, anchor), false);
  assert.equal(terminalPredictionCursorMatches(undefined, anchor), false);
  assert.equal(terminalPredictionCursorMatches({ ...anchor, visible: true }, undefined), false);
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

test("terminal prediction resolves default, explicit, and inverse effective colors", () => {
  assert.deepEqual(effectiveTerminalPredictionCellStyle(terminalCell()), {
    foreground: "var(--terminal-foreground)",
    background: "var(--terminal-background)",
    flags: 0,
  });
  assert.deepEqual(effectiveTerminalPredictionCellStyle(terminalCell({
    fg_r: 12,
    fg_g: 34,
    fg_b: 56,
    bg_r: 78,
    bg_g: 90,
    bg_b: 123,
    fgIsDefault: false,
    bgIsDefault: false,
    flags: CellFlags.BOLD
      | CellFlags.ITALIC
      | CellFlags.FAINT
      | CellFlags.UNDERLINE
      | CellFlags.STRIKETHROUGH,
  })), {
    foreground: "rgb(12, 34, 56)",
    background: "rgb(78, 90, 123)",
    flags: CellFlags.BOLD
      | CellFlags.ITALIC
      | CellFlags.FAINT
      | CellFlags.UNDERLINE
      | CellFlags.STRIKETHROUGH,
  });
  assert.deepEqual(effectiveTerminalPredictionCellStyle(terminalCell({
    fg_r: 12,
    fg_g: 34,
    fg_b: 56,
    bg_r: 78,
    bg_g: 90,
    bg_b: 123,
    fgIsDefault: false,
    bgIsDefault: false,
    flags: CellFlags.INVERSE,
  })), {
    foreground: "rgb(78, 90, 123)",
    background: "rgb(12, 34, 56)",
    flags: CellFlags.INVERSE,
  });
  assert.deepEqual(effectiveTerminalPredictionCellStyle(terminalCell({ flags: CellFlags.INVERSE })), {
    foreground: "var(--terminal-background)",
    background: "var(--terminal-foreground)",
    flags: CellFlags.INVERSE,
  });
});

test("terminal prediction inherits an active colored span across empty and wrapped cells", () => {
  const colored = terminalCell({
    codepoint: "P".codePointAt(0),
    fg_r: 240,
    fg_g: 240,
    fg_b: 240,
    bg_r: 20,
    bg_g: 80,
    bg_b: 140,
    fgIsDefault: false,
    bgIsDefault: false,
    flags: CellFlags.BOLD
      | CellFlags.ITALIC
      | CellFlags.FAINT
      | CellFlags.UNDERLINE
      | CellFlags.STRIKETHROUGH,
  });
  const viewport = [terminalCell(), colored, terminalCell(), terminalCell()];
  assert.deepEqual(terminalPredictionStyleAtCursor(viewport, 4, { x: 2, y: 0 }, () => false), {
    foreground: "rgb(240, 240, 240)",
    background: "rgb(20, 80, 140)",
    flags: CellFlags.BOLD
      | CellFlags.ITALIC
      | CellFlags.FAINT
      | CellFlags.UNDERLINE
      | CellFlags.STRIKETHROUGH,
  });
  const explicitlyStyledCursorCell = terminalCell({
    bg_r: 90,
    bg_g: 30,
    bg_b: 120,
    bgIsDefault: false,
  });
  assert.deepEqual(terminalPredictionStyleAtCursor(
    [terminalCell(), colored, explicitlyStyledCursorCell, terminalCell()],
    4,
    { x: 2, y: 0 },
    () => false,
  ), {
    foreground: "var(--terminal-foreground)",
    background: "rgb(90, 30, 120)",
    flags: 0,
  });

  const wrappedViewport = [terminalCell(), terminalCell(), terminalCell(), colored, terminalCell()];
  assert.deepEqual(terminalPredictionStyleAtCursor(
    wrappedViewport,
    4,
    { x: 0, y: 1 },
    (row) => row === 0,
  ), {
    foreground: "rgb(240, 240, 240)",
    background: "rgb(20, 80, 140)",
    flags: CellFlags.BOLD
      | CellFlags.ITALIC
      | CellFlags.FAINT
      | CellFlags.UNDERLINE
      | CellFlags.STRIKETHROUGH,
  });
  assert.deepEqual(terminalPredictionStyleAtCursor(
    wrappedViewport,
    4,
    { x: 0, y: 1 },
    () => false,
  ), {
    foreground: "var(--terminal-foreground)",
    background: "var(--terminal-background)",
    flags: 0,
  });
});

test("terminal prediction keeps matching empty backgrounds transparent and covers mismatches", () => {
  const defaultStyle = effectiveTerminalPredictionCellStyle(terminalCell());
  assert.deepEqual(terminalPredictionCellPaint(defaultStyle, terminalCell(), "x"), {
    foreground: "var(--terminal-foreground)",
    background: "transparent",
    flags: 0,
  });
  assert.equal(
    terminalPredictionCellPaint(defaultStyle, terminalCell({ codepoint: "q".codePointAt(0) }), "x").background,
    "var(--terminal-background)",
  );
  assert.equal(
    terminalPredictionCellPaint(defaultStyle, terminalCell(), "", true).background,
    "var(--terminal-background)",
  );

  const coloredStyle = {
    foreground: "rgb(240, 240, 240)",
    background: "rgb(20, 80, 140)",
    flags: CellFlags.BOLD | CellFlags.ITALIC,
  };
  assert.equal(
    terminalPredictionCellPaint(coloredStyle, terminalCell(), "x").background,
    "rgb(20, 80, 140)",
  );
  assert.equal(
    terminalPredictionCellPaint(coloredStyle, undefined, "x").background,
    "rgb(20, 80, 140)",
  );
  assert.equal(
    terminalPredictionCellPaint(coloredStyle, terminalCell(), "").background,
    "transparent",
  );
  assert.equal(
    terminalPredictionCellPaint(coloredStyle, terminalCell(), "x").flags,
    CellFlags.BOLD | CellFlags.ITALIC,
  );
});

test("terminal prediction uses Ghostty-compatible font strings for styled faces", () => {
  assert.equal(
    ghosttyCanvasFont(14, "Fira Code, monospace"),
    "14px \"Fira Code\", monospace",
  );
  assert.equal(
    ghosttyCanvasFont(16, "\"MesloLGM Nerd Font\", monospace", CellFlags.BOLD | CellFlags.ITALIC),
    "italic bold 16px \"MesloLGM Nerd Font\", monospace",
  );
});
