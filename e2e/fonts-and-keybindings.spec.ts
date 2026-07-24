import { routeTerminalFontFamily, expect, test } from "./fixtures";

test("uses a configured shortcut while preserving defaults for omitted actions", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop keyboard coverage");

  await page.addInitScript(() => {
    const inputs: string[] = [];
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function send(data) {
      if (typeof data === "string") {
        try {
          const message = JSON.parse(data) as { type?: string; data?: string };
          if (message.type === "input" && typeof message.data === "string") inputs.push(message.data);
        } catch {
          // Ignore non-JSON websocket traffic.
        }
      }
      return originalSend.call(this, data);
    };
    (window as unknown as { __wmuxKeybindingInputs: string[] }).__wmuxKeybindingInputs = inputs;
  });
  await page.reload();
  const activePane = page.locator(".terminal-pane.active");
  await expect(activePane).toHaveClass(/terminal-ready/, { timeout: 10_000 });
  await activePane.locator(".terminal-host textarea").evaluate((textarea: HTMLTextAreaElement) => textarea.focus());

  await page.keyboard.press("Control+Shift+P");
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __wmuxKeybindingInputs: string[] }).__wmuxKeybindingInputs.join(""),
  )).toContain("\x1bb");

  await page.keyboard.press("Control+K");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
});

test("registers and loads the bundled Meslo terminal font", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop Chromium font coverage");
  await routeTerminalFontFamily(page, '"MesloLGM Nerd Font"');
  await page.reload();
  await expect(page.locator(".terminal-pane.active")).toHaveClass(/terminal-ready/, { timeout: 10_000 });

  const result = await page.evaluate(() => {
    const faces = [...document.fonts]
      .filter((face) => face.family === "MesloLGM Nerd Font")
      .map((face) => ({ style: face.style, weight: face.weight, status: face.status }));
    const terminalFontFamily = getComputedStyle(document.querySelector(".terminal-host") as HTMLElement).fontFamily;
    const predictionCanvas = document.querySelector(".terminal-input-prediction-canvas");
    return {
      faces,
      hasPredictionCanvas: predictionCanvas instanceof HTMLCanvasElement,
      terminalFontFamily,
    };
  });

  expect(result.faces).toEqual(expect.arrayContaining([
    { style: "normal", weight: "400", status: "loaded" },
    { style: "normal", weight: "700", status: "loaded" },
    { style: "italic", weight: "400", status: "loaded" },
    { style: "italic", weight: "700", status: "loaded" },
  ]));
  expect(result.faces).toHaveLength(4);
  expect(result.terminalFontFamily).toContain("MesloLGM Nerd Font");
  expect(result.hasPredictionCanvas).toBe(true);
});

test("does not block terminal startup on slow bundled fonts", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop Chromium font coverage");
  await page.route("**/fonts/meslo-v3.4.0/**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await route.continue();
  });
  await routeTerminalFontFamily(page, '"MesloLGM Nerd Font"');

  await page.reload();
  await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
  const startedAt = Date.now();
  await expect(page.locator(".terminal-pane.active")).toHaveClass(/terminal-ready/, { timeout: 3_500 });
  expect(Date.now() - startedAt).toBeLessThan(3_500);
});

test("pastes text after a full reload without forwarding Ctrl+V to the pane", async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop clipboard coverage");

  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });
  await page.addInitScript(() => {
    const inputs: string[] = [];
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function send(data) {
      if (typeof data === "string") {
        try {
          const message = JSON.parse(data) as { type?: string; data?: string };
          if (message.type === "input" && typeof message.data === "string") inputs.push(message.data);
        } catch {
          // Ignore non-JSON websocket traffic.
        }
      }
      return originalSend.call(this, data);
    };
    (window as unknown as { __wmuxPasteInputs: string[] }).__wmuxPasteInputs = inputs;
  });
  await page.reload();

  const activePane = page.locator(".terminal-pane.active");
  await expect(activePane).toHaveClass(/terminal-ready/, { timeout: 10_000 });
  await activePane.locator(".terminal-host textarea").evaluate((textarea: HTMLTextAreaElement) => textarea.focus());
  await page.evaluate(() => {
    (window as unknown as { __wmuxPasteInputs: string[] }).__wmuxPasteInputs.length = 0;
  });

  const text = "wmux-paste-after-refresh";
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await page.keyboard.press("Control+V");

  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __wmuxPasteInputs: string[] }).__wmuxPasteInputs.join(""),
  )).toContain(text);
  const paneInputs = await page.evaluate(() =>
    (window as unknown as { __wmuxPasteInputs: string[] }).__wmuxPasteInputs,
  );
  expect(paneInputs).not.toContain("\x16");
});

test("copies tmux default-selection OSC 52 requests to the browser clipboard", async ({
  page,
  context,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop clipboard coverage");

  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });

  let bootstrapResponse = await request.get("/api/bootstrap");
  let bootstrap = await bootstrapResponse.json() as {
    activeWorkspaceId?: string;
    workspaces: Array<{
      id: string;
      activeTabId: string;
      tabs: Array<{ id: string; panes: Array<{ id: string }> }>;
    }>;
  };
  if (bootstrap.workspaces.length === 0) {
    const created = await request.post("/api/workspaces", { data: { machineId: "local" } });
    expect(created.ok()).toBeTruthy();
    await page.reload();
    await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
    bootstrapResponse = await request.get("/api/bootstrap");
    bootstrap = await bootstrapResponse.json();
  }

  const workspace = bootstrap.workspaces.find(({ id }) => id === bootstrap.activeWorkspaceId)
    ?? bootstrap.workspaces[0];
  const tab = workspace.tabs.find(({ id }) => id === workspace.activeTabId) ?? workspace.tabs[0];
  const pane = tab.panes[0];
  expect(pane).toBeTruthy();

  const activePane = page.locator(".terminal-pane.active");
  await expect(activePane).toHaveClass(/terminal-ready/, { timeout: 10_000 });
  await activePane.locator(".terminal-host textarea").evaluate((textarea: HTMLTextAreaElement) => textarea.focus());
  await page.keyboard.press("Enter");

  const copiedText = "wmux Codex copy ✓";
  const encoded = Buffer.from(copiedText).toString("base64");
  await page.evaluate(() => navigator.clipboard.writeText("wmux-copy-sentinel"));
  await page.keyboard.type(`printf '\\033]52;;${encoded}\\a'`);
  await page.keyboard.press("Enter");

  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(copiedText);
  await expect(page.getByRole("button", { name: "Copy terminal request" })).toBeHidden();
});

test("predicts bounded shell and alternate-screen input locally", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop terminal prediction coverage");
  test.setTimeout(45_000);

  let sawAlternateScreen = false;
  await page.routeWebSocket(/\/ws\/panes\//, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    browserSocket.onMessage((message) => serverSocket.send(message));
    serverSocket.onMessage((message) => {
      let delay = 0;
      try {
        const parsed = JSON.parse(String(message)) as { type?: string; data?: string };
        if (parsed.type === "output") delay = 250;
        if (parsed.data?.includes("\x1b[?1049h")) sawAlternateScreen = true;
      } catch {
        // Forward non-JSON frames without delay.
      }
      setTimeout(() => browserSocket.send(message), delay);
    });
  });

  const created = await request.post("/api/workspaces", { data: { machineId: "local" } });
  expect(created.ok()).toBeTruthy();
  const payload = await created.json() as {
    workspace: { id: string; activeTabId: string };
  };
  try {
    await page.goto(`/workspaces/${payload.workspace.id}/tabs/${payload.workspace.activeTabId}`);
    const activePane = page.locator(".terminal-pane.active");
    await expect(activePane).toHaveClass(/terminal-ready/, { timeout: 10_000 });
    const textarea = activePane.locator(".terminal-host textarea");
    await textarea.evaluate((element: HTMLTextAreaElement) => element.focus());
    await page.waitForTimeout(400);
    await page.keyboard.type("a");
    await page.waitForTimeout(350);

    await page.keyboard.type("x");
    const predictionCanvas = activePane.locator(".terminal-input-prediction-canvas");
    await expect(predictionCanvas).toHaveAttribute("data-active", "true");
    const predictedX = JSON.parse(
      (await predictionCanvas.getAttribute("data-prediction-cells")) ?? "[]",
    )[0] as { col: number; row: number };
    await page.keyboard.press("Backspace");
    await expect.poll(() => predictionCanvas.getAttribute("data-prediction-cursor"))
      .toBe(JSON.stringify({ col: predictedX.col, row: predictedX.row }));
    await expect(predictionCanvas).not.toHaveAttribute("data-active", "true", { timeout: 1_000 });

    await page.keyboard.press("Backspace");
    await page.waitForTimeout(350);
    await page.keyboard.type("PS1=$'\\e[30;46mP>' bash --noprofile --norc -i");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    await page.keyboard.type("a");
    await page.waitForTimeout(350);
    await page.keyboard.type("x");
    await expect(predictionCanvas).toHaveAttribute("data-active", "true");
    await page.keyboard.press("Control+C");
    await page.waitForTimeout(350);
    await page.keyboard.type("exit");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    await page.keyboard.type("printf '\\033[?1049h\\033[2J\\033[HREADY\\r\\n'");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    expect(sawAlternateScreen).toBe(true);
    await page.keyboard.type("a");
    await page.waitForTimeout(350);

    await page.keyboard.type("z");
    await expect(predictionCanvas).toHaveAttribute("data-active", "true");
    const predictedZ = JSON.parse(
      (await predictionCanvas.getAttribute("data-prediction-cells")) ?? "[]",
    )[0] as { col: number; row: number };
    await page.keyboard.press("Backspace");
    await expect.poll(() => predictionCanvas.getAttribute("data-prediction-cursor"))
      .toBe(JSON.stringify({ col: predictedZ.col, row: predictedZ.row }));
    await page.waitForTimeout(350);
    await page.keyboard.press("Control+C");
    await page.waitForTimeout(300);
    await page.keyboard.type("printf '\\033[?1049l'");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(350);

    await page.keyboard.press("Control+K");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await palette.getByPlaceholder("Search commands, workspaces, tabs, hosts").fill("Open diagnostics");
    await palette.getByPlaceholder("Search commands, workspaces, tabs, hosts").press("Enter");
    const diagnostics = page.getByRole("dialog", { name: "wmux diagnostics" });
    await expect(diagnostics).toBeVisible();
    await expect(diagnostics).toContainText("WMUX::SYSTEM_CONSOLE");
    await expect(diagnostics).toContainText("CLIENT::TERMINAL_LATENCY");
    await expect(diagnostics.getByRole("button", { name: /REFRESH/ })).toBeVisible();
    await expect(diagnostics.locator(".latency-row", { hasText: /SHELL::PREDICTED/i }).locator("span").nth(1)).not.toHaveText("0");
    await expect(diagnostics.locator(".latency-row", { hasText: /SHELL::CANVAS/i }).locator("span").nth(1)).not.toHaveText("0");
    await expect(diagnostics.locator(".latency-row", { hasText: /TUI::PREDICTED/i }).locator("span").nth(1)).not.toHaveText("0");
  } finally {
    const removed = await request.delete(`/api/workspaces/${payload.workspace.id}`);
    expect(removed.ok()).toBeTruthy();
  }
});

test("sends Shift+Enter as one Ctrl+J newline while preserving plain Enter", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop keyboard coverage");

  await page.addInitScript(() => {
    const inputs: string[] = [];
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function send(data) {
      if (typeof data === "string") {
        try {
          const message = JSON.parse(data) as { type?: string; data?: string; terminalResponse?: boolean };
          if (message.type === "input" && typeof message.data === "string" && message.terminalResponse !== true) {
            inputs.push(message.data);
          }
        } catch {
          // Ignore non-JSON websocket traffic.
        }
      }
      return originalSend.call(this, data);
    };
    (window as unknown as { __wmuxKeyboardInputs: string[] }).__wmuxKeyboardInputs = inputs;
  });

  const bootstrapResponse = await request.get("/api/bootstrap");
  const bootstrap = await bootstrapResponse.json() as { workspaces: unknown[] };
  if (bootstrap.workspaces.length === 0) {
    const createResponse = await request.post("/api/workspaces", { data: { machineId: "local" } });
    expect(createResponse.ok()).toBeTruthy();
  }
  await page.reload();

  const activePane = page.locator(".terminal-pane.active");
  await expect(activePane).toHaveClass(/terminal-ready/, { timeout: 10_000 });
  await activePane.locator(".terminal-host textarea").evaluate((textarea: HTMLTextAreaElement) => textarea.focus());
  await page.evaluate(() => {
    (window as unknown as { __wmuxKeyboardInputs: string[] }).__wmuxKeyboardInputs.length = 0;
  });

  await page.keyboard.press("Shift+Enter");
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __wmuxKeyboardInputs: string[] }).__wmuxKeyboardInputs,
  )).toEqual(["\n"]);

  await page.evaluate(() => {
    (window as unknown as { __wmuxKeyboardInputs: string[] }).__wmuxKeyboardInputs.length = 0;
  });
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __wmuxKeyboardInputs: string[] }).__wmuxKeyboardInputs,
  )).toEqual(["\r"]);
});

test("persists a color scheme and applies it to the shared chrome palette", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop settings coverage");
  const before = await request.get("/api/bootstrap");
  expect(before.ok()).toBeTruthy();
  const originalSettings = (await before.json() as { settings: Record<string, unknown> }).settings;

  try {
    await page.goto("/?legacy=1");
    await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
    await page.locator('button[title="Settings"]').click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByLabel("App color scheme").selectOption("dracula");
    await expect.poll(() => page.locator("html").evaluate((element) =>
      element.style.getPropertyValue("--black"),
    )).toBe("#282a36");
    await expect.poll(() => page.locator("html").evaluate((element) => ({
      browserChrome: element.style.getPropertyValue("--wmux-browser-chrome"),
      terminalBackground: element.style.getPropertyValue("--terminal-background"),
      scheme: element.dataset.colorScheme,
    }))).toEqual({
      browserChrome: "#282a36",
      terminalBackground: "#282a36",
      scheme: "dracula",
    });
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#282a36");
    await page.keyboard.press("Control+S");

    await expect.poll(async () => {
      const response = await request.get("/api/bootstrap");
      return (await response.json() as { settings: { colorScheme: string } }).settings.colorScheme;
    }).toBe("dracula");
    await page.reload();
    await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => page.locator("html").evaluate((element) =>
      element.style.getPropertyValue("--black"),
    )).toBe("#282a36");

    await page.routeWebSocket(/\/ws\/panes\//, (browserSocket) => {
      const serverSocket = browserSocket.connectToServer();
      browserSocket.onMessage((message) => serverSocket.send(message));
      serverSocket.onMessage((message) => setTimeout(() => browserSocket.send(message), 250));
    });
    await page.reload();
    const activePane = page.locator(".terminal-pane.active");
    await expect(activePane).toHaveClass(/terminal-ready/, { timeout: 10_000 });
    await activePane.locator(".terminal-host textarea").evaluate((element: HTMLTextAreaElement) => element.focus());
    await page.keyboard.type("a");
    await page.waitForTimeout(350);
    await page.keyboard.type("x");
    await expect(activePane.locator(".terminal-input-prediction-canvas")).toHaveAttribute("data-active", "true");
  } finally {
    const restored = await request.post("/api/settings", { data: originalSettings });
    expect(restored.ok()).toBeTruthy();
  }
});

test("completes a Ctrl+Alt-drag rectangle on outside mouseup and clears it on keyboard input", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop mouse gesture coverage");

  let response = await request.get("/api/bootstrap");
  expect(response.ok()).toBeTruthy();
  let bootstrap = await response.json() as {
    activeWorkspaceId: string;
    workspaces: Array<{
      id: string;
      activeTabId: string;
      tabs: Array<{ id: string; panes: Array<{ id: string }> }>;
    }>;
  };
  if (bootstrap.workspaces.length === 0) {
    response = await request.post("/api/workspaces", { data: { machineId: "local" } });
    expect(response.ok()).toBeTruthy();
    await page.reload();
    await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
    response = await request.get("/api/bootstrap");
    bootstrap = await response.json();
  }

  const workspace = bootstrap.workspaces.find(({ id }) => id === bootstrap.activeWorkspaceId)
    ?? bootstrap.workspaces[0];
  const tab = workspace.tabs.find(({ id }) => id === workspace.activeTabId) ?? workspace.tabs[0];
  const pane = tab.panes[0];
  const seed = await request.post(`/api/panes/${pane.id}/input`, {
    data: { data: "printf 'rect-one\\nrect-two\\nrect-three\\n'\r", cols: 100, rows: 30 },
  });
  expect(seed.ok()).toBeTruthy();

  const activePane = page.locator(".terminal-pane.active");
  await expect(activePane).toHaveClass(/terminal-ready/, { timeout: 10_000 });
  const canvas = activePane.locator(".terminal-host canvas");
  await expect(canvas).toBeVisible();
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error("terminal canvas has no bounding box");

  await page.keyboard.down("Control");
  await page.keyboard.down("Alt");
  await page.mouse.move(canvasBox.x + 12, canvasBox.y + 12);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 92, canvasBox.y + 52, { steps: 4 });
  await expect(activePane.locator(".terminal-rectangle-selection")).toBeVisible();
  await page.mouse.move(canvasBox.x + 92, Math.max(1, canvasBox.y - 8));
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await page.keyboard.up("Control");

  const overlay = activePane.locator(".terminal-rectangle-selection");
  await expect(overlay).toBeVisible();
  const overlayBox = await overlay.boundingBox();
  expect(overlayBox).toBeTruthy();
  expect(overlayBox!.y).toBeGreaterThanOrEqual(canvasBox.y - 1);
  expect(overlayBox!.y + overlayBox!.height).toBeLessThanOrEqual(canvasBox.y + canvasBox.height + 1);

  await page.keyboard.press("x");
  await expect(overlay).toHaveCount(0);
  await page.keyboard.press("Control+C");
});

test("does not forward a primary drag from the hidden terminal input as PTY mouse motion", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop mouse gesture coverage");

  await page.addInitScript(() => {
    const sent: string[] = [];
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function send(data) {
      if (typeof data === "string") sent.push(data);
      return originalSend.call(this, data);
    };
    (window as unknown as { __wmuxSentSocketMessages: string[] }).__wmuxSentSocketMessages = sent;
  });
  await page.reload();

  let response = await request.get("/api/bootstrap");
  let bootstrap = await response.json() as {
    activeWorkspaceId: string;
    workspaces: Array<{
      id: string;
      activeTabId: string;
      tabs: Array<{ id: string; panes: Array<{ id: string }> }>;
    }>;
  };
  if (bootstrap.workspaces.length === 0) {
    response = await request.post("/api/workspaces", { data: { machineId: "local" } });
    expect(response.ok()).toBeTruthy();
    await page.reload();
    response = await request.get("/api/bootstrap");
    bootstrap = await response.json();
  }

  const workspace = bootstrap.workspaces.find(({ id }) => id === bootstrap.activeWorkspaceId)
    ?? bootstrap.workspaces[0];
  const tab = workspace.tabs.find(({ id }) => id === workspace.activeTabId) ?? workspace.tabs[0];
  const pane = tab.panes[0];
  const activePane = page.locator(".terminal-pane.active");
  await expect(activePane).toHaveClass(/terminal-ready/, { timeout: 10_000 });

  const enableMouse = await request.post(`/api/panes/${pane.id}/input`, {
    data: { data: "printf '\\033[?1000h\\033[?1002h\\033[?1006h'\r", cols: 100, rows: 30 },
  });
  expect(enableMouse.ok()).toBeTruthy();
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    (window as unknown as { __wmuxSentSocketMessages: string[] }).__wmuxSentSocketMessages.length = 0;
  });

  await activePane.locator(".terminal-host textarea").evaluate((textarea) => {
    const rect = textarea.getBoundingClientRect();
    const down = new MouseEvent("mousedown", {
      bubbles: true,
      button: 0,
      clientX: rect.left + 1,
      clientY: rect.top + 1,
    });
    const move = new MouseEvent("mousemove", {
      bubbles: true,
      buttons: 1,
      clientX: rect.left + 24,
      clientY: rect.top + 12,
    });
    const up = new MouseEvent("mouseup", {
      bubbles: true,
      button: 0,
      clientX: rect.left + 24,
      clientY: rect.top + 12,
    });
    textarea.dispatchEvent(down);
    textarea.dispatchEvent(move);
    textarea.dispatchEvent(up);
  });

  const paneInputs = await page.evaluate(() =>
    (window as unknown as { __wmuxSentSocketMessages: string[] }).__wmuxSentSocketMessages
      .flatMap((message) => {
        try {
          const parsed = JSON.parse(message) as { type?: string; data?: string };
          return parsed.type === "input" && typeof parsed.data === "string" ? [parsed.data] : [];
        } catch {
          return [];
        }
      }),
  );
  expect(paneInputs.some((data) => data.includes("\x1b[<32;"))).toBe(false);
});
