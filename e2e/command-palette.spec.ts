import { awaitAppShell, expect, test } from "./fixtures";

test("console navigation exposes session filters, host inspection and mounted-pane zoom", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop console navigation coverage");
  const command = async (query: string) => {
    await page.keyboard.press("Control+K");
    const search = page.getByRole("combobox", { name: "Search commands and sessions" });
    await search.fill(query);
    await search.press("Enter");
  };
  await page.keyboard.press("Control+K");
  const search = page.getByRole("combobox", { name: "Search commands and sessions" });
  await search.fill("host:local runtime:shell");
  await expect(page.getByRole("option").first()).toContainText("Open session:");
  await expect(search).toHaveAttribute("aria-activedescendant", /console-command-/);
  await page.keyboard.press("Escape");
  await command("Inspect host: Local");
  const inspector = page.getByRole("dialog", { name: "Host Local", exact: true });
  await expect(inspector).toContainText("REACHABILITY");
  await expect(inspector).toContainText("BACKEND");
  await page.keyboard.press("Escape");
  await command("Split right");
  const terminals = page.locator(".layout-cache-item.active .terminal-pane");
  await expect(terminals).toHaveCount(2);
  await terminals.evaluateAll((elements) => elements.forEach((element, index) => element.setAttribute("data-zoom-identity", String(index))));
  await command("Zoom active pane");
  await expect(terminals.filter({ visible: true })).toHaveCount(1);
  await expect(terminals).toHaveCount(2);
  await command("Restore split layout");
  await expect(terminals.filter({ visible: true })).toHaveCount(2);
  expect(await terminals.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-zoom-identity")))).toEqual(["0", "1"]);
  await command("Open agent fleet");
  await page.getByRole("button", { name: "[DOCK]", exact: true }).click();
  const fleet = page.getByRole("region", { name: "Agent fleet" });
  await expect(fleet).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("console-fleet-docked.png") });
  await fleet.getByRole("button", { name: "Close agent fleet" }).click();
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
  let releaseCreation: () => void = () => undefined;
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
  await awaitAppShell(page);
  await expect(page).toHaveURL(new RegExp(`${directPath.replaceAll("/", "\\/")}$`));
});

test("renames the current workspace through the command palette", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "one desktop command palette run covers the shared command");
  let workspaceId: string | undefined;
  const renamedTitle = `Command renamed ${Date.now()}`;

  try {
    const response = await request.post("/api/workspaces", { data: { machineId: "local" } });
    expect(response.ok()).toBeTruthy();
    const workspace = (await response.json() as {
      workspace: { id: string; name: string; activeTabId: string };
    }).workspace;
    workspaceId = workspace.id;

    await page.goto(`/workspaces/${workspace.id}/tabs/${workspace.activeTabId}`);
    await awaitAppShell(page);
    await page.keyboard.press("Control+K");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    const search = palette.getByPlaceholder("Search commands, workspaces, tabs, hosts");
    await search.fill("Rename current workspace");
    await search.press("Enter");

    const dialog = page.getByRole("dialog", { name: `Rename ${workspace.name}` });
    const nameInput = dialog.getByRole("textbox", { name: "Workspace name" });
    await expect(nameInput).toBeFocused();
    await expect(nameInput).toHaveValue(workspace.name);
    await nameInput.fill(renamedTitle);
    await nameInput.press("Enter");

    await expect(page.locator(`a[role="treeitem"][href^="/workspaces/${workspace.id}/"]`))
      .toHaveAccessibleName(new RegExp(`^${renamedTitle}`));
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
