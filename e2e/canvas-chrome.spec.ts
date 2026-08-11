import { awaitAppShell, createNestedWorkspacePair, expect, test } from "./fixtures";

const waitForLifeFrameWindow = async (
  page: import("@playwright/test").Page,
  milliseconds: number,
): Promise<void> => {
  // The fixed interval spans the external animation clock so the test can prove that hidden rendering stays paused.
  await page.waitForTimeout(milliseconds);
};

const openDelayedRetroBoot = async ({
  browser,
  currentPage,
  mobile,
  randomValue,
}: {
  browser: import("@playwright/test").Browser;
  currentPage: import("@playwright/test").Page;
  mobile: boolean;
  randomValue: number;
}) => {
  const context = await browser.newContext({
    reducedMotion: "no-preference",
    viewport: mobile ? { width: 412, height: 915 } : { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  let releaseBootstrap: () => void = () => undefined;
  const bootstrapGate = new Promise<void>((resolve) => {
    releaseBootstrap = resolve;
  });
  await page.addInitScript((selectionRandom) => {
    Math.random = () => selectionRandom;
  }, randomValue);
  await page.routeWebSocket("**/ws/events", (webSocket) => webSocket.close());
  await page.route("**/api/bootstrap", async (route) => {
    await bootstrapGate;
    await route.continue();
  }, { times: 1 });
  await page.goto(new URL("/", currentPage.url()).href, { waitUntil: "domcontentloaded" });
  return {
    context,
    page,
    close: async () => {
      releaseBootstrap();
      await context.close();
    },
  };
};

test("legacy query parameters canonicalize to the canvas chrome", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "canvas desktop routing coverage");
  test.setTimeout(60_000);
  await page.goto("/?legacy=1");
  await awaitAppShell(page);
  await expect(page.locator(".open-tui-sidebar canvas")).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.has("legacy")).toBe(false);
});

test("canvas workspace tree exposes nested depth and agent origin", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "canvas desktop tree coverage");
  test.setTimeout(60_000);
  const { child, root } = await createNestedWorkspacePair(request);
  try {
    await page.goto(`/workspaces/${root.id}/tabs/${root.activeTabId}`);
    await awaitAppShell(page);
    const rootItem = page.locator(`a[role="treeitem"][href^="/workspaces/${root.id}/"]`);
    const childItem = page.locator(`a[role="treeitem"][href^="/workspaces/${child.id}/"]`);
    await expect(rootItem).toHaveAttribute("aria-level", "1");
    await expect(childItem).toHaveAttribute("aria-level", "2");
    await expect(childItem).toHaveAttribute("data-agent-created", "true");
    await expect(childItem).toHaveAttribute("aria-label", /created by an agent/);
    const collapseButton = page.getByRole("button", { name: `Collapse ${root.name}` });
    await collapseButton.focus();
    await page.keyboard.press("Enter");
    await expect(childItem).toHaveCount(0);
    const expandButton = page.getByRole("button", { name: `Expand ${root.name}` });
    await expandButton.focus();
    await page.keyboard.press("Enter");
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
    await expect.poll(
      async () => Number(await canvas.getAttribute("data-render-frame") ?? 0),
      { timeout: 20_000 },
    ).toBeGreaterThan(2);

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
    screen: "rgb(12, 13, 15)",
    bezel: "rgb(85, 204, 238)",
    padding: ["31px", "13px", "29px", "17px"],
  });
});

test("desktop boot overlay covers the shell until the sequence completes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop boot overlay coverage");
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
  const overlay = page.locator(".retro-boot-screen.retro-boot-overlay");
  await expect(overlay).toBeVisible();
  await expect(page.locator("main.app-shell")).toHaveAttribute("aria-hidden", "true");
  expect(await page.evaluate(() =>
    document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
      ?.closest(".retro-boot-screen") !== null,
  )).toBe(true);
  await expect(page.locator(".retro-boot-screen")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator("main.app-shell")).not.toHaveAttribute("aria-hidden", "true");
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
  await expect(page.locator(".retro-boot-screen")).toHaveCount(0, { timeout: 2_000 });
});

test("Spectrum tape phases animate their native palettes and stop under reduced motion", async ({
  browser,
  page: currentPage,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop boot-effect coverage");
  const boot = await openDelayedRetroBoot({
    browser,
    currentPage,
    mobile: false,
    randomValue: 0.212_765_957_446_808_5,
  });
  try {
    const screen = boot.page.locator('[data-boot-profile="zx-spectrum"]');
    await expect.poll(async () => screen.evaluate((element) => {
      const style = getComputedStyle(element);
      return element.getAttribute("data-tape-border") === "header"
        && style.animationName === "retro-tape-border-shift"
        && style.backgroundImage.includes("rgb(0, 215, 215)")
        && style.backgroundImage.includes("rgb(215, 0, 0)");
    }), { intervals: [10, 20, 50], timeout: 20_000 }).toBe(true);
    await boot.page.screenshot({ path: testInfo.outputPath("zx-spectrum-header.png") });

    await boot.page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => screen.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
    await boot.page.emulateMedia({ reducedMotion: "no-preference" });

    await expect.poll(async () => screen.evaluate((element) => {
      const style = getComputedStyle(element);
      return element.getAttribute("data-tape-border") === "data"
        && style.animationDuration === "0.11s"
        && style.backgroundImage.includes("rgb(22, 59, 215)")
        && style.backgroundImage.includes("rgb(230, 219, 0)");
    }), { intervals: [10, 20, 50], timeout: 20_000 }).toBe(true);
  } finally {
    await boot.close();
  }
});

test("mobile tape borders stay inside browser safe-area chrome", async ({ browser, page: currentPage }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile boot-effect coverage");
  const boot = await openDelayedRetroBoot({
    browser,
    currentPage,
    mobile: true,
    randomValue: 0.212_765_957_446_808_5,
  });
  try {
    const screen = boot.page.locator('[data-boot-profile="zx-spectrum"]');
    await expect.poll(async () => screen.evaluate((element) => {
      const bezel = element.querySelector<HTMLElement>(".retro-boot-bezel")!;
      const screenStyle = getComputedStyle(element);
      const bezelStyle = getComputedStyle(bezel);
      return element.getAttribute("data-tape-border") === "header"
        && screenStyle.backgroundColor === "rgb(12, 13, 15)"
        && screenStyle.backgroundImage === "none"
        && bezelStyle.backgroundImage.includes("rgb(0, 215, 215)");
    }), { intervals: [10, 20, 50], timeout: 20_000 }).toBe(true);
    await boot.page.screenshot({ path: testInfo.outputPath("zx-spectrum-mobile-header.png") });
  } finally {
    await boot.close();
  }
});

test("TRS-80 Model 4 keeps all 80 columns inside the mobile framebuffer", async ({
  browser,
  page: currentPage,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile 80-column coverage");
  const boot = await openDelayedRetroBoot({
    browser,
    currentPage,
    mobile: true,
    randomValue: 0.184_397_163_120_567_36,
  });
  try {
    const screen = boot.page.locator('[data-boot-profile="trs-80-model-4"]');
    await expect(screen.locator(".retro-boot-terminal canvas")).toBeVisible({ timeout: 20_000 });
    const bounds = await screen.evaluate((element) => {
      const framebuffer = element.querySelector<HTMLElement>(".retro-boot-framebuffer")!.getBoundingClientRect();
      const terminal = element.querySelector<HTMLElement>(".retro-boot-terminal")!;
      const canvas = terminal.querySelector("canvas")!.getBoundingClientRect();
      return {
        canvasLeft: canvas.left,
        canvasRight: canvas.right,
        framebufferLeft: framebuffer.left,
        framebufferRight: framebuffer.right,
        overflowX: getComputedStyle(terminal).overflowX,
        scrollWidth: terminal.scrollWidth,
        clientWidth: terminal.clientWidth,
      };
    });
    expect(bounds.canvasLeft).toBeGreaterThanOrEqual(bounds.framebufferLeft - 0.5);
    expect(bounds.canvasRight).toBeLessThanOrEqual(bounds.framebufferRight + 0.5);
    expect(bounds.overflowX).toBe("hidden");
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
    await boot.page.screenshot({ path: testInfo.outputPath("trs-80-model-4-mobile.png") });
  } finally {
    await boot.close();
  }
});
