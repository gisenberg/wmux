import { CellFlags, type GhosttyCell } from "ghostty-web";

export interface PredictedTerminalInput {
  sequence: number;
  kind: "insert" | "backspace";
  text: string;
}

export interface PredictedTerminalCell {
  col: number;
  row: number;
  text: string;
}

export interface PredictedTerminalLayout {
  cells: PredictedTerminalCell[];
  cursor: { col: number; row: number };
  authoritativeCursor: { col: number; row: number };
}

export interface TerminalPredictionCursor {
  x: number;
  y: number;
  visible?: boolean;
}

export interface TerminalPredictionCellStyle {
  foreground: string;
  background: string;
  flags: number;
}

export type TerminalPredictionScreen = "normal" | "alternate";

export interface TerminalPredictionEchoProbe {
  screen: TerminalPredictionScreen;
  origin: { x: number; y: number; visible: true };
  previousCodepoint: number;
  inputs: PredictedTerminalInput[];
}

const MAX_ECHO_PROBE_INPUTS = 16;
const DEFAULT_FOREGROUND = "var(--terminal-foreground)";
const DEFAULT_BACKGROUND = "var(--terminal-background)";

const rgb = (red: number, green: number, blue: number): string => `rgb(${red}, ${green}, ${blue})`;

export const effectiveTerminalPredictionCellStyle = (
  cell: GhosttyCell | undefined,
): TerminalPredictionCellStyle => {
  if (!cell) return { foreground: DEFAULT_FOREGROUND, background: DEFAULT_BACKGROUND, flags: 0 };
  const inverse = Boolean(cell.flags & CellFlags.INVERSE);
  const foregroundIsDefault = inverse ? cell.bgIsDefault : cell.fgIsDefault;
  const backgroundIsDefault = inverse ? cell.fgIsDefault : cell.bgIsDefault;
  return {
    foreground: foregroundIsDefault
      ? (inverse ? DEFAULT_BACKGROUND : DEFAULT_FOREGROUND)
      : inverse
        ? rgb(cell.bg_r, cell.bg_g, cell.bg_b)
        : rgb(cell.fg_r, cell.fg_g, cell.fg_b),
    background: backgroundIsDefault
      ? (inverse ? DEFAULT_FOREGROUND : DEFAULT_BACKGROUND)
      : inverse
        ? rgb(cell.fg_r, cell.fg_g, cell.fg_b)
        : rgb(cell.bg_r, cell.bg_g, cell.bg_b),
    flags: cell.flags,
  };
};

const terminalCellCarriesStyle = (cell: GhosttyCell | undefined): cell is GhosttyCell => Boolean(
  cell
  && (
    cell.codepoint !== 0
    || !cell.fgIsDefault
    || !cell.bgIsDefault
    || cell.flags !== 0
    || cell.width !== 1
  )
);

export const terminalPredictionStyleAtCursor = (
  viewport: readonly GhosttyCell[],
  cols: number,
  cursor: { x: number; y: number },
  isRowWrapped: (row: number) => boolean,
): TerminalPredictionCellStyle => {
  const cellAt = (col: number, row: number): GhosttyCell | undefined => {
    if (col < 0 || col >= cols || row < 0) return undefined;
    return viewport[row * cols + col];
  };
  const current = cellAt(cursor.x, cursor.y);
  if (terminalCellCarriesStyle(current)) return effectiveTerminalPredictionCellStyle(current);

  const previous = cursor.x > 0
    ? cellAt(cursor.x - 1, cursor.y)
    : cursor.y > 0 && isRowWrapped(cursor.y - 1)
      ? cellAt(cols - 1, cursor.y - 1)
      : undefined;
  return effectiveTerminalPredictionCellStyle(
    terminalCellCarriesStyle(previous) ? previous : current,
  );
};

const terminalCellHasVisibleContent = (cell: GhosttyCell | undefined): boolean => Boolean(
  cell
  && (
    (cell.codepoint !== 0 && cell.codepoint !== 32 && !(cell.flags & CellFlags.INVISIBLE))
    || (cell.flags & (CellFlags.UNDERLINE | CellFlags.STRIKETHROUGH))
  )
);

export const terminalPredictionCellPaint = (
  style: TerminalPredictionCellStyle,
  underlyingCell: GhosttyCell | undefined,
  text: string,
  coversAuthoritativeCursor = false,
): TerminalPredictionCellStyle => {
  const underlyingStyle = effectiveTerminalPredictionCellStyle(underlyingCell);
  const needsConcreteBackground = coversAuthoritativeCursor
    || Boolean(text) && (
      !underlyingCell
      || terminalCellHasVisibleContent(underlyingCell)
      || underlyingStyle.background !== style.background
    );
  return {
    foreground: style.foreground,
    background: needsConcreteBackground ? style.background : "transparent",
    flags: style.flags,
  };
};

// Single-cell printable codepoints whose terminal width is unambiguously one
// column: ASCII plus the Latin, Greek, and Cyrillic letter blocks without
// their combining-mark ranges. Wide, zero-width, and astral input still goes
// through the authoritative echo only.
const NARROW_PRINTABLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x20, 0x7e],
  [0xa1, 0xac],
  [0xae, 0x2ff],
  [0x370, 0x377],
  [0x37a, 0x37f],
  [0x384, 0x3ff],
  [0x400, 0x482],
  [0x48a, 0x52f],
];

export const isPredictableTerminalCodepoint = (codepoint: number): boolean =>
  NARROW_PRINTABLE_RANGES.some(([start, end]) => codepoint >= start && codepoint <= end);

export const predictedTerminalInput = (sequence: number, data: string): PredictedTerminalInput | null => {
  if (data === "\b" || data === "\x7f") return { sequence, kind: "backspace", text: "" };
  const codepoint = data.codePointAt(0);
  if (
    codepoint !== undefined
    && String.fromCodePoint(codepoint) === data
    && isPredictableTerminalCodepoint(codepoint)
  ) {
    return { sequence, kind: "insert", text: data };
  }
  return null;
};

export const terminalPredictionCursorMatches = (
  cursor: TerminalPredictionCursor | null | undefined,
  anchor: Pick<TerminalPredictionCursor, "x" | "y"> | null | undefined,
  requireVisible = true,
): boolean => Boolean(
  cursor
  && (cursor.visible || !requireVisible)
  && anchor
  && cursor.x === anchor.x
  && cursor.y === anchor.y
);

export const layoutPredictedTerminalInput = (
  cursor: TerminalPredictionCursor,
  cols: number,
  rows: number,
  predictions: readonly PredictedTerminalInput[],
): PredictedTerminalLayout | null => {
  if (!cursor.visible || cols < 2 || rows < 1 || predictions.length === 0) return null;
  let col = cursor.x;
  let row = cursor.y;
  if (col < 0 || col >= cols || row < 0 || row >= rows) return null;
  const cells = new Map<string, PredictedTerminalCell>();

  for (const prediction of predictions) {
    if (prediction.kind === "backspace") {
      // Crossing a wrapped row is ambiguous without reading the terminal's
      // wide-cell/wrap metadata, so fail closed at the left edge.
      if (col === 0) return null;
      col -= 1;
      cells.set(`${row}:${col}`, { col, row, text: "" });
      continue;
    }

    cells.set(`${row}:${col}`, { col, row, text: prediction.text });
    col += 1;
    if (col < cols) continue;
    col = 0;
    row += 1;
    if (row >= rows) return null;
  }

  return {
    cells: [...cells.values()],
    cursor: { col, row },
    authoritativeCursor: { col: cursor.x, row: cursor.y },
  };
};

export const createTerminalPredictionEchoProbe = (
  prediction: PredictedTerminalInput,
  cursor: { x: number; y: number; visible?: boolean },
  cols: number,
  rows: number,
  screen: TerminalPredictionScreen,
  previousCodepoint: number | undefined,
): TerminalPredictionEchoProbe | null => {
  if (
    prediction.kind !== "insert"
    || !cursor.visible
    || previousCodepoint === undefined
    || cursor.x < 0
    || cursor.x >= cols - 1
    || cursor.y < 0
    || cursor.y >= rows
  ) return null;
  return {
    screen,
    origin: { x: cursor.x, y: cursor.y, visible: true },
    previousCodepoint,
    inputs: [prediction],
  };
};

export const extendTerminalPredictionEchoProbe = (
  probe: TerminalPredictionEchoProbe,
  prediction: PredictedTerminalInput,
  cols: number,
  rows: number,
): TerminalPredictionEchoProbe | null => {
  if (
    probe.inputs.length >= MAX_ECHO_PROBE_INPUTS
    || prediction.sequence <= probe.inputs[probe.inputs.length - 1]!.sequence
  ) return null;
  const inputs = [...probe.inputs, prediction];
  if (!layoutPredictedTerminalInput(probe.origin, cols, rows, inputs)) return null;
  return { ...probe, inputs };
};

const predictedCellMatches = (
  cell: PredictedTerminalCell,
  readCodepoint: (col: number, row: number) => number | undefined,
): boolean => {
  const codepoint = readCodepoint(cell.col, cell.row);
  return cell.text
    ? codepoint === cell.text.codePointAt(0)
    : codepoint === 0 || codepoint === 32;
};

export const terminalPredictionEchoProbeMatches = (
  probe: TerminalPredictionEchoProbe,
  acknowledgedSequence: number | undefined,
  cursor: { x: number; y: number; visible?: boolean },
  cols: number,
  rows: number,
  screen: TerminalPredictionScreen,
  readCodepoint: (col: number, row: number) => number | undefined,
): boolean => {
  if (acknowledgedSequence === undefined || screen !== probe.screen) return false;
  const acknowledgedInputs = probe.inputs.filter((input) => input.sequence <= acknowledgedSequence);
  const layout = layoutPredictedTerminalInput(probe.origin, cols, rows, acknowledgedInputs);
  if (!layout || cursor.x !== layout.cursor.col || cursor.y !== layout.cursor.row) return false;

  const originCell = layout.cells.find((cell) => cell.col === probe.origin.x && cell.row === probe.origin.y);
  if (!originCell?.text) return false;
  const expectedOriginCodepoint = originCell.text.codePointAt(0);
  if (
    expectedOriginCodepoint === undefined
    || probe.previousCodepoint === expectedOriginCodepoint
    || readCodepoint(originCell.col, originCell.row) !== expectedOriginCodepoint
  ) return false;

  return layout.cells.every((cell) => predictedCellMatches(cell, readCodepoint));
};

export interface TerminalPredictionSettlement {
  // Leading predictions the terminal now reflects; the rest stay pending.
  confirmed: number;
  anchor: { x: number; y: number };
}

// Output is tagged with the newest input the server had forwarded when it
// sent the chunk, so an acknowledgement is only an upper bound: the chunk may
// carry an earlier keystroke's echo, or none at all. Confirm the longest
// acknowledged prefix the terminal actually shows and keep the remainder
// pending; report divergence only when no prefix explains the cursor.
export const settlePredictedTerminalInput = (
  anchor: { x: number; y: number },
  cols: number,
  rows: number,
  predictions: readonly PredictedTerminalInput[],
  acknowledgedSequence: number,
  cursor: { x: number; y: number },
  readCodepoint: (col: number, row: number) => number | undefined,
): TerminalPredictionSettlement | null => {
  let acknowledgedCount = 0;
  while (
    acknowledgedCount < predictions.length
    && predictions[acknowledgedCount]!.sequence <= acknowledgedSequence
  ) acknowledgedCount += 1;

  for (let count = acknowledgedCount; count >= 0; count -= 1) {
    if (count === 0) {
      return cursor.x === anchor.x && cursor.y === anchor.y
        ? { confirmed: 0, anchor }
        : null;
    }
    const layout = layoutPredictedTerminalInput(
      { ...anchor, visible: true },
      cols,
      rows,
      predictions.slice(0, count),
    );
    if (!layout || layout.cursor.col !== cursor.x || layout.cursor.row !== cursor.y) continue;
    if (!layout.cells.every((cell) => predictedCellMatches(cell, readCodepoint))) continue;
    return { confirmed: count, anchor: { x: layout.cursor.col, y: layout.cursor.row } };
  }
  return null;
};
