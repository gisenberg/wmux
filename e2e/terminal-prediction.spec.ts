import path from "node:path";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { awaitAppShell } from "./fixtures";

interface PredictionCell {
  col: number;
  row: number;
  text?: string;
}

interface InkBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  centroidX: number;
  centroidY: number;
  pixels: number;
}

const routeTerminalFontFamily = async (page: Page, terminalFontFamily: string): Promise<void> => {
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({ response, json: { ...payload, terminalFontFamily } });
  });
  await page.routeWebSocket("**/ws/events", (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    serverSocket.onMessage((message) => {
      if (typeof message !== "string") {
        browserSocket.send(message);
        return;
      }
      try {
        const payload = JSON.parse(message) as { type?: string; state?: Record<string, unknown> };
        if (payload.type === "snapshot" && payload.state) {
          browserSocket.send(JSON.stringify({
            ...payload,
            state: { ...payload.state, terminalFontFamily },
          }));
          return;
        }
      } catch {
        // Forward non-JSON event messages unchanged.
      }
      browserSocket.send(message);
    });
  });
};

const terminalOutputDelayMs = 750;

// Keep the synthetic echo comfortably behind browser input dispatch under concurrent runner load.
const delayTerminalOutput = async (page: Page, delayMs = terminalOutputDelayMs): Promise<void> => {
  await page.routeWebSocket(/\/ws\/panes\//, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    browserSocket.onMessage((message) => serverSocket.send(message));
    serverSocket.onMessage((message) => {
      let delay = 0;
      try {
        const parsed = JSON.parse(String(message)) as { type?: string };
        if (parsed.type === "output") delay = delayMs;
      } catch {
        // Forward non-JSON frames without delay.
      }
      setTimeout(() => browserSocket.send(message), delay);
    });
  });
};

const createWorkspace = async (
  request: APIRequestContext,
): Promise<{ id: string; activeTabId: string }> => {
  const response = await request.post("/api/workspaces", { data: { machineId: "local" } });
  expect(response.ok()).toBeTruthy();
  const payload = await response.json() as {
    workspace: { id: string; activeTabId: string };
  };
  return payload.workspace;
};

const openDelayedTerminal = async (
  page: Page,
  request: APIRequestContext,
  fontFamily: string,
  fontSize: number,
): Promise<{
  workspace: { id: string; activeTabId: string };
  pane: Locator;
  prediction: Locator;
}> => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    Math.random = () => 0;
  });
  await routeTerminalFontFamily(page, fontFamily);
  await delayTerminalOutput(page);
  const settings = await request.post("/api/settings", { data: { terminalFontSize: fontSize } });
  expect(settings.ok()).toBeTruthy();
  await page.goto("/");
  await awaitAppShell(page);
  const workspace = await createWorkspace(request);
  await page.goto(`/workspaces/${workspace.id}/tabs/${workspace.activeTabId}`);
  await awaitAppShell(page);
  const pane = page.locator(".terminal-pane.active");
  await expect(pane).toHaveClass(/terminal-ready/, { timeout: 20_000 });
  await pane.locator(".terminal-host textarea").evaluate((element: HTMLTextAreaElement) => element.focus());
  await page.waitForTimeout(700);
  return {
    workspace,
    pane,
    prediction: pane.locator(".terminal-input-prediction-canvas"),
  };
};

const predictionCells = async (prediction: Locator): Promise<PredictionCell[]> =>
  JSON.parse((await prediction.getAttribute("data-prediction-cells")) ?? "[]") as PredictionCell[];

const canvasInkBounds = async (
  canvas: Locator,
  cell: PredictionCell,
  metrics: { width: number; height: number; dpr: number },
  foreground: string,
  background: string,
): Promise<InkBounds | null> => canvas.evaluate((
  element,
  { cell, metrics, foreground, background },
) => {
  const canvas = element as HTMLCanvasElement;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  const colorPixel = (color: string): [number, number, number] => {
    const sample = document.createElement("canvas");
    sample.width = 1;
    sample.height = 1;
    const sampleContext = sample.getContext("2d")!;
    sampleContext.fillStyle = color;
    sampleContext.fillRect(0, 0, 1, 1);
    const pixel = sampleContext.getImageData(0, 0, 1, 1).data;
    return [pixel[0]!, pixel[1]!, pixel[2]!];
  };
  const foregroundRgb = colorPixel(foreground);
  const backgroundRgb = colorPixel(background);
  const startX = Math.round(cell.col * metrics.width * metrics.dpr);
  const startY = Math.round(cell.row * metrics.height * metrics.dpr);
  const width = Math.round(metrics.width * metrics.dpr);
  const height = Math.round(metrics.height * metrics.dpr);
  const image = context.getImageData(startX, startY, width, height);
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  let weight = 0;
  let weightedX = 0;
  let weightedY = 0;
  let pixels = 0;
  const distance = (red: number, green: number, blue: number, target: [number, number, number]) =>
    Math.hypot(red - target[0], green - target[1], blue - target[2]);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const alpha = image.data[offset + 3]!;
      if (alpha === 0) continue;
      const foregroundDistance = distance(
        image.data[offset]!,
        image.data[offset + 1]!,
        image.data[offset + 2]!,
        foregroundRgb,
      );
      const backgroundDistance = distance(
        image.data[offset]!,
        image.data[offset + 1]!,
        image.data[offset + 2]!,
        backgroundRgb,
      );
      if (foregroundDistance + 4 >= backgroundDistance) continue;
      const pixelWeight = Math.max(1, backgroundDistance - foregroundDistance) * alpha;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
      weightedX += x * pixelWeight;
      weightedY += y * pixelWeight;
      weight += pixelWeight;
      pixels += 1;
    }
  }
  if (pixels === 0 || weight === 0) return null;
  return {
    left,
    top,
    right,
    bottom,
    centroidX: weightedX / weight,
    centroidY: weightedY / weight,
    pixels,
  };
}, { cell, metrics, foreground, background });

const assertInkMatch = (predicted: InkBounds | null, authoritative: InkBounds | null): void => {
  expect(predicted).not.toBeNull();
  expect(authoritative).not.toBeNull();
  expect(predicted!.left).toBe(authoritative!.left);
  expect(predicted!.top).toBe(authoritative!.top);
  expect(predicted!.right).toBe(authoritative!.right);
  expect(predicted!.bottom).toBe(authoritative!.bottom);
  expect(predicted!.pixels).toBe(authoritative!.pixels);
  expect(Math.abs(predicted!.centroidX - authoritative!.centroidX)).toBeLessThan(0.05);
  expect(Math.abs(predicted!.centroidY - authoritative!.centroidY)).toBeLessThan(0.05);
};

const readPredictionMetrics = async (
  prediction: Locator,
): Promise<{ width: number; height: number; baseline: number; dpr: number }> =>
  prediction.evaluate((canvas) => ({
    width: Number((canvas as HTMLCanvasElement).dataset.cellWidth),
    height: Number((canvas as HTMLCanvasElement).dataset.cellHeight),
    baseline: Number((canvas as HTMLCanvasElement).dataset.baseline),
    dpr: Number((canvas as HTMLCanvasElement).dataset.devicePixelRatio),
  }));

const readTerminalColors = async (pane: Locator): Promise<{ foreground: string; background: string }> =>
  pane.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      foreground: style.getPropertyValue("--terminal-foreground").trim(),
      background: style.getPropertyValue("--terminal-background").trim(),
    };
  });

const armTerminalPrediction = async (page: Page, prediction: Locator): Promise<void> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (!await prediction.getAttribute("data-armed-screen")) {
        await page.keyboard.type("a");
        await expect(prediction).toHaveAttribute("data-armed-screen", /^(normal|alternate)$/, { timeout: 2_000 });
      }
      await page.keyboard.type("q");
      await expect(prediction).toHaveAttribute("data-active", "true", { timeout: 400 });
      await expect(prediction).not.toHaveAttribute("data-active", "true", { timeout: 2_000 });
      return;
    } catch {
      await page.waitForTimeout(250);
    }
  }
  throw new Error("Terminal prediction did not arm after three authoritative echoes");
};

// A late authoritative write (shell integration hooks, title updates) can
// disarm the prediction between echoes, so a single keystroke occasionally
// renders unpredicted by design; settle and re-arm instead of failing.
const typeActivePrediction = async (
  page: Page,
  prediction: Locator,
  character: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.keyboard.type(character);
    try {
      await expect(prediction).toHaveAttribute("data-active", "true", { timeout: 1_000 });
      return;
    } catch {
      await expect(prediction).not.toHaveAttribute("data-active", "true", { timeout: 3_000 });
      await armTerminalPrediction(page, prediction);
    }
  }
  throw new Error(`Prediction did not activate after typing ${JSON.stringify(character)}`);
};

const verifyDelayedGlyph = async (
  page: Page,
  pane: Locator,
  prediction: Locator,
  foreground?: string,
  background?: string,
): Promise<void> => {
  await armTerminalPrediction(page, prediction);
  await typeActivePrediction(page, prediction, "x");
  await page.keyboard.type("y");
  await expect(prediction).toHaveAttribute("data-active", "true");
  const cells = await predictionCells(prediction);
  expect(cells).toHaveLength(2);
  const metrics = await readPredictionMetrics(prediction);
  expect(metrics.baseline * metrics.dpr).toBeCloseTo(Math.round(metrics.baseline * metrics.dpr), 8);
  const colors = foreground && background
    ? { foreground, background }
    : await readTerminalColors(pane);
  const predicted = await canvasInkBounds(prediction, cells[0]!, metrics, colors.foreground, colors.background);
  const transparentTail = await prediction.evaluate((canvas, { cell, metrics }) => {
    const context = (canvas as HTMLCanvasElement).getContext("2d", { willReadFrequently: true })!;
    const x = Math.round(cell.col * metrics.width * metrics.dpr);
    const y = Math.round(cell.row * metrics.height * metrics.dpr);
    return context.getImageData(x, y, 1, 1).data[3];
  }, { cell: cells[1]!, metrics });
  if (!foreground) expect(transparentTail).toBe(0);
  const transition = await prediction.evaluate((canvas) => {
    const style = getComputedStyle(canvas);
    return {
      animationName: style.animationName,
      transitionDuration: style.transitionDuration,
    };
  });
  expect(transition).toEqual({ animationName: "none", transitionDuration: "0s" });
  await expect(prediction).not.toHaveAttribute("data-active", "true", { timeout: 2_000 });
  const authoritative = await canvasInkBounds(
    pane.locator(".terminal-host canvas"),
    cells[0]!,
    metrics,
    colors.foreground,
    colors.background,
  );
  assertInkMatch(predicted, authoritative);
};

for (const fontCase of [
  { name: "Fira Code 13", family: "\"Fira Code\"", size: 13 },
  { name: "Meslo 14", family: "\"MesloLGM Nerd Font\"", size: 14 },
  { name: "Fira Code 16", family: "\"Fira Code\"", size: 16 },
]) {
  test(`prediction ink matches Ghostty with ${fontCase.name}`, async ({ page, request }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium",
      "desktop Chromium metric matrix",
    );
    test.setTimeout(75_000);
    const { workspace, pane, prediction } = await openDelayedTerminal(
      page,
      request,
      fontCase.family,
      fontCase.size,
    );
    try {
      await verifyDelayedGlyph(page, pane, prediction);
    } finally {
      await request.delete(`/api/workspaces/${workspace.id}`);
    }
  });
}

test("styled inverse prediction matches Ghostty ink and ANSI backgrounds", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop Chromium styled-cell coverage");
  test.setTimeout(75_000);
  const { workspace, pane, prediction } = await openDelayedTerminal(
    page,
    request,
    "\"MesloLGM Nerd Font\"",
    14,
  );
  try {
    await page.keyboard.type("PS1=$'\\e[1;3;2;4;9;7;38;2;20;40;60;48;2;210;180;80mP>' bash --noprofile --norc -i");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1_100);
    await armTerminalPrediction(page, prediction);
    await page.keyboard.type("x");
    await expect(prediction).toHaveAttribute("data-active", "true");
    expect(Number(await prediction.getAttribute("data-style-flags")) & 159).toBe(159);
    const cells = await predictionCells(prediction);
    const metrics = await readPredictionMetrics(prediction);
    const predicted = await canvasInkBounds(prediction, cells[0]!, metrics, "rgb(210, 180, 80)", "rgb(20, 40, 60)");
    await expect(prediction).not.toHaveAttribute("data-active", "true", { timeout: 2_000 });
    const authoritative = await canvasInkBounds(
      pane.locator(".terminal-host canvas"),
      cells[0]!,
      metrics,
      "rgb(210, 180, 80)",
      "rgb(20, 40, 60)",
    );
    assertInkMatch(predicted, authoritative);
  } finally {
    await request.delete(`/api/workspaces/${workspace.id}`);
  }
});

test("DPR changes clear stale prediction metrics before repainting", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Chromium CDP scale-change coverage");
  test.setTimeout(75_000);
  const { workspace, pane, prediction } = await openDelayedTerminal(
    page,
    request,
    "\"Fira Code\"",
    14,
  );
  const cdp = await page.context().newCDPSession(page);
  try {
    await armTerminalPrediction(page, prediction);
    await typeActivePrediction(page, prediction, "x");
    const initialMetrics = await readPredictionMetrics(prediction);
    expect(initialMetrics.dpr).toBe(2);
    expect(initialMetrics.width).toBeGreaterThanOrEqual(8);
    expect(initialMetrics.width).toBeLessThan(9);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1.5,
      mobile: false,
    });
    await expect(prediction).not.toHaveAttribute("data-active", "true");
    await expect.poll(() => page.evaluate(() => window.devicePixelRatio)).toBe(1.5);
    await armTerminalPrediction(page, prediction);
    await page.keyboard.type("x");
    await expect(prediction).toHaveAttribute("data-device-pixel-ratio", "2");
    const metrics = await readPredictionMetrics(prediction);
    const backingScale = await prediction.evaluate((canvas, metrics) => ({
      x: (canvas as HTMLCanvasElement).width / (parseFloat((canvas as HTMLCanvasElement).style.width) || 1),
      y: (canvas as HTMLCanvasElement).height / (parseFloat((canvas as HTMLCanvasElement).style.height) || 1),
      expected: metrics.dpr,
    }), metrics);
    expect(backingScale.x).toBeCloseTo(backingScale.expected, 8);
    expect(backingScale.y).toBeCloseTo(backingScale.expected, 8);
    await verifyDelayedGlyph(page, pane, prediction);
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await request.delete(`/api/workspaces/${workspace.id}`);
  }
});

test("prediction layout crosses a wrapped row and confirms without residue", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop wrapped-row coverage");
  test.setTimeout(75_000);
  const { workspace, pane, prediction } = await openDelayedTerminal(
    page,
    request,
    "\"Fira Code\"",
    14,
  );
  try {
    await armTerminalPrediction(page, prediction);
    await page.keyboard.type("x");
    await expect(prediction).toHaveAttribute("data-active", "true");
    const metrics = await readPredictionMetrics(prediction);
    await expect(prediction).not.toHaveAttribute("data-active", "true", { timeout: 2_000 });
    const cols = await pane.locator(".terminal-host canvas").evaluate(
      (canvas, cellWidth) => Math.floor(parseFloat((canvas as HTMLCanvasElement).style.width) / cellWidth),
      metrics.width,
    );
    await page.keyboard.press("Enter");
    await page.waitForTimeout(650);
    await page.keyboard.type(`PS1=''; printf '\\033[2J\\033[H\\033[1;${cols - 1}H'`);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1_100);
    await page.keyboard.type("a");
    await expect.poll(async () => {
      const rawCursor = await prediction.getAttribute("data-armed-cursor");
      if (!rawCursor) return undefined;
      return (JSON.parse(rawCursor) as { x: number }).x;
    }, { timeout: 2_000 }).toBe(cols - 1);
    await page.keyboard.type("x");
    await expect(prediction).toHaveAttribute("data-active", "true");
    await page.keyboard.type("y");
    await expect(prediction).toHaveAttribute("data-active", "true");
    const cells = await predictionCells(prediction);
    expect(cells[0]!.col).toBe(cols - 1);
    expect(cells[1]).toEqual({
      col: 0,
      row: cells[0]!.row + 1,
    });
    await expect(prediction).not.toHaveAttribute("data-active", "true", { timeout: 2_000 });
    const alpha = await prediction.evaluate((canvas) => {
      const target = canvas as HTMLCanvasElement;
      const data = target.getContext("2d", { willReadFrequently: true })!
        .getImageData(0, 0, target.width, target.height).data;
      return data.some((value, index) => index % 4 === 3 && value !== 0);
    });
    expect(alpha).toBe(false);
  } finally {
    await request.delete(`/api/workspaces/${workspace.id}`);
  }
});

test("renders Unicode quadrant blocks as exact cell geometry", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "canvas block rendering coverage");
  await page.goto("/");
  await awaitAppShell(page);
  const projectRoot = process.cwd().replaceAll("\\", "/");
  const ghosttyUrl = `/@fs${path.posix.join(projectRoot, "node_modules/ghostty-web/dist/ghostty-web.es.js")}`;
  const result = await page.evaluate(async ({ ghosttyUrl }) => {
    const { CanvasRenderer } = await import(new URL(ghosttyUrl, window.location.href).href);
    const foreground = [202, 124, 94] as const;
    const background = [26, 27, 37] as const;
    const canvas = document.createElement("canvas");
    const cell = (codepoint: number) => ({
      codepoint,
      fg_r: foreground[0],
      fg_g: foreground[1],
      fg_b: foreground[2],
      bg_r: 0,
      bg_g: 0,
      bg_b: 0,
      fgIsDefault: false,
      bgIsDefault: true,
      flags: 0,
      width: 1,
      hyperlink_id: 0,
      grapheme_len: 0,
    });
    const cells = [cell(0x2597), cell(0x2596)];
    const dpr = 2;
    const renderer = new CanvasRenderer(canvas, {
      fontSize: 14,
      fontFamily: '"Fira Code", monospace',
      cursorBlink: false,
      devicePixelRatio: dpr,
      theme: {
        foreground: `rgb(${foreground.join(", ")})`,
        background: `rgb(${background.join(", ")})`,
      },
    });
    renderer.resize(2, 1);
    renderer.render({
      getLine: () => cells,
      getViewport: () => cells,
      getCursor: () => ({ x: 0, y: 0, visible: false }),
      getDimensions: () => ({ cols: 2, rows: 1 }),
      isRowDirty: () => true,
      clearDirty: () => undefined,
    }, true);

    const metrics = renderer.getMetrics();
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const stats = cells.map((_, col) => {
      const left = Math.round(col * metrics.width * dpr);
      const right = Math.round((col + 1) * metrics.width * dpr);
      const bottom = Math.round(metrics.height * dpr);
      const pixels = context.getImageData(left, 0, right - left, bottom).data;
      let foregroundPixels = 0;
      let backgroundPixels = 0;
      let blendedPixels = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const rgb = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
        if (rgb.every((value, index) => value === foreground[index])) {
          foregroundPixels += 1;
        } else if (rgb.every((value, index) => value === background[index])) {
          backgroundPixels += 1;
        } else {
          blendedPixels += 1;
        }
      }
      return { foregroundPixels, backgroundPixels, blendedPixels };
    });
    const cellWidth = Math.round(metrics.width * dpr);
    const cellHeight = Math.round(metrics.height * dpr);
    const leftHalf = Math.round(metrics.width / 2) * dpr;
    const rightHalf = cellWidth - leftHalf;
    const topHalf = Math.round(metrics.height / 2) * dpr;
    const bottomHalf = cellHeight - topHalf;
    return {
      stats,
      expectedForegroundPixels: [rightHalf * bottomHalf, leftHalf * bottomHalf],
      expectedBackgroundPixels: [
        cellWidth * cellHeight - rightHalf * bottomHalf,
        cellWidth * cellHeight - leftHalf * bottomHalf,
      ],
    };
  }, { ghosttyUrl });

  expect(result.stats).toEqual([
    {
      foregroundPixels: result.expectedForegroundPixels[0],
      backgroundPixels: result.expectedBackgroundPixels[0],
      blendedPixels: 0,
    },
    {
      foregroundPixels: result.expectedForegroundPixels[1],
      backgroundPixels: result.expectedBackgroundPixels[1],
      blendedPixels: 0,
    },
  ]);
});

test("mobile WebKit prediction ink matches Ghostty canvas metrics", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-webkit", "mobile WebKit coverage");
  test.setTimeout(75_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await awaitAppShell(page);
  const projectRoot = process.cwd().replaceAll("\\", "/");
  const ghosttyUrl = `/@fs${path.posix.join(projectRoot, "node_modules/ghostty-web/dist/ghostty-web.es.js")}`;
  const predictionUrl = `/@fs${path.posix.join(projectRoot, "src/client/src/terminal-prediction-renderer.ts")}`;
  const inputPredictionUrl = `/@fs${path.posix.join(projectRoot, "src/client/src/terminal-input-prediction.ts")}`;
  const result = await page.evaluate(async ({ ghosttyUrl, predictionUrl, inputPredictionUrl }) => {
    const ghostty = await import(new URL(ghosttyUrl, window.location.href).href);
    const predictionModule = await import(new URL(predictionUrl, window.location.href).href);
    const inputPrediction = await import(new URL(inputPredictionUrl, window.location.href).href);
    const host = document.createElement("div");
    host.style.position = "relative";
    host.style.width = "320px";
    host.style.height = "80px";
    host.style.paddingLeft = "17px";
    document.body.append(host);
    const authoritativeCanvas = document.createElement("canvas");
    const predictionCanvas = document.createElement("canvas");
    predictionCanvas.id = "webkit-prediction-canvas";
    predictionCanvas.style.position = "absolute";
    predictionCanvas.style.left = "17px";
    host.append(authoritativeCanvas, predictionCanvas);
    const emptyCell = () => ({
      codepoint: 0,
      fg_r: 0,
      fg_g: 0,
      fg_b: 0,
      bg_r: 0,
      bg_g: 0,
      bg_b: 0,
      fgIsDefault: true,
      bgIsDefault: true,
      flags: 0,
      width: 1,
      hyperlink_id: 0,
      grapheme_len: 0,
    });
    const cells = Array.from({ length: 8 }, emptyCell);
    cells[1] = { ...emptyCell(), codepoint: "x".codePointAt(0)! };
    const authoritative = new ghostty.CanvasRenderer(authoritativeCanvas, {
      fontSize: 14,
      fontFamily: "\"Fira Code\", monospace",
      cursorBlink: false,
      theme: {
        foreground: "#d8dee9",
        background: "#101114",
        cursor: "#f4d35e",
        cursorAccent: "#101114",
      },
      devicePixelRatio: window.devicePixelRatio,
    });
    authoritative.resize(4, 2);
    authoritative.render({
      getLine: (row: number) => cells.slice(row * 4, row * 4 + 4),
      getViewport: () => cells,
      getCursor: () => ({ x: 2, y: 0, visible: false }),
      getDimensions: () => ({ cols: 4, rows: 2 }),
      isRowDirty: () => true,
      clearDirty: () => undefined,
    }, true);
    const prediction = new predictionModule.TerminalPredictionRenderer(predictionCanvas);
    const style = inputPrediction.effectiveTerminalPredictionCellStyle(emptyCell());
    prediction.paint({
      metrics: authoritative.getMetrics(),
      devicePixelRatio: window.devicePixelRatio,
      cols: 4,
      rows: 2,
      fontSize: 14,
      fontFamily: "\"Fira Code\", monospace",
      theme: {
        foreground: "#d8dee9",
        background: "#101114",
        cursor: "#f4d35e",
        cursorAccent: "#101114",
      },
      layout: {
        cells: [{ col: 1, row: 0, text: "x" }],
        cursor: { col: 2, row: 0 },
        authoritativeCursor: { col: 1, row: 0 },
      },
      style,
      cellAt: () => emptyCell(),
      cellPaint: inputPrediction.terminalPredictionCellPaint,
      cursorStyle: "block",
      authoritativeCanvas,
    });
    authoritativeCanvas.id = "webkit-authoritative-canvas";
    return {
      dpr: window.devicePixelRatio,
      metrics: authoritative.getMetrics(),
      left: Math.round(predictionCanvas.getBoundingClientRect().left - host.getBoundingClientRect().left),
    };
  }, { ghosttyUrl, predictionUrl, inputPredictionUrl });
  expect(result.left).toBe(17);
  expect(result.metrics.baseline * result.dpr).toBeCloseTo(
    Math.round(result.metrics.baseline * result.dpr),
    8,
  );
  const cell = { col: 1, row: 0, text: "x" };
  const metrics = { width: result.metrics.width, height: result.metrics.height, dpr: result.dpr };
  const predicted = await canvasInkBounds(
    page.locator("#webkit-prediction-canvas"),
    cell,
    metrics,
    "#d8dee9",
    "#101114",
  );
  const authoritative = await canvasInkBounds(
    page.locator("#webkit-authoritative-canvas"),
    cell,
    metrics,
    "#d8dee9",
    "#101114",
  );
  assertInkMatch(predicted, authoritative);
});
