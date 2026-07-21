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

export interface TerminalPredictionStyledCell {
  fg_r: number;
  fg_g: number;
  fg_b: number;
  bg_r: number;
  bg_g: number;
  bg_b: number;
  fgIsDefault: boolean;
  bgIsDefault: boolean;
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
const INVERSE_CELL_FLAG = 1 << 4;

export const terminalPredictionCellBackground = (
  cell: TerminalPredictionStyledCell | null | undefined,
): string => {
  if (!cell) return "var(--terminal-background)";
  const inverse = (cell.flags & INVERSE_CELL_FLAG) !== 0;
  if (inverse) {
    return cell.fgIsDefault
      ? "var(--terminal-foreground)"
      : `rgb(${cell.fg_r}, ${cell.fg_g}, ${cell.fg_b})`;
  }
  return cell.bgIsDefault
    ? "var(--terminal-background)"
    : `rgb(${cell.bg_r}, ${cell.bg_g}, ${cell.bg_b})`;
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
