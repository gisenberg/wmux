import assert from "node:assert/strict";
import test from "node:test";
import {
  RectangularSelection,
  clipRectToViewport,
  extractRectangularText,
  normalizeRect,
  viewportAbsoluteTop,
} from "../src/client/src/terminal-rectangular-selection.ts";

interface FakeMouseEvent {
  button: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  clientX: number;
  clientY: number;
  defaultPrevented: boolean;
  immediatePropagationStopped: boolean;
  preventDefault(): void;
  stopImmediatePropagation(): void;
}

type FakeListener = (event: FakeMouseEvent) => void;

class FakeEventTarget {
  private readonly listeners = new Map<string, FakeListener[]>();

  addEventListener(type: string, listener: FakeListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: FakeListener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener));
  }

  dispatch(type: string, event: FakeMouseEvent): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
      if (event.immediatePropagationStopped) break;
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }
}

class FakeElement extends FakeEventTarget {
  constructor(readonly ownerDocument: FakeEventTarget) {
    super();
  }
}

interface FakeCell {
  codepoint: number;
  width: number;
}

class FakeTerminal {
  readonly document = new FakeEventTarget();
  readonly element = new FakeElement(this.document);
  readonly canvas = {
    getBoundingClientRect: () => ({ left: 100, top: 200, right: 140, bottom: 260 }),
  };
  readonly renderer = {
    getCanvas: () => this.canvas,
    getMetrics: () => ({ width: 10, height: 20 }),
  };
  readonly wasmTerm = {
    getLine: (row: number) => this.screenCells[row] ?? null,
    getScrollbackLine: (row: number) => this.scrollbackCells[row] ?? null,
    getGraphemeString: (row: number, col: number) => this.grapheme(this.screenCells[row]?.[col]),
    getScrollbackGraphemeString: (row: number, col: number) => this.grapheme(this.scrollbackCells[row]?.[col]),
  };
  readonly scrollCalls: number[] = [];
  clearSelectionCalls = 0;
  viewportY = 0;

  constructor(
    readonly cols = 4,
    readonly rows = 3,
    scrollback: string[] = ["old0", "old1"],
    screen: string[] = ["new0", "new1", "new2"],
  ) {
    this.scrollbackCells = scrollback.map((line) => cells(line, cols));
    this.screenCells = screen.map((line) => cells(line, cols));
  }

  private readonly scrollbackCells: FakeCell[][];
  private readonly screenCells: FakeCell[][];

  getViewportY(): number {
    return this.viewportY;
  }

  getScrollbackLength(): number {
    return this.scrollbackCells.length;
  }

  scrollLines(lines: number): void {
    this.scrollCalls.push(lines);
    this.viewportY = Math.min(
      this.getScrollbackLength(),
      Math.max(0, this.viewportY - lines),
    );
  }

  clearSelection(): void {
    this.clearSelectionCalls += 1;
  }

  private grapheme(cell: FakeCell | undefined): string {
    return cell?.codepoint ? String.fromCodePoint(cell.codepoint) : " ";
  }
}

const cells = (line: string, cols: number): FakeCell[] =>
  Array.from({ length: cols }, (_, col) => ({
    codepoint: line[col]?.codePointAt(0) ?? 0,
    width: 1,
  }));

const mouse = (clientX: number, clientY: number, overrides: Partial<FakeMouseEvent> = {}): FakeMouseEvent => ({
  button: 0,
  altKey: true,
  ctrlKey: false,
  metaKey: false,
  clientX,
  clientY,
  defaultPrevented: false,
  immediatePropagationStopped: false,
  preventDefault() {
    this.defaultPrevented = true;
  },
  stopImmediatePropagation() {
    this.immediatePropagationStopped = true;
  },
  ...overrides,
});

const createController = (
  term: FakeTerminal,
  completed: string[] = [],
): RectangularSelection =>
  new RectangularSelection(
    term as unknown as ConstructorParameters<typeof RectangularSelection>[0],
    () => undefined,
    (text) => completed.push(text),
  );

test("normalizes every drag direction", () => {
  for (const [start, end] of [
    [{ col: 4, row: 5 }, { col: 1, row: 2 }],
    [{ col: 1, row: 5 }, { col: 4, row: 2 }],
    [{ col: 4, row: 2 }, { col: 1, row: 5 }],
    [{ col: 1, row: 2 }, { col: 4, row: 5 }],
  ]) {
    assert.deepEqual(normalizeRect({ start, end }), {
      start: { col: 1, row: 2 },
      end: { col: 4, row: 5 },
    });
  }
});

test("maps bottom-screen and scrolled viewport rows into the combined buffer", () => {
  assert.equal(viewportAbsoluteTop(5, 0), 5);
  assert.equal(viewportAbsoluteTop(5, 2.8), 3);

  const bottom = new FakeTerminal();
  const bottomController = createController(bottom);
  bottom.element.dispatch("mousedown", mouse(101, 201));
  bottom.document.dispatch("mousemove", mouse(111, 241));
  assert.deepEqual(bottomController.overlay, {
    start: { col: 0, row: 2 },
    end: { col: 1, row: 4 },
  });
  bottom.document.dispatch("mouseup", mouse(111, 241));
  bottomController.dispose();

  const scrolled = new FakeTerminal();
  scrolled.viewportY = 1.9;
  const scrolledController = createController(scrolled);
  scrolled.element.dispatch("mousedown", mouse(101, 201));
  scrolled.document.dispatch("mousemove", mouse(111, 241));
  assert.deepEqual(scrolledController.overlay, {
    start: { col: 0, row: 1 },
    end: { col: 1, row: 3 },
  });
  scrolled.document.dispatch("mouseup", mouse(111, 241));
  scrolledController.dispose();
});

test("clips absolute selections to visible rows using scrollback-relative viewport coordinates", () => {
  assert.deepEqual(
    clipRectToViewport(
      { start: { col: 1, row: 1 }, end: { col: 3, row: 5 } },
      5,
      2.8,
      3,
    ),
    { start: { col: 1, row: 0 }, end: { col: 3, row: 2 } },
  );
  assert.equal(
    clipRectToViewport(
      { start: { col: 0, row: 0 }, end: { col: 1, row: 2 } },
      5,
      1,
      3,
    ),
    undefined,
  );
});

test("extracts one rectangle across actual scrollback and screen sources", () => {
  const term = new FakeTerminal(4, 3, ["aaaa", "SBcd"], ["XYzz", "uvwx", "last"]);
  term.viewportY = 1;
  const completed: string[] = [];
  const controller = createController(term, completed);

  term.element.dispatch("mousedown", mouse(101, 201));
  term.document.dispatch("mousemove", mouse(121, 241));
  term.document.dispatch("mouseup", mouse(121, 241));

  assert.deepEqual(completed, ["SBc\nXYz\nuvw"]);
  controller.dispose();
});

test("owns document capture listeners until an outside mouseup completes the gesture", () => {
  const term = new FakeTerminal();
  const completed: string[] = [];
  const controller = createController(term, completed);
  let terminalMouseDowns = 0;
  term.element.addEventListener("mousedown", () => {
    terminalMouseDowns += 1;
  });

  const down = mouse(101, 201);
  term.element.dispatch("mousedown", down);
  assert.equal(down.defaultPrevented, true);
  assert.equal(terminalMouseDowns, 0, "the latched rectangle suppresses terminal mouse reporting");
  assert.equal(term.document.listenerCount("mousemove"), 1);
  assert.equal(term.document.listenerCount("mouseup"), 1);

  term.document.dispatch("mousemove", mouse(121, 221));
  term.document.dispatch("mouseup", mouse(400, 400));
  assert.deepEqual(completed, ["new\nnew"]);
  assert.equal(term.document.listenerCount("mousemove"), 0);
  assert.equal(term.document.listenerCount("mouseup"), 0);
  controller.dispose();
});

test("Alt-only primary mousedown owns a rectangle before other terminal handlers", () => {
  const term = new FakeTerminal();
  const controller = createController(term);
  let terminalMouseDowns = 0;
  term.element.addEventListener("mousedown", () => {
    terminalMouseDowns += 1;
  });

  const down = mouse(101, 201);
  term.element.dispatch("mousedown", down);

  assert.equal(down.defaultPrevented, true);
  assert.equal(terminalMouseDowns, 0);
  assert.equal(term.document.listenerCount("mousemove"), 1);
  assert.equal(term.document.listenerCount("mouseup"), 1);
  controller.dispose();
});

test("Ctrl+Alt and Meta+Alt primary mousedown both start rectangular selection", () => {
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) {
    const term = new FakeTerminal();
    const controller = createController(term);
    const down = mouse(101, 201, modifiers);

    term.element.dispatch("mousedown", down);

    assert.equal(down.defaultPrevented, true);
    assert.equal(term.document.listenerCount("mousemove"), 1);
    assert.equal(term.document.listenerCount("mouseup"), 1);
    controller.dispose();
  }
});

test("rejects non-primary and no-Alt rectangular selection presses", () => {
  const term = new FakeTerminal();
  const controller = createController(term);

  term.element.dispatch("mousedown", mouse(101, 201, { altKey: false }));
  term.element.dispatch("mousedown", mouse(101, 201, { button: 1 }));

  assert.equal(term.document.listenerCount("mousemove"), 0);
  assert.equal(term.document.listenerCount("mouseup"), 0);
  controller.dispose();
});

test("auto-scroll updates the endpoint to the newly exposed absolute row", () => {
  const term = new FakeTerminal(4, 3, ["0000", "1111", "2222", "3333", "4444"]);
  const controller = createController(term);

  term.element.dispatch("mousedown", mouse(101, 221));
  term.document.dispatch("mousemove", mouse(111, 190));

  assert.deepEqual(term.scrollCalls, [-1]);
  assert.equal(term.viewportY, 1);
  assert.deepEqual(controller.overlay, {
    start: { col: 0, row: 4 },
    end: { col: 1, row: 6 },
  });
  assert.deepEqual(controller.visibleOverlay, {
    start: { col: 0, row: 0 },
    end: { col: 1, row: 2 },
  });

  term.document.dispatch("mouseup", mouse(111, 190));
  assert.equal(term.document.listenerCount("mousemove"), 0);
  controller.dispose();
});

test("auto-scroll follows the latest pointer when it crosses to the opposite edge", () => {
  const term = new FakeTerminal(4, 3, ["0000", "1111", "2222", "3333", "4444"]);
  term.viewportY = 2;
  const controller = createController(term);

  term.element.dispatch("mousedown", mouse(101, 221));
  term.document.dispatch("mousemove", mouse(111, 190));
  term.document.dispatch("mousemove", mouse(121, 270));

  assert.deepEqual(term.scrollCalls, [-1, 1]);
  assert.equal(term.viewportY, 2);
  assert.deepEqual(controller.overlay, {
    start: { col: 0, row: 4 },
    end: { col: 2, row: 5 },
  });

  term.document.dispatch("mouseup", mouse(121, 270));
  controller.dispose();
});

test("dispose cancels a latched gesture and removes every owned listener", () => {
  const term = new FakeTerminal();
  const controller = createController(term);
  term.element.dispatch("mousedown", mouse(101, 201));

  controller.dispose();

  assert.equal(term.element.listenerCount("mousedown"), 0);
  assert.equal(term.document.listenerCount("mousemove"), 0);
  assert.equal(term.document.listenerCount("mouseup"), 0);
});

test("preserves interior blanks and trims only the right edge of each row", () => {
  const lines = [" a b  ", "  c d "];
  assert.equal(
    extractRectangularText(
      { start: { col: 1, row: 0 }, end: { col: 4, row: 1 } },
      (row) => [...lines[row]].map((char) => ({ codepoint: char.codePointAt(0)!, width: 1 })),
    ),
    "a b\n c d",
  );
});

test("copies a wide glyph only when its leading cell is selected", () => {
  const wideCells = [
    { codepoint: 0x1f642, width: 2, text: "🙂" },
    { codepoint: 0, width: 0 },
    { codepoint: 0x65, width: 1, text: "é" },
  ];
  assert.equal(
    extractRectangularText({ start: { col: 0, row: 0 }, end: { col: 0, row: 0 } }, () => wideCells),
    "🙂",
  );
  assert.equal(
    extractRectangularText({ start: { col: 1, row: 0 }, end: { col: 1, row: 0 } }, () => wideCells),
    "",
  );
  assert.equal(
    extractRectangularText({ start: { col: 1, row: 0 }, end: { col: 2, row: 0 } }, () => wideCells),
    "é",
  );
});
