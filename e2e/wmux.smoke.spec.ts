import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Math.random = () => 0;
  });
  await page.goto("/");
  await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
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

test("mobile chrome keeps navigation, chat, terminal, and actions reachable", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile-"), "mobile-only smoke coverage");

  const chrome = page.getByRole("banner", { name: "Mobile session controls" });
  await expect(chrome).toBeVisible();
  await expect(chrome.getByRole("button", { name: "Open chat" })).toHaveAttribute("aria-pressed", "true");
  await chrome.getByRole("button", { name: "Open terminal" }).click();
  await expect(chrome.getByRole("button", { name: "Open terminal" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".terminal-pane.active")).toHaveClass(/terminal-ready/, { timeout: 10_000 });

  await chrome.getByRole("button", { name: "Open workspaces and hosts" }).click();
  const navigation = page.getByRole("complementary", { name: "Workspace navigation" });
  await expect(navigation).toBeVisible();
  await expect(navigation.locator(".workspace-version-badge")).toHaveCount(0);
  await page.locator("button.mobile-sidebar-close").click();

  await chrome.getByRole("button", { name: "Open actions" }).click();
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
});
