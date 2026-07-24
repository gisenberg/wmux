import { createNestedWorkspacePair, expect, test } from "./fixtures";

const waitForLifeFrameWindow = async (
  page: import("@playwright/test").Page,
  milliseconds: number,
): Promise<void> => {
  // The fixed interval spans the external animation clock so the test can prove that hidden rendering stays paused.
  await page.waitForTimeout(milliseconds);
};

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
    await waitForLifeFrameWindow(page, 180);
    const pausedAt = Number(await canvas.getAttribute("data-render-frame"));
    await waitForLifeFrameWindow(page, 300);
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
