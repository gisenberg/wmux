import assert from "node:assert/strict";
import test from "node:test";
import { OscColorQueryParser } from "../src/shared/terminal-color-queries.js";
import { terminalThemeById } from "../src/shared/terminal-themes.js";

const tokyoNight = terminalThemeById("tokyo-night");
const dracula = terminalThemeById("dracula");
const responses = (parser: OscColorQueryParser, input: string, theme = tokyoNight): string[] =>
  parser.push(input, theme).responses;

test("OSC color queries report the selected foreground, background, and ANSI palette", () => {
  const parser = new OscColorQueryParser();
  assert.deepEqual(responses(parser, "\x1b]10;?\x07"), ["\x1b]10;rgb:c0c0/caca/f5f5\x1b\\"]);
  assert.deepEqual(responses(parser, "\x1b]11;?\x1b\\"), ["\x1b]11;rgb:1a1a/1b1b/2626\x1b\\"]);
  assert.deepEqual(responses(parser, "\x1b]4;0;?;1;?;15;?\x07"), [
    "\x1b]4;0;rgb:1515/1616/1e1e\x1b\\",
    "\x1b]4;1;rgb:f7f7/7676/8e8e\x1b\\",
    "\x1b]4;15;rgb:c0c0/caca/f5f5\x1b\\",
  ]);
});

test("OSC palette queries cover the standard 256-color cube and grayscale ramp", () => {
  const parser = new OscColorQueryParser();
  assert.deepEqual(responses(parser, "\x1b]4;16;?;21;?;231;?;232;?;255;?\x1b\\"), [
    "\x1b]4;16;rgb:0000/0000/0000\x1b\\",
    "\x1b]4;21;rgb:0000/0000/ffff\x1b\\",
    "\x1b]4;231;rgb:ffff/ffff/ffff\x1b\\",
    "\x1b]4;232;rgb:0808/0808/0808\x1b\\",
    "\x1b]4;255;rgb:eeee/eeee/eeee\x1b\\",
  ]);
});

test("OSC color queries survive chunk boundaries and use the current live theme", () => {
  const parser = new OscColorQueryParser();
  assert.deepEqual(responses(parser, "prefix\x1b]10"), []);
  assert.deepEqual(responses(parser, ";?\x1b"), []);
  assert.deepEqual(responses(parser, "\\suffix", dracula), ["\x1b]10;rgb:f8f8/f8f8/f2f2\x1b\\"]);

  assert.deepEqual(responses(parser, "\x1b"), []);
  parser.reset();
  assert.deepEqual(responses(parser, "]11;?\x07"), []);
});

test("OSC color query themes resolve lazily from live server settings", () => {
  const parser = new OscColorQueryParser();
  let theme = tokyoNight;
  let resolutions = 0;
  const currentTheme = () => {
    resolutions += 1;
    return theme;
  };

  assert.deepEqual(parser.push("ordinary output", currentTheme).responses, []);
  assert.equal(resolutions, 0);
  assert.deepEqual(parser.push("\x1b]10;?\x07", currentTheme).responses, [
    "\x1b]10;rgb:c0c0/caca/f5f5\x1b\\",
  ]);
  theme = dracula;
  assert.deepEqual(parser.push("\x1b]10;?\x07", currentTheme).responses, [
    "\x1b]10;rgb:f8f8/f8f8/f2f2\x1b\\",
  ]);
  assert.equal(resolutions, 2);
});

test("OSC color queries distinguish BEL terminators from audible bells", () => {
  const parser = new OscColorQueryParser();
  assert.deepEqual(parser.push("\x1b]10;?\x07", tokyoNight), {
    responses: ["\x1b]10;rgb:c0c0/caca/f5f5\x1b\\"],
    bellTerminators: 1,
  });
  assert.deepEqual(parser.push("\x1b]11;?\x1b\\", tokyoNight).bellTerminators, 0);
});

test("OSC color query parsing is strict and bounded", () => {
  const parser = new OscColorQueryParser();
  for (const input of [
    "\x1b]0;?\x07",
    "\x1b]4;256;?\x07",
    "\x1b]4;01;?\x07",
    "\x1b]4;1;#ffffff\x07",
    "\x1b]10;#ffffff\x07",
    "\x1b]10;?",
  ]) {
    assert.deepEqual(responses(parser, input), []);
    parser.reset();
  }
  assert.deepEqual(responses(parser, `\x1b]10;${"x".repeat(4097)}\x07`), []);
});
