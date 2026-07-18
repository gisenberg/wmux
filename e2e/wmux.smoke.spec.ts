import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Math.random = () => 0;
  });
  await page.goto("/");
  await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
});

test("publishes standalone app metadata for direct workspace routes", async ({ page, request }) => {
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#050505");
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
  });
});

test("creates a workspace through the command palette and preserves its direct link", async ({ page, request }) => {
  const before = await request.get("/api/bootstrap");
  expect(before.ok()).toBeTruthy();
  const beforePayload = await before.json() as { workspaces: unknown[] };

  await page.keyboard.press("Control+K");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await palette.getByPlaceholder("Search commands, workspaces, tabs, hosts").fill("New workspace on Local");
  await palette.getByPlaceholder("Search commands, workspaces, tabs, hosts").press("Enter");

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
  const directPath = `/workspaces/${workspace?.id}/tabs/${workspace?.activeTabId}`;
  await expect(page).toHaveURL(new RegExp(`${directPath.replaceAll("/", "\\/")}$`));
  await page.reload();
  await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(new RegExp(`${directPath.replaceAll("/", "\\/")}$`));
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
    await settings.getByLabel("Color scheme").selectOption("dracula");
    await expect.poll(() => page.locator("main.app-shell").evaluate((element) =>
      element.style.getPropertyValue("--black"),
    )).toBe("#282a36");
    await settings.getByRole("button", { name: "Save" }).click();

    await expect.poll(async () => {
      const response = await request.get("/api/bootstrap");
      return (await response.json() as { settings: { colorScheme: string } }).settings.colorScheme;
    }).toBe("dracula");
    await page.reload();
    await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => page.locator("main.app-shell").evaluate((element) =>
      element.style.getPropertyValue("--black"),
    )).toBe("#282a36");
  } finally {
    const restored = await request.post("/api/settings", { data: originalSettings });
    expect(restored.ok()).toBeTruthy();
  }
});

test("idle Life field stays bounded and pauses when it leaves the viewport", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop WebGL lifecycle coverage");

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

  const chrome = page.getByRole("banner", { name: "Mobile session controls" });
  await expect(chrome).toBeVisible();
  await expect(chrome.getByRole("button", { name: "Open chat" })).toHaveAttribute("aria-pressed", "true");
  await chrome.getByRole("button", { name: "Open terminal" }).click();
  await expect(chrome.getByRole("button", { name: "Open terminal" })).toHaveAttribute("aria-pressed", "true");
  const activePane = page.locator(".terminal-pane.active");
  await expect(activePane).toHaveClass(/terminal-ready/, { timeout: 10_000 });

  const appShell = page.locator("main.app-shell");
  await appShell.evaluate((element: HTMLElement) => {
    element.style.setProperty("--wmux-mobile-left-inset", "32px");
    element.style.setProperty("--wmux-mobile-right-inset", "48px");
  });
  await expect.poll(() => activePane.locator(".terminal-host-shell").evaluate((element) => {
    const style = window.getComputedStyle(element);
    return { left: style.paddingLeft, right: style.paddingRight };
  })).toEqual({ left: "32px", right: "48px" });
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
  await page.locator("button.mobile-sidebar-close").click();

  await chrome.getByRole("button", { name: "Open actions" }).click();
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
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
    screen: "rgb(5, 5, 5)",
    bezel: "rgb(85, 204, 238)",
    padding: ["31px", "13px", "29px", "17px"],
  });
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

  await page.reload();
  const chrome = page.getByRole("banner", { name: "Mobile session controls" });
  await chrome.getByRole("button", { name: "Open chat" }).click();
  const thread = page.locator(".mobile-agent-thread");
  await expect(thread).toBeVisible();
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
});
