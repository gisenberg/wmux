import fs from "node:fs";
import { createRequire } from "node:module";
import { CellFlags, Ghostty, type GhosttyCell, type GhosttyTerminal } from "ghostty-web";

export type AttachReplayKind = "raw" | "checkpoint";

export interface AttachReplay {
  data: string;
  kind: AttachReplayKind;
}

const require = createRequire(import.meta.url);
const excludedPrivateModes = new Set([7, 25, 47, 1047, 1049, 2026]);
const privateModePattern = /\x1b\[\?([0-9;]+)([hl])/g;
const modeCarryLimit = 96;
const maxCheckpointScrollbackLines = 10_000;
const maxCheckpointScrollbackBytes = 2 * 1024 * 1024;
// Longest trailing escape or control-string fragment held back between writes.
const partialSequenceCarryLimit = 4096;

interface SnapshotOptions {
  // Start from RIS so a freshly cleared browser terminal restores every mode.
  reset: boolean;
  // Seed the checkpoint's plain-text scrollback before painting the screen.
  seedHistory: boolean;
}

interface CheckpointThemeConfig {
  fgColor?: number;
  bgColor?: number;
  cursorColor?: number;
  palette?: number[];
}

let sharedGhostty: Ghostty | null | undefined;

const loadGhostty = (): Ghostty | undefined => {
  if (sharedGhostty !== undefined) return sharedGhostty ?? undefined;
  try {
    const wasmPath = require.resolve("ghostty-web/ghostty-vt.wasm");
    const wasm = (globalThis as unknown as {
      WebAssembly: {
        Module: new (bytes: Uint8Array) => object;
        Instance: new (
          module: object,
          imports: Record<string, Record<string, (...args: number[]) => void>>,
        ) => ConstructorParameters<typeof Ghostty>[0];
      };
    }).WebAssembly;
    const module = new wasm.Module(fs.readFileSync(wasmPath));
    const instance = new wasm.Instance(module, { env: { log: () => undefined } });
    sharedGhostty = new Ghostty(instance);
  } catch (error) {
    sharedGhostty = null;
    console.warn(`wmux: terminal checkpoint engine unavailable: ${formatError(error)}`);
  }
  return sharedGhostty ?? undefined;
};

/**
 * Maintains an authoritative VT screen alongside a pane's raw byte replay.
 * Snapshot output is ANSI so the browser can restore it through the same
 * ghostty-web write path used for live PTY output.
 */
export class TerminalCheckpoint {
  private terminal?: GhosttyTerminal;
  private privateModes = new Map<number, boolean>();
  private modeCarry = "";
  private sequenceCarry = "";
  private readonly themeConfig?: CheckpointThemeConfig;

  constructor(cols: number, rows: number, themeEnvironment: Record<string, string> = {}) {
    this.themeConfig = checkpointThemeConfig(themeEnvironment);
    try {
      this.terminal = loadGhostty()?.createTerminal(normalizeCols(cols), normalizeRows(rows), this.themeConfig);
    } catch (error) {
      console.warn(`wmux: terminal checkpoint initialization failed: ${formatError(error)}`);
    }
  }

  get available(): boolean {
    return Boolean(this.terminal);
  }

  get isAlternateScreen(): boolean {
    return this.terminal?.isAlternateScreen() ?? false;
  }

  get dimensions(): { cols: number; rows: number } | undefined {
    const terminal = this.terminal;
    return terminal ? { cols: terminal.cols, rows: terminal.rows } : undefined;
  }

  write(data: string): void {
    if (!this.terminal || !data) return;
    this.capturePrivateModes(data);
    // Windows agent polls and resize boundaries split output at arbitrary
    // byte offsets. Hold back a trailing partial sequence so a reframe between
    // chunks cannot hand its continuation to a fresh parser as plain text.
    const combined = this.sequenceCarry + data;
    const carryLength = partialTerminalSequenceLength(combined);
    this.sequenceCarry = carryLength > 0 ? combined.slice(combined.length - carryLength) : "";
    const body = carryLength > 0 ? combined.slice(0, combined.length - carryLength) : combined;
    if (!body) return;
    try {
      this.terminal.write(body);
    } catch (error) {
      this.disable(error);
    }
  }

  resize(cols: number, rows: number): void {
    if (!this.terminal) return;
    try {
      this.terminal.resize(normalizeCols(cols), normalizeRows(rows));
    } catch (error) {
      this.disable(error);
    }
  }

  /**
   * Resize a Windows-style screen without Ghostty's bottom-anchored reflow.
   * ConPTY keeps the existing viewport rows and cursor anchored from the top,
   * so repaint the old absolute screen into a fresh grid of the target size.
   */
  reframe(cols: number, rows: number): void {
    if (!this.terminal) return;
    const targetCols = normalizeCols(cols);
    const targetRows = normalizeRows(rows);
    if (this.terminal.isAlternateScreen()) {
      // A repainted snapshot only carries the active screen. Full-screen apps
      // redraw after ConPTY resizes them anyway, so resize in place and keep
      // the inactive primary screen for when the app exits.
      this.resize(targetCols, targetRows);
      return;
    }
    const snapshot = this.snapshotForDimensions(targetCols, targetRows, { reset: true, seedHistory: true });
    if (!snapshot || !this.terminal) return;
    try {
      const next = loadGhostty()?.createTerminal(targetCols, targetRows, this.themeConfig);
      if (!next) return;
      this.terminal.free();
      this.terminal = next;
      this.modeCarry = "";
      this.terminal.write(snapshot);
    } catch (error) {
      this.disable(error);
    }
  }

  snapshot(): string {
    const terminal = this.terminal;
    if (!terminal) return "";
    return this.snapshotForDimensions(terminal.cols, terminal.rows, { reset: true, seedHistory: false });
  }

  /**
   * Attach replay for a freshly cleared browser terminal: the retained
   * scrollback first, then the authoritative screen painted in place.
   */
  snapshotWithScrollbackSeed(): string {
    const terminal = this.terminal;
    if (!terminal) return "";
    return this.snapshotForDimensions(terminal.cols, terminal.rows, { reset: true, seedHistory: true });
  }

  /**
   * Repaint the active screen of an already attached browser terminal.
   * Deliberately no RIS: resetting a live browser terminal discards its
   * scrollback and the modes it restored on attach.
   */
  repaint(): string {
    const terminal = this.terminal;
    if (!terminal) return "";
    return this.snapshotForDimensions(terminal.cols, terminal.rows, { reset: false, seedHistory: false });
  }

  private snapshotForDimensions(
    targetCols: number,
    targetRows: number,
    options: SnapshotOptions,
  ): string {
    const terminal = this.terminal;
    if (!terminal) return "";
    try {
      terminal.update();
      const cursor = terminal.getCursor();
      const cells = terminal.getViewport();
      const alternateScreen = terminal.isAlternateScreen();
      const paintCols = Math.min(terminal.cols, targetCols);
      // conhost keeps the cursor row visible when the viewport shrinks and
      // scrolls the rows above it into history, so anchor the paint window on
      // the cursor instead of blindly clipping the bottom of the screen.
      const rowOffset = !alternateScreen && cursor.y >= targetRows ? cursor.y - targetRows + 1 : 0;
      const paintRows = Math.min(terminal.rows - rowOffset, targetRows);
      const output: string[] = options.reset ? ["\x1bc"] : [];
      if (alternateScreen && options.reset) output.push("\x1b[?1049h");

      if (options.seedHistory && !alternateScreen) {
        const scrolledLines = Array.from({ length: rowOffset }, (_, row) =>
          cellsToText(cells.slice(row * terminal.cols, (row + 1) * terminal.cols), terminal.cols));
        const scrolledBytes = scrolledLines.reduce((total, line) => total + Buffer.byteLength(line) + 2, 0);
        // Seed with wrapping enabled so history longer than the target width
        // reflows the way conhost reflows its buffer on a narrower resize.
        output.push("\x1b[?7h", "\x1b[2J", "\x1b[H");
        output.push(...this.scrollbackSeedLines(Math.max(0, maxCheckpointScrollbackBytes - scrolledBytes))
          .flatMap((line) => [line, "\r\n"]));
        output.push(...scrolledLines.flatMap((line) => [line, "\r\n"]));
        output.push("\r\n".repeat(Math.max(0, targetRows - 1)));
      }

      // Disable wrapping while painting absolute rows so a glyph in the final
      // column cannot introduce an extra scroll or line wrap.
      output.push("\x1b[?7l", "\x1b[2J", "\x1b[H");
      let activeStyle = "";
      for (let row = 0; row < paintRows; row += 1) {
        output.push(`\x1b[${row + 1};1H`);
        for (let col = 0; col < paintCols; col += 1) {
          const cell = cells[(row + rowOffset) * terminal.cols + col];
          if (!cell || cell.width === 0) continue;
          if (col + cell.width > paintCols) continue;
          const style = cellStyleKey(cell);
          if (style !== activeStyle) {
            output.push(cellStyleSequence(cell));
            activeStyle = style;
          }
          output.push(cell.codepoint === 0 ? " " : String.fromCodePoint(cell.codepoint));
        }
      }

      output.push("\x1b[0m");
      this.restorePrivateModes(output, terminal);
      output.push(cursorStyleSequence(cursor.style, cursor.blinking));
      output.push(
        `\x1b[${Math.min(cursor.y - rowOffset, targetRows - 1) + 1};${Math.min(cursor.x, targetCols - 1) + 1}H`,
      );
      output.push(cursor.visible ? "\x1b[?25h" : "\x1b[?25l");
      return output.join("");
    } catch (error) {
      this.disable(error);
      return "";
    }
  }

  screenLines(): string[] {
    const terminal = this.terminal;
    if (!terminal) return [];
    terminal.update();
    const cells = terminal.getViewport();
    const lines: string[] = [];
    for (let row = 0; row < terminal.rows; row += 1) {
      let line = "";
      for (let col = 0; col < terminal.cols; col += 1) {
        const cell = cells[row * terminal.cols + col];
        if (!cell || cell.width === 0) continue;
        line += cell.codepoint === 0 ? " " : String.fromCodePoint(cell.codepoint);
      }
      lines.push(line);
    }
    return lines;
  }

  private scrollbackSeedLines(byteLimit: number): string[] {
    const terminal = this.terminal;
    if (!terminal || byteLimit <= 0) return [];
    const available = terminal.getScrollbackLength();
    const retained: string[] = [];
    let retainedBytes = 0;
    const oldest = Math.max(0, available - maxCheckpointScrollbackLines);
    for (let offset = available - 1; offset >= oldest; offset -= 1) {
      const line = cellsToText(terminal.getScrollbackLine(offset), terminal.cols);
      const lineBytes = Buffer.byteLength(line) + 2;
      if (retainedBytes + lineBytes > byteLimit) break;
      retained.push(line);
      retainedBytes += lineBytes;
    }
    retained.reverse();
    return retained;
  }

  cursor(): { x: number; y: number; visible: boolean } | undefined {
    const cursor = this.terminal?.getCursor();
    return cursor ? { x: cursor.x, y: cursor.y, visible: Boolean(cursor.visible) } : undefined;
  }

  dispose(): void {
    this.terminal?.free();
    this.terminal = undefined;
  }

  private capturePrivateModes(data: string): void {
    const combined = this.modeCarry + data;
    for (const match of combined.matchAll(privateModePattern)) {
      const enabled = match[2] === "h";
      for (const value of match[1].split(";")) {
        const mode = Number(value);
        if (Number.isInteger(mode)) this.privateModes.set(mode, enabled);
      }
    }
    this.modeCarry = combined.slice(-modeCarryLimit);
  }

  private restorePrivateModes(output: string[], terminal: GhosttyTerminal): void {
    const modes = new Map(this.privateModes);
    if (!modes.has(2004) && terminal.hasBracketedPaste()) modes.set(2004, true);
    if (!modes.has(1004) && terminal.hasFocusEvents()) modes.set(1004, true);
    for (const [mode, enabled] of [...modes].sort(([first], [second]) => first - second)) {
      if (excludedPrivateModes.has(mode)) continue;
      output.push(`\x1b[?${mode}${enabled ? "h" : "l"}`);
    }
    output.push(`\x1b[?7${modes.get(7) === false ? "l" : "h"}`);
  }

  private disable(error: unknown): void {
    console.warn(`wmux: terminal checkpoint disabled after parser failure: ${formatError(error)}`);
    this.dispose();
  }
}

export const selectAttachReplay = (
  rawReplay: string,
  rawReplayTruncated: boolean,
  checkpoint: TerminalCheckpoint,
  preferCheckpoint = false,
): AttachReplay => {
  if (preferCheckpoint || rawReplayTruncated || checkpoint.isAlternateScreen) {
    const snapshot = checkpoint.snapshot();
    if (snapshot) return { data: snapshot, kind: "checkpoint" };
  }
  return { data: rawReplay, kind: "raw" };
};

const cellStyleKey = (cell: GhosttyCell): string =>
  `${cell.flags}:${cell.fgIsDefault ? "default" : `${cell.fg_r},${cell.fg_g},${cell.fg_b}`}`
  + `:${cell.bgIsDefault ? "default" : `${cell.bg_r},${cell.bg_g},${cell.bg_b}`}`;

const cellStyleSequence = (cell: GhosttyCell): string => {
  const codes = [0];
  if (cell.flags & CellFlags.BOLD) codes.push(1);
  if (cell.flags & CellFlags.FAINT) codes.push(2);
  if (cell.flags & CellFlags.ITALIC) codes.push(3);
  if (cell.flags & CellFlags.UNDERLINE) codes.push(4);
  if (cell.flags & CellFlags.BLINK) codes.push(5);
  if (cell.flags & CellFlags.INVERSE) codes.push(7);
  if (cell.flags & CellFlags.INVISIBLE) codes.push(8);
  if (cell.flags & CellFlags.STRIKETHROUGH) codes.push(9);
  // Keep semantic defaults as defaults so a restored screen still follows a
  // later color-scheme change instead of freezing the palette of one theme.
  if (cell.fgIsDefault) codes.push(39);
  else codes.push(38, 2, cell.fg_r, cell.fg_g, cell.fg_b);
  if (cell.bgIsDefault) codes.push(49);
  else codes.push(48, 2, cell.bg_r, cell.bg_g, cell.bg_b);
  return `\x1b[${codes.join(";")}m`;
};

/**
 * Length of an unterminated escape, CSI, or control-string fragment at the end
 * of `data`, or 0 when the tail is complete. Bounded so a runaway payload can
 * never stall the checkpoint.
 */
export const partialTerminalSequenceLength = (data: string): number => {
  const start = data.lastIndexOf("\x1b");
  if (start === -1 || data.length - start > partialSequenceCarryLimit) return 0;
  const tail = data.slice(start);
  if (tail.length === 1) return 1;
  const introducer = tail.charCodeAt(1);
  if (introducer === 0x5b) {
    // CSI: parameters and intermediates until a final byte in 0x40..0x7e.
    for (let index = 2; index < tail.length; index += 1) {
      const code = tail.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return 0;
      if (code < 0x20 || code > 0x3f) return 0;
    }
    return tail.length;
  }
  if (introducer === 0x5d || introducer === 0x50 || introducer === 0x5f || introducer === 0x5e || introducer === 0x58) {
    // OSC, DCS, APC, PM, SOS: terminated by ST (whose ESC would be the last
    // one found above) or, for OSC, by BEL.
    if (introducer === 0x5d && tail.includes("\x07")) return 0;
    return tail.length;
  }
  if (introducer >= 0x20 && introducer <= 0x2f) {
    // nF escape such as ESC ( B: intermediates until a final byte 0x30..0x7e.
    for (let index = 2; index < tail.length; index += 1) {
      const code = tail.charCodeAt(index);
      if (code >= 0x30 && code <= 0x7e) return 0;
      if (code < 0x20 || code > 0x2f) return 0;
    }
    return tail.length;
  }
  return 0;
};

const cellsToText = (cells: GhosttyCell[] | null, cols: number): string => {
  if (!cells) return "";
  let line = "";
  for (let col = 0; col < Math.min(cols, cells.length); col += 1) {
    const cell = cells[col];
    if (!cell || cell.width === 0) continue;
    if (col + cell.width > cols) continue;
    line += cell.codepoint === 0 ? " " : String.fromCodePoint(cell.codepoint);
  }
  return line.trimEnd();
};

const cursorStyleSequence = (style: string, blinking: boolean): string => {
  const code = style === "underline" ? (blinking ? 3 : 4) : style === "bar" ? (blinking ? 5 : 6) : blinking ? 1 : 2;
  return `\x1b[${code} q`;
};

const normalizeCols = (value: number): number => Math.max(2, Math.floor(value || 80));
const normalizeRows = (value: number): number => Math.max(1, Math.floor(value || 24));
const parseHexColor = (value: string | undefined): number | undefined => {
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) return undefined;
  return Number.parseInt(value.slice(1), 16);
};

const checkpointThemeConfig = (environment: Record<string, string>): CheckpointThemeConfig | undefined => {
  const fgColor = parseHexColor(environment.WMUX_TERMINAL_FOREGROUND);
  const bgColor = parseHexColor(environment.WMUX_TERMINAL_BACKGROUND);
  const rawPalette = environment.WMUX_TERMINAL_ANSI_PALETTE?.split(",") ?? [];
  const palette = rawPalette.length === 16 ? rawPalette.map(parseHexColor) : [];
  if (palette.some((color) => color === undefined)) palette.length = 0;
  if (fgColor === undefined && bgColor === undefined && palette.length === 0) return undefined;
  return {
    ...(fgColor === undefined ? {} : { fgColor, cursorColor: fgColor }),
    ...(bgColor === undefined ? {} : { bgColor }),
    ...(palette.length === 0 ? {} : { palette: palette as number[] }),
  };
};

const formatError = (error: unknown): string => error instanceof Error ? error.message : String(error);
