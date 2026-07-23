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

export const predictedTerminalInput = (sequence: number, data: string): PredictedTerminalInput | null => {
  if (data === "\b" || data === "\x7f") return { sequence, kind: "backspace", text: "" };
  if (data.length === 1 && data >= " " && data <= "~") {
    return { sequence, kind: "insert", text: data };
  }
  return null;
};

export const layoutPredictedTerminalInput = (
  cursor: { x: number; y: number; visible?: boolean },
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

export const terminalPredictionEchoProbeMatches = (
  probe: TerminalPredictionEchoProbe,
  acknowledgedSequence: number | undefined,
  cursor: { x: number; y: number; visible?: boolean },
  cols: number,
  rows: number,
  screen: TerminalPredictionScreen,
  readCodepoint: (col: number, row: number) => number | undefined,
): boolean => {
  if (acknowledgedSequence === undefined || screen !== probe.screen || !cursor.visible) return false;
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

  return layout.cells.every((cell) => {
    const codepoint = readCodepoint(cell.col, cell.row);
    return cell.text
      ? codepoint === cell.text.codePointAt(0)
      : codepoint === 0 || codepoint === 32;
  });
};
