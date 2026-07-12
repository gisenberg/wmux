export type RGBA = readonly [number, number, number, number];

export interface CellGrid {
  width: number;
  height: number;
  chars: Uint32Array;
  fg: Float32Array;
  bg: Float32Array;
  attrs: Uint32Array;
}

export interface GridPainterOptions {
  fontSize?: number;
  fontFamily?: string;
  cellVAlign?: "top" | "middle" | "bottom";
  clearColor?: string;
}

export interface CellMetrics {
  width: number;
  height: number;
  cols: number;
  rows: number;
}

export interface CanvasViewport {
  cssW: number;
  cssH: number;
  deviceW: number;
  deviceH: number;
}

export const ATTR_BOLD = 1 << 0;
export const ATTR_ITALIC = 1 << 2;
export const ATTR_UNDERLINE = 1 << 3;
export const ATTR_VALIGN_MIDDLE = 1 << 4;
export const ATTR_VALIGN_BOTTOM = 2 << 4;

const rgbaCss = (buffer: Float32Array, offset: number): string => {
  const red = Math.round(Math.max(0, Math.min(1, buffer[offset] ?? 0)) * 255);
  const green = Math.round(Math.max(0, Math.min(1, buffer[offset + 1] ?? 0)) * 255);
  const blue = Math.round(Math.max(0, Math.min(1, buffer[offset + 2] ?? 0)) * 255);
  const alpha = Math.max(0, Math.min(1, buffer[offset + 3] ?? 1));
  return alpha === 1 ? `rgb(${red} ${green} ${blue})` : `rgb(${red} ${green} ${blue} / ${alpha})`;
};

const canvasFont = (fontSize: number, fontFamily: string, attrs: number): string => {
  const style = attrs & ATTR_ITALIC ? "italic " : "";
  const weight = attrs & ATTR_BOLD ? "700 " : "400 ";
  return `${style}${weight}${fontSize}px ${fontFamily}`;
};

const configureCanvasText = (context: CanvasRenderingContext2D): void => {
  context.textBaseline = "top";
  const extended = context as CanvasRenderingContext2D & {
    fontKerning?: CanvasFontKerning;
    fontVariantLigatures?: string;
    fontFeatureSettings?: string;
  };
  extended.fontKerning = "normal";
  extended.fontVariantLigatures = "common-ligatures contextual";
  extended.fontFeatureSettings = '"calt" 1, "liga" 1';
};

/** A small wmux-owned renderer for the cell grids used by the surrounding chrome. */
export class GridPainter {
  readonly canvas: HTMLCanvasElement;
  readonly cellWidth: number;
  readonly cellHeight: number;

  private readonly context: CanvasRenderingContext2D;
  private readonly fontSize: number;
  private readonly fontFamily: string;
  private readonly defaultVAlign: 0 | 1 | 2;
  private readonly clearColor: string;
  private cssWidth = 1;
  private cssHeight = 1;
  private viewportConfigured = false;
  private cols = 1;
  private rows = 1;

  constructor(canvas: HTMLCanvasElement, options: GridPainterOptions = {}) {
    this.canvas = canvas;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas 2D rendering is unavailable");
    this.context = context;
    this.fontSize = options.fontSize ?? 13;
    this.fontFamily = options.fontFamily ?? "ui-monospace, SFMono-Regular, Menlo, monospace";
    this.defaultVAlign = options.cellVAlign === "middle" ? 1 : options.cellVAlign === "bottom" ? 2 : 0;
    this.clearColor = options.clearColor ?? "#000000";

    context.font = canvasFont(this.fontSize, this.fontFamily, 0);
    configureCanvasText(context);
    this.cellWidth = Math.max(1, Math.round(context.measureText("M").width));
    this.cellHeight = Math.max(1, Math.round(this.fontSize * 1.2));
  }

  fit(width: number, height: number): { cols: number; rows: number } {
    return {
      cols: Math.max(1, Math.floor(width / this.cellWidth)),
      rows: Math.max(1, Math.floor(height / this.cellHeight)),
    };
  }

  resize(cols: number, rows: number): void {
    this.cols = Math.max(1, Math.floor(cols));
    this.rows = Math.max(1, Math.floor(rows));
    if (this.viewportConfigured) return;

    const deviceScale = window.devicePixelRatio || 1;
    this.cssWidth = this.cols * this.cellWidth;
    this.cssHeight = this.rows * this.cellHeight;
    this.canvas.width = Math.max(1, Math.round(this.cssWidth * deviceScale));
    this.canvas.height = Math.max(1, Math.round(this.cssHeight * deviceScale));
    this.canvas.style.width = `${this.cssWidth}px`;
    this.canvas.style.height = `${this.cssHeight}px`;
    this.configureContext();
  }

  setViewport(deviceWidth: number, deviceHeight: number, cssWidth: number, cssHeight: number): void {
    this.viewportConfigured = true;
    this.cssWidth = Math.max(1, cssWidth);
    this.cssHeight = Math.max(1, cssHeight);
    const nextDeviceWidth = Math.max(1, Math.round(deviceWidth));
    const nextDeviceHeight = Math.max(1, Math.round(deviceHeight));
    if (this.canvas.width !== nextDeviceWidth) this.canvas.width = nextDeviceWidth;
    if (this.canvas.height !== nextDeviceHeight) this.canvas.height = nextDeviceHeight;
    this.configureContext();
  }

  paint(grid: CellGrid): void {
    if (grid.width !== this.cols || grid.height !== this.rows) this.resize(grid.width, grid.height);

    const context = this.context;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = this.clearColor;
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    context.restore();

    for (let row = 0; row < grid.height; row += 1) {
      const top = row * this.cellHeight;
      const height = row === grid.height - 1 ? Math.max(this.cellHeight, this.cssHeight - top) : this.cellHeight;
      for (let col = 0; col < grid.width; col += 1) {
        const cell = row * grid.width + col;
        const left = col * this.cellWidth;
        const width = col === grid.width - 1 ? Math.max(this.cellWidth, this.cssWidth - left) : this.cellWidth;
        context.fillStyle = rgbaCss(grid.bg, cell * 4);
        context.fillRect(left, top, width, height);
      }
    }

    let activeFont = "";
    for (let row = 0; row < grid.height; row += 1) {
      const top = row * this.cellHeight;
      for (let col = 0; col < grid.width; col += 1) {
        const cell = row * grid.width + col;
        const codePoint = grid.chars[cell] ?? 0x20;
        if (codePoint === 0 || codePoint === 0x20 || codePoint > 0x10ffff) continue;

        const attrs = grid.attrs[cell] ?? 0;
        const nextFont = canvasFont(this.fontSize, this.fontFamily, attrs);
        if (nextFont !== activeFont) {
          context.font = nextFont;
          configureCanvasText(context);
          activeFont = nextFont;
        }
        context.fillStyle = rgbaCss(grid.fg, cell * 4);
        const encodedVAlign = (attrs >> 4) & 0b11;
        const vAlign = encodedVAlign === 1 || encodedVAlign === 2 ? encodedVAlign : this.defaultVAlign;
        const verticalOffset = vAlign === 1
          ? Math.round((this.cellHeight - this.fontSize) / 2)
          : vAlign === 2
            ? this.cellHeight - this.fontSize
            : 0;
        const left = col * this.cellWidth;
        context.fillText(String.fromCodePoint(codePoint), left, top + verticalOffset);
        if (attrs & ATTR_UNDERLINE) {
          const underline = Math.min(top + this.cellHeight - 1, top + verticalOffset + this.fontSize - 1);
          context.fillRect(left, underline, this.cellWidth, 1);
        }
      }
    }
  }

  dispose(): void {
    // Canvas 2D owns no external resources.
  }

  private configureContext(): void {
    this.context.setTransform(
      this.canvas.width / this.cssWidth,
      0,
      0,
      this.canvas.height / this.cssHeight,
      0,
      0,
    );
    this.context.font = canvasFont(this.fontSize, this.fontFamily, 0);
    configureCanvasText(this.context);
  }
}

export const createGridPainter = (
  canvas: HTMLCanvasElement,
  opts: GridPainterOptions = {},
): GridPainter => new GridPainter(canvas, { clearColor: "#050505", ...opts });

export const measureCanvasViewport = (
  canvas: HTMLCanvasElement,
  entry?: ResizeObserverEntry,
): CanvasViewport => {
  const contentBox = entry?.contentBoxSize?.[0];
  const rect = contentBox ? undefined : canvas.getBoundingClientRect();
  const cssW = Math.max(1, contentBox?.inlineSize ?? rect?.width ?? 1);
  const cssH = Math.max(1, contentBox?.blockSize ?? rect?.height ?? 1);
  const deviceBox = entry?.devicePixelContentBoxSize?.[0];
  const dpr = window.devicePixelRatio || 1;
  return {
    cssW,
    cssH,
    deviceW: Math.max(deviceBox?.inlineSize ?? 0, Math.round(cssW * dpr), 1),
    deviceH: Math.max(deviceBox?.blockSize ?? 0, Math.round(cssH * dpr), 1),
  };
};

export const syncPainterViewport = (
  painter: GridPainter,
  canvas: HTMLCanvasElement,
  entry?: ResizeObserverEntry,
): CellMetrics => {
  const viewport = measureCanvasViewport(canvas, entry);
  painter.setViewport(viewport.deviceW, viewport.deviceH, viewport.cssW, viewport.cssH);
  const { cols, rows } = painter.fit(viewport.cssW, viewport.cssH);
  painter.resize(cols, rows);
  return { width: painter.cellWidth, height: painter.cellHeight, cols, rows };
};

export const observeCanvasViewport = (
  canvas: HTMLCanvasElement,
  onResize: (entry?: ResizeObserverEntry) => void,
): ResizeObserver => {
  const observer = new ResizeObserver((entries) => onResize(entries[0]));
  try {
    observer.observe(canvas, { box: "device-pixel-content-box" });
  } catch {
    observer.observe(canvas);
  }
  return observer;
};

export const createGrid = (
  width: number,
  height: number,
  background: RGBA,
  foreground: RGBA,
): CellGrid => {
  const cells = Math.max(1, width * height);
  const chars = new Uint32Array(cells);
  const fg = new Float32Array(cells * 4);
  const bg = new Float32Array(cells * 4);
  const attrs = new Uint32Array(cells);
  for (let index = 0; index < cells; index += 1) {
    chars[index] = 0x20;
    setRgba(fg, index, foreground);
    setRgba(bg, index, background);
  }
  return { width, height, chars, fg, bg, attrs };
};

export const writeText = (
  grid: CellGrid,
  row: number,
  col: number,
  text: string,
  color: RGBA,
  attributes = ATTR_BOLD,
) => {
  if (row < 0 || row >= grid.height || col >= grid.width) return;
  let x = Math.max(0, col);
  for (const char of text) {
    if (x >= grid.width) break;
    const codePoint = char.codePointAt(0) ?? 0x20;
    const index = row * grid.width + x;
    grid.chars[index] = codePoint;
    grid.attrs[index] = attributes;
    setRgba(grid.fg, index, color);
    x += 1;
  }
};

export const fillCells = (
  grid: CellGrid,
  row: number,
  col: number,
  width: number,
  color: RGBA,
) => {
  if (row < 0 || row >= grid.height || width <= 0) return;
  const start = Math.max(0, col);
  const end = Math.min(grid.width, start + width);
  for (let nextCol = start; nextCol < end; nextCol += 1) {
    setCellBackground(grid, row, nextCol, color);
  }
};

export const setCellBackground = (grid: CellGrid, row: number, col: number, color: RGBA) => {
  if (row < 0 || row >= grid.height || col < 0 || col >= grid.width) return;
  setRgba(grid.bg, row * grid.width + col, color);
};

export const setRgba = (buffer: Float32Array, index: number, color: RGBA) => {
  const offset = index * 4;
  buffer[offset] = color[0];
  buffer[offset + 1] = color[1];
  buffer[offset + 2] = color[2];
  buffer[offset + 3] = color[3];
};

export const fitText = (text: string, maxCells: number): string => {
  if (maxCells <= 0) return "";
  if (text.length <= maxCells) return text;
  if (maxCells <= 3) return text.slice(0, maxCells);
  return `${text.slice(0, maxCells - 3)}...`;
};

export function hexToRgba(hex: string): RGBA {
  const value = hex.replace("#", "");
  const parsed = Number.parseInt(value, 16);
  return [
    ((parsed >> 16) & 255) / 255,
    ((parsed >> 8) & 255) / 255,
    (parsed & 255) / 255,
    1,
  ];
}
