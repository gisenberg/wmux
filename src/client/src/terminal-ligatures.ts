import { CanvasRenderer, CellFlags } from "ghostty-web";
import { WMUX_FONT_FEATURE_SETTINGS } from "./fonts";

interface TerminalCell {
  codepoint: number;
  fg_r: number;
  fg_g: number;
  fg_b: number;
  bg_r: number;
  bg_g: number;
  bg_b: number;
  flags: number;
  width: number;
  hyperlink_id: number;
  grapheme_len: number;
}

interface RendererInternals {
  ctx: CanvasRenderingContext2D;
  metrics: { width: number; height: number; baseline: number };
  theme: {
    background: string;
    selectionForeground: string;
  };
  fontSize: number;
  fontFamily: string;
  renderCellBackground: (cell: TerminalCell, col: number, row: number) => void;
  renderCellText: (cell: TerminalCell, col: number, row: number) => void;
  isInSelection: (col: number, row: number) => boolean;
  rgbToCSS: (red: number, green: number, blue: number) => string;
}

const patched = Symbol.for("wmux.ghostty-web.ligature-render-line");
const allowedRunFlags = CellFlags.BOLD | CellFlags.ITALIC | CellFlags.INVERSE | CellFlags.FAINT;
const ligatureCandidatePattern = /[!#$%&*+\-./:<=>?@\\^|~]{2,}/;

export const enableTerminalLigatures = (): void => {
  const prototype = CanvasRenderer.prototype as unknown as { [patched]?: true; renderLine?: unknown };
  if (prototype[patched] || typeof prototype.renderLine !== "function") return;

  prototype.renderLine = function renderLineWithLigatures(
    this: RendererInternals,
    line: TerminalCell[],
    row: number,
    cols: number,
  ) {
    const y = row * this.metrics.height;
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, y, cols * this.metrics.width, this.metrics.height);

    for (let col = 0; col < line.length; col += 1) {
      const cell = line[col];
      if (cell?.width !== 0) this.renderCellBackground(cell, col, row);
    }

    let col = 0;
    while (col < line.length) {
      const run = collectLigatureRun(this, line, row, col);
      if (run) {
        renderLigatureRun(this, run, row);
        col = run.end;
        continue;
      }
      const cell = line[col];
      if (cell?.width !== 0) this.renderCellText(cell, col, row);
      col += 1;
    }
  };

  prototype[patched] = true;
};

interface LigatureRun {
  start: number;
  end: number;
  text: string;
  firstCell: TerminalCell;
  selected: boolean;
}

const collectLigatureRun = (
  renderer: RendererInternals,
  line: TerminalCell[],
  row: number,
  start: number,
): LigatureRun | null => {
  const firstCell = line[start];
  if (!isRunCell(firstCell)) return null;
  if (!isLigatureOperatorCodepoint(firstCell.codepoint || 32)) return null;
  const selected = renderer.isInSelection(start, row);
  const signature = cellSignature(firstCell, selected);
  let text = "";
  let end = start;

  while (end < line.length) {
    const cell = line[end];
    if (!isRunCell(cell)) break;
    if (!isLigatureOperatorCodepoint(cell.codepoint || 32)) break;
    if (renderer.isInSelection(end, row) !== selected) break;
    if (cellSignature(cell, selected) !== signature) break;
    text += String.fromCodePoint(cell.codepoint || 32);
    end += 1;
  }

  if (end - start < 2 || !ligatureCandidatePattern.test(text)) return null;
  return { start, end, text, firstCell, selected };
};

const renderLigatureRun = (renderer: RendererInternals, run: LigatureRun, row: number): void => {
  const ctx = renderer.ctx;
  const cell = run.firstCell;
  let fontStyle = "";
  if (cell.flags & CellFlags.ITALIC) fontStyle += "italic ";
  if (cell.flags & CellFlags.BOLD) fontStyle += "bold ";
  ctx.font = `${fontStyle}${renderer.fontSize}px ${renderer.fontFamily}`;
  configureCanvasLigatures(ctx);
  ctx.fillStyle = run.selected
    ? renderer.theme.selectionForeground
    : foregroundColor(renderer, cell);
  if (cell.flags & CellFlags.FAINT) ctx.globalAlpha = 0.5;
  ctx.fillText(run.text, run.start * renderer.metrics.width, row * renderer.metrics.height + renderer.metrics.baseline);
  if (cell.flags & CellFlags.FAINT) ctx.globalAlpha = 1;
};

const isRunCell = (cell: TerminalCell | undefined): cell is TerminalCell => {
  if (!cell || cell.width !== 1 || cell.grapheme_len > 0 || cell.hyperlink_id > 0) return false;
  if (cell.flags & ~allowedRunFlags) return false;
  const codepoint = cell.codepoint || 32;
  return codepoint >= 32 && codepoint <= 126;
};

const isLigatureOperatorCodepoint = (codepoint: number): boolean => {
  const char = String.fromCodePoint(codepoint);
  return /[!#$%&*+\-./:<=>?@\\^|~]/.test(char);
};

const cellSignature = (cell: TerminalCell, selected: boolean): string =>
  [
    selected ? 1 : 0,
    cell.flags & allowedRunFlags,
    cell.fg_r,
    cell.fg_g,
    cell.fg_b,
    cell.bg_r,
    cell.bg_g,
    cell.bg_b,
  ].join(":");

const foregroundColor = (renderer: RendererInternals, cell: TerminalCell): string => {
  if (cell.flags & CellFlags.INVERSE) return renderer.rgbToCSS(cell.bg_r, cell.bg_g, cell.bg_b);
  return renderer.rgbToCSS(cell.fg_r, cell.fg_g, cell.fg_b);
};

const configureCanvasLigatures = (ctx: CanvasRenderingContext2D): void => {
  const textContext = ctx as CanvasRenderingContext2D & {
    fontKerning?: string;
    fontVariantLigatures?: string;
    fontFeatureSettings?: string;
    letterSpacing?: string;
  };
  textContext.fontKerning = "normal";
  textContext.fontVariantLigatures = "common-ligatures contextual";
  textContext.fontFeatureSettings = WMUX_FONT_FEATURE_SETTINGS;
  textContext.letterSpacing = "0px";
};
