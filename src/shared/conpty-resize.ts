import type { GhosttyCell } from "ghostty-web";
import { cellStyleSequence } from "./terminal-cell-style.js";

/**
 * How a terminal model must change geometry to stay in lockstep with the
 * process that produces its output.
 *
 * - `native`: the remote side is an ordinary PTY whose application redraws
 *   after SIGWINCH, so the local emulator's own reflow is authoritative.
 * - `conpty`: the remote side is ConPTY, itself a terminal emulator. It emits
 *   nothing on resize and keeps addressing rows of its own reflowed buffer, so
 *   the local model must reproduce ConPTY's reflow exactly.
 */
export type TerminalResizeMode = "native" | "conpty";

export interface ViewportGlyphCell {
  text: string;
  // 2 starts a double-width glyph, 0 is the spacer after it or the spacer
  // left where a wide glyph did not fit before a wrap.
  width: number;
  blank: boolean;
  // SGR reproducing the cell's rendition from a reset pen.
  style: string;
}

export interface ViewportRow {
  cells: ViewportGlyphCell[];
  // This row is the soft-wrapped continuation of the row above.
  continues: boolean;
}

export interface ResizableTerminalModel {
  readonly cols: number;
  readonly rows: number;
  resize(cols: number, rows: number): void;
  write(data: string): void;
  isAlternateScreen(): boolean;
  cursor(): { x: number; y: number };
  viewportRows(): ViewportRow[];
  mode(mode: number): boolean;
}

interface Glyph {
  text: string;
  width: 1 | 2;
  blank: boolean;
  style: string;
}

export interface ExpectedRow {
  glyphs: Glyph[];
  continues: boolean;
}

export interface ConptyReflow {
  // The viewport ConPTY holds after the resize.
  rows: ExpectedRow[];
  // ConPTY's cursor, when it is exact. A cursor in the final column may be a
  // pending wrap, which the model cannot observe, so it is left alone.
  cursor?: { x: number; y: number };
}

interface LogicalLine {
  glyphs: Glyph[];
  // Cell position of the cursor within the line, when the cursor is on it.
  cursorCell?: number;
}

/**
 * The viewport ConPTY produces when it reflows its buffer to a new size,
 * derived from the model's pre-resize viewport.
 *
 * ConPTY 1.22+ keeps no scrollback: its buffer is exactly the viewport, so a
 * top row that continues a line which scrolled away starts a line of its own.
 * Reflow rewraps each logical line into the new width, moving a wide glyph
 * that no longer fits to the next row. When the content (every non-blank row
 * and the cursor row) no longer fits, the oldest top rows are discarded so the
 * bottom stays anchored; otherwise the content stays anchored at the top and
 * blank rows are added below it.
 */
export const conptyReflow = (
  viewport: ViewportRow[],
  cursor: { x: number; y: number },
  oldCols: number,
  cols: number,
  rows: number,
): ConptyReflow => {
  const lines: LogicalLine[] = [];
  viewport.forEach((row, index) => {
    const last = lines.at(-1);
    const line: LogicalLine = last && index > 0 && row.continues ? last : { glyphs: [] };
    if (line !== last) lines.push(line);
    const wrapsIntoNext = viewport[index + 1]?.continues === true;
    const glyphs = rowGlyphs(row.cells);
    // Trailing blanks end a line; a wrapped row continues through them.
    // Offsets count glyph cells, so the spacer a wide glyph leaves at a wrap
    // boundary never shifts the cursor.
    if (index === cursor.y) line.cursorCell = usedCells(line.glyphs) + cursor.x;
    line.glyphs.push(...(wrapsIntoNext ? glyphs : trimBlank(glyphs)));
  });

  const expected: ExpectedRow[] = [];
  let cursorAt: { x: number; y: number } | undefined;
  let contentRows = 0;
  for (const line of lines) {
    const top = expected.length;
    const placed = wrapGlyphs(line.glyphs, cols);
    placed.rows.forEach((glyphs, row) => expected.push({ glyphs, continues: row > 0 }));
    if (line.glyphs.some((glyph) => !glyph.blank)) contentRows = top + placed.lastContentRow + 1;
    if (line.cursorCell !== undefined) {
      const position = placed.cellPosition(line.cursorCell);
      cursorAt = { x: position.x, y: top + position.y };
      // A cursor past the line's last row continues it onto blank rows.
      while (expected.length <= cursorAt.y) expected.push({ glyphs: [], continues: expected.length > top });
      contentRows = Math.max(contentRows, cursorAt.y + 1);
    }
  }
  const overflow = Math.max(0, contentRows - rows);
  const visible = expected.slice(overflow, overflow + rows);
  // The first visible row begins ConPTY's buffer, whatever it continued.
  if (visible[0]) visible[0] = { ...visible[0], continues: false };
  while (visible.length < rows) visible.push({ glyphs: [], continues: false });
  if (!cursorAt || cursor.x >= oldCols - 1) return { rows: visible };
  return { rows: visible, cursor: { x: cursorAt.x, y: Math.max(0, cursorAt.y - overflow) } };
};

const rowGlyphs = (cells: ViewportGlyphCell[]): Glyph[] => {
  const glyphs: Glyph[] = [];
  for (const cell of cells) {
    if (cell.width === 0) continue;
    glyphs.push({ text: cell.text || " ", width: cell.width >= 2 ? 2 : 1, blank: cell.blank, style: cell.style });
  }
  return glyphs;
};

const trimBlank = (glyphs: Glyph[]): Glyph[] => {
  let end = glyphs.length;
  while (end > 0 && glyphs[end - 1]?.blank) end -= 1;
  return glyphs.slice(0, end);
};

const usedCells = (glyphs: Glyph[]): number => glyphs.reduce((total, glyph) => total + glyph.width, 0);

const wrapGlyphs = (glyphs: Glyph[], cols: number) => {
  const rows: Glyph[][] = [[]];
  // Source cell offset where each glyph starts, and where it was placed.
  const starts: number[] = [];
  const placements: Array<{ x: number; y: number }> = [];
  let x = 0;
  let y = 0;
  let source = 0;
  let lastContentRow = 0;
  for (const glyph of glyphs) {
    if (x + glyph.width > cols) {
      y += 1;
      x = 0;
      rows.push([]);
    }
    rows[y]?.push(glyph);
    starts.push(source);
    placements.push({ x, y });
    if (!glyph.blank) lastContentRow = y;
    x += glyph.width;
    source += glyph.width;
  }
  return {
    rows,
    lastContentRow,
    cellPosition: (cell: number): { x: number; y: number } => {
      for (let index = glyphs.length - 1; index >= 0; index -= 1) {
        const start = starts[index] ?? 0;
        if (cell >= start && cell < start + (glyphs[index]?.width ?? 1)) {
          const placement = placements[index] ?? { x: 0, y: 0 };
          return { x: placement.x + cell - start, y: placement.y };
        }
      }
      // Past the last glyph the cursor continues along the row, wrapping as
      // text written there would.
      const beyond = x + cell - source;
      return { x: beyond % cols, y: y + Math.floor(beyond / cols) };
    },
  };
};

const rowText = (glyphs: Glyph[]): string => glyphs.map((glyph) => glyph.text).join("").trimEnd();

const viewportTexts = (model: ResizableTerminalModel): string[] =>
  model.viewportRows().map((row) => rowText(rowGlyphs(row.cells)));

/**
 * The row where the expected viewport's first row appears in the model:
 * positive when the model pulled that many history rows into view.
 */
const findViewportShift = (actual: string[], expected: string[]): number | undefined => {
  const rows = actual.length;
  for (let shift = 0; shift < rows; shift += 1) {
    let matches = true;
    for (let row = 0; row < rows && matches; row += 1) {
      const expectedRow = expected[row] ?? "";
      if (row + shift < rows) matches = actual[row + shift] === expectedRow;
      else matches = expectedRow === "";
    }
    if (matches) return shift;
  }
  return undefined;
};

/**
 * Apply a resize with ConPTY's semantics on top of Ghostty's reflow.
 *
 * Ghostty rewraps text the same way ConPTY does, but it keeps scrollback: it
 * pulls history back into view when reflowed content leaves room at the top,
 * rejoins a line whose start ConPTY already discarded, can push more rows out
 * than ConPTY does, and can misplace a cursor past the end of a rewrapped
 * line. Locate ConPTY's expected viewport in Ghostty's result by content and
 * return any rows Ghostty pulled down to history; when Ghostty's viewport
 * cannot be aligned, paint ConPTY's viewport over it. Then place the cursor
 * where ConPTY put it.
 *
 * The alternate screen is resized in place by both emulators without reflow.
 */
export const resizeLikeConpty = (model: ResizableTerminalModel, cols: number, rows: number): void => {
  if (cols === model.cols && rows === model.rows) return;
  if (model.isAlternateScreen()) {
    model.resize(cols, rows);
    return;
  }
  const expected = conptyReflow(model.viewportRows(), model.cursor(), model.cols, cols, rows);
  model.resize(cols, rows);
  const shift = findViewportShift(viewportTexts(model), expected.rows.map((row) => rowText(row.glyphs)));
  if (shift === undefined) paintViewport(model, expected.rows);
  else if (shift > 0) returnPulledRows(model, rows, shift);
  if (!expected.cursor) return;
  const cursor = model.cursor();
  if (cursor.x !== expected.cursor.x || cursor.y !== expected.cursor.y) {
    model.write(`\x1b[${expected.cursor.y + 1};${expected.cursor.x + 1}H`);
  }
};

const returnPulledRows = (model: ResizableTerminalModel, rows: number, pulled: number): void => {
  const up = Math.min(pulled, model.cursor().y);
  // Scrolling the full-screen region returns the pulled rows to history.
  // Ghostty treats rows created by a scroll as used, so a later height shrink
  // would keep them and push real content out instead; erasing them marks
  // them blank again. The cursor moves with its content first so the single
  // DECSC/DECRC pair keeps the pen out of both operations and restores the
  // final position; Ghostty keeps rows up to a restored cursor in use, so the
  // restore must not land on the bottom row. The reset SGR leaves the exposed
  // rows without a background fill.
  model.write(
    `${up > 0 ? `\x1b[${up}A` : ""}\x1b7\x1b[0m\x1b[${pulled}S\x1b[${rows - pulled + 1};1H\x1b[J\x1b8`,
  );
};

/**
 * Paint ConPTY's viewport over the model's, with the model's own graphemes
 * and styles. Continuation rows flow from the pending wrap of the full row
 * above them, so soft wraps survive for the next reflow.
 */
const paintViewport = (model: ResizableTerminalModel, rows: ExpectedRow[]): void => {
  // Origin mode would address these rows relative to the scroll region.
  if (model.mode(6)) return;
  const cursor = model.cursor();
  const synchronized = !model.mode(2026);
  const output: string[] = synchronized ? ["\x1b[?2026h"] : [];
  output.push("\x1b[?7h");
  let pen = "";
  rows.forEach((row, index) => {
    if (!(index > 0 && row.continues)) output.push(`\x1b[${index + 1};1H`);
    let x = 0;
    for (const glyph of row.glyphs) {
      if (glyph.style !== pen) {
        output.push(glyph.style);
        pen = glyph.style;
      }
      output.push(glyph.text);
      x += glyph.width;
    }
    if (x >= model.cols) return;
    if (rows[index + 1]?.continues) {
      // Reach the right margin so the continuation wraps.
      output.push("\x1b[0m", " ".repeat(model.cols - x));
    } else {
      output.push("\x1b[0m\x1b[K");
    }
    pen = "\x1b[0m";
  });
  output.push("\x1b[0m", model.mode(7) ? "\x1b[?7h" : "\x1b[?7l", `\x1b[${cursor.y + 1};${cursor.x + 1}H`);
  if (synchronized) output.push("\x1b[?2026l");
  model.write(output.join(""));
};

export const resizeTerminalModel = (
  model: ResizableTerminalModel,
  cols: number,
  rows: number,
  mode: TerminalResizeMode,
): void => {
  if (mode === "conpty") resizeLikeConpty(model, cols, rows);
  else model.resize(cols, rows);
};

export interface GhosttyModelSource {
  readonly cols: number;
  readonly rows: number;
  resize(cols: number, rows: number): void;
  write(data: string): void;
  isAlternateScreen(): boolean;
  cursor(): { x: number; y: number };
  viewport(): readonly GhosttyCell[];
  grapheme(row: number, col: number): string;
  isRowWrapped(row: number): boolean;
  mode(mode: number): boolean;
}

/** Adapt a Ghostty terminal to the resize model. */
export const ghosttyResizeModel = (source: GhosttyModelSource): ResizableTerminalModel => ({
  get cols() {
    return source.cols;
  },
  get rows() {
    return source.rows;
  },
  resize: (cols, rows) => source.resize(cols, rows),
  write: (data) => source.write(data),
  isAlternateScreen: () => source.isAlternateScreen(),
  cursor: () => source.cursor(),
  mode: (mode) => source.mode(mode),
  viewportRows: () => {
    const cells = source.viewport();
    return Array.from({ length: source.rows }, (_, row) => ({
      continues: row > 0 && source.isRowWrapped(row),
      cells: Array.from({ length: source.cols }, (_unused, col) => {
        const cell = cells[row * source.cols + col];
        const codepoint = cell?.codepoint ?? 0;
        const text = !cell || codepoint === 0
          ? " "
          : cell.grapheme_len > 0
            ? source.grapheme(row, col) || String.fromCodePoint(codepoint)
            : String.fromCodePoint(codepoint);
        return {
          text,
          width: cell?.width ?? 1,
          blank: (codepoint === 0 || codepoint === 0x20) && (cell?.bgIsDefault ?? true),
          style: cell ? cellStyleSequence(cell) : "\x1b[0m",
        };
      }),
    }));
  },
});
