import assert from "node:assert/strict";
import { test } from "node:test";
import type { GhosttyTerminal } from "ghostty-web";
import { TerminalCheckpoint } from "../src/server/terminal-checkpoint.js";

// Expected screens were recorded from ConPTY itself (OpenConsole 1.24 through
// pywinpty on Windows 11) by reading its screen buffer after each resize.

const trimmed = (checkpoint: TerminalCheckpoint): string[] =>
  checkpoint.screenLines().map((line) => line.trimEnd());

const withCheckpoint = (cols: number, rows: number, body: (checkpoint: TerminalCheckpoint) => void): void => {
  const checkpoint = new TerminalCheckpoint(cols, rows);
  try {
    body(checkpoint);
  } finally {
    checkpoint.dispose();
  }
};

const blank = (count: number): string[] => Array.from({ length: count }, () => "");

test("ConPTY resizes keep a prompt top-anchored instead of pulling history back into view", () => {
  withCheckpoint(60, 16, (checkpoint) => {
    const prompt = "PS C:\\Users\\gisenberg> echo T:\\git\\gisenberg\\guitar-practice";
    assert.equal(prompt.length, 60);
    checkpoint.write(Array.from({ length: 30 }, (_, index) => `line ${index}\r\n`).join("") + `${prompt}\r\n`);
    const history = Array.from({ length: 14 }, (_, index) => `line ${index + 16}`);
    assert.deepEqual(trimmed(checkpoint), [...history, prompt, ""]);

    checkpoint.resize(60, 30, "conpty");
    assert.deepEqual(trimmed(checkpoint), [...history, prompt, ...blank(15)]);
    assert.deepEqual(checkpoint.cursor(), { x: 0, y: 15, visible: true });

    checkpoint.resize(60, 10, "conpty");
    const shortHistory = Array.from({ length: 8 }, (_, index) => `line ${index + 22}`);
    assert.deepEqual(trimmed(checkpoint), [...shortHistory, prompt, ""]);
    assert.deepEqual(checkpoint.cursor(), { x: 0, y: 9, visible: true });

    checkpoint.resize(60, 16, "conpty");
    assert.deepEqual(trimmed(checkpoint), [...shortHistory, prompt, ...blank(7)]);
    assert.deepEqual(checkpoint.cursor(), { x: 0, y: 9, visible: true });

    checkpoint.resize(30, 16, "conpty");
    assert.deepEqual(trimmed(checkpoint), [
      ...shortHistory,
      "PS C:\\Users\\gisenberg> echo T:",
      "\\git\\gisenberg\\guitar-practice",
      ...blank(6),
    ]);
    assert.deepEqual(checkpoint.cursor(), { x: 0, y: 10, visible: true });

    checkpoint.resize(60, 16, "conpty");
    assert.deepEqual(trimmed(checkpoint), [...shortHistory, prompt, ...blank(7)]);
    assert.deepEqual(checkpoint.cursor(), { x: 0, y: 9, visible: true });
  });
});

test("ConPTY height shrinks keep the content below the cursor anchored at the bottom", () => {
  withCheckpoint(20, 6, (checkpoint) => {
    checkpoint.write("\x1b[2J\x1b[Hr1\x1b[2;1Hr2\x1b[3;1HPS> \x1b[5;1Hbelow5\x1b[6;1Hbelow6\x1b[3;5H");
    checkpoint.resize(20, 4, "conpty");
    assert.deepEqual(trimmed(checkpoint), ["PS>", "", "below5", "below6"]);
    assert.deepEqual(checkpoint.cursor(), { x: 4, y: 0, visible: true });

    checkpoint.resize(20, 6, "conpty");
    assert.deepEqual(trimmed(checkpoint), ["PS>", "", "below5", "below6", "", ""]);
    assert.deepEqual(checkpoint.cursor(), { x: 4, y: 0, visible: true });
  });
});

test("ConPTY height shrinks drop blank rows below a top cursor", () => {
  withCheckpoint(20, 6, (checkpoint) => {
    checkpoint.write("\x1b[2J\x1b[HPS> ");
    checkpoint.resize(20, 3, "conpty");
    assert.deepEqual(trimmed(checkpoint), ["PS>", "", ""]);
    assert.deepEqual(checkpoint.cursor(), { x: 4, y: 0, visible: true });
    checkpoint.resize(20, 6, "conpty");
    assert.deepEqual(trimmed(checkpoint), ["PS>", ...blank(5)]);
    assert.deepEqual(checkpoint.cursor(), { x: 4, y: 0, visible: true });
  });
});

test("ConPTY width changes reflow wide glyphs across the wrap boundary", () => {
  withCheckpoint(20, 6, (checkpoint) => {
    checkpoint.write("\x1b[2J\x1b[Habcdefghijklmnopq羊羊羊xyz");
    assert.deepEqual(trimmed(checkpoint), ["abcdefghijklmnopq羊", "羊羊xyz", ...blank(4)]);
    assert.deepEqual(checkpoint.cursor(), { x: 7, y: 1, visible: true });

    checkpoint.resize(19, 6, "conpty");
    assert.deepEqual(trimmed(checkpoint), ["abcdefghijklmnopq羊", "羊羊xyz", ...blank(4)]);
    assert.deepEqual(checkpoint.cursor(), { x: 7, y: 1, visible: true });

    checkpoint.resize(18, 6, "conpty");
    assert.deepEqual(trimmed(checkpoint), ["abcdefghijklmnopq", "羊羊羊xyz", ...blank(4)]);
    assert.deepEqual(checkpoint.cursor(), { x: 9, y: 1, visible: true });

    checkpoint.resize(20, 6, "conpty");
    assert.deepEqual(trimmed(checkpoint), ["abcdefghijklmnopq羊", "羊羊xyz", ...blank(4)]);
    assert.deepEqual(checkpoint.cursor(), { x: 7, y: 1, visible: true });
    // ConPTY's own screen, reported after every resize, agrees.
    const repaint = checkpoint.reconcileConsoleScreen({
      cols: 20,
      rows: 6,
      cursorX: 7,
      cursorY: 1,
      cursorVisible: true,
      lines: [
        { text: "abcdefghijklmnopq羊 ", wide: [17] },
        { text: "羊羊xyz" + " ".repeat(13), wide: [0, 2] },
        ...blank(4).map(() => ({ text: " ".repeat(20) })),
      ],
    });
    assert.equal(repaint, "");
  });
});

test("ConPTY height changes with history keep the cursor row and never restore scrolled rows", () => {
  withCheckpoint(20, 6, (checkpoint) => {
    checkpoint.write(Array.from({ length: 9 }, (_, index) => `h${index + 1}\r\n`).join("") + "PS> ");
    assert.deepEqual(trimmed(checkpoint), ["h5", "h6", "h7", "h8", "h9", "PS>"]);
    checkpoint.resize(20, 9, "conpty");
    assert.deepEqual(trimmed(checkpoint), ["h5", "h6", "h7", "h8", "h9", "PS>", "", "", ""]);
    assert.deepEqual(checkpoint.cursor(), { x: 4, y: 5, visible: true });
    checkpoint.resize(20, 3, "conpty");
    assert.deepEqual(trimmed(checkpoint), ["h8", "h9", "PS>"]);
    assert.deepEqual(checkpoint.cursor(), { x: 4, y: 2, visible: true });
  });
});

test("rows returned to history by a ConPTY resize stay in the attach scrollback seed", () => {
  withCheckpoint(20, 4, (checkpoint) => {
    checkpoint.write("a\r\nb\r\nc\r\nd\r\ne\r\nf\r\nPS> ");
    checkpoint.resize(20, 6, "conpty");
    assert.deepEqual(trimmed(checkpoint), ["d", "e", "f", "PS>", "", ""]);
    const seed = checkpoint.snapshotWithScrollbackSeed();
    assert.match(seed, /a\r\nb\r\nc\r\n/);
    assert.equal(seed.split("d").length - 1, 1);
  });
});

test("native resizes keep the emulator's own reflow for ordinary PTYs", () => {
  withCheckpoint(20, 4, (checkpoint) => {
    checkpoint.write("a\r\nb\r\nc\r\nd\r\ne\r\nf\r\nPS> ");
    checkpoint.resize(20, 6, "native");
    assert.deepEqual(trimmed(checkpoint), ["b", "c", "d", "e", "f", "PS>"]);
  });
});

test("alternate-screen resizes crop in place for ConPTY", () => {
  withCheckpoint(12, 3, (checkpoint) => {
    checkpoint.write("PS> vim\r\n\x1b[?1049h\x1b[2J\x1b[Heditor");
    checkpoint.resize(14, 4, "conpty");
    assert.equal(checkpoint.isAlternateScreen, true);
    assert.deepEqual(checkpoint.dimensions, { cols: 14, rows: 4 });
    assert.match(checkpoint.screenLines()[0], /^editor/);
    checkpoint.write("\x1b[?1049l");
    assert.match(checkpoint.screenLines().join("\n"), /PS> vim/);
  });
});

const consoleRow = (text: string, cols: number, extra: { wide?: number[]; attrs?: Array<[number, number]> } = {}) => ({
  text: text + " ".repeat(Math.max(0, cols - text.length - (extra.wide?.length ?? 0))),
  ...extra,
});

test("console reconciliation leaves a matching model untouched", () => {
  withCheckpoint(12, 3, (checkpoint) => {
    checkpoint.write("\x1b[38;2;10;20;30mPS>\x1b[0m ok 👍🏽");
    const repaint = checkpoint.reconcileConsoleScreen({
      cols: 12,
      rows: 3,
      cursorX: 9,
      cursorY: 0,
      cursorVisible: true,
      // ConPTY reports a multi-codepoint grapheme as U+FFFD.
      lines: [consoleRow("PS> ok \uFFFD", 12, { wide: [7] }), consoleRow("", 12), consoleRow("", 12)],
    });
    assert.equal(repaint, "");
  });
});

test("console reconciliation repaints only disagreeing rows and keeps agreeing styles", () => {
  withCheckpoint(40, 3, (checkpoint) => {
    // A model that lost the tail of a prompt, as the old clipping reframe did.
    checkpoint.write("\x1b[38;2;200;100;0mPS\x1b[0m T:\\git\\gi\r\nsecond");
    const repaint = checkpoint.reconcileConsoleScreen({
      cols: 40,
      rows: 3,
      cursorX: 38,
      cursorY: 0,
      cursorVisible: true,
      lines: [
        consoleRow("PS T:\\git\\gisenberg\\guitar-practice>", 40, { attrs: [[0x0c, 2], [0x07, 38]] }),
        consoleRow("second", 40),
        consoleRow("", 40),
      ],
    });
    assert.match(repaint, /\x1b\[1;1H/);
    assert.doesNotMatch(repaint, /\x1b\[2;1H/);
    // The agreeing "PS" keeps the model's exact RGB rather than console red.
    assert.match(repaint, /38;2;200;100;0;49mPS/);
    assert.doesNotMatch(repaint, /\x1b\[0;91/);
    assert.deepEqual(trimmed(checkpoint), ["PS T:\\git\\gisenberg\\guitar-practice>", "second", ""]);
    assert.deepEqual(checkpoint.cursor(), { x: 38, y: 0, visible: true });
  });
});

test("console reconciliation falls back to console attributes for text it did not have", () => {
  withCheckpoint(10, 2, (checkpoint) => {
    checkpoint.write("old");
    const repaint = checkpoint.reconcileConsoleScreen({
      cols: 10,
      rows: 2,
      cursorX: 3,
      cursorY: 0,
      cursorVisible: true,
      lines: [consoleRow("new", 10, { attrs: [[0x0c, 3], [0x07, 7]] }), consoleRow("", 10)],
    });
    assert.match(repaint, /\x1b\[0;91;49mnew/);
    assert.match(repaint, /\x1b\[0;39;49m {7}/);
    assert.match(repaint, /^\x1b\[\?2026h/);
    assert.match(repaint, /\x1b\[\?2026l$/);
  });
});

test("console reconciliation ignores screens for another geometry or a split sequence", () => {
  withCheckpoint(10, 2, (checkpoint) => {
    checkpoint.write("old");
    const screen = {
      cols: 12,
      rows: 2,
      cursorX: 0,
      cursorY: 0,
      cursorVisible: true,
      lines: [consoleRow("new", 12), consoleRow("", 12)],
    };
    assert.equal(checkpoint.reconcileConsoleScreen(screen), "");
    checkpoint.write("\x1b[3");
    assert.equal(checkpoint.reconcileConsoleScreen({ ...screen, cols: 10, lines: [consoleRow("new", 10), consoleRow("", 10)] }), "");
  });
});

test("browser terminals reproduce the server model's ConPTY resize on the same stream", async () => {
  const { resizeTerminalLike } = await import("../src/client/src/terminal-pane-runtime.js");
  const stream = Array.from({ length: 30 }, (_, index) => `line ${index}\r\n`).join("") + "PS C:\\> ";
  // ghostty-web's browser Terminal forwards resize and write to its WASM
  // terminal; drive the client path through the same wrapper shape.
  const browserModel = new TerminalCheckpoint(60, 16);
  const wasm = (browserModel as unknown as { terminal: GhosttyTerminal }).terminal;
  const browser = {
    cols: 60,
    rows: 16,
    wasmTerm: wasm,
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      wasm.resize(cols, rows);
    },
    write: (data: string) => wasm.write(data),
  };
  try {
    withCheckpoint(60, 16, (checkpoint) => {
      browser.write(stream);
      checkpoint.write(stream);
      for (const [cols, rows] of [[60, 30], [60, 10], [30, 16], [60, 16]] as const) {
        resizeTerminalLike(browser as unknown as Parameters<typeof resizeTerminalLike>[0], cols, rows, "conpty");
        checkpoint.resize(cols, rows, "conpty");
        assert.deepEqual(browserModel.cursor(), checkpoint.cursor(), `${cols}x${rows}`);
        assert.deepEqual(trimmed(browserModel), trimmed(checkpoint), `${cols}x${rows}`);
        assert.equal(wasm.getScrollbackLength(), (checkpoint as unknown as { terminal: GhosttyTerminal }).terminal.getScrollbackLength());
      }
    });
  } finally {
    browserModel.dispose();
  }
});

test("ConPTY narrowing keeps a prompt cursor at the end of its rewrapped line", () => {
  withCheckpoint(137, 10, (checkpoint) => {
    const line = "PS C:\\Users\\example\\git\\example\\wmux> echo T:\\git\\example\\guitar-practice";
    checkpoint.write(`a\r\nb\r\n${line}`);
    checkpoint.resize(48, 10, "conpty");
    assert.deepEqual(trimmed(checkpoint).slice(0, 4), ["a", "b", line.slice(0, 48), line.slice(48)]);
    assert.deepEqual(checkpoint.cursor(), { x: line.length - 48, y: 3, visible: true });
  });
});

test("ConPTY resizes keep the cursor after text a shell redrew at another width", () => {
  withCheckpoint(137, 10, (checkpoint) => {
    const prompt = "PS C:\\Users\\example\\git\\example\\wmux> ";
    const command = "echo T:\\git\\example\\guitar-practice";
    checkpoint.write(`a\r\nb\r\n${prompt}${command}`);
    checkpoint.resize(48, 10, "conpty");
    // PSReadLine redraws the edited line from its start with absolute moves.
    const text = `${command} more`;
    const end = prompt.length + text.length;
    checkpoint.write(`\x1b[3;${prompt.length + 1}H${text}\x1b[${3 + Math.floor(end / 48)};${(end % 48) + 1}H`);
    assert.deepEqual(checkpoint.cursor(), { x: end % 48, y: 2 + Math.floor(end / 48), visible: true });
    checkpoint.resize(173, 10, "conpty");
    assert.deepEqual(checkpoint.cursor(), { x: end, y: 2, visible: true });
    checkpoint.resize(137, 10, "conpty");
    assert.equal(trimmed(checkpoint)[2], `${prompt}${text}`);
    assert.deepEqual(checkpoint.cursor(), { x: end, y: 2, visible: true });
  });
});

test("ConPTY widening with a wide glyph keeps the viewport top-anchored", () => {
  withCheckpoint(20, 6, (checkpoint) => {
    checkpoint.write("old 0\r\nold 1\r\nold 2\r\nold 3\r\nPS> echo abcdefgh 羊 tail\r\nPS> ");
    assert.deepEqual(trimmed(checkpoint), ["old 1", "old 2", "old 3", "PS> echo abcdefgh 羊", " tail", "PS>"]);
    checkpoint.resize(60, 6, "conpty");
    // ConPTY rejoins the wrapped line in place and leaves a blank row below
    // instead of bringing "old 0" back from history.
    assert.deepEqual(trimmed(checkpoint), ["old 1", "old 2", "old 3", "PS> echo abcdefgh 羊 tail", "PS>", ""]);
    assert.deepEqual(checkpoint.cursor(), { x: 4, y: 4, visible: true });
  });
});

test("ConPTY resizes place the cursor exactly after wide glyphs a shell redrew", () => {
  withCheckpoint(137, 10, (checkpoint) => {
    const prompt = "PS C:\\> ";
    checkpoint.write(`a\r\nb\r\n${prompt}echo 羊`);
    checkpoint.resize(20, 10, "conpty");
    const text = "echo 羊 wraps-past-the-phone-width";
    // Cell width: every character is one cell except the wide glyph.
    const end = prompt.length + text.length + 1;
    checkpoint.write(`\x1b[3;${prompt.length + 1}H${text}\x1b[${3 + Math.floor(end / 20)};${(end % 20) + 1}H`);
    const atPhone = checkpoint.cursor();
    checkpoint.resize(173, 10, "conpty");
    assert.deepEqual(checkpoint.cursor(), { x: end, y: 2, visible: true }, `from ${JSON.stringify(atPhone)}`);
    checkpoint.resize(137, 10, "conpty");
    assert.equal(trimmed(checkpoint)[2], `${prompt}${text}`);
    assert.deepEqual(checkpoint.cursor(), { x: end, y: 2, visible: true });
  });
});
