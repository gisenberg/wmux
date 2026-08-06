import type { Page } from "@playwright/test";
import { expect, test, type E2eWorkspace } from "./fixtures";

const openSettings = async (page: Page, mobile: boolean): Promise<void> => {
  await page.keyboard.press("Control+K");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  if (mobile) {
    await palette.getByRole("button", { name: "Open settings", exact: false }).click();
  } else {
    const search = palette.getByPlaceholder("Search commands, workspaces, tabs, hosts");
    await search.fill("Open settings");
    await search.press("Enter");
  }
};

const openNavigation = async (page: Page, mobile: boolean): Promise<void> => {
  if (!mobile) return;
  await page.getByRole("banner", { name: "Mobile session controls" })
    .getByRole("button", { name: "Open workspaces and hosts" }).click();
};

test("switches sidebar host grouping without reloading on desktop and mobile Chromium", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name === "mobile-webkit", "Chromium canvas/sidebar coverage");
  test.setTimeout(90_000);
  const mobile = testInfo.project.name === "mobile-chromium";
  const machineId = `sidebar-host-b-${testInfo.project.name}-${Date.now()}`;
  const fleetMachines = Array.from({ length: 18 }, (_, index) => ({
    id: `sidebar-fleet-${index + 1}-${testInfo.project.name}-${Date.now()}`,
    name: `Sidebar Fleet ${String(index + 1).padStart(2, "0")}`,
  }));
  const offlineMachine = {
    id: `sidebar-offline-${testInfo.project.name}-${Date.now()}`,
    name: "Sidebar Offline",
  };
  const createdIds: string[] = [];
  const registeredMachineIds: string[] = [];
  let originalSettings: Record<string, unknown> | undefined;
  let primaryFailure: unknown;
  const cleanupFailures: string[] = [];

  try {
    const before = await request.get("/api/bootstrap");
    expect(before.ok()).toBeTruthy();
    originalSettings = (await before.json() as { settings: Record<string, unknown> }).settings;
    const grouped = await request.post("/api/settings", { data: { groupSidebarSessionsByHost: true } });
    expect(grouped.ok()).toBeTruthy();

    registeredMachineIds.push(machineId);
    const machine = await request.post("/api/machines", {
      data: { id: machineId, name: "Sidebar Host B", kind: "local" },
    });
    expect(machine.ok()).toBeTruthy();
    const create = async (machineTarget: string, parentPaneId?: string): Promise<E2eWorkspace> => {
      const response = await request.post("/api/workspaces", {
        data: parentPaneId
          ? { machineId: machineTarget, createdBy: "agent", parentPaneId }
          : { machineId: machineTarget },
      });
      expect(response.ok()).toBeTruthy();
      const workspace = (await response.json() as { workspace: E2eWorkspace }).workspace;
      createdIds.push(workspace.id);
      return workspace;
    };
    const parent = await create("local");
    const parentPaneId = parent.tabs[0]!.panes[0]!.id;
    const remoteChild = await create(machineId, parentPaneId);
    const localChild = await create("local", parentPaneId);
    const treeItem = (workspace: E2eWorkspace) => page.locator(`a[role="treeitem"][href^="/workspaces/${workspace.id}/"]`);

    await page.goto(`/workspaces/${parent.id}/tabs/${parent.activeTabId}`);
    await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
    await openNavigation(page, mobile);
    const navigation = page.locator("#wmux-sidebar");
    const tree = navigation.locator('[role="tree"][aria-label="Agents"]');
    const spaces = navigation.getByRole("navigation", { name: "Spaces" });
    await expect(tree).toHaveAttribute("data-grouping", "space");
    await expect(spaces.getByRole("button", { name: /^Local,/ })).toHaveCount(1);
    await expect(spaces.getByRole("button", { name: /^Sidebar Host B,/ })).toHaveCount(1);
    await expect(treeItem(parent)).toHaveCount(1);
    await expect(treeItem(localChild)).toHaveCount(1);
    await expect(treeItem(remoteChild)).toHaveCount(1);
    await expect(treeItem(parent)).toHaveAttribute("data-presentation-machine-id", "local");
    await expect(treeItem(localChild)).toHaveAttribute("data-presentation-machine-id", "local");
    await expect(treeItem(remoteChild)).toHaveAttribute("data-presentation-machine-id", machineId);
    await expect(treeItem(parent)).toHaveAccessibleName(parent.name);
    await expect(treeItem(remoteChild)).not.toHaveAccessibleName(/Sidebar Host B/);
    const groupedTops = await Promise.all([parent, localChild, remoteChild].map(async (workspace) =>
      (await treeItem(workspace).boundingBox())!.y));
    expect(groupedTops[0]).toBeLessThan(groupedTops[1]);
    expect(groupedTops[1]).toBeLessThan(groupedTops[2]);
    const childHeight = (await treeItem(localChild).boundingBox())!.height;
    expect(groupedTops[2] - groupedTops[1]).toBeGreaterThan(childHeight);

    if (mobile) await page.locator("button.mobile-sidebar-close").click();
    await openSettings(page, mobile);
    const settings = page.getByRole("dialog", { name: "Settings" });
    const groupingControl = settings.getByRole("button", { name: "Group sidebar sessions by host" });
    await expect(groupingControl).toHaveAttribute("aria-pressed", "true");
    const groupingBox = await groupingControl.boundingBox();
    expect(groupingBox).toBeTruthy();
    expect(groupingBox!.width).toBeGreaterThan(100);
    expect(groupingBox!.height).toBeGreaterThan(0);
    if (mobile) {
      const canvasBox = await settings.locator(".open-tui-settings-canvas").boundingBox();
      expect(canvasBox).toBeTruthy();
      const cellWidth = (canvasBox!.width - groupingBox!.width) / 2;
      await page.mouse.click(groupingBox!.x + groupingBox!.width - cellWidth * 5.5, groupingBox!.y + groupingBox!.height / 4);
    }
    else {
      await groupingControl.focus();
      await page.keyboard.press("Enter");
    }
    await expect(groupingControl).toHaveAttribute("aria-pressed", "false");
    await expect(tree).toHaveAttribute("data-grouping", "global");
    const saveSettings = settings.getByRole("button", { name: "Save settings" });
    await saveSettings.focus();
    await page.keyboard.press("Enter");
    await expect(settings).toHaveCount(0);
    await expect.poll(async () => {
      const response = await request.get("/api/bootstrap");
      return (await response.json() as { settings: { groupSidebarSessionsByHost: boolean } }).settings.groupSidebarSessionsByHost;
    }).toBe(false);
    await openNavigation(page, mobile);
    await expect(tree).toHaveAttribute("data-grouping", "global");
    await expect(navigation.getByRole("navigation", { name: "Spaces" })).toHaveCount(0);
    const targetHost = navigation.getByRole("navigation", { name: "Target host" });
    const targetSelect = targetHost.getByRole("combobox", { name: "Target host" });
    await expect(targetSelect).toHaveValue("local");
    await expect(targetSelect.locator('option[value="local"]')).toHaveText(/Local \[(?:ONLINE|OFFLINE)\]/);
    await expect(treeItem(parent)).toHaveAttribute("aria-level", "1");
    await expect(treeItem(localChild)).toHaveAttribute("aria-level", "2");
    await expect(treeItem(remoteChild)).toHaveAttribute("aria-level", "2");
    await expect(treeItem(parent)).toHaveAccessibleName(new RegExp(`^${parent.name}, host Local`));
    await expect(treeItem(remoteChild)).toHaveAccessibleName(new RegExp(`^${remoteChild.name}, host Sidebar Host B`));
    const globalTops = await Promise.all([parent, localChild, remoteChild].map(async (workspace) =>
      (await treeItem(workspace).boundingBox())!.y));
    expect(globalTops[0]).toBeLessThan(globalTops[1]);
    expect(globalTops[1]).toBeLessThan(globalTops[2]);
    expect(Math.abs((globalTops[2] - globalTops[1]) - childHeight)).toBeLessThanOrEqual(2);

    for (const fleetMachine of fleetMachines) {
      registeredMachineIds.push(fleetMachine.id);
      const response = await request.post("/api/machines", {
        data: { ...fleetMachine, kind: "local" },
      });
      expect(response.ok()).toBeTruthy();
    }
    registeredMachineIds.push(offlineMachine.id);
    const offlineResponse = await request.post("/api/machines", {
      data: { ...offlineMachine, kind: "service" },
    });
    expect(offlineResponse.ok()).toBeTruthy();
    await expect.poll(async () => targetSelect.locator("option").evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value))).toEqual(expect.arrayContaining(registeredMachineIds));
    await expect(targetSelect).toHaveValue("local");

    const targetBox = await targetSelect.boundingBox();
    const createAction = targetHost.getByRole("button", { name: /^Create agent session on Sidebar Host B@/ });
    const initialCreateAction = targetHost.getByRole("button", { name: /^Create agent session on Local@/ });
    await expect(initialCreateAction).toBeEnabled();
    const initialCreateBox = await initialCreateAction.boundingBox();
    expect(targetBox).toBeTruthy();
    expect(initialCreateBox).toBeTruthy();
    expect(targetBox!.x + targetBox!.width).toBeLessThanOrEqual(initialCreateBox!.x + 1);

    const stateBeforeTargetChange = await request.get("/api/bootstrap");
    expect(stateBeforeTargetChange.ok()).toBeTruthy();
    const workspacesBeforeTargetChange = (await stateBeforeTargetChange.json() as {
      workspaces: E2eWorkspace[];
    }).workspaces;
    await targetSelect.selectOption(offlineMachine.id);
    await expect(targetSelect).toHaveValue(offlineMachine.id);
    await expect(targetHost.getByRole("button", { name: /^Create agent session on Sidebar Offline@/ })).toBeDisabled();
    await targetSelect.selectOption(machineId);
    await expect(targetSelect).toHaveValue(machineId);
    await expect(tree).toHaveAttribute("data-target-space-id", machineId);
    await expect(createAction).toBeEnabled();
    const stateAfterTargetChange = await request.get("/api/bootstrap");
    expect(stateAfterTargetChange.ok()).toBeTruthy();
    expect((await stateAfterTargetChange.json() as { workspaces: E2eWorkspace[] }).workspaces).toEqual(workspacesBeforeTargetChange);

    const idsBeforeCreate = new Set(workspacesBeforeTargetChange.map((workspace) => workspace.id));
    if (mobile) await createAction.tap();
    else await createAction.click();
    let createdFromAction: (E2eWorkspace & { machineId: string }) | undefined;
    await expect.poll(async () => {
      const response = await request.get("/api/bootstrap");
      if (!response.ok()) return false;
      const newWorkspaces = (await response.json() as {
        workspaces: Array<E2eWorkspace & { machineId: string }>;
      }).workspaces.filter((workspace) => !idsBeforeCreate.has(workspace.id));
      for (const workspace of newWorkspaces) {
        if (!createdIds.includes(workspace.id)) createdIds.push(workspace.id);
      }
      createdFromAction = newWorkspaces[0];
      return createdFromAction?.machineId === machineId;
    }).toBe(true);

    await page.reload();
    await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
    await openNavigation(page, mobile);
    await expect(page.getByRole("tree", { name: "Agents" })).toHaveAttribute("data-grouping", "global");
    await expect(page.getByRole("navigation", { name: "Target host" })
      .getByRole("combobox", { name: "Target host" })).toHaveValue(machineId);
    if (mobile) await expect(page.getByRole("complementary", { name: "Workspace navigation" })).toBeVisible();
  } catch (error) {
    primaryFailure = error;
  } finally {
    for (const workspaceId of createdIds.reverse()) {
      try {
        const response = await request.delete(`/api/workspaces/${workspaceId}`);
        if (!response.ok() && response.status() !== 404) cleanupFailures.push(`workspace ${workspaceId} delete returned ${response.status()}`);
      } catch (error) {
        cleanupFailures.push(`workspace ${workspaceId} delete failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const registeredMachineId of registeredMachineIds.reverse()) {
      try {
        const response = await request.delete(`/api/machines/${registeredMachineId}`);
        if (!response.ok() && response.status() !== 404) cleanupFailures.push(`machine ${registeredMachineId} delete returned ${response.status()}`);
      } catch (error) {
        cleanupFailures.push(`machine ${registeredMachineId} delete failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (originalSettings) {
      try {
        const response = await request.post("/api/settings", { data: originalSettings });
        if (!response.ok()) cleanupFailures.push(`settings restore returned ${response.status()}`);
      } catch (error) {
        cleanupFailures.push(`settings restore failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      const response = await request.get("/api/bootstrap");
      if (!response.ok()) cleanupFailures.push(`bootstrap cleanup check returned ${response.status()}`);
      else {
        const payload = await response.json() as { workspaces: Array<{ id: string }>; settings: Record<string, unknown> };
        const leftovers = createdIds.filter((workspaceId) => payload.workspaces.some((workspace) => workspace.id === workspaceId));
        if (leftovers.length) cleanupFailures.push(`workspaces remain: ${leftovers.join(", ")}`);
        if (originalSettings && payload.settings.groupSidebarSessionsByHost !== originalSettings.groupSidebarSessionsByHost) {
          cleanupFailures.push("sidebar grouping setting was not restored");
        }
      }
      const catalog = await request.get("/api/machines/manage");
      if (!catalog.ok()) cleanupFailures.push(`machine catalog cleanup check returned ${catalog.status()}`);
      else {
        const remainingMachineIds = (await catalog.json() as { staticMachines: Array<{ id: string }> }).staticMachines
          .map((machine) => machine.id)
          .filter((id) => registeredMachineIds.includes(id));
        if (remainingMachineIds.length) cleanupFailures.push(`machines remain registered: ${remainingMachineIds.join(", ")}`);
      }
    } catch (error) {
      cleanupFailures.push(`cleanup verification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (primaryFailure && cleanupFailures.length) {
    throw new AggregateError([primaryFailure, ...cleanupFailures.map((failure) => new Error(failure))], "sidebar host grouping test and cleanup failed");
  }
  if (primaryFailure) throw primaryFailure;
  if (cleanupFailures.length) throw new Error(`sidebar host grouping cleanup failed: ${cleanupFailures.join("; ")}`);
});
