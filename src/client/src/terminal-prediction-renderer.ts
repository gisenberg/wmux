import { CellFlags, type FontMetrics, type GhosttyCell, type ITheme } from "ghostty-web";
import {
  effectiveTerminalPredictionCellStyle,
  type PredictedTerminalLayout,
  type TerminalPredictionCellStyle,
} from "./terminal-input-prediction";

export interface TerminalPredictionPaint {
  metrics: FontMetrics;
  devicePixelRatio: number;
  cols: number;
  rows: number;
  fontSize: number;
  fontFamily: string;
  theme: ITheme;
  layout: PredictedTerminalLayout;
  style: TerminalPredictionCellStyle;
  cellAt: (col: number, row: number) => GhosttyCell | undefined;
  cellPaint: (
    style: TerminalPredictionCellStyle,
    underlyingCell: GhosttyCell | undefined,
    text: string,
    coversAuthoritativeCursor?: boolean,
  ) => TerminalPredictionCellStyle;
  cursorStyle: "block" | "underline" | "bar";
  authoritativeCanvas: HTMLCanvasElement;
}

const quotedFontFamily = (fontFamily: string): string => fontFamily
  .split(",")
  .map((family) => {
    const trimmed = family.trim();
    if (trimmed.startsWith("\"") || trimmed.startsWith("'") || !trimmed.includes(" ")) return trimmed;
    return `"${trimmed}"`;
  })
  .join(", ");

export const ghosttyCanvasFont = (
  fontSize: number,
  fontFamily: string,
  flags = 0,
): string => {
  const style = flags & CellFlags.ITALIC ? "italic " : "";
  const weight = flags & CellFlags.BOLD ? "bold " : "";
  return `${style}${weight}${fontSize}px ${quotedFontFamily(fontFamily)}`;
};

const themeColor = (
  color: string,
  theme: ITheme,
): string => {
  if (color === "var(--terminal-foreground)") return theme.foreground ?? "#d4d4d4";
  if (color === "var(--terminal-background)") return theme.background ?? "#1e1e1e";
  return color;
};

const drawTextAndDecorations = (
  context: CanvasRenderingContext2D,
  text: string,
  col: number,
  row: number,
  style: TerminalPredictionCellStyle,
  metrics: FontMetrics,
  fontSize: number,
  fontFamily: string,
  theme: ITheme,
  foregroundOverride?: string,
): void => {
  if (!text || style.flags & CellFlags.INVISIBLE) return;
  const cellX = col * metrics.width;
  const cellY = row * metrics.height;
  const foreground = foregroundOverride ?? themeColor(style.foreground, theme);
  context.font = ghosttyCanvasFont(fontSize, fontFamily, style.flags);
  context.fillStyle = foreground;
  if (style.flags & CellFlags.FAINT) context.globalAlpha = 0.5;
  context.fillText(text, cellX, cellY + metrics.baseline);
  if (style.flags & CellFlags.FAINT) context.globalAlpha = 1;

  if (style.flags & CellFlags.UNDERLINE) {
    const underlineY = cellY + metrics.baseline + 2;
    context.strokeStyle = foreground;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(cellX, underlineY);
    context.lineTo(cellX + metrics.width, underlineY);
    context.stroke();
  }
  if (style.flags & CellFlags.STRIKETHROUGH) {
    const strikeY = cellY + metrics.height / 2;
    context.strokeStyle = foreground;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(cellX, strikeY);
    context.lineTo(cellX + metrics.width, strikeY);
    context.stroke();
  }
};

const authoritativeCellText = (cell: GhosttyCell | undefined): string => {
  if (!cell || cell.flags & CellFlags.INVISIBLE || cell.codepoint <= 0 || cell.codepoint > 0x10ffff) return "";
  return String.fromCodePoint(cell.codepoint);
};

export class TerminalPredictionRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private active = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("Failed to create terminal prediction canvas");
    this.context = context;
  }

  clear(): void {
    if (this.canvas.width > 0 && this.canvas.height > 0) {
      this.context.save();
      this.context.setTransform(1, 0, 0, 1, 0, 0);
      this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.context.restore();
    }
    this.active = false;
    delete this.canvas.dataset.active;
    delete this.canvas.dataset.predictionCells;
    delete this.canvas.dataset.predictionCursor;
    delete this.canvas.dataset.styleFlags;
  }

  paint(options: TerminalPredictionPaint): boolean {
    const {
      metrics,
      devicePixelRatio,
      cols,
      rows,
      authoritativeCanvas,
    } = options;
    if (
      metrics.width <= 0
      || metrics.height <= 0
      || metrics.baseline <= 0
      || devicePixelRatio <= 0
      || authoritativeCanvas.width <= 0
      || authoritativeCanvas.height <= 0
    ) {
      this.clear();
      return false;
    }

    if (this.canvas.width !== authoritativeCanvas.width) this.canvas.width = authoritativeCanvas.width;
    if (this.canvas.height !== authoritativeCanvas.height) this.canvas.height = authoritativeCanvas.height;
    this.canvas.style.width = authoritativeCanvas.style.width || `${cols * metrics.width}px`;
    this.canvas.style.height = authoritativeCanvas.style.height || `${rows * metrics.height}px`;
    this.context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    this.context.textBaseline = "alphabetic";
    this.context.textAlign = "left";
    this.context.clearRect(0, 0, cols * metrics.width, rows * metrics.height);

    const { layout, style, theme, cellAt, cellPaint } = options;
    const backgrounds = [
      {
        col: layout.authoritativeCursor.col,
        row: layout.authoritativeCursor.row,
        paint: cellPaint(
          style,
          cellAt(layout.authoritativeCursor.col, layout.authoritativeCursor.row),
          "",
          true,
        ),
      },
      ...layout.cells.map((cell) => ({
        col: cell.col,
        row: cell.row,
        paint: cellPaint(style, cellAt(cell.col, cell.row), cell.text),
      })),
    ];
    for (const background of backgrounds) {
      if (background.paint.background === "transparent") continue;
      this.context.fillStyle = themeColor(background.paint.background, theme);
      this.context.fillRect(
        background.col * metrics.width,
        background.row * metrics.height,
        metrics.width,
        metrics.height,
      );
    }

    for (const cell of layout.cells) {
      drawTextAndDecorations(
        this.context,
        cell.text,
        cell.col,
        cell.row,
        style,
        metrics,
        options.fontSize,
        options.fontFamily,
        theme,
      );
    }

    const cursorX = layout.cursor.col * metrics.width;
    const cursorY = layout.cursor.row * metrics.height;
    this.context.fillStyle = theme.cursor ?? theme.foreground ?? "#ffffff";
    if (options.cursorStyle === "block") {
      this.context.fillRect(cursorX, cursorY, metrics.width, metrics.height);
      const predictedCell = layout.cells.find((cell) =>
        cell.col === layout.cursor.col && cell.row === layout.cursor.row);
      const underlyingCell = cellAt(layout.cursor.col, layout.cursor.row);
      const cursorText = predictedCell ? predictedCell.text : authoritativeCellText(underlyingCell);
      const cursorTextStyle = predictedCell
        ? style
        : effectiveTerminalPredictionCellStyle(underlyingCell);
      this.context.save();
      this.context.beginPath();
      this.context.rect(cursorX, cursorY, metrics.width, metrics.height);
      this.context.clip();
      drawTextAndDecorations(
        this.context,
        cursorText,
        layout.cursor.col,
        layout.cursor.row,
        cursorTextStyle,
        metrics,
        options.fontSize,
        options.fontFamily,
        theme,
        theme.cursorAccent ?? theme.background ?? "#1e1e1e",
      );
      this.context.restore();
    } else if (options.cursorStyle === "underline") {
      const underlineHeight = Math.max(2, Math.floor(metrics.height * 0.15));
      this.context.fillRect(
        cursorX,
        cursorY + metrics.height - underlineHeight,
        metrics.width,
        underlineHeight,
      );
    } else {
      const barWidth = Math.max(2, Math.floor(metrics.width * 0.15));
      this.context.fillRect(cursorX, cursorY, barWidth, metrics.height);
    }

    this.active = true;
    this.canvas.dataset.active = "true";
    this.canvas.dataset.cellWidth = String(metrics.width);
    this.canvas.dataset.cellHeight = String(metrics.height);
    this.canvas.dataset.baseline = String(metrics.baseline);
    this.canvas.dataset.devicePixelRatio = String(devicePixelRatio);
    this.canvas.dataset.predictionCells = JSON.stringify(
      layout.cells.map(({ col, row }) => ({ col, row })),
    );
    this.canvas.dataset.predictionCursor = JSON.stringify(layout.cursor);
    this.canvas.dataset.styleFlags = String(style.flags);
    return true;
  }

  get isActive(): boolean {
    return this.active;
  }
}
