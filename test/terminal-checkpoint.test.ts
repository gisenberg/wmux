import assert from "node:assert/strict";
import { test } from "node:test";
import { selectAttachReplay, TerminalCheckpoint } from "../src/server/terminal-checkpoint.js";
import { terminalThemeEnvironment } from "../src/server/terminal-theme.js";

test("checkpoint snapshots preserve the selected terminal defaults and ANSI palette", () => {
  const checkpoint = new TerminalCheckpoint(12, 2, terminalThemeEnvironment("tokyo-night"));
  try {
    checkpoint.write("default \x1b[31mred\x1b[39;49m");
    const snapshot = checkpoint.snapshot();
    assert.match(snapshot, /38;2;192;202;245;48;2;26;27;38/);
    assert.match(snapshot, /38;2;247;118;142;48;2;26;27;38/);
    assert.doesNotMatch(snapshot, /48;2;0;0;0/);

    checkpoint.reframe(12, 4);
    assert.doesNotMatch(checkpoint.snapshot(), /48;2;0;0;0/);
  } finally {
    checkpoint.dispose();
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

test("normal-screen checkpoints can seed the visible viewport into scrollback", () => {
  const checkpoint = new TerminalCheckpoint(12, 3);
  try {
    checkpoint.write(Array.from({ length: 12 }, (_, index) => `line-${String(index + 1).padStart(2, "0")}`)
      .join("\r\n"));
    const replay = checkpoint.snapshotWithScrollbackSeed();
    assert.match(replay, /line-01\r\nline-02\r\n/);
    assert.match(replay, /line-10\r\nline-11\r\nline-12/);
    assert.equal(replay.split("line-12").length - 1, 2);
  } finally {
    checkpoint.dispose();
  }
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
    assert.equal(replay.split("line-12").length - 1, 2);
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
