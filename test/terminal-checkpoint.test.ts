import assert from "node:assert/strict";
import { test } from "node:test";
import {
  partialTerminalSequenceLength,
  selectAttachReplay,
  TerminalCheckpoint,
} from "../src/server/terminal-checkpoint.js";
import { terminalThemeEnvironment } from "../src/server/terminal-theme.js";

test("checkpoint snapshots keep semantic defaults and paint the ANSI palette explicitly", () => {
  const checkpoint = new TerminalCheckpoint(12, 2, terminalThemeEnvironment("tokyo-night"));
  try {
    checkpoint.write("default \x1b[31mred\x1b[39;49m");
    const snapshot = checkpoint.snapshot();
    // Default cells stay default so a later color-scheme change still applies.
    assert.match(snapshot, /\x1b\[0;39;49md/);
    assert.match(snapshot, /38;2;247;118;142;49mr/);
    assert.doesNotMatch(snapshot, /38;2;192;202;245/);
    assert.doesNotMatch(snapshot, /48;2;0;0;0/);

    checkpoint.reframe(12, 4);
    const reframed = checkpoint.snapshot();
    assert.match(reframed, /\x1b\[0;39;49md/);
    assert.match(reframed, /38;2;247;118;142;49mr/);
    assert.doesNotMatch(reframed, /48;2;0;0;0/);
  } finally {
    checkpoint.dispose();
  }
});

test("checkpoint restores retain default and inverse styling through a round trip", () => {
  const source = new TerminalCheckpoint(16, 2);
  const restored = new TerminalCheckpoint(16, 2);
  try {
    source.write("\x1b[7minv\x1b[27m \x1b[44mblue\x1b[49m plain");
    restored.write(source.snapshot());
    assert.deepEqual(restored.screenLines(), source.screenLines());
    const cells = (checkpoint: TerminalCheckpoint) => (checkpoint as unknown as {
      terminal: { update(): void; getViewport(): { fgIsDefault: boolean; bgIsDefault: boolean; flags: number }[] };
    }).terminal;
    cells(source).update();
    cells(restored).update();
    const sourceCells = cells(source).getViewport().slice(0, 16)
      .map((cell) => `${cell.fgIsDefault}:${cell.bgIsDefault}:${cell.flags}`);
    const restoredCells = cells(restored).getViewport().slice(0, 16)
      .map((cell) => `${cell.fgIsDefault}:${cell.bgIsDefault}:${cell.flags}`);
    assert.deepEqual(restoredCells, sourceCells);
  } finally {
    source.dispose();
    restored.dispose();
  }
});

test("terminal checkpoints round-trip an alternate-screen viewport and cursor", () => {
  const source = new TerminalCheckpoint(16, 5);
  const restored = new TerminalCheckpoint(16, 5);
  try {
    source.write("\x1b[?1049h\x1b[2J\x1b[H\x1b[31;1mFRETWORK\x1b[3;4Hmeasure 28\x1b[?25l");
    const snapshot = source.snapshot();
    restored.write(snapshot);

    assert.equal(source.isAlternateScreen, true);
    assert.equal(restored.isAlternateScreen, true);
    assert.deepEqual(restored.screenLines(), source.screenLines());
    assert.deepEqual(restored.cursor(), source.cursor());
    assert.match(restored.screenLines().join("\n"), /FRETWORK/);
    assert.match(restored.screenLines().join("\n"), /measure 28/);
  } finally {
    source.dispose();
    restored.dispose();
  }
});

test("attach replay keeps raw history until a checkpoint is required", () => {
  const checkpoint = new TerminalCheckpoint(12, 3);
  try {
    checkpoint.write("shell output\r\n");
    assert.deepEqual(selectAttachReplay("shell output\r\n", false, checkpoint), {
      data: "shell output\r\n",
      kind: "raw",
    });

    checkpoint.write("\x1b[?1049h\x1b[2J\x1b[Hcodex tui");
    const alternateReplay = selectAttachReplay("stale cursor deltas", false, checkpoint);
    assert.equal(alternateReplay.kind, "checkpoint");
    assert.match(alternateReplay.data, /codex tui/);
  } finally {
    checkpoint.dispose();
  }
});

test("truncated normal-screen history restores the authoritative current screen", () => {
  const source = new TerminalCheckpoint(14, 4);
  const restored = new TerminalCheckpoint(14, 4);
  try {
    source.write("old history\r\n");
    source.write("\x1b[2J\x1b[Hcurrent screen\x1b[4;2H>");
    const replay = selectAttachReplay("arbitrary tail", true, source);
    assert.equal(replay.kind, "checkpoint");

    restored.write(replay.data);
    assert.deepEqual(restored.screenLines(), source.screenLines());
    assert.deepEqual(restored.cursor(), source.cursor());
  } finally {
    source.dispose();
    restored.dispose();
  }
});

test("cross-size replay restores the authoritative cursor from a checkpoint", () => {
  const rawReplay =
    "\x1b[2J\x1b[Habcdefghijklmnopqrst"
    + "\x1b[2;1HABCDEFGHIJKLMNOPQRST"
    + "\x1b[3;1H01234567890123456789"
    + "\x1b[5;11H\x1b[?25l";
  const source = new TerminalCheckpoint(20, 6);
  const rawAtNewSize = new TerminalCheckpoint(10, 6);
  const restored = new TerminalCheckpoint(10, 6);
  try {
    source.write(rawReplay);
    source.resize(10, 6);
    rawAtNewSize.write(rawReplay);

    assert.notDeepEqual(rawAtNewSize.cursor(), source.cursor());

    const replay = selectAttachReplay(rawReplay, false, source, true);
    assert.equal(replay.kind, "checkpoint");
    restored.write(replay.data);

    assert.deepEqual(restored.screenLines(), source.screenLines());
    assert.deepEqual(restored.cursor(), source.cursor());
  } finally {
    source.dispose();
    rawAtNewSize.dispose();
    restored.dispose();
  }
});

test("checkpoint snapshots retain split private input-mode sequences", () => {
  const checkpoint = new TerminalCheckpoint(10, 2);
  try {
    checkpoint.write("\x1b[?20");
    checkpoint.write("04h\x1b[?1000hready");
    const snapshot = checkpoint.snapshot();
    assert.match(snapshot, /\x1b\[\?2004h/);
    assert.match(snapshot, /\x1b\[\?1000h/);
  } finally {
    checkpoint.dispose();
  }
});

test("normal-screen attach replay seeds history without duplicating the visible viewport", () => {
  const checkpoint = new TerminalCheckpoint(12, 3);
  const restored = new TerminalCheckpoint(12, 3);
  try {
    checkpoint.write(Array.from({ length: 12 }, (_, index) => `line-${String(index + 1).padStart(2, "0")}`)
      .join("\r\n"));
    const replay = checkpoint.snapshotWithScrollbackSeed();
    assert.match(replay, /^\x1bc/);
    assert.match(replay, /line-01\r\nline-02\r\n/);
    assert.match(replay, /line-09\r\n/);
    assert.equal(replay.split("line-10").length - 1, 1);
    assert.equal(replay.split("line-12").length - 1, 1);

    restored.write(replay);
    assert.deepEqual(restored.screenLines(), checkpoint.screenLines());
    assert.deepEqual(restored.cursor(), checkpoint.cursor());
    const scrollback = (restored as unknown as {
      terminal: { getScrollbackLength(): number; getScrollbackLine(offset: number): { codepoint: number }[] | null };
    }).terminal;
    assert.equal(scrollback.getScrollbackLength(), 9);
    const lastHistory = scrollback.getScrollbackLine(8)?.map((cell) => String.fromCodePoint(cell.codepoint || 32))
      .join("").trimEnd();
    assert.equal(lastHistory, "line-09");
  } finally {
    checkpoint.dispose();
    restored.dispose();
  }
});

test("live repaints never reset the attached terminal", () => {
  const checkpoint = new TerminalCheckpoint(12, 3);
  try {
    checkpoint.write("history\r\n\x1b[?1049h\x1b[2J\x1b[Hfull-screen");
    const repaint = checkpoint.repaint();
    assert.doesNotMatch(repaint, /\x1bc/);
    assert.doesNotMatch(repaint, /\x1b\[\?1049h/);
    assert.match(repaint, /full-screen/);
  } finally {
    checkpoint.dispose();
  }
});

test("reframing inside the alternate screen keeps the primary screen for when the app exits", () => {
  const checkpoint = new TerminalCheckpoint(12, 3);
  try {
    checkpoint.write("PS> vim\r\n\x1b[?1049h\x1b[2J\x1b[Heditor");
    checkpoint.reframe(14, 4);
    assert.equal(checkpoint.isAlternateScreen, true);
    assert.deepEqual(checkpoint.dimensions, { cols: 14, rows: 4 });
    assert.match(checkpoint.screenLines()[0], /^editor/);
    checkpoint.write("\x1b[?1049l");
    assert.match(checkpoint.screenLines().join("\n"), /PS> vim/);
  } finally {
    checkpoint.dispose();
  }
});

test("checkpoint writes carry a split escape sequence across a reframe", () => {
  const checkpoint = new TerminalCheckpoint(20, 3);
  try {
    checkpoint.write("ok \x1b[38;2;12");
    checkpoint.reframe(24, 4);
    checkpoint.write("0;34;56mcolored");
    assert.equal(checkpoint.screenLines()[0].trimEnd(), "ok colored");
    assert.match(checkpoint.snapshot(), /38;2;120;34;56/);

    checkpoint.write("\r\n\x1b]0;title");
    checkpoint.reframe(20, 4);
    checkpoint.write(" more\x07after");
    assert.equal(checkpoint.screenLines()[1].trimEnd(), "after");
  } finally {
    checkpoint.dispose();
  }
});

test("partial terminal sequence detection recognizes every unterminated tail", () => {
  assert.equal(partialTerminalSequenceLength("plain text"), 0);
  assert.equal(partialTerminalSequenceLength("text\x1b"), 1);
  assert.equal(partialTerminalSequenceLength("text\x1b["), 2);
  assert.equal(partialTerminalSequenceLength("text\x1b[38;2;1"), 8);
  assert.equal(partialTerminalSequenceLength("text\x1b[31m"), 0);
  assert.equal(partialTerminalSequenceLength("text\x1b[?25l"), 0);
  assert.equal(partialTerminalSequenceLength("text\x1b]7;file:///C:/"), 15);
  assert.equal(partialTerminalSequenceLength("text\x1b]7;file:///C:/\x07"), 0);
  assert.equal(partialTerminalSequenceLength("text\x1b]7;file:///C:/\x1b\\"), 0);
  assert.equal(partialTerminalSequenceLength("text\x1bP>|ghostty"), 11);
  assert.equal(partialTerminalSequenceLength("text\x1b("), 2);
  assert.equal(partialTerminalSequenceLength("text\x1b(B"), 0);
  assert.equal(partialTerminalSequenceLength("text\x1bc"), 0);
  assert.equal(partialTerminalSequenceLength(`\x1b]52;c;${"A".repeat(5000)}`), 0);
});

test("Windows-style reframing keeps the viewport and cursor anchored from the top", () => {
  const checkpoint = new TerminalCheckpoint(12, 3);
  try {
    checkpoint.write("one\r\ntwo\r\nPS> ");
    assert.deepEqual(checkpoint.cursor(), { x: 4, y: 2, visible: true });

    checkpoint.reframe(12, 6);

    assert.deepEqual(checkpoint.cursor(), { x: 4, y: 2, visible: true });
    assert.match(checkpoint.screenLines()[2], /^PS> /);
    assert.equal(checkpoint.screenLines()[5].trim(), "");
  } finally {
    checkpoint.dispose();
  }
});

test("Windows-style reframing carries scrollback across resize boundaries without duplicating the viewport", () => {
  const checkpoint = new TerminalCheckpoint(12, 3);
  try {
    checkpoint.write(Array.from({ length: 12 }, (_, index) => `line-${String(index + 1).padStart(2, "0")}`)
      .join("\r\n"));
    checkpoint.reframe(18, 5);
    checkpoint.reframe(10, 4);
    const replay = checkpoint.snapshotWithScrollbackSeed();
    assert.match(replay, /line-01\r\nline-02\r\n/);
    assert.equal(replay.split("line-12").length - 1, 1);
    assert.equal(replay.split("line-09").length - 1, 1);
  } finally {
    checkpoint.dispose();
  }
});

test("Windows-style reframing clips discarded rows and columns when shrinking", () => {
  const checkpoint = new TerminalCheckpoint(12, 5);
  try {
    checkpoint.write([
      "\x1b[1;1HABCDEFGHIJKL",
      "\x1b[2;1Hsecond-row",
      "\x1b[3;1Hthird-row",
      "\x1b[4;1HDISCARD-FOUR",
      "\x1b[5;1HDISCARD-FIVE",
      "\x1b[5;12H",
    ].join(""));

    checkpoint.write("\x1b[3;10H");
    checkpoint.reframe(7, 3);

    assert.deepEqual(checkpoint.screenLines(), [
      "ABCDEFG",
      "second-",
      "third-r",
    ]);
    assert.deepEqual(checkpoint.cursor(), { x: 6, y: 2, visible: true });
    assert.doesNotMatch(checkpoint.screenLines().join("\n"), /DISCARD/);
  } finally {
    checkpoint.dispose();
  }
});

test("Windows-style shrinking keeps the cursor row visible and scrolls the rows above into history", () => {
  const checkpoint = new TerminalCheckpoint(12, 5);
  try {
    checkpoint.write("one\r\ntwo\r\nthree\r\nfour\r\nPS> ");
    assert.deepEqual(checkpoint.cursor(), { x: 4, y: 4, visible: true });

    checkpoint.reframe(12, 3);

    assert.deepEqual(checkpoint.screenLines().map((line) => line.trimEnd()), ["three", "four", "PS>"]);
    assert.deepEqual(checkpoint.cursor(), { x: 4, y: 2, visible: true });
    const replay = checkpoint.snapshotWithScrollbackSeed();
    assert.match(replay, /one\r\ntwo\r\n/);
    assert.equal(replay.split("three").length - 1, 1);
  } finally {
    checkpoint.dispose();
  }
});
