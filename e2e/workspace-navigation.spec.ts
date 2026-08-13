import { awaitAppShell, createNestedWorkspacePair, expect, test, type E2eWorkspace } from "./fixtures";
import { e2eRegistrationToken } from "./config-auth.js";

test("navigates, persists, targets spaces, and moves nested workspaces", async ({ page, request }, testInfo) => {
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
  const undoChildClose = async () => {
    await expect(childItem()).toHaveCount(0);
    const toast = page.locator(".wmux-toast").filter({ hasText: child.name });
    await expect(toast).toContainText("[PENDING]");
    await expect(toast).toContainText("Closing in 10 seconds");
    await expect.poll(async () => {
      const response = await request.get("/api/bootstrap");
      const payload = await response.json() as { workspaces: E2eWorkspace[] };
      return payload.workspaces.some((workspace) => workspace.id === child.id);
    }).toBe(true);
    expect(await toast.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        borderRadius: style.borderRadius,
        boxShadow: style.boxShadow,
        fontFamily: style.fontFamily,
      };
    })).toMatchObject({
      borderRadius: "0px",
      boxShadow: "none",
      fontFamily: expect.stringContaining("Fira Code"),
    });
    await toast.getByRole("button", { name: `Undo close ${child.name}` }).click();
    await expect(childItem()).toBeVisible();
    await expect(toast).toHaveCount(0);
  };

  try {
    await page.goto(rootPath);
    await awaitAppShell(page);
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
    await awaitAppShell(page);
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
    const spaces = page.getByRole("navigation", { name: "Spaces" });
    const agents = page.getByRole("tree", { name: "Agents" });
    await expect(spaces.getByRole("button", { name: /^Local,/ })).toHaveAttribute("aria-current", "true");
    await expect(agents).toHaveAttribute("data-grouping", "space");
    await expect(agents).toHaveAttribute("data-target-space-id", "local");
    await expect(rootItem()).toBeVisible();
    await expect(childItem()).toBeVisible();
    if (isMobile) {
      await expect(page.getByRole("button", { name: childActionName })).toBeVisible();
      await page.getByRole("button", { name: childActionName }).click();
      await expect(moveDialog.locator(".workspace-move-actions button")).toHaveCount(4);
      await moveDialog.getByRole("button", { name: "Close workspace", exact: true }).click();
      const closeDialog = page.getByRole("dialog", { name: "Close workspace?" });
      await closeDialog.getByRole("button", { name: "Close workspace" }).click();
      await undoChildClose();
    } else {
      await childItem().press("Shift+F10");
      const agentMenu = page.getByRole("menu", { name: `Agent actions: ${child.name}` });
      await expect(agentMenu).toBeVisible();
      await agentMenu.getByRole("menuitem", { name: /Favorite$/ }).click();
      await expect(childItem()).toHaveAttribute("data-favorite", "true");
      await expect.poll(async () => {
        const response = await request.get("/api/bootstrap");
        const payload = await response.json() as { settings: { favoriteWorkspaceIds: string[] } };
        return payload.settings.favoriteWorkspaceIds;
      }).toContain(child.id);
      await expect.poll(async () => {
        const childTop = await childItem().evaluate((element) => element.getBoundingClientRect().top);
        const rootTop = await rootItem().evaluate((element) => element.getBoundingClientRect().top);
        return childTop < rootTop;
      }).toBe(true);

      await page.reload();
      await awaitAppShell(page);
      await expect(childItem()).toHaveAttribute("data-favorite", "true");
      await childItem().press("Shift+F10");
      await expect(agentMenu.getByRole("menuitem", { name: /Unfavorite$/ })).toBeVisible();
      await agentMenu.getByRole("menuitem", { name: "Close agent" }).click();
      await undoChildClose();
    }
  } finally {
    await request.delete(`/api/workspaces/${child.id}`);
    await request.delete(`/api/workspaces/${root.id}`);
  }
});

test("Agents rail keeps an inactive agent tab on its reporting host", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "one desktop host-grouping run covers shared presentation logic");
  let workspaceId: string | undefined;

  try {
    const workspaceResponse = await request.post("/api/workspaces", {
      data: { machineId: "local" },
    });
    expect(workspaceResponse.ok()).toBeTruthy();
    const workspace = (await workspaceResponse.json() as {
      workspace: E2eWorkspace & {
        tabs: Array<{ id: string; activePaneId: string; panes: Array<{ id: string }> }>;
      };
    }).workspace;
    workspaceId = workspace.id;
    const agentTab = workspace.tabs[0]!;

    const agentEvent = await request.post("/api/agent-events", {
      data: {
        workspaceId: workspace.id,
        tabId: agentTab.id,
        paneId: agentTab.activePaneId,
        agent: "codex",
        status: "completed",
        title: "Agent remains discoverable",
        summary: "Waiting for another turn",
      },
    });
    expect(agentEvent.ok()).toBeTruthy();

    const supportMachineId = "agent-support-fixture";
    const supportTabId = "tab_agent_support_fixture";
    const supportPaneId = "pane_agent_support_fixture";
    await page.routeWebSocket("**/ws/events", (webSocket) => webSocket.close());
    await page.route("**/api/bootstrap", async (route) => {
      const response = await route.fetch();
      const payload = await response.json() as {
        machines: Array<Record<string, unknown> & { id: string; name: string }>;
        workspaces: Array<E2eWorkspace & {
          machineId: string;
          tabs: Array<{
            id: string;
            title: string;
            activePaneId: string;
            layout: { type: "pane"; paneId: string };
            panes: Array<Record<string, unknown> & { id: string; machineId: string }>;
            createdAt: string;
          }>;
        }>;
      };
      const fixtureWorkspace = payload.workspaces.find(
        (candidate) => candidate.id === workspace.id,
      );
      const fixtureAgentTab = fixtureWorkspace?.tabs.find(
        (candidate) => candidate.id === agentTab.id,
      );
      const fixtureAgentPane = fixtureAgentTab?.panes.find(
        (candidate) => candidate.id === agentTab.activePaneId,
      );
      const localMachine = payload.machines.find(
        (candidate) => candidate.id === "local",
      );
      if (!fixtureWorkspace || !fixtureAgentTab || !fixtureAgentPane || !localMachine) {
        await route.fulfill({ response });
        return;
      }
      const supportTab = {
        ...fixtureAgentTab,
        id: supportTabId,
        title: "Support",
        activePaneId: supportPaneId,
        layout: { type: "pane" as const, paneId: supportPaneId },
        panes: [{
          ...fixtureAgentPane,
          id: supportPaneId,
          machineId: supportMachineId,
          title: "Support",
        }],
      };
      await route.fulfill({
        response,
        json: {
          ...payload,
          machines: [
            ...payload.machines,
            { ...localMachine, id: supportMachineId, name: "Agent Support" },
          ],
          workspaces: payload.workspaces.map((candidate) =>
            candidate.id === workspace.id
              ? {
                  ...candidate,
                  activeTabId: supportTabId,
                  tabs: [...candidate.tabs, supportTab],
                }
              : candidate),
        },
      });
    });

    await page.goto(`/workspaces/${workspace.id}/tabs/${supportTabId}`);
    await awaitAppShell(page);
    const agentItem = page.locator(`a[role="treeitem"][href^="/workspaces/${workspace.id}/"]`);
    await expect(agentItem).toHaveAttribute(
      "href",
      `/workspaces/${workspace.id}/tabs/${agentTab.id}`,
    );
    await expect(agentItem).toHaveAttribute("data-agent-machine", "local");

    await agentItem.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/workspaces/${workspace.id}/tabs/${agentTab.id}$`));
  } finally {
    if (workspaceId) {
      await request.delete(`/api/workspaces/${workspaceId}`).catch(() => undefined);
    }
  }
});

test("workspace close grace hides immediately, restores on undo, and closes after its deadline", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "one desktop deadline run covers the server-owned timer");
  test.setTimeout(45_000);
  const targetResponse = await request.post("/api/workspaces", { data: { machineId: "local" } });
  expect(targetResponse.ok()).toBeTruthy();
  const target = (await targetResponse.json() as { workspace: E2eWorkspace }).workspace;
  const targetPath = `/workspaces/${target.id}/tabs/${target.activeTabId}`;
  const targetItem = page.locator(`a[role="treeitem"][href^="/workspaces/${target.id}/"]`);
  const closeFromPalette = async () => {
    await page.keyboard.press("Control+K");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await palette.locator("input").fill("Close current workspace");
    await page.keyboard.press("Enter");
  };

  try {
    await page.goto(targetPath);
    await awaitAppShell(page);
    await expect(targetItem).toBeVisible();

    await closeFromPalette();
    await expect(targetItem).toHaveCount(0);
    const firstToast = page.locator(".wmux-toast").filter({ hasText: target.name });
    await expect(firstToast).toContainText("[PENDING]");
    await expect.poll(async () => {
      const payload = await (await request.get("/api/bootstrap")).json() as { workspaces: E2eWorkspace[] };
      return payload.workspaces.some((workspace) => workspace.id === target.id);
    }).toBe(true);

    await firstToast.getByRole("button", { name: `Undo close ${target.name}` }).click();
    await expect(targetItem).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${targetPath}$`));

    await closeFromPalette();
    await expect(targetItem).toHaveCount(0);
    await expect.poll(async () => {
      const payload = await (await request.get("/api/bootstrap")).json() as { workspaces: E2eWorkspace[] };
      return payload.workspaces.some((workspace) => workspace.id === target.id);
    }, { timeout: 15_000 }).toBe(false);
    await expect(page.locator(".wmux-toast").filter({ hasText: target.name })).toHaveCount(0);
  } finally {
    await request.delete(`/api/workspaces/${target.id}`).catch(() => undefined);
  }
});

test("mobile sidebar opens and activates workspaces by touch", async ({ page, request }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile-"), "mobile-only touch coverage");
  const { child, root } = await createNestedWorkspacePair(request);
  const rootPath = `/workspaces/${root.id}/tabs/${root.activeTabId}`;
  const childPath = `/workspaces/${child.id}/tabs/${child.activeTabId}`;
  const navigation = page.getByRole("complementary", { name: "Workspace navigation" });
  const mobileActions = page.getByRole("banner", { name: "Mobile session controls" })
    .locator(".open-tui-mobile-chrome-actions button");
  const navigationToggle = mobileActions.first();
  const rootItem = page.locator(`a[role="treeitem"][href="${rootPath}"]`);
  const childItem = page.locator(`a[role="treeitem"][href="${childPath}"]`);

  try {
    await page.goto(rootPath);
    await awaitAppShell(page);
    await expect(mobileActions).toHaveCount(3);
    await expect(mobileActions.nth(0)).toHaveAccessibleName("Open workspaces and hosts");
    await expect(mobileActions.nth(1)).toHaveAccessibleName("Open chat");
    await expect(mobileActions.nth(2)).toHaveAccessibleName("Open terminal");
    await expect(page.getByRole("button", { name: "Open agent fleet" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open actions" })).toHaveCount(0);
    await navigationToggle.tap();
    await expect(navigation).toBeVisible();
    await expect(
      navigation.getByRole("navigation", { name: "Spaces" }).getByRole("button").first(),
    ).toBeVisible();
    await expect(
      navigation.getByRole("tree", { name: "Agents" }).getByRole("treeitem").first(),
    ).toBeVisible();
    await expect(navigation.getByText("Host status", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Agent fleet" })).toHaveCount(0);
    await expect(childItem).toHaveAttribute("draggable", "false");

    const routeHistoryLength = await page.evaluate(() => window.history.length);
    await childItem.tap();
    await expect(page).toHaveURL(new RegExp(`${childPath}$`));
    await expect(navigation).toBeHidden();
    expect(await page.evaluate(() => window.history.length)).toBe(routeHistoryLength);

    await navigationToggle.tap();
    await expect(navigation).toBeVisible();
    await rootItem.tap();
    await expect(page).toHaveURL(new RegExp(`${rootPath}$`));
    await expect(navigation).toBeHidden();
    expect(await page.evaluate(() => window.history.length)).toBe(routeHistoryLength);
  } finally {
    await request.delete(`/api/workspaces/${child.id}`).catch(() => undefined);
    await request.delete(`/api/workspaces/${root.id}`).catch(() => undefined);
  }
});

test("desktop workspace menu renames the sidebar entry", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "one desktop run covers the shared sidebar menu");
  const renamedTitle = `Renamed workspace ${Date.now()}`;
  let workspaceId: string | undefined;

  try {
    const response = await request.post("/api/workspaces", { data: { machineId: "local" } });
    expect(response.ok()).toBeTruthy();
    const workspace = (await response.json() as { workspace: E2eWorkspace }).workspace;
    workspaceId = workspace.id;

    await page.goto(`/workspaces/${workspace.id}/tabs/${workspace.activeTabId}`);
    await awaitAppShell(page);
    const workspaceItem = page.locator(`a[role="treeitem"][href^="/workspaces/${workspace.id}/"]`);
    await workspaceItem.click({ button: "right" });

    const actions = page.getByRole("menu", { name: `Agent actions: ${workspace.name}` });
    await actions.getByRole("menuitem", { name: "Rename workspace" }).click();
    const renameDialog = page.getByRole("dialog", { name: `Rename workspace: ${workspace.name}` });
    const nameInput = renameDialog.getByRole("textbox", { name: "Workspace name" });
    await expect(nameInput).toBeFocused();
    await expect(nameInput).toHaveValue(workspace.name);
    await nameInput.fill(renamedTitle);
    await renameDialog.getByRole("button", { name: "Save name" }).click();

    await expect(workspaceItem).toHaveAccessibleName(new RegExp(`^${renamedTitle}`));
    await expect(workspaceItem).toBeFocused();
    await expect.poll(async () => {
      const bootstrapResponse = await request.get("/api/bootstrap");
      const payload = await bootstrapResponse.json() as {
        workspaces: Array<{ id: string; name: string; nameSource: string }>;
      };
      const updated = payload.workspaces.find((candidate) => candidate.id === workspace.id);
      return updated ? { name: updated.name, nameSource: updated.nameSource } : null;
    }).toEqual({ name: renamedTitle, nameSource: "user" });
  } finally {
    if (workspaceId) await request.delete(`/api/workspaces/${workspaceId}`).catch(() => undefined);
  }
});

test("desktop agent group menu closes every workspace on its host", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile-"), "desktop-only context menu coverage");
  const suffix = testInfo.project.name.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase();
  const machineId = `agent-group-${suffix}`;
  const machineName = `Agent Group ${suffix}`;
  const createdWorkspaceIds: string[] = [];

  try {
    const registered = await request.post("/api/registry/hosts", {
      headers: { authorization: `Bearer ${e2eRegistrationToken()}` },
      data: {
        machine: {
          id: machineId,
          name: machineName,
          kind: "ssh",
          port: 1,
        },
        ttlMs: 60_000,
      },
    });
    expect(registered.ok()).toBeTruthy();
    for (let index = 0; index < 2; index += 1) {
      const response = await request.post("/api/workspaces", { data: { machineId } });
      expect(response.ok()).toBeTruthy();
      const workspace = (await response.json() as { workspace: E2eWorkspace }).workspace;
      createdWorkspaceIds.push(workspace.id);
    }

    await page.reload();
    await awaitAppShell(page);
    // Keyboard focus on the chrome needs the asynchronously initialized
    // terminal, not just the mounted shell.
    await expect(page.locator(".terminal-pane.active")).toHaveClass(/terminal-ready/, { timeout: 10_000 });
    const group = page.getByRole("navigation", { name: "Spaces" })
      .getByRole("button", { name: new RegExp(`^${machineName},`) });
    await group.focus();
    await page.keyboard.press("Shift+F10");
    const groupMenu = page.getByRole("menu", { name: `Agent group actions: ${machineName}` });
    await expect(groupMenu).toBeVisible();
    await groupMenu.getByRole("menuitem", { name: "Close all agents (2)" }).click();
    const confirmMenu = page.getByRole("menu", {
      name: `Confirm closing 2 agents on ${machineName}`,
    });
    await expect(confirmMenu).toContainText("kill their backing sessions");
    await confirmMenu.getByRole("menuitem", { name: "Confirm close all" }).click();

    await expect.poll(async () => {
      const response = await request.get("/api/bootstrap");
      const payload = await response.json() as { workspaces: Array<{ machineId: string }> };
      return payload.workspaces.filter((workspace) => workspace.machineId === machineId).length;
    }).toBe(0);
    createdWorkspaceIds.length = 0;
  } finally {
    for (const workspaceId of createdWorkspaceIds.reverse()) {
      await request.delete(`/api/workspaces/${workspaceId}`).catch(() => undefined);
    }
    await request.delete(`/api/registry/hosts/${machineId}`).catch(() => undefined);
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
  await awaitAppShell(page);
  await expect(page.getByText(/wmux failed to load/i)).toHaveCount(0);
  await expect.poll(() => failures).toBe(2);
  await expect.poll(() => requests, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
});

test("mobile chrome keeps navigation, chat, and terminal reachable", async ({ page }, testInfo) => {
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
  await expect(
    navigation.getByRole("navigation", { name: "Spaces" }).getByRole("button").first(),
  ).toBeVisible();
  await expect(
    navigation.getByRole("tree", { name: "Agents" }).getByRole("treeitem").first(),
  ).toBeVisible();
  await expect(navigation.getByText("Host status", { exact: true })).toHaveCount(0);
  await expect(
    navigation.getByRole("navigation", { name: /^Sessions in / }),
  ).toBeVisible();
  await page.locator("button.mobile-sidebar-close").click();
  await expect(navigation).toBeHidden();

  await page.keyboard.press("Control+K");
  const commandPalette = page.getByRole("dialog", { name: "Command palette" });
  await expect(commandPalette).toBeVisible();
  await expect(page.locator(".command-item").first()).toContainText("Split right");
  await commandPalette.locator("input").fill("Close current tab");
  await page.keyboard.press("Enter");
  const closeTabDialog = page.getByRole("dialog", { name: "Close tab?" });
  await expect(closeTabDialog).toBeVisible();
  await closeTabDialog.getByRole("button", { name: "Cancel" }).click();

  await page.keyboard.press("Control+K");
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

test("mobile chat restores durable timeline history without terminal replay", async ({ page, request }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile-"), "mobile-only timeline coverage");
  const sessionSuffix = testInfo.project.name.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase();
  const runId = `mobile-timeline-turn-${sessionSuffix}`;
  const sessionId = `mobile-timeline-session-${sessionSuffix}`;
  const prompt = `Timeline-only ${testInfo.project.name} prompt after the terminal replay boundary.`;
  const outcome = `Timeline-only ${testInfo.project.name} response restored from durable storage.`;

  const bootstrapResponse = await request.get("/api/bootstrap");
  expect(bootstrapResponse.ok()).toBeTruthy();
  const bootstrap = await bootstrapResponse.json() as {
    activeWorkspaceId: string;
    workspaces: Array<{
      id: string;
      activeTabId: string;
      tabs: Array<{ id: string; activePaneId: string }>;
    }>;
  };
  const workspace = bootstrap.workspaces.find(
    (candidate) => candidate.id === bootstrap.activeWorkspaceId,
  );
  const tab = workspace?.tabs.find(
    (candidate) => candidate.id === workspace.activeTabId,
  );
  expect(workspace).toBeTruthy();
  expect(tab).toBeTruthy();

  const running = await request.post("/api/agent-events", {
    data: {
      workspaceId: workspace?.id,
      tabId: tab?.id,
      paneId: tab?.activePaneId,
      runId,
      sessionId,
      agent: "codex",
      status: "running",
      title: "Durable mobile history",
      summary: "Timeline turn running",
      prompt,
    },
  });
  expect(running.ok()).toBeTruthy();
  const completed = await request.post("/api/agent-events", {
    data: {
      workspaceId: workspace?.id,
      tabId: tab?.id,
      paneId: tab?.activePaneId,
      runId,
      sessionId,
      agent: "codex",
      status: "completed",
      title: "Durable mobile history",
      summary: "Timeline turn completed",
      message: outcome,
    },
  });
  expect(completed.ok()).toBeTruthy();

  await page.evaluate(() => {
    window.sessionStorage.removeItem("wmux:mobile-agent-messages");
    window.sessionStorage.removeItem("wmux.mobileSurfaceModes");
  });
  await page.reload();
  await expect(page.getByText(prompt)).toBeVisible();
  await expect(page.getByText(outcome)).toBeVisible();

  const timelineResponse = await request.get(
    `/api/agent-sessions/${sessionId}`,
  );
  expect(timelineResponse.ok()).toBeTruthy();
  const timeline = await timelineResponse.json() as {
    timeline: { entries: Array<{ kind: string }> };
  };
  expect(timeline.timeline.entries.map((entry) => entry.kind)).toEqual([
    "prompt",
    "status",
    "outcome",
  ]);
});
