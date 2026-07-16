import { createContext, useContext, useMemo, type ReactNode } from "react";
import { hexToRgba, type RGBA } from "./opentui-grid";
import { colorSchemeById, type TerminalColorScheme, type WmuxChromeColors } from "./color-schemes";
import type { TerminalColorSchemeId } from "./types";

const ColorSchemeContext = createContext<TerminalColorScheme>(colorSchemeById("wmux"));

export interface OpenTuiTheme {
  colors: WmuxChromeColors;
  rgba: Record<keyof WmuxChromeColors, RGBA>;
}

export function ColorSchemeProvider({ id, children }: { id: TerminalColorSchemeId; children: ReactNode }) {
  return <ColorSchemeContext.Provider value={colorSchemeById(id)}>{children}</ColorSchemeContext.Provider>;
}

export const useColorScheme = (): TerminalColorScheme => useContext(ColorSchemeContext);

export const useOpenTuiTheme = (): OpenTuiTheme => {
  const value = useColorScheme();
  return useMemo(() => ({
    colors: value.chrome,
    rgba: Object.fromEntries(
      Object.entries(value.chrome).map(([key, color]) => [key, hexToRgba(color)]),
    ) as Record<keyof WmuxChromeColors, RGBA>,
  }), [value]);
};
