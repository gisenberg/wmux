import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    Math.random = () => 0;
  });
  await page.goto("/");
  await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
});

const routeTerminalFontFamily = async (page: Page, terminalFontFamily: string): Promise<void> => {
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({ response, json: { ...payload, terminalFontFamily } });
  });
  await page.routeWebSocket("**/ws/events", (webSocket) => {
    const server = webSocket.connectToServer();
    server.onMessage((message) => {
      if (typeof message !== "string") {
        webSocket.send(message);
        return;
      }
      try {
        const payload = JSON.parse(message) as { type?: string; state?: Record<string, unknown> };
        if (payload.type === "snapshot" && payload.state) {
          webSocket.send(JSON.stringify({
            ...payload,
            state: { ...payload.state, terminalFontFamily },
          }));
          return;
        }
      } catch {
        // Forward non-JSON event messages unchanged.
      }
      webSocket.send(message);
    });
  });
};

interface E2eWorkspace {
  id: string;
  name: string;
  activeTabId: string;
  parentWorkspaceId?: string;
  tabs: Array<{ panes: Array<{ id: string }> }>;
}

const createNestedWorkspacePair = async (request: APIRequestContext): Promise<{
  root: E2eWorkspace;
  child: E2eWorkspace;
}> => {
  const rootResponse = await request.post("/api/workspaces", { data: { machineId: "local" } });
  expect(rootResponse.ok()).toBeTruthy();
  const root = (await rootResponse.json() as { workspace: E2eWorkspace }).workspace;
  const childResponse = await request.post("/api/workspaces", {
    data: {
      machineId: "local",
      createdBy: "agent",
      parentPaneId: root.tabs[0].panes[0].id,
    },
  });
  expect(childResponse.ok()).toBeTruthy();
  const child = (await childResponse.json() as { workspace: E2eWorkspace }).workspace;
  return { child, root };
};

test("publishes standalone app metadata for direct workspace routes", async ({ page, request }) => {
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#101114");
  await expect(page.locator('meta[name="mobile-web-app-capable"]')).toHaveAttribute("content", "yes");
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute("content", "yes");
  await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute(
    "content",
    "black-translucent",
  );
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/site.webmanifest");

  const response = await request.get("/site.webmanifest");
  expect(response.ok()).toBeTruthy();
  expect(await response.json()).toMatchObject({
    start_url: "/",
    scope: "/",
    display: "standalone",
    icons: expect.arrayContaining([
      expect.objectContaining({ src: "/icons/wmux-192.png", sizes: "192x192" }),
      expect.objectContaining({ src: "/icons/wmux-512.png", sizes: "512x512" }),
      expect.objectContaining({ src: "/icons/wmux-maskable-512.png", purpose: "maskable" }),
    ]),
  });
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "/icons/wmux-apple-touch-180.png");
  for (const icon of ["wmux-apple-touch-180.png", "wmux-192.png", "wmux-512.png", "wmux-maskable-512.png"]) {
    const iconResponse = await request.get(`/icons/${icon}`);
    expect(iconResponse.ok()).toBeTruthy();
    expect(iconResponse.headers()["content-type"]).toContain("image/png");
  }
});

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
    const predictionFontFamily = getComputedStyle(
      document.querySelector(".terminal-input-prediction-layer") as HTMLElement,
    ).fontFamily;
    return { faces, predictionFontFamily, terminalFontFamily };
  });

  expect(result.faces).toEqual(expect.arrayContaining([
    { style: "normal", weight: "400", status: "loaded" },
    { style: "normal", weight: "700", status: "loaded" },
    { style: "italic", weight: "400", status: "loaded" },
    { style: "italic", weight: "700", status: "loaded" },
  ]));
  expect(result.faces).toHaveLength(4);
  expect(result.terminalFontFamily).toContain("MesloLGM Nerd Font");
  expect(result.predictionFontFamily).toBe(result.terminalFontFamily);
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

test("creates a workspace through the command palette and preserves its direct link", async ({ page, request }, testInfo) => {
  if (testInfo.project.name.startsWith("mobile-")) {
    await page.getByRole("banner", { name: "Mobile session controls" })
      .getByRole("button", { name: "Open terminal" })
      .click();
  }
  const before = await request.get("/api/bootstrap");
  expect(before.ok()).toBeTruthy();
  const beforePayload = await before.json() as { workspaces: unknown[] };
  let releaseCreation = () => undefined;
  const creationGate = new Promise<void>((resolve) => {
    releaseCreation = resolve;
  });
  await page.route("**/api/workspaces", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await creationGate;
    await route.continue();
  });

  await page.keyboard.press("Control+K");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await palette.getByPlaceholder("Search commands, workspaces, tabs, hosts").fill("New workspace on Local");
  await palette.getByPlaceholder("Search commands, workspaces, tabs, hosts").press("Enter");
  await expect(page.locator(".terminal-startup-status", { hasText: "Creating shell on local" })).toBeVisible();
  releaseCreation();

  await expect.poll(async () => {
    const response = await request.get("/api/bootstrap");
    const payload = await response.json() as { workspaces: unknown[] };
    return payload.workspaces.length;
  }).toBe(beforePayload.workspaces.length + 1);

  const current = await request.get("/api/bootstrap");
  const payload = await current.json() as {
    activeWorkspaceId: string;
    workspaces: Array<{ id: string; activeTabId: string }>;
  };
  const workspace = payload.workspaces.find((candidate) => candidate.id === payload.activeWorkspaceId);
  expect(workspace).toBeTruthy();
  expect(workspace?.id).toMatch(/^ws_[0-9a-f]{32}$/);
  const directPath = `/workspaces/${workspace?.id}/tabs/${workspace?.activeTabId}`;
  await expect(page).toHaveURL(new RegExp(`${directPath.replaceAll("/", "\\/")}$`));
  await page.reload();
  await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(new RegExp(`${directPath.replaceAll("/", "\\/")}$`));
});

test("workspace tooltips expose the active pane session identifier", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop hover coverage");
  test.setTimeout(60_000);

  const response = await request.post("/api/workspaces", { data: { machineId: "local" } });
  expect(response.ok()).toBeTruthy();
  const payload = await response.json() as {
    workspace: {
      id: string;
      name: string;
      activeTabId: string;
      tabs: Array<{ id: string; activePaneId: string; panes: Array<{ id: string }> }>;
    };
  };
  const workspace = payload.workspace;
  const tab = workspace.tabs.find((candidate) => candidate.id === workspace.activeTabId);
  const pane = tab?.panes.find((candidate) => candidate.id === tab.activePaneId);
  expect(pane).toBeTruthy();
  if (!pane) throw new Error("active session is unavailable");

  try {
    await page.goto("/?legacy=1");
    await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
    const workspaceRow = page.locator(`a.workspace-item[href^="/workspaces/${workspace.id}/"]`);
    await expect(workspaceRow).toHaveAttribute("title", new RegExp(`Session ${pane.id}`));

    await page.goto("/");
    await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
    const canvas = page.locator(".open-tui-sidebar canvas");
    await expect(canvas).toBeVisible();
    const found = await canvas.evaluate((element: HTMLCanvasElement, expected) => {
      const rect = element.getBoundingClientRect();
      for (let y = 0; y < rect.height; y += 3) {
        element.dispatchEvent(new PointerEvent("pointermove", {
          bubbles: true,
          clientX: rect.left + 40,
          clientY: rect.top + y,
          pointerId: 98,
        }));
        if (element.title.includes(expected)) return true;
      }
      return false;
    }, `Session ${pane.id}`);
    expect(found).toBe(true);
  } finally {
    await request.delete(`/api/workspaces/${workspace.id}`);
  }
});

test("navigates, persists, filters, and moves nested workspaces", async ({ page, request }, testInfo) => {
  test.setTimeout(60_000);
  const { child, root } = await createNestedWorkspacePair(request);
  const rootPath = `/workspaces/${root.id}/tabs/${root.activeTabId}`;
  const openWorkspaceNavigation = async () => {
    if (!testInfo.project.name.startsWith("mobile-")) return;
    await page.getByRole("banner", { name: "Mobile session controls" })
      .getByRole("button", { name: "Open workspaces and hosts" })
      .click();
  };
  const rootItem = () => page.locator(`a[role="treeitem"][href^="/workspaces/${root.id}/"]`);
  const childItem = () => page.locator(`a[role="treeitem"][href^="/workspaces/${child.id}/"]`);

  try {
    await page.goto(rootPath);
    await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
    await openWorkspaceNavigation();
    await expect(rootItem()).toHaveAttribute("aria-level", "1");
    await expect(rootItem()).toHaveAttribute("aria-expanded", "true");
    await expect(childItem()).toHaveAttribute("aria-level", "2");
    await expect(childItem()).toHaveAttribute("href", new RegExp(`^/workspaces/${child.id}/tabs/${child.activeTabId}$`));

    await page.getByRole("button", { name: `Collapse ${root.name}` }).press("Enter");
    await expect(rootItem()).toHaveAttribute("aria-expanded", "false");
    await expect(childItem()).toHaveCount(0);
    await expect.poll(async () => {
      const response = await request.get("/api/bootstrap");
      const payload = await response.json() as { settings: { collapsedWorkspaceIds: string[] } };
      return payload.settings.collapsedWorkspaceIds;
    }).toContain(root.id);

    await page.reload();
    await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
    await openWorkspaceNavigation();
    await expect(rootItem()).toHaveAttribute("aria-expanded", "false");
    await expect(childItem()).toHaveCount(0);

    await page.getByRole("button", { name: `Expand ${root.name}` }).press("Enter");
    await expect(childItem()).toHaveAttribute("aria-level", "2");
    await page.getByRole("button", { name: `Move ${child.name}` }).press("Enter");
    const moveDialog = page.getByRole("dialog", { name: `Move ${child.name}` });
    await expect(moveDialog).toBeVisible();
    if (testInfo.project.name.startsWith("mobile-")) {
      const actionBoxes = await moveDialog.locator(".workspace-move-actions button").evaluateAll((buttons) => buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      }));
      expect(actionBoxes).toHaveLength(4);
      expect(actionBoxes.every((box) => box.left === actionBoxes[0].left && box.width === actionBoxes[0].width)).toBe(true);
      expect(actionBoxes.every((box, index) => box.height >= 44 && box.right <= page.viewportSize()!.width && (
        index === 0 || box.top > actionBoxes[index - 1].top
      ))).toBe(true);
    }
    await moveDialog.getByRole("button", { name: "Move out one level" }).click();
    await expect.poll(async () => {
      const response = await request.get("/api/bootstrap");
      const payload = await response.json() as { workspaces: E2eWorkspace[] };
      return payload.workspaces.find((workspace) => workspace.id === child.id)?.parentWorkspaceId ?? null;
    }).toBeNull();
    await expect(childItem()).toHaveAttribute("aria-level", "1");

    await expect(page.getByRole("button", { name: `Move ${child.name}` })).toBeVisible();
    if (testInfo.project.name.startsWith("mobile-")) {
      await page.getByRole("combobox", { name: "Filter workspace list by host" }).selectOption("local");
    } else {
      await page.getByRole("button", { name: /^Workspace host filter:/ }).press("Enter");
    }
    await expect(page.getByRole("button", { name: `Move ${child.name}` })).toHaveCount(0);
    await expect(rootItem()).toBeVisible();
    await expect(childItem()).toBeVisible();
  } finally {
    await request.delete(`/api/workspaces/${child.id}`);
    await request.delete(`/api/workspaces/${root.id}`);
  }
});

test("legacy workspace tree preserves nested indentation and agent origin", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "legacy desktop tree coverage");
  const { child, root } = await createNestedWorkspacePair(request);
  try {
    await page.goto(`/workspaces/${root.id}/tabs/${root.activeTabId}?legacy=1`);
    await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
    const rootItem = page.locator(`a.workspace-item[href^="/workspaces/${root.id}/"]`);
    const childItem = page.locator(`a.workspace-item[href^="/workspaces/${child.id}/"]`);
    await expect(rootItem).toHaveAttribute("aria-level", "1");
    await expect(childItem).toHaveAttribute("aria-level", "2");
    await expect(rootItem.locator("xpath=..")).toHaveCSS("margin-left", "0px");
    await expect(childItem.locator("xpath=..")).toHaveCSS("margin-left", "14px");
    await expect(childItem.getByTitle("Created by an agent")).toHaveText("AI");
    await page.getByRole("button", { name: `Collapse ${root.name}` }).click();
    await expect(childItem).toHaveCount(0);
    await page.getByRole("button", { name: `Expand ${root.name}` }).click();
    await expect(childItem).toBeVisible();
  } finally {
    await request.delete(`/api/workspaces/${child.id}`);
    await request.delete(`/api/workspaces/${root.id}`);
  }
});

test("drags legacy workspace rows into a persisted order", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop drag-and-drop coverage");
  const firstResponse = await request.post("/api/workspaces", { data: { machineId: "local" } });
  const secondResponse = await request.post("/api/workspaces", { data: { machineId: "local" } });
  expect(firstResponse.ok()).toBeTruthy();
  expect(secondResponse.ok()).toBeTruthy();
  const first = (await firstResponse.json() as { workspace: { id: string } }).workspace;
  const second = (await secondResponse.json() as { workspace: { id: string } }).workspace;

  try {
    await page.goto("/?legacy=1");
    await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
    const source = page.locator(`a.workspace-item[href^="/workspaces/${second.id}/"]`);
    const target = page.locator(`a.workspace-item[href^="/workspaces/${first.id}/"]`);
    await expect(source).toBeVisible();
    await expect(target).toBeVisible();
    await source.dragTo(target, { targetPosition: { x: 30, y: 55 } });

    await expect.poll(async () => {
      const response = await request.get("/api/bootstrap");
      const payload = await response.json() as { workspaces: Array<{ id: string }> };
      return payload.workspaces.map((workspace) => workspace.id).slice(0, 2);
    }).toEqual([first.id, second.id]);
  } finally {
    await request.delete(`/api/workspaces/${second.id}`);
    await request.delete(`/api/workspaces/${first.id}`);
  }
});

test("drags canvas workspace rows into a persisted order", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop canvas drag coverage");
  const firstResponse = await request.post("/api/workspaces", { data: { machineId: "local" } });
  const secondResponse = await request.post("/api/workspaces", { data: { machineId: "local" } });
  expect(firstResponse.ok()).toBeTruthy();
  expect(secondResponse.ok()).toBeTruthy();
  const first = (await firstResponse.json() as { workspace: { id: string; name: string } }).workspace;
  const second = (await secondResponse.json() as { workspace: { id: string; name: string } }).workspace;

  try {
    await page.goto("/");
    await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
    const canvas = page.locator(".open-tui-sidebar canvas");
    await expect(canvas).toBeVisible();
    const bounds = await canvas.evaluate((element: HTMLCanvasElement, names) => {
      const rect = element.getBoundingClientRect();
      const result: Record<string, { min: number; max: number }> = {};
      for (let y = 0; y < rect.height; y += 3) {
        element.dispatchEvent(new PointerEvent("pointermove", {
          bubbles: true,
          clientX: rect.left + 40,
          clientY: rect.top + y,
          pointerId: 99,
        }));
        for (const name of names) {
          if (!element.title.includes(name) || !element.title.includes("drag to reorder")) continue;
          const current = result[name];
          result[name] = current ? { min: Math.min(current.min, y), max: Math.max(current.max, y) } : { min: y, max: y };
        }
      }
      return result;
    }, [first.name, second.name]);
    expect(bounds[first.name]).toBeTruthy();
    expect(bounds[second.name]).toBeTruthy();
    const box = await canvas.boundingBox();
    expect(box).toBeTruthy();
    if (!box) throw new Error("canvas has no bounds");

    await page.mouse.move(box.x + 40, box.y + (bounds[second.name].min + bounds[second.name].max) / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + bounds[first.name].max, { steps: 12 });
    await page.mouse.up();

    await expect.poll(async () => {
      const response = await request.get("/api/bootstrap");
      const payload = await response.json() as { workspaces: Array<{ id: string }> };
      return payload.workspaces.map((workspace) => workspace.id).slice(0, 2);
    }).toEqual([first.id, second.id]);
  } finally {
    await request.delete(`/api/workspaces/${second.id}`);
    await request.delete(`/api/workspaces/${first.id}`);
  }
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
    const predictedX = activePane.locator(".terminal-input-prediction-cell", { hasText: "x" });
    await expect(predictedX).toBeVisible();
    const predictedXLeft = await predictedX.evaluate((element: HTMLElement) => element.style.left);
    await page.keyboard.press("Backspace");
    await expect.poll(() => activePane.locator(".terminal-input-prediction-cursor")
      .evaluate((element: HTMLElement) => element.style.left)).toBe(predictedXLeft);
    await expect(activePane.locator(".terminal-input-prediction-layer")).toBeEmpty({ timeout: 1_000 });

    await page.keyboard.press("Backspace");
    await page.waitForTimeout(350);
    await page.keyboard.type("printf '\\033[48;2;12;34;56m   \\b\\b\\b'; bash -c 'IFS= read -r -n 3 value'; printf '\\033[0m'");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(350);
    await page.keyboard.type("a");
    await page.waitForTimeout(350);
    await page.keyboard.type("x");
    const coloredPrediction = activePane.locator(".terminal-input-prediction-cell", { hasText: "x" });
    await expect(coloredPrediction).toHaveCSS("background-color", "rgb(12, 34, 56)");
    await page.keyboard.type("y");
    await page.waitForTimeout(350);
    await page.keyboard.type("(sleep 1; printf '\\rBACKGROUND') &");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(350);
    await page.keyboard.type("a");
    await page.waitForTimeout(1_100);
    await page.keyboard.type("x");
    await expect(activePane.locator(".terminal-input-prediction-layer")).toBeEmpty();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(700);
    await page.keyboard.type("printf '\\033[?1049h\\033[2J\\033[HREADY\\r\\n'");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    expect(sawAlternateScreen).toBe(true);
    await page.keyboard.type("a");
    await page.waitForTimeout(350);

    await page.keyboard.type("z");
    const predictedZ = activePane.locator(".terminal-input-prediction-cell", { hasText: "z" });
    await expect(predictedZ).toBeVisible();
    const predictedZLeft = await predictedZ.evaluate((element: HTMLElement) => element.style.left);
    await page.keyboard.press("Backspace");
    await expect.poll(() => activePane.locator(".terminal-input-prediction-cursor")
      .evaluate((element: HTMLElement) => element.style.left)).toBe(predictedZLeft);
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

test("keeps the loaded UI and recovers when a wake-up bootstrap briefly fails", async ({ page }) => {
  let failures = 0;
  let requests = 0;
  await page.route("**/api/bootstrap", async (route) => {
    requests += 1;
    if (failures < 2) {
      failures += 1;
      await route.abort("internetdisconnected");
      return;
    }
    await route.continue();
  });

  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator("main.app-shell")).toBeVisible();
  await expect(page.getByText(/wmux failed to load/i)).toHaveCount(0);
  await expect.poll(() => failures).toBe(2);
  await expect.poll(() => requests, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
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
  } finally {
    const restored = await request.post("/api/settings", { data: originalSettings });
    expect(restored.ok()).toBeTruthy();
  }
});

test("idle Life field stays bounded and pauses when it leaves the viewport", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop WebGL lifecycle coverage");
  test.setTimeout(60_000);

  const response = await request.get("/api/bootstrap");
  expect(response.ok()).toBeTruthy();
  const bootstrap = await response.json() as { workspaces: Array<{ id: string }> };

  try {
    for (const workspace of bootstrap.workspaces) {
      const removed = await request.delete(`/api/workspaces/${workspace.id}`);
      expect(removed.ok()).toBeTruthy();
    }
    await page.reload();

    const canvas = page.getByLabel("Interactive Game of Life field; click a column to toggle a cell");
    await expect(canvas).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => Number(await canvas.getAttribute("data-render-frame") ?? 0)).toBeGreaterThan(2);

    const renderSize = await canvas.evaluate((element: HTMLCanvasElement) => ({
      pixels: element.width * element.height,
      fps: Number(element.dataset.renderFps),
    }));
    expect(renderSize.pixels).toBeLessThanOrEqual(520_000);
    expect(renderSize.fps).toBeGreaterThanOrEqual(8);
    expect(renderSize.fps).toBeLessThanOrEqual(12);

    await canvas.evaluate((element) => {
      element.closest<HTMLElement>(".empty-workspace-view")!.style.display = "none";
    });
    await page.waitForTimeout(180);
    const pausedAt = Number(await canvas.getAttribute("data-render-frame"));
    await page.waitForTimeout(300);
    expect(Number(await canvas.getAttribute("data-render-frame"))).toBe(pausedAt);

    await canvas.evaluate((element) => {
      element.closest<HTMLElement>(".empty-workspace-view")!.style.display = "";
    });
    await expect.poll(async () => Number(await canvas.getAttribute("data-render-frame"))).toBeGreaterThan(pausedAt);
    await canvas.click({ position: { x: 80, y: 80 } });
  } finally {
    if (bootstrap.workspaces.length > 0) {
      const restored = await request.post("/api/workspaces", { data: { machineId: "local" } });
      expect(restored.ok()).toBeTruthy();
    }
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

test("mobile chrome keeps navigation, chat, terminal, and actions reachable", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile-"), "mobile-only smoke coverage");
  test.setTimeout(60_000);

  const terminalOutputWriters = new Set<(data: string) => void>();
  await page.routeWebSocket(/\/ws\/panes\//, (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    browserSocket.onMessage((message) => serverSocket.send(message));
    serverSocket.onMessage((message) => browserSocket.send(message));
    terminalOutputWriters.add((data) => browserSocket.send(JSON.stringify({ type: "output", data })));
  });
  await page.addInitScript(() => {
    const sent: string[] = [];
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function send(data) {
      if (typeof data === "string") sent.push(data);
      return originalSend.call(this, data);
    };
    (window as unknown as { __wmuxMobileSocketMessages: string[] }).__wmuxMobileSocketMessages = sent;
  });
  await page.reload();

  const chrome = page.getByRole("banner", { name: "Mobile session controls" });
  await expect(chrome).toBeVisible();
  await expect.poll(() => chrome.evaluate((element) => Math.round(element.getBoundingClientRect().height))).toBe(96);
  const modeRowGeometry = await chrome.evaluate((element) => {
    const canvas = element.querySelector("canvas")?.getBoundingClientRect();
    const actions = element.querySelector(".open-tui-mobile-chrome-actions")?.getBoundingClientRect();
    if (!canvas || !actions) return null;
    const cellHeight = Math.round(12 * 1.2);
    const rows = Math.max(1, Math.floor(canvas.height / cellHeight));
    const actionBoundary = Math.max(0, canvas.height - actions.height);
    const paintedActionTop = canvas.top + Math.min(rows - 1, Math.ceil(actionBoundary / cellHeight)) * cellHeight;
    return { actionTop: actions.top, paintedActionTop };
  });
  expect(modeRowGeometry).not.toBeNull();
  expect(modeRowGeometry!.paintedActionTop).toBeGreaterThanOrEqual(modeRowGeometry!.actionTop);
  await expect(chrome.getByRole("button", { name: "Open terminal" })).toHaveAttribute("aria-pressed", "true");
  await chrome.getByRole("button", { name: "Open chat" }).click();
  await expect(page.getByText("No agent detected", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Agent message" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Interrupt agent" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start Codex" })).toBeVisible();
  await chrome.getByRole("button", { name: "Open terminal" }).click();
  const activePane = page.locator(".terminal-pane.active");
  await expect(activePane).toHaveClass(/terminal-ready/, { timeout: 10_000 });

  const touchBehavior = await activePane.locator(".terminal-host-shell").evaluate((element) => {
    const shell = element as HTMLElement;
    const rect = shell.getBoundingClientRect();
    const dispatch = (type: string, pointerId: number, clientY: number) => {
      const event = new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId,
        pointerType: "touch",
        isPrimary: true,
        clientX: rect.left + 20,
        clientY,
      });
      shell.dispatchEvent(event);
      return event.defaultPrevented;
    };

    dispatch("pointerdown", 41, rect.top + 100);
    const swipePrevented = dispatch("pointermove", 41, rect.top + 40);
    dispatch("pointerup", 41, rect.top + 40);

    (document.activeElement as HTMLElement | null)?.blur();
    dispatch("pointerdown", 42, rect.top + 80);
    dispatch("pointerup", 42, rect.top + 80);
    return {
      swipePrevented,
      tapFocusedTerminal: document.activeElement === shell.querySelector("textarea"),
      touchAction: getComputedStyle(shell).touchAction,
    };
  });
  expect(touchBehavior).toEqual({ swipePrevented: true, tapFocusedTerminal: true, touchAction: "none" });

  const fullViewport = page.viewportSize();
  expect(fullViewport).toBeTruthy();
  await page.setViewportSize({ width: fullViewport!.width, height: Math.min(520, fullViewport!.height - 120) });
  await expect(page.locator("main.app-shell")).toHaveClass(/mobile-keyboard-open/);
  const terminalKeys = page.getByRole("toolbar", { name: "Terminal keys" });
  await expect(terminalKeys).toBeVisible();
  const keySizes = await terminalKeys.getByRole("button").evaluateAll((buttons) => buttons.map((button) => {
    const rect = button.getBoundingClientRect();
    return { width: Math.round(rect.width), height: Math.round(rect.height) };
  }));
  expect(keySizes.every(({ width, height }) => width >= 44 && height >= 44)).toBe(true);
  await terminalKeys.getByRole("button", { name: "Esc" }).click();
  await terminalKeys.getByRole("button", { name: "Ctrl" }).click();
  await expect(terminalKeys.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.type("c");
  await expect(terminalKeys.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __wmuxMobileSocketMessages: string[] }).__wmuxMobileSocketMessages
      .flatMap((message) => {
        try {
          const parsed = JSON.parse(message) as { type?: string; data?: string };
          return parsed.type === "input" ? [parsed.data] : [];
        } catch {
          return [];
        }
      }),
  )).toEqual(expect.arrayContaining(["\x1b", "\x03"]));
  await terminalKeys.getByRole("button", { name: "Ctrl" }).click();
  await page.keyboard.insertText("ß");
  await expect(terminalKeys.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __wmuxMobileSocketMessages: string[] }).__wmuxMobileSocketMessages
      .flatMap((message) => {
        try {
          const parsed = JSON.parse(message) as { type?: string; data?: string };
          return parsed.type === "input" ? [parsed.data] : [];
        } catch {
          return [];
        }
      }),
  )).toEqual(expect.arrayContaining(["ß"]));
  const unicodeInputs = await page.evaluate(() =>
    (window as unknown as { __wmuxMobileSocketMessages: string[] }).__wmuxMobileSocketMessages
      .flatMap((message) => {
        try {
          const parsed = JSON.parse(message) as { type?: string; data?: string };
          return parsed.type === "input" ? [parsed.data] : [];
        } catch {
          return [];
        }
      }),
  );
  expect(unicodeInputs).not.toContain("\x13");
  for (const writeTerminalOutput of terminalOutputWriters) writeTerminalOutput("\x1b[?1h");
  await terminalKeys.getByRole("button", { name: "Arrow up" }).click();
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __wmuxMobileSocketMessages: string[] }).__wmuxMobileSocketMessages
      .flatMap((message) => {
        try {
          const parsed = JSON.parse(message) as { type?: string; data?: string };
          return parsed.type === "input" ? [parsed.data] : [];
        } catch {
          return [];
        }
      }),
  )).toEqual(expect.arrayContaining(["\x1bOA"]));
  for (const writeTerminalOutput of terminalOutputWriters) writeTerminalOutput("\x1b[?1l");
  await terminalKeys.getByRole("button", { name: "Arrow down" }).click();
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __wmuxMobileSocketMessages: string[] }).__wmuxMobileSocketMessages
      .flatMap((message) => {
        try {
          const parsed = JSON.parse(message) as { type?: string; data?: string };
          return parsed.type === "input" ? [parsed.data] : [];
        } catch {
          return [];
        }
      }),
  )).toEqual(expect.arrayContaining(["\x1b[B"]));
  await page.setViewportSize(fullViewport!);
  await expect(page.locator("main.app-shell")).not.toHaveClass(/mobile-keyboard-open/);

  await activePane.getByRole("button", { name: "Close pane" }).click();
  const closeDialog = page.getByRole("dialog", { name: "Close pane?" });
  await expect(closeDialog).toBeVisible();
  await expect(closeDialog).toContainText("kill 1 backing session");
  await expect(closeDialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  const closeActionSizes = await closeDialog.getByRole("button").evaluateAll((buttons) => buttons.map((button) => {
    const rect = button.getBoundingClientRect();
    return { width: Math.round(rect.width), height: Math.round(rect.height) };
  }));
  expect(closeActionSizes.every(({ width, height }) => width >= 44 && height >= 44)).toBe(true);
  await page.keyboard.press("Shift+Tab");
  await expect(closeDialog.getByRole("button", { name: "Close pane" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeDialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await closeDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(closeDialog).toBeHidden();
  await expect(activePane).toBeVisible();

  const appShell = page.locator("main.app-shell");
  await appShell.evaluate((element: HTMLElement) => {
    element.style.setProperty("--wmux-mobile-left-inset", "32px");
    element.style.setProperty("--wmux-mobile-right-inset", "48px");
  });
  await expect.poll(() => activePane.locator(".terminal-host-shell").evaluate((element) => {
    const style = window.getComputedStyle(element);
    return { left: style.paddingLeft, right: style.paddingRight };
  })).toEqual({ left: "32px", right: "48px" });
  await expect.poll(() => activePane.locator(".terminal-input-prediction-layer").evaluate((element) => {
    const hostRect = element.parentElement!.getBoundingClientRect();
    const layerRect = element.getBoundingClientRect();
    return {
      left: Math.round(layerRect.left - hostRect.left),
      right: Math.round(hostRect.right - layerRect.right),
    };
  })).toEqual({ left: 32, right: 48 });
  const chromeInsets = await page.locator(".open-tui-mobile-chrome-canvas").evaluate((canvas) => {
    const chromeRect = canvas.parentElement!.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    return {
      left: Math.round(canvasRect.left - chromeRect.left),
      right: Math.round(chromeRect.right - canvasRect.right),
    };
  });
  expect(chromeInsets).toEqual({ left: 32, right: 48 });
  await appShell.evaluate((element: HTMLElement) => {
    element.style.removeProperty("--wmux-mobile-left-inset");
    element.style.removeProperty("--wmux-mobile-right-inset");
  });

  await chrome.getByRole("button", { name: "Open workspaces and hosts" }).click();
  const navigation = page.getByRole("complementary", { name: "Workspace navigation" });
  await expect(navigation).toBeVisible();
  await expect(navigation.locator(".workspace-version-badge")).toHaveCount(0);
  const moveTarget = navigation.getByRole("button", { name: /^Move / }).first();
  await expect.poll(() => moveTarget.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { width: Math.round(rect.width), height: Math.round(rect.height) };
  })).toEqual({ width: 44, height: 44 });
  const hostSummary = navigation.getByRole("button", { name: /Host status/i });
  await expect(hostSummary).toHaveAttribute("aria-expanded", "false");
  await expect(navigation.locator(".machine-list")).toBeHidden();
  await hostSummary.click();
  await expect(navigation.locator(".machine-list")).toBeVisible();
  await page.locator("button.mobile-sidebar-close").click();
  await expect(navigation).toBeHidden();

  await chrome.getByRole("button", { name: "Open actions" }).click();
  const commandPalette = page.getByRole("dialog", { name: "Command palette" });
  await expect(commandPalette).toBeVisible();
  await expect(page.locator(".command-item").first()).toContainText("Split right");
  await commandPalette.locator("input").fill("Close current tab");
  await page.keyboard.press("Enter");
  const closeTabDialog = page.getByRole("dialog", { name: "Close tab?" });
  await expect(closeTabDialog).toBeVisible();
  await closeTabDialog.getByRole("button", { name: "Cancel" }).click();

  await chrome.getByRole("button", { name: "Open actions" }).click();
  await commandPalette.locator("input").fill("Close current workspace");
  await page.keyboard.press("Enter");
  const closeWorkspaceDialog = page.getByRole("dialog", { name: "Close workspace?" });
  await expect(closeWorkspaceDialog).toBeVisible();
  await closeWorkspaceDialog.getByRole("button", { name: "Cancel" }).click();
});

test("mobile boot profiles cannot tint browser safe-area chrome", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile-"), "mobile-only safe-area coverage");

  const bootColors = await page.evaluate(() => {
    const screen = document.createElement("main");
    screen.className = "retro-boot-screen";
    screen.style.setProperty("--retro-page", "#55ccee");
    screen.style.setProperty("--retro-background", "#55ccee");
    screen.style.setProperty("--wmux-mobile-top-inset", "31px");
    screen.style.setProperty("--wmux-mobile-right-inset", "13px");
    screen.style.setProperty("--wmux-mobile-bottom-inset", "29px");
    screen.style.setProperty("--wmux-mobile-left-inset", "17px");
    const bezel = document.createElement("section");
    bezel.className = "retro-boot-bezel";
    screen.append(bezel);
    document.body.append(screen);

    const screenStyle = getComputedStyle(screen);
    const bezelStyle = getComputedStyle(bezel);
    const result = {
      screen: screenStyle.backgroundColor,
      bezel: bezelStyle.backgroundColor,
      padding: [
        screenStyle.paddingTop,
        screenStyle.paddingRight,
        screenStyle.paddingBottom,
        screenStyle.paddingLeft,
      ],
    };
    screen.remove();
    return result;
  });

  expect(bootColors).toEqual({
    screen: "rgb(16, 17, 20)",
    bezel: "rgb(85, 204, 238)",
    padding: ["31px", "13px", "29px", "17px"],
  });
});

test("mobile boot exits without a decorative delay once bootstrap is ready", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile-"), "mobile-only boot timing coverage");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  let markBootstrapReady: (() => void) | undefined;
  const bootstrapReady = new Promise<void>((resolve) => {
    markBootstrapReady = resolve;
  });
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/bootstrap" && response.ok()) markBootstrapReady?.();
  });

  await page.goto("/");
  await bootstrapReady;
  await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 2_000 });
});

test("mobile chat retains focus and bottom anchoring across viewport changes", async ({ page, request }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile-"), "mobile-only viewport coverage");

  const response = await request.get("/api/bootstrap");
  expect(response.ok()).toBeTruthy();
  const bootstrap = await response.json() as {
    activeWorkspaceId: string;
    workspaces: Array<{
      id: string;
      activeTabId: string;
      tabs: Array<{ id: string; activePaneId: string }>;
    }>;
  };
  const workspace = bootstrap.workspaces.find((candidate) => candidate.id === bootstrap.activeWorkspaceId);
  const tab = workspace?.tabs.find((candidate) => candidate.id === workspace.activeTabId);
  expect(workspace).toBeTruthy();
  expect(tab).toBeTruthy();

  for (let index = 0; index < 10; index += 1) {
    const notification = await request.post("/api/notifications", {
      data: {
        workspaceId: workspace?.id,
        tabId: tab?.id,
        paneId: tab?.activePaneId,
        title: `Mobile viewport event ${index + 1}`,
        body: "Enough structured activity to keep the mobile thread scrollable while its visual viewport changes.",
      },
    });
    expect(notification.ok()).toBeTruthy();
  }
  const agentEvent = await request.post("/api/agent-events", {
    data: {
      workspaceId: workspace?.id,
      tabId: tab?.id,
      paneId: tab?.activePaneId,
      agent: "codex",
      status: "running",
      title: "Mobile keyboard regression",
      summary: "Keep the composer available for follow-up input",
    },
  });
  expect(agentEvent.ok()).toBeTruthy();

  await page.evaluate(() => window.sessionStorage.removeItem("wmux.mobileSurfaceModes"));
  await page.reload();
  const chrome = page.getByRole("banner", { name: "Mobile session controls" });
  await expect(chrome.getByRole("button", { name: "Open chat" })).toHaveAttribute("aria-pressed", "true");
  const thread = page.locator(".mobile-agent-thread");
  await expect(thread).toBeVisible();
  const messageStyle = await page.locator(".mobile-agent-message").first().evaluate((element) => {
    const style = window.getComputedStyle(element);
    return {
      borderRadius: style.borderRadius,
      borderBottomStyle: style.borderBottomStyle,
      marginLeft: style.marginLeft,
    };
  });
  expect(messageStyle).toEqual({ borderRadius: "0px", borderBottomStyle: "solid", marginLeft: "0px" });
  const inputPrompt = await page.locator(".mobile-agent-input-row").evaluate((element) =>
    window.getComputedStyle(element, "::before").content,
  );
  expect(inputPrompt).toBe('">"');
  await thread.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });

  await thread.evaluate((element) => {
    window.visualViewport?.dispatchEvent(new Event("resize"));
    element.scrollTop = Math.max(0, element.scrollTop - 96);
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => thread.evaluate((element) =>
    element.scrollHeight - element.scrollTop - element.clientHeight,
  )).toBeLessThan(2);

  await page.setViewportSize({ width: 390, height: 520 });
  await page.setViewportSize({ width: 390, height: 760 });
  await expect.poll(() => thread.evaluate((element) =>
    element.scrollHeight - element.scrollTop - element.clientHeight,
  )).toBeLessThan(2);

  await thread.evaluate((element) => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    element.scrollTop = 0;
  });
  await page.setViewportSize({ width: 390, height: 560 });
  await page.setViewportSize({ width: 390, height: 720 });
  await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(page.getByRole("button", { name: "Latest" })).toBeVisible();

  await page.getByRole("button", { name: "Latest" }).click();
  const composer = page.getByRole("textbox", { name: "Agent message" });
  await composer.fill("mobile follow-up");
  await page.setViewportSize({ width: 390, height: 520 });
  const appShell = page.locator("main.app-shell");
  await expect(appShell).toHaveClass(/mobile-keyboard-open/);
  await expect.poll(() => composer.evaluate((element) => window.getComputedStyle(element).paddingLeft)).toBe("28px");

  const compactTargets = page.locator(".mobile-agent-input-row button, .mobile-agent-composer-actions button");
  const targetSizes = await compactTargets.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }),
  );
  expect(targetSizes.length).toBeGreaterThan(0);
  expect(targetSizes.every(({ width, height }) => width >= 44 && height >= 44)).toBe(true);

  const send = page.getByRole("button", { name: "Send message" });
  await send.focus();
  await expect(appShell).toHaveClass(/mobile-keyboard-open/);
  await composer.focus();
  await send.click();
  await expect(composer).toBeFocused();

  await page.setViewportSize({ width: 390, height: 720 });
  await expect(appShell).not.toHaveClass(/mobile-keyboard-open/);

  const completedEvent = await request.post("/api/agent-events", {
    data: {
      workspaceId: workspace?.id,
      tabId: tab?.id,
      paneId: tab?.activePaneId,
      agent: "codex",
      status: "completed",
      title: "Mobile keyboard regression",
      summary: "Composer controls remain contained after the run",
    },
  });
  expect(completedEvent.ok()).toBeTruthy();
  await expect(page.getByRole("button", { name: "Interrupt agent" })).toHaveCount(0);
  const focusTerminalContained = await page.getByRole("button", { name: "Focus terminal" }).evaluate((button) => {
    const buttonRect = button.getBoundingClientRect();
    const labelRect = button.querySelector("span")?.getBoundingClientRect();
    return Boolean(labelRect && labelRect.left >= buttonRect.left && labelRect.right <= buttonRect.right);
  });
  expect(focusTerminalContained).toBe(true);
});
