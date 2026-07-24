import { expect, test } from "./fixtures";

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
