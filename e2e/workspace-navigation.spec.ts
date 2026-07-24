import { createNestedWorkspacePair, expect, test, type E2eWorkspace } from "./fixtures";

test("navigates, persists, filters, and moves nested workspaces", async ({ page, request }, testInfo) => {
  test.setTimeout(60_000);
  const { child, root } = await createNestedWorkspacePair(request);
  const rootPath = `/workspaces/${root.id}/tabs/${root.activeTabId}`;
  const isMobile = testInfo.project.name.startsWith("mobile-");
  const openWorkspaceNavigation = async () => {
    if (!isMobile) return;
    await page.getByRole("banner", { name: "Mobile session controls" })
      .getByRole("button", { name: "Open workspaces and hosts" })
      .click();
  };
  const rootItem = () => page.locator(`a[role="treeitem"][href^="/workspaces/${root.id}/"]`);
  const childItem = () => page.locator(`a[role="treeitem"][href^="/workspaces/${child.id}/"]`);
  const childActionName = isMobile ? `Workspace options for ${child.name}` : `Move ${child.name}`;

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
    const childAction = page.getByRole("button", { name: childActionName });
    await childAction.press("Enter");
    const moveDialog = page.getByRole("dialog", {
      name: isMobile ? `Workspace options: ${child.name}` : `Move ${child.name}`,
    });
    await expect(moveDialog).toBeVisible();
    if (isMobile) {
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
      await moveDialog.getByRole("button", { name: "Close workspace", exact: true }).click();
      const closeDialog = page.getByRole("dialog", { name: "Close workspace?" });
      await expect(closeDialog).toContainText(child.name);
      await closeDialog.getByRole("button", { name: "Cancel" }).click();
      await expect(childAction).toBeFocused();
      await childAction.press("Enter");
      await expect(moveDialog).toBeVisible();
    }
    await moveDialog.getByRole("button", { name: "Move out one level" }).click();
    await expect.poll(async () => {
      const response = await request.get("/api/bootstrap");
      const payload = await response.json() as { workspaces: E2eWorkspace[] };
      return payload.workspaces.find((workspace) => workspace.id === child.id)?.parentWorkspaceId ?? null;
    }).toBeNull();
    await expect(childItem()).toHaveAttribute("aria-level", "1");

    await expect(page.getByRole("button", { name: childActionName })).toBeVisible();
    if (isMobile) {
      await page.getByRole("combobox", { name: "Filter workspace list by host" }).selectOption("local");
    } else {
      await page.getByRole("button", { name: /^Workspace host filter:/ }).press("Enter");
    }
    await expect(rootItem()).toBeVisible();
    await expect(childItem()).toBeVisible();
    if (isMobile) {
      await expect(page.getByRole("button", { name: childActionName })).toBeVisible();
      await page.getByRole("button", { name: childActionName }).click();
      await expect(moveDialog.locator(".workspace-move-actions")).toHaveCount(0);
      await moveDialog.getByRole("button", { name: "Close workspace", exact: true }).click();
      const closeDialog = page.getByRole("dialog", { name: "Close workspace?" });
      await closeDialog.getByRole("button", { name: "Close workspace" }).click();
      await expect.poll(async () => {
        const response = await request.get("/api/bootstrap");
        const payload = await response.json() as { workspaces: E2eWorkspace[] };
        return payload.workspaces.some((workspace) => workspace.id === child.id);
      }).toBe(false);
      await expect(childItem()).toHaveCount(0);
    } else {
      await expect(page.getByRole("button", { name: childActionName })).toHaveCount(0);
    }
  } finally {
    await request.delete(`/api/workspaces/${child.id}`);
    await request.delete(`/api/workspaces/${root.id}`);
  }
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
    const mobileClipboard = { text: "", blocked: false };
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function send(data) {
      if (typeof data === "string") sent.push(data);
      return originalSend.call(this, data);
    };
    const testWindow = window as unknown as {
      __wmuxMobileSocketMessages: string[];
      __wmuxMobileClipboard: typeof mobileClipboard;
    };
    testWindow.__wmuxMobileSocketMessages = sent;
    testWindow.__wmuxMobileClipboard = mobileClipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: async () => {
          if (mobileClipboard.blocked) throw new DOMException("Clipboard read blocked", "NotAllowedError");
          return mobileClipboard.text;
        },
        writeText: async (text: string) => {
          mobileClipboard.text = text;
        },
      },
    });
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
  const directPaste = "wmux-mobile-direct-paste";
  await page.evaluate((text) => {
    const clipboard = (window as unknown as {
      __wmuxMobileClipboard: { text: string; blocked: boolean };
    }).__wmuxMobileClipboard;
    clipboard.text = text;
    clipboard.blocked = false;
  }, directPaste);
  await terminalKeys.getByRole("button", { name: "Paste clipboard" }).click();
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __wmuxMobileSocketMessages: string[] }).__wmuxMobileSocketMessages.join(""),
  )).toContain(directPaste);

  await page.evaluate(() => {
    const clipboard = (window as unknown as {
      __wmuxMobileClipboard: { text: string; blocked: boolean };
    }).__wmuxMobileClipboard;
    clipboard.blocked = true;
  });
  await terminalKeys.getByRole("button", { name: "Paste clipboard" }).click();
  const pasteDialog = page.getByRole("dialog", { name: "Paste into terminal" });
  await expect(pasteDialog).toBeVisible();
  await expect(pasteDialog).toContainText("blocked direct clipboard access");
  const manualPaste = "wmux-mobile-manual-paste";
  await pasteDialog.getByRole("textbox", { name: "Text to paste into terminal" }).fill(manualPaste);
  const pasteActions = await pasteDialog.getByRole("button").evaluateAll((buttons) => buttons.map((button) => {
    const rect = button.getBoundingClientRect();
    return { width: Math.round(rect.width), height: Math.round(rect.height) };
  }));
  expect(pasteActions.every(({ width, height }) => width >= 44 && height >= 44)).toBe(true);
  await pasteDialog.getByRole("button", { name: "Insert text" }).click();
  await expect(pasteDialog).toBeHidden();
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __wmuxMobileSocketMessages: string[] }).__wmuxMobileSocketMessages.join(""),
  )).toContain(manualPaste);

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
  await expect.poll(() => activePane.locator(".terminal-input-prediction-canvas").evaluate((element) => {
    const host = element.parentElement!;
    const hostRect = host.getBoundingClientRect();
    const predictionRect = element.getBoundingClientRect();
    const predictionLeft = Math.round(predictionRect.left - hostRect.left);
    const predictionRight = Math.round(hostRect.right - predictionRect.right);
    return predictionLeft === 32
      && predictionRight >= 48;
  })).toBe(true);
  const safeAreaPrediction = await activePane.locator(".terminal-input-prediction-canvas").evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const hostRect = canvas.parentElement!.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const pixel = canvas.getContext("2d")?.getImageData(0, 0, 1, 1).data;
    return {
      alpha: pixel?.[3] ?? -1,
      inside: canvasRect.left >= hostRect.left && canvasRect.right <= hostRect.right,
    };
  });
  expect(safeAreaPrediction).toEqual({ alpha: 0, inside: true });
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
  const workspaceOptionsTarget = navigation.getByRole("button", { name: /^Workspace options for / }).first();
  await expect.poll(() => workspaceOptionsTarget.evaluate((element) => {
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
