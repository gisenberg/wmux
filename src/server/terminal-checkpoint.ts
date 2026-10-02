import fs from "node:fs";
import { createRequire } from "node:module";
import { Ghostty, type GhosttyCell, type GhosttyTerminal } from "ghostty-web";
import { cellStyleKey, cellStyleSequence } from "../shared/terminal-cell-style.js";
import {
  ghosttyResizeModel,
  resizeTerminalModel,
  type ResizableTerminalModel,
  type TerminalResizeMode,
} from "../shared/conpty-resize.js";
import type { WindowsAgentConsoleScreen, WindowsAgentScreenLine } from "../shared/windows-agent-protocol.js";
import { TERMINAL_RESET } from "../shared/terminal-protocol.js";

export type AttachReplayKind = "raw" | "checkpoint";

export interface AttachReplay {
  data: string;
  kind: AttachReplayKind;
}

const require = createRequire(import.meta.url);
// 2027 is restored from the live model rather than from captured output.
const excludedPrivateModes = new Set([7, 25, 47, 1047, 1049, 2026, 2027]);
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
    // byte offsets. Hold back a trailing partial sequence so a resize between
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

  resize(cols: number, rows: number, mode: TerminalResizeMode = "native"): void {
    const terminal = this.terminal;
    if (!terminal) return;
    try {
      resizeTerminalModel(checkpointResizeModel(terminal), normalizeCols(cols), normalizeRows(rows), mode);
    } catch (error) {
      this.disable(error);
    }
  }

  snapshot(): string {
    return this.paint({ reset: true, seedHistory: false });
  }

  /**
   * Attach replay for a freshly cleared browser terminal: the retained
   * scrollback first, then the authoritative screen painted in place.
   */
  snapshotWithScrollbackSeed(): string {
    return this.paint({ reset: true, seedHistory: true });
  }

  /**
   * Repaint the active screen of an already attached browser terminal.
   * Deliberately no RIS: resetting a live browser terminal discards its
   * scrollback and the modes it restored on attach.
   */
  repaint(): string {
    return this.paint({ reset: false, seedHistory: false });
  }

  /**
   * Converge this model on the screen ConPTY itself holds.
   *
   * The console screen is authoritative for text and cursor placement, but its
   * legacy API reduces colors to the 16-color console palette and reports
   * wider graphemes as U+FFFD. Cells whose text already agrees keep this
   * model's exact style and grapheme; only disagreeing cells fall back to the
   * console's own attributes. Returns the repaint applied to this model, which
   * an attached browser must apply at the same stream position, or "" when the
   * model already matched.
   */
  reconcileConsoleScreen(screen: WindowsAgentConsoleScreen): string {
    const terminal = this.terminal;
    if (!terminal || this.sequenceCarry) return "";
    if (terminal.cols !== screen.cols || terminal.rows !== screen.rows) return "";
    try {
      terminal.update();
      // Origin mode addresses rows relative to the scroll region; a repaint
      // cannot safely assume absolute rows there.
      if (terminal.getMode(6)) return "";
      const cells = terminal.getViewport();
      const cursor = terminal.getCursor();
      const truth = screen.lines.map((line) => decodeConsoleLine(line, screen.cols));
      const mismatchedRows: number[] = [];
      for (let row = 0; row < screen.rows; row += 1) {
        const expected = truth[row];
        for (let col = 0; col < screen.cols; col += 1) {
          if (!consoleCellMatches(expected?.[col], cells, terminal, row, col)) {
            mismatchedRows.push(row);
            break;
          }
        }
      }
      const cursorMatches = cursorAgrees(cursor, screen, terminal.cols);
      if (mismatchedRows.length === 0 && cursorMatches) return "";

      const synchronized = !terminal.getMode(2026);
      const output: string[] = synchronized ? ["\x1b[?2026h"] : [];
      output.push("\x1b[?7l");
      let activeStyle = "";
      for (const row of mismatchedRows) {
        output.push(`\x1b[${row + 1};1H`);
        const expected = truth[row] ?? [];
        for (let col = 0; col < screen.cols; col += 1) {
          const cell = expected[col];
          if (!cell || cell.width === 0) continue;
          const modelCell = cells[row * terminal.cols + col];
          const agrees = consoleCellMatches(cell, cells, terminal, row, col);
          const style = agrees && modelCell ? `m:${cellStyleKey(modelCell)}` : `c:${cell.attribute}`;
          if (style !== activeStyle) {
            output.push(agrees && modelCell ? cellStyleSequence(modelCell) : consoleAttributeSequence(cell.attribute));
            activeStyle = style;
          }
          if (agrees && modelCell) output.push(cellText(terminal, modelCell, row, col));
          // The console hides wider graphemes behind U+FFFD; keep the cell
          // width with a double-width placeholder rather than two cells.
          else output.push(cell.width === 2 && cell.text === "\uFFFD" ? WIDE_UNKNOWN_GLYPH : cell.text);
        }
      }
      output.push("\x1b[0m");
      output.push(terminal.getMode(7) ? "\x1b[?7h" : "\x1b[?7l");
      output.push(`\x1b[${screen.cursorY + 1};${screen.cursorX + 1}H`);
      if (synchronized) output.push("\x1b[?2026l");
      const repaint = output.join("");
      terminal.write(repaint);
      return repaint;
    } catch (error) {
      this.disable(error);
      return "";
    }
  }

  private paint(options: SnapshotOptions): string {
    const terminal = this.terminal;
    if (!terminal) return "";
    try {
      terminal.update();
      const cursor = terminal.getCursor();
      const cells = terminal.getViewport();
      const alternateScreen = terminal.isAlternateScreen();
      const output: string[] = options.reset ? [TERMINAL_RESET] : [];
      if (alternateScreen && options.reset) output.push("\x1b[?1049h");

      if (options.seedHistory && !alternateScreen) {
        // Seed with wrapping enabled so history longer than the browser's
        // width reflows the way it would have been written.
        output.push("\x1b[?7h", "\x1b[2J", "\x1b[H");
        output.push(...this.scrollbackSeedLines(maxCheckpointScrollbackBytes).flatMap((line) => [line, "\r\n"]));
        output.push("\r\n".repeat(Math.max(0, terminal.rows - 1)));
      }

      // Paint with autowrap enabled so soft-wrapped rows are recreated as
      // wraps rather than hard lines: a continuation row flows from the
      // pending wrap left by the full row above it, and every other row starts
      // with an absolute cursor move. A glyph in the final column only sets the
      // pending wrap, so painting never scrolls.
      output.push("\x1b[?7h", "\x1b[2J", "\x1b[H");
      let activeStyle = "";
      for (let row = 0; row < terminal.rows; row += 1) {
        const continuation = row > 0 && terminal.isRowWrapped(row);
        const wrapsIntoNext = row + 1 < terminal.rows && terminal.isRowWrapped(row + 1);
        if (!continuation) output.push(`\x1b[${row + 1};1H`);
        let painted = 0;
        for (let col = 0; col < terminal.cols; col += 1) {
          const cell = cells[row * terminal.cols + col];
          if (!cell || cell.width === 0) continue;
          const width = Math.max(1, cell.width);
          if (col + width > terminal.cols) continue;
          const style = cellStyleKey(cell);
          if (style !== activeStyle) {
            output.push(cellStyleSequence(cell));
            activeStyle = style;
          }
          output.push(cellText(terminal, cell, row, col));
          painted = col + width;
        }
        // A wrapped row must reach the right margin for its continuation to
        // wrap; pad a trailing wide-glyph gap with blanks.
        if (wrapsIntoNext && painted < terminal.cols) output.push(" ".repeat(terminal.cols - painted));
      }

      output.push("\x1b[0m");
      this.restorePrivateModes(output, terminal);
      output.push(cursorStyleSequence(cursor.style, cursor.blinking));
      output.push(`\x1b[${cursor.y + 1};${cursor.x + 1}H`);
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
        line += cellText(terminal, cell, row, col);
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
      const line = scrollbackLineText(terminal, offset);
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
    output.push(`\x1b[?2027${terminal.getMode(2027) ? "h" : "l"}`);
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

/** The full grapheme of a viewport cell, not just its first code point. */
const cellText = (terminal: GhosttyTerminal, cell: GhosttyCell, row: number, col: number): string => {
  if (cell.codepoint === 0) return " ";
  if (cell.grapheme_len > 0) return terminal.getGraphemeString(row, col) || String.fromCodePoint(cell.codepoint);
  return String.fromCodePoint(cell.codepoint);
};

const scrollbackLineText = (terminal: GhosttyTerminal, offset: number): string => {
  const cells = terminal.getScrollbackLine(offset);
  if (!cells) return "";
  let line = "";
  for (let col = 0; col < Math.min(terminal.cols, cells.length); col += 1) {
    const cell = cells[col];
    if (!cell || cell.width === 0) continue;
    if (col + cell.width > terminal.cols) continue;
    if (cell.codepoint === 0) line += " ";
    // Scrollback cells carry only their first code point; resolve the full
    // grapheme for anything beyond ASCII, where clusters can occur.
    else if (cell.codepoint < 0x80) line += String.fromCodePoint(cell.codepoint);
    else line += terminal.getScrollbackGraphemeString(offset, col) || String.fromCodePoint(cell.codepoint);
  }
  return line.trimEnd();
};

const checkpointResizeModel = (terminal: GhosttyTerminal): ResizableTerminalModel =>
  ghosttyResizeModel({
    get cols() {
      return terminal.cols;
    },
    get rows() {
      return terminal.rows;
    },
    resize: (cols, rows) => terminal.resize(cols, rows),
    write: (data) => terminal.write(data),
    isAlternateScreen: () => terminal.isAlternateScreen(),
    cursor: () => {
      const cursor = terminal.getCursor();
      return { x: cursor.x, y: cursor.y };
    },
    viewport: () => {
      terminal.update();
      return terminal.getViewport();
    },
    grapheme: (row, col) => terminal.getGraphemeString(row, col),
    isRowWrapped: (row) => terminal.isRowWrapped(row),
    mode: (mode) => terminal.getMode(mode),
  });

// A double-width stand-in for a grapheme the console reported only as U+FFFD.
const WIDE_UNKNOWN_GLYPH = "\uFF1F";

interface ConsoleCell {
  text: string;
  width: 0 | 1 | 2;
  attribute: number;
}

const decodeConsoleLine = (line: WindowsAgentScreenLine, cols: number): ConsoleCell[] => {
  const attributes: number[] = [];
  for (const [attribute, count] of line.attrs ?? []) {
    for (let index = 0; index < count && attributes.length < cols; index += 1) attributes.push(attribute);
  }
  const wide = new Set(line.wide ?? []);
  const cells: ConsoleCell[] = [];
  let col = 0;
  // Console cells hold single UTF-16 units; ConPTY substitutes U+FFFD for
  // anything wider, so indexing code units cannot split a surrogate pair.
  for (let index = 0; index < line.text.length && col < cols; index += 1) {
    const text = line.text[index] ?? " ";
    const attribute = attributes[col] ?? 7;
    if (wide.has(col) && col + 1 < cols) {
      cells.push({ text, width: 2, attribute });
      cells.push({ text: "", width: 0, attribute: attributes[col + 1] ?? attribute });
      col += 2;
    } else {
      cells.push({ text, width: 1, attribute });
      col += 1;
    }
  }
  while (cells.length < cols) cells.push({ text: " ", width: 1, attribute: attributes[cells.length] ?? 7 });
  return cells;
};

const consoleCellMatches = (
  expected: ConsoleCell | undefined,
  cells: GhosttyCell[],
  terminal: GhosttyTerminal,
  row: number,
  col: number,
): boolean => {
  const cell = cells[row * terminal.cols + col];
  if (!expected || !cell) return !expected && !cell;
  // Width 0 marks both the second half of a wide glyph and the spacer left
  // where a wide glyph did not fit before a wrap. The console shows the
  // latter as an ordinary blank cell.
  const tail = cell.width === 0 && col > 0 && (cells[row * terminal.cols + col - 1]?.width ?? 0) >= 2;
  const width = tail ? 0 : cell.width >= 2 ? 2 : 1;
  if (expected.width !== width) return false;
  if (width === 0) return true;
  const text = cell.width === 0 ? " " : cellText(terminal, cell, row, col);
  if (expected.text === text) return true;
  // The console reports graphemes beyond one UTF-16 unit as U+FFFD.
  if (expected.text === "\uFFFD") return text.length > 1 || cell.codepoint > 0xffff || text === WIDE_UNKNOWN_GLYPH;
  return false;
};

const cursorAgrees = (
  cursor: { x: number; y: number },
  screen: WindowsAgentConsoleScreen,
  cols: number,
): boolean => {
  if (cursor.x === screen.cursorX && cursor.y === screen.cursorY) return true;
  // Ghostty holds a glyph written in the final column as a pending wrap, and
  // the console reports the same state as the start of the next row.
  return cursor.x === cols - 1 && screen.cursorX === 0 && screen.cursorY === cursor.y + 1;
};

// Console attribute bits are BGR; ANSI palette indexes are RGB.
const consoleColorToAnsi = (value: number): number =>
  ((value & 0x4) ? 1 : 0) | ((value & 0x2) ? 2 : 0) | ((value & 0x1) ? 4 : 0);

/**
 * SGR for a legacy console attribute. ConPTY maps the terminal's default
 * colors onto console slots 7 and 0, so those stay semantic defaults.
 */
export const consoleAttributeSequence = (attribute: number): string => {
  const codes = [0];
  const foreground = attribute & 0xf;
  const background = (attribute >> 4) & 0xf;
  if (attribute & 0x8000) codes.push(4);
  if (attribute & 0x4000) codes.push(7);
  if (foreground === 7) codes.push(39);
  else codes.push((foreground & 0x8 ? 90 : 30) + consoleColorToAnsi(foreground));
  if (background === 0) codes.push(49);
  else codes.push((background & 0x8 ? 100 : 40) + consoleColorToAnsi(background));
  return `\x1b[${codes.join(";")}m`;
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
