import assert from "node:assert/strict";
import test from "node:test";
import { TERMINAL_COLOR_SCHEME_IDS } from "../src/shared/protocol.js";
import { colorSchemeById, terminalColorSchemes } from "../src/client/src/color-schemes.js";

const requiredThemeColors = [
  "background", "foreground", "cursor", "cursorAccent", "selectionBackground", "selectionForeground",
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

test("color scheme catalog covers every persisted scheme id", () => {
  assert.deepEqual(terminalColorSchemes.map((scheme) => scheme.id), [...TERMINAL_COLOR_SCHEME_IDS]);
  assert.equal(new Set(terminalColorSchemes.map((scheme) => scheme.name)).size, terminalColorSchemes.length);
});

test("color schemes provide complete terminal and chrome palettes", () => {
  for (const scheme of terminalColorSchemes) {
    assert.equal(colorSchemeById(scheme.id), scheme);
    for (const key of requiredThemeColors) assert.match(scheme.terminal[key], /^#[0-9a-f]{6}$/i, `${scheme.id}.${key}`);
    for (const [key, value] of Object.entries(scheme.chrome)) assert.match(value, /^#[0-9a-f]{6}$/i, `${scheme.id}.${key}`);
  }
});
