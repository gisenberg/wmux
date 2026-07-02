import { CanvasPainter } from "opentui-browser/canvas-painter";
import type { CanvasPainterOptions } from "opentui-browser/canvas-painter";
import type { CellGrid } from "opentui-browser/cell-grid";

export type { CellGrid };

export type RGBA = readonly [number, number, number, number];

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

export const createOpenTuiPainter = (
  canvas: HTMLCanvasElement,
  opts: CanvasPainterOptions = {},
): CanvasPainter => new CanvasPainter(canvas, { clearColor: "#050505", ...opts });

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
  painter: CanvasPainter,
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
