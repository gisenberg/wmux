import assert from "node:assert/strict";
import test from "node:test";
import { TERMINAL_COLOR_SCHEME_IDS, TERMINAL_COLOR_SCHEME_MODES } from "../src/shared/protocol.js";
import { TERMINAL_ANSI_COLOR_KEYS, terminalThemeById } from "../src/shared/terminal-themes.js";
import {
  terminalThemeEnvironment,
  terminalThemeFromEnvironment,
} from "../src/server/terminal-theme.js";

test("every color scheme exposes stable session theme metadata", () => {
  for (const colorScheme of TERMINAL_COLOR_SCHEME_IDS) {
    const theme = terminalThemeById(colorScheme);
    assert.deepEqual(terminalThemeEnvironment(colorScheme), {
      WMUX_COLOR_SCHEME: colorScheme,
      WMUX_COLOR_MODE: TERMINAL_COLOR_SCHEME_MODES[colorScheme],
      WMUX_TERMINAL_FOREGROUND: theme.foreground,
      WMUX_TERMINAL_BACKGROUND: theme.background,
      WMUX_TERMINAL_ANSI_PALETTE: TERMINAL_ANSI_COLOR_KEYS.map((key) => theme[key]).join(","),
    });
  }
  assert.deepEqual(terminalThemeEnvironment("tokyo-night"), {
    WMUX_COLOR_SCHEME: "tokyo-night",
    WMUX_COLOR_MODE: "dark",
    WMUX_TERMINAL_FOREGROUND: "#c0caf5",
    WMUX_TERMINAL_BACKGROUND: "#1a1b26",
    WMUX_TERMINAL_ANSI_PALETTE: "#15161e,#f7768e,#9ece6a,#e0af68,#7aa2f7,#bb9af7,#7dcfff,#a9b1d6,#414868,#f7768e,#9ece6a,#e0af68,#7aa2f7,#bb9af7,#7dcfff,#c0caf5",
  });
  assert.equal(
    terminalThemeFromEnvironment({ WMUX_COLOR_SCHEME: "tokyo-night" }),
    terminalThemeById("tokyo-night"),
  );
  assert.equal(terminalThemeFromEnvironment({ WMUX_COLOR_SCHEME: "unknown" }), undefined);
});
