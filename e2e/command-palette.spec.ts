import { expect, test } from "./fixtures";

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
