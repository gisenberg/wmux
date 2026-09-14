import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createGrid,
  createGridPainter,
  fillCells,
  fitText,
  textCellWidth,
  writeText,
} from "../src/client/src/opentui-grid.ts";

const black = [0, 0, 0, 1] as const;
const white = [1, 1, 1, 1] as const;

test("canvas grid keeps combining and emoji ZWJ graphemes intact", () => {
  const grid = createGrid(8, 1, black, white);
  writeText(grid, 0, 0, "e\u0301👩🏽‍💻Z", white, 0);

  assert.equal(grid.graphemes?.[0], "e\u0301");
  assert.equal(grid.graphemes?.[1], "👩🏽‍💻");
  assert.equal(grid.graphemes?.[2], "");
  assert.equal(grid.graphemes?.[3], "Z");
  assert.equal(textCellWidth("e\u0301👩🏽‍💻Z"), 4);
});

test("canvas grid accounts for wide CJK cells and does not split them at a clip boundary", () => {
  const grid = createGrid(3, 1, black, white);
  writeText(grid, 0, 0, "日本A", white, 0);

  assert.equal(grid.graphemes?.[0], "日");
  assert.equal(grid.graphemes?.[1], "");
  assert.equal(grid.graphemes?.[2], undefined);
  assert.equal(fitText("日本A", 3), "日");
  assert.equal(textCellWidth(fitText("日本A", 3)), 2);
});

test("canvas grid fitting retains RTL graphemes without splitting a combining mark", () => {
  const label = "שָׁלוֹם שלום";
  const fitted = fitText(label, 8);
  assert.equal(fitted, "שָׁלוֹם ...");
  assert.equal(textCellWidth(fitted), 8);
  assert.equal(fitted.includes("שָ"), true);
});

test("writing over a wide-cell continuation removes the old leading glyph", () => {
  const grid = createGrid(3, 1, black, white);
  writeText(grid, 0, 0, "日", white, 0);
  writeText(grid, 0, 1, "A", white, 0);
  writeText(grid, 0, 1, "B", white, 0);
  assert.equal(grid.graphemes?.[0], undefined);
  assert.equal(grid.graphemes?.[1], "B");
});

test("emoji presentation selectors and keycaps consume two cells", () => {
  assert.equal(textCellWidth("❤️"), 2);
  assert.equal(textCellWidth("☕"), 2);
  assert.equal(textCellWidth("1️⃣"), 2);
  assert.equal(fitText("❤️A", 2), "❤️");
});

test("direct scalar-buffer updates override an earlier grapheme layer", () => {
  const painted: string[] = [];
  const context = {
    font: "",
    textBaseline: "",
    fillStyle: "",
    measureText: () => ({ width: 8 }),
    setTransform: () => undefined,
    fillRect: () => undefined,
    fillText: (text: string) => painted.push(text),
    save: () => undefined,
    restore: () => undefined,
  };
  const canvas = {
    width: 1,
    height: 1,
    style: {},
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  const global = globalThis as typeof globalThis & { window?: { devicePixelRatio: number } };
  const previousWindow = global.window;
  global.window = { devicePixelRatio: 1 };
  try {
    const painter = createGridPainter(canvas);
    const grid = createGrid(2, 1, black, white);
    writeText(grid, 0, 0, "日", white, 0);
    grid.chars[0] = "A".codePointAt(0)!;
    grid.chars[1] = "B".codePointAt(0)!;
    fillCells(grid, 0, 0, 2, black);
    painter.paint(grid);
    assert.deepEqual(painted, ["A", "B"]);
  } finally {
    if (previousWindow) global.window = previousWindow;
    else delete global.window;
  }
});
