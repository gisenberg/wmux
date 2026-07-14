export interface RectPoint {
  col: number;
  row: number;
}

export interface RectRange {
  start: RectPoint;
  end: RectPoint;
}

export interface RectCell {
  codepoint: number;
  width: number;
  text?: string;
}

interface RectTerminal {
  cols: number;
  rows: number;
  element?: HTMLElement;
  renderer?: {
    getCanvas(): HTMLCanvasElement;
    getMetrics(): { width: number; height: number };
  };
  wasmTerm?: {
    getLine(row: number): Array<{ codepoint: number; width: number }> | null;
    getScrollbackLine(row: number): Array<{ codepoint: number; width: number }> | null;
    getGraphemeString(row: number, col: number): string;
    getScrollbackGraphemeString(row: number, col: number): string;
  };
  getViewportY(): number;
  getScrollbackLength(): number;
  scrollLines(lines: number): void;
  clearSelection(): void;
}

const DRAG_THRESHOLD_PX = 4;
const AUTO_SCROLL_INTERVAL_MS = 50;

export const normalizeRect = (range: RectRange): RectRange => ({
  start: {
    col: Math.min(range.start.col, range.end.col),
    row: Math.min(range.start.row, range.end.row),
  },
  end: {
    col: Math.max(range.start.col, range.end.col),
    row: Math.max(range.start.row, range.end.row),
  },
});

export const viewportAbsoluteTop = (scrollbackLength: number, viewportY: number): number =>
  scrollbackLength - Math.floor(viewportY);

export const clipRectToViewport = (
  range: RectRange,
  scrollbackLength: number,
  viewportY: number,
  rows: number,
): RectRange | undefined => {
  const normalized = normalizeRect(range);
  const absoluteTop = viewportAbsoluteTop(scrollbackLength, viewportY);
  const startRow = Math.max(normalized.start.row, absoluteTop);
  const endRow = Math.min(normalized.end.row, absoluteTop + rows - 1);
  if (startRow > endRow) return undefined;

  return {
    start: { col: normalized.start.col, row: startRow - absoluteTop },
    end: { col: normalized.end.col, row: endRow - absoluteTop },
  };
};

// A wide glyph belongs to its leading cell. Selecting only its continuation
// does not copy a partial glyph, while selecting its lead copies it whole.
export const extractRectangularText = (
  range: RectRange,
  lineAt: (row: number) => RectCell[] | null,
): string => {
  const normalized = normalizeRect(range);
  const rows: string[] = [];

  for (let row = normalized.start.row; row <= normalized.end.row; row += 1) {
    const line = lineAt(row) ?? [];
    let text = "";

    for (let col = normalized.start.col; col <= normalized.end.col; col += 1) {
      const cell = line[col];
      if (!cell || cell.width === 0) continue;
      text += cell.text ?? (cell.codepoint ? String.fromCodePoint(cell.codepoint) : " ");
    }

    rows.push(text.replace(/\s+$/u, ""));
  }

  return rows.join("\n");
};

export class RectangularSelection {
  private range?: RectRange;
  private dragging = false;
  private thresholdMet = false;
  private origin?: { x: number; y: number; point: RectPoint };
  private scrollTimer?: ReturnType<typeof setInterval>;
  private scrollDirection = 0;
  private scrollEvent?: MouseEvent;
  private readonly ownerDocument: Document;

  constructor(
    private readonly term: RectTerminal,
    private readonly changed: () => void,
    private readonly completed: (text: string) => void,
  ) {
    this.ownerDocument = term.element?.ownerDocument ?? document;
    term.element?.addEventListener("mousedown", this.down, true);
  }

  get text(): string {
    return this.range && this.thresholdMet ? extractRectangularText(this.range, this.lineAt) : "";
  }

  get overlay(): RectRange | undefined {
    return this.range && this.thresholdMet ? normalizeRect(this.range) : undefined;
  }

  get visibleOverlay(): RectRange | undefined {
    if (!this.range || !this.thresholdMet) return undefined;
    return clipRectToViewport(
      this.range,
      this.term.getScrollbackLength(),
      this.term.getViewportY(),
      this.term.rows,
    );
  }

  clear = (): void => {
    const changed = this.range !== undefined || this.dragging;
    this.stopDrag();
    this.range = undefined;
    this.thresholdMet = false;
    this.origin = undefined;
    if (changed) this.changed();
  };

  dispose = (): void => {
    this.clear();
    this.term.element?.removeEventListener("mousedown", this.down, true);
  };

  private point = (event: MouseEvent): RectPoint | undefined => {
    const canvas = this.term.renderer?.getCanvas();
    const metrics = this.term.renderer?.getMetrics();
    if (!canvas || !metrics || metrics.width <= 0 || metrics.height <= 0) return undefined;

    const rect = canvas.getBoundingClientRect();
    const col = clamp(Math.floor((event.clientX - rect.left) / metrics.width), 0, this.term.cols - 1);
    const viewportRow = clamp(Math.floor((event.clientY - rect.top) / metrics.height), 0, this.term.rows - 1);
    return {
      col,
      row: viewportAbsoluteTop(this.term.getScrollbackLength(), this.term.getViewportY()) + viewportRow,
    };
  };

  private down = (event: MouseEvent): void => {
    if (event.button !== 0 || !event.altKey) return;
    const point = this.point(event);
    if (!point) return;

    this.stopDrag();
    this.term.clearSelection();
    this.origin = { x: event.clientX, y: event.clientY, point };
    this.range = { start: point, end: point };
    this.dragging = true;
    this.thresholdMet = false;
    this.ownerDocument.addEventListener("mousemove", this.move, true);
    this.ownerDocument.addEventListener("mouseup", this.up, true);
    event.preventDefault();
    event.stopImmediatePropagation();
    this.changed();
  };

  private move = (event: MouseEvent): void => {
    if (!this.dragging || !this.origin) return;
    const point = this.point(event);
    if (!point) return;

    this.thresholdMet ||= Math.hypot(event.clientX - this.origin.x, event.clientY - this.origin.y) > DRAG_THRESHOLD_PX;
    this.range = { start: this.origin.point, end: point };
    this.autoScroll(event);
    event.preventDefault();
    event.stopImmediatePropagation();
    this.changed();
  };

  private up = (event: MouseEvent): void => {
    if (!this.dragging) return;
    const completed = this.thresholdMet;
    this.stopDrag();
    event.preventDefault();
    event.stopImmediatePropagation();
    this.changed();

    if (completed) this.completed(this.text);
    else this.clear();
  };

  private autoScroll(event: MouseEvent): void {
    const canvas = this.term.renderer?.getCanvas();
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const direction = event.clientY < rect.top ? -1 : event.clientY > rect.bottom ? 1 : 0;
    if (!direction) {
      this.stopScroll();
      return;
    }
    const directionChanged = this.scrollDirection !== direction;
    this.scrollDirection = direction;
    this.scrollEvent = event;
    if (this.scrollTimer !== undefined) {
      if (directionChanged) this.scrollEndpoint();
      return;
    }

    this.scrollEndpoint();
    this.scrollTimer = globalThis.setInterval(
      () => this.scrollEndpoint(),
      AUTO_SCROLL_INTERVAL_MS,
    );
  }

  private scrollEndpoint(): void {
    if (!this.scrollEvent || !this.scrollDirection) return;
    this.term.scrollLines(this.scrollDirection);
    const point = this.point(this.scrollEvent);
    if (!this.range || !point) return;
    this.range.end = point;
    this.changed();
  }

  private stopDrag(): void {
    this.dragging = false;
    this.stopScroll();
    this.ownerDocument.removeEventListener("mousemove", this.move, true);
    this.ownerDocument.removeEventListener("mouseup", this.up, true);
  }

  private stopScroll(): void {
    if (this.scrollTimer !== undefined) globalThis.clearInterval(this.scrollTimer);
    this.scrollTimer = undefined;
    this.scrollDirection = 0;
    this.scrollEvent = undefined;
  }

  private lineAt = (absoluteRow: number): RectCell[] | null => {
    const wasm = this.term.wasmTerm;
    if (!wasm) return null;
    const scrollbackLength = this.term.getScrollbackLength();
    const fromScrollback = absoluteRow < scrollbackLength;
    const sourceRow = fromScrollback ? absoluteRow : absoluteRow - scrollbackLength;
    const source = fromScrollback ? wasm.getScrollbackLine(sourceRow) : wasm.getLine(sourceRow);
    if (!source) return null;

    return source.map((cell, col) => ({
      codepoint: cell.codepoint,
      width: cell.width,
      ...(cell.codepoint
        ? {
            text: fromScrollback
              ? wasm.getScrollbackGraphemeString(sourceRow, col)
              : wasm.getGraphemeString(sourceRow, col),
          }
        : {}),
    }));
  };
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);
