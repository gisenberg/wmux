import type { ITheme } from "ghostty-web";
import type { TerminalColorSchemeId } from "./types";

export interface WmuxChromeColors {
  black: string;
  panel: string;
  panel2: string;
  panel3: string;
  active: string;
  activeSoft: string;
  line: string;
  lineBright: string;
  gold: string;
  goldDim: string;
  text: string;
  muted: string;
  faint: string;
  red: string;
  green: string;
  blue: string;
  agent: string;
  runningSoft: string;
  failedSoft: string;
}

export interface TerminalColorScheme {
  id: TerminalColorSchemeId;
  name: string;
  terminal: Required<ITheme>;
  chrome: WmuxChromeColors;
}

type SchemeInput = {
  id: TerminalColorSchemeId;
  name: string;
  accent: string;
  terminal: Required<ITheme>;
  chrome?: WmuxChromeColors;
};

const scheme = ({ id, name, accent, terminal, chrome }: SchemeInput): TerminalColorScheme => ({
  id,
  name,
  terminal,
  chrome: chrome ?? {
    black: terminal.background,
    panel: mix(terminal.background, terminal.foreground, 0.035),
    panel2: mix(terminal.background, terminal.foreground, 0.065),
    panel3: mix(terminal.background, terminal.foreground, 0.1),
    active: mix(terminal.background, accent, 0.14),
    activeSoft: mix(terminal.background, accent, 0.075),
    line: mix(terminal.background, terminal.foreground, 0.18),
    lineBright: mix(terminal.background, accent, 0.72),
    gold: accent,
    goldDim: mix(terminal.background, accent, 0.68),
    text: terminal.foreground,
    muted: mix(terminal.background, terminal.foreground, 0.62),
    faint: mix(terminal.background, terminal.foreground, 0.4),
    red: terminal.brightRed,
    green: terminal.brightGreen,
    blue: terminal.brightBlue,
    agent: terminal.brightMagenta,
    runningSoft: mix(terminal.background, terminal.brightBlue, 0.09),
    failedSoft: mix(terminal.background, terminal.brightRed, 0.1),
  },
});

export const terminalColorSchemes: readonly TerminalColorScheme[] = [
  scheme({
    id: "wmux",
    name: "wmux",
    accent: "#f4d35e",
    chrome: {
      black: "#050505", panel: "#0a0907", panel2: "#11100d", panel3: "#171510",
      active: "#17130a", activeSoft: "#100e08", line: "#2f2a1d", lineBright: "#b99a45",
      gold: "#f4d35e", goldDim: "#a9944f", text: "#e4ded0", muted: "#8d826f", faint: "#5f584b",
      red: "#d94a3d", green: "#47d37c", blue: "#5097ff", agent: "#c792ea",
      runningSoft: "#061019", failedSoft: "#150806",
    },
    terminal: {
      background: "#101114", foreground: "#d8dee9", cursor: "#f7c95c", cursorAccent: "#101114",
      selectionBackground: "#31445f", selectionForeground: "#f2eee4",
      black: "#1b1d22", red: "#be3e37", green: "#45b86a", yellow: "#d4b45f", blue: "#5097ff",
      magenta: "#b48ead", cyan: "#65b9c7", white: "#d8dee9", brightBlack: "#5f6673", brightRed: "#e05a50",
      brightGreen: "#62d486", brightYellow: "#f4d35e", brightBlue: "#73adff", brightMagenta: "#c792ea",
      brightCyan: "#88d7e3", brightWhite: "#f2eee4",
    },
  }),
  scheme({
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    accent: "#f9e2af",
    terminal: {
      background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc", cursorAccent: "#1e1e2e",
      selectionBackground: "#45475a", selectionForeground: "#cdd6f4",
      black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af", blue: "#89b4fa",
      magenta: "#cba6f7", cyan: "#94e2d5", white: "#bac2de", brightBlack: "#585b70", brightRed: "#f38ba8",
      brightGreen: "#a6e3a1", brightYellow: "#f9e2af", brightBlue: "#89b4fa", brightMagenta: "#cba6f7",
      brightCyan: "#94e2d5", brightWhite: "#a6adc8",
    },
  }),
  scheme({
    id: "dracula",
    name: "Dracula",
    accent: "#f1fa8c",
    terminal: {
      background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2", cursorAccent: "#282a36",
      selectionBackground: "#44475a", selectionForeground: "#f8f8f2",
      black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c", blue: "#bd93f9",
      magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2", brightBlack: "#6272a4", brightRed: "#ff6e6e",
      brightGreen: "#69ff94", brightYellow: "#ffffa5", brightBlue: "#d6acff", brightMagenta: "#ff92df",
      brightCyan: "#a4ffff", brightWhite: "#ffffff",
    },
  }),
  scheme({
    id: "nord",
    name: "Nord",
    accent: "#88c0d0",
    terminal: {
      background: "#2e3440", foreground: "#d8dee9", cursor: "#88c0d0", cursorAccent: "#2e3440",
      selectionBackground: "#434c5e", selectionForeground: "#eceff4",
      black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b", blue: "#81a1c1",
      magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0", brightBlack: "#4c566a", brightRed: "#bf616a",
      brightGreen: "#a3be8c", brightYellow: "#ebcb8b", brightBlue: "#81a1c1", brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb", brightWhite: "#eceff4",
    },
  }),
  scheme({
    id: "solarized-dark",
    name: "Solarized Dark",
    accent: "#b58900",
    terminal: {
      background: "#002b36", foreground: "#839496", cursor: "#93a1a1", cursorAccent: "#002b36",
      selectionBackground: "#073642", selectionForeground: "#eee8d5",
      black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900", blue: "#268bd2",
      magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5", brightBlack: "#002b36", brightRed: "#cb4b16",
      brightGreen: "#586e75", brightYellow: "#657b83", brightBlue: "#839496", brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
    },
  }),
  scheme({
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    accent: "#fabd2f",
    terminal: {
      background: "#282828", foreground: "#ebdbb2", cursor: "#fabd2f", cursorAccent: "#282828",
      selectionBackground: "#504945", selectionForeground: "#fbf1c7",
      black: "#282828", red: "#cc241d", green: "#98971a", yellow: "#d79921", blue: "#458588",
      magenta: "#b16286", cyan: "#689d6a", white: "#a89984", brightBlack: "#928374", brightRed: "#fb4934",
      brightGreen: "#b8bb26", brightYellow: "#fabd2f", brightBlue: "#83a598", brightMagenta: "#d3869b",
      brightCyan: "#8ec07c", brightWhite: "#ebdbb2",
    },
  }),
  scheme({
    id: "tokyo-night",
    name: "Tokyo Night",
    accent: "#e0af68",
    terminal: {
      background: "#1a1b26", foreground: "#c0caf5", cursor: "#c0caf5", cursorAccent: "#1a1b26",
      selectionBackground: "#33467c", selectionForeground: "#c0caf5",
      black: "#15161e", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68", blue: "#7aa2f7",
      magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6", brightBlack: "#414868", brightRed: "#f7768e",
      brightGreen: "#9ece6a", brightYellow: "#e0af68", brightBlue: "#7aa2f7", brightMagenta: "#bb9af7",
      brightCyan: "#7dcfff", brightWhite: "#c0caf5",
    },
  }),
];

const schemesById = new Map(terminalColorSchemes.map((candidate) => [candidate.id, candidate]));

export const colorSchemeById = (id: TerminalColorSchemeId): TerminalColorScheme =>
  schemesById.get(id) ?? terminalColorSchemes[0];

export const colorSchemeCssVariables = (value: TerminalColorScheme): Record<string, string> => value.id === "wmux" ? ({
  "--black": "#050505",
  "--panel": "#0b0b0a",
  "--panel-2": "#11100d",
  "--panel-3": "#171510",
  "--line": "#2f2a1d",
  "--line-bright": "#b99a45",
  "--gold": "#d4b45f",
  "--gold-hot": "#f1d273",
  "--ivory": "#f2eee4",
  "--muted": "#9b9280",
  "--red": "#be3e37",
  "--green": "#45b86a",
  "--blue": "#5097ff",
}) : ({
  "--black": value.chrome.black,
  "--panel": value.chrome.panel,
  "--panel-2": value.chrome.panel2,
  "--panel-3": value.chrome.panel3,
  "--line": value.chrome.line,
  "--line-bright": value.chrome.lineBright,
  "--gold": value.chrome.goldDim,
  "--gold-hot": value.chrome.gold,
  "--ivory": value.chrome.text,
  "--muted": value.chrome.muted,
  "--red": value.chrome.red,
  "--green": value.chrome.green,
  "--blue": value.chrome.blue,
});

function mix(from: string, to: string, amount: number): string {
  const left = parseHex(from);
  const right = parseHex(to);
  const channel = (index: number) => Math.round(left[index] + (right[index] - left[index]) * amount);
  return `#${[channel(0), channel(1), channel(2)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function parseHex(value: string): [number, number, number] {
  const normalized = value.replace(/^#/, "");
  return [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16)) as [number, number, number];
}
