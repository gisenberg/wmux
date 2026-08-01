import {
  TERMINAL_COLOR_SCHEME_IDS,
  TERMINAL_COLOR_SCHEME_MODES,
  type TerminalColorSchemeId,
} from "../shared/protocol.js";
import {
  TERMINAL_ANSI_COLOR_KEYS,
  terminalThemeById,
  type TerminalTheme,
} from "../shared/terminal-themes.js";

const terminalColorSchemeIds = new Set<string>(TERMINAL_COLOR_SCHEME_IDS);

export const terminalThemeEnvironment = (colorScheme: TerminalColorSchemeId): Record<string, string> => {
  const theme = terminalThemeById(colorScheme);
  return {
    WMUX_COLOR_SCHEME: colorScheme,
    WMUX_COLOR_MODE: TERMINAL_COLOR_SCHEME_MODES[colorScheme],
    WMUX_TERMINAL_FOREGROUND: theme.foreground,
    WMUX_TERMINAL_BACKGROUND: theme.background,
    WMUX_TERMINAL_ANSI_PALETTE: TERMINAL_ANSI_COLOR_KEYS.map((key) => theme[key]).join(","),
  };
};

export const terminalThemeFromEnvironment = (
  environment: Record<string, string>,
): TerminalTheme | undefined => {
  const colorScheme = environment.WMUX_COLOR_SCHEME;
  return terminalColorSchemeIds.has(colorScheme)
    ? terminalThemeById(colorScheme as TerminalColorSchemeId)
    : undefined;
};
