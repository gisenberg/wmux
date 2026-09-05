import { awaitAppShell, createNestedWorkspacePair, expect, test } from "./fixtures";
import { RETRO_BOOT_PROFILES } from "../src/client/src/retro-boot-profiles";

const profileRandom = (id: string) => {
  const index = RETRO_BOOT_PROFILES.findIndex((profile) => profile.id === id);
  if (index < 0) throw new Error(`Unknown boot profile ${id}`);
  const weightBefore = RETRO_BOOT_PROFILES.slice(0, index).reduce((sum, profile) => sum + (profile.weight ?? 1), 0);
  const total = RETRO_BOOT_PROFILES.reduce((sum, profile) => sum + (profile.weight ?? 1), 0);
  return (weightBefore + (RETRO_BOOT_PROFILES[index].weight ?? 1) / 2) / total;
};

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
  controlledClock = false,
}: {
  browser: import("@playwright/test").Browser;
  currentPage: import("@playwright/test").Page;
  mobile: boolean;
  randomValue: number;
  controlledClock?: boolean;
}) => {
  const storageState = await currentPage.context().storageState();
  const context = await browser.newContext({
    reducedMotion: "no-preference",
    storageState,
    viewport: mobile ? { width: 412, height: 915 } : { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  if (controlledClock) {
    const start = new Date("2025-01-01T00:00:00Z");
    await page.clock.install({ time: start });
    await page.clock.pauseAt(new Date(start.getTime() + 60_000));
  }
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
  });
  await page.goto(new URL("/", currentPage.url()).href, { waitUntil: "domcontentloaded" });
  return {
    context,
    page,
    close: async () => {
      releaseBootstrap();
      await context.close();
      expect(pageErrors, "retro boot must not throw browser errors").toEqual([]);
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
    controlledClock: true,
  });
  try {
    const screen = boot.page.locator('[data-boot-profile="zx-spectrum"]');
    await expect.poll(async () => {
      await boot.page.clock.runFor(50);
      return screen.evaluate((element) => {
        const style = getComputedStyle(element);
        return element.getAttribute("data-tape-border") === "header"
          && style.animationName === "retro-tape-border-shift"
          && !style.backgroundImage.includes("135deg")
          && style.backgroundSize === "100% 24px"
          && style.backgroundImage.includes("rgb(0, 215, 215)")
          && style.backgroundImage.includes("rgb(215, 0, 0)");
      });
    }, { intervals: [10, 20, 50], timeout: 20_000 }).toBe(true);
    await boot.page.screenshot({ path: testInfo.outputPath("zx-spectrum-header.png") });

    await boot.page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => screen.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
    await boot.page.emulateMedia({ reducedMotion: "no-preference" });

    await expect.poll(async () => {
      await boot.page.clock.runFor(50);
      return screen.evaluate((element) => {
        const style = getComputedStyle(element);
        return element.getAttribute("data-tape-border") === "data"
          && style.animationDuration === "0.11s"
          && style.backgroundImage.includes("rgb(22, 59, 215)")
          && style.backgroundImage.includes("rgb(230, 219, 0)");
      });
    }, { intervals: [10, 20, 50], timeout: 20_000 }).toBe(true);
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
        && !bezelStyle.backgroundImage.includes("135deg")
        && bezelStyle.backgroundImage.includes("rgb(0, 215, 215)");
    }), { intervals: [10, 20, 50], timeout: 20_000 }).toBe(true);
    await boot.page.screenshot({ path: testInfo.outputPath("zx-spectrum-mobile-header.png") });
  } finally {
    await boot.close();
  }
});

test("PC POST advances its in-place memory count before loading DOS", async ({ browser, page: currentPage }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop POST coverage");
  const boot = await openDelayedRetroBoot({ browser, currentPage, mobile: false, randomValue: profileRandom("ibm-pc-at") });
  try {
    const screen = boot.page.locator('[data-boot-profile="ibm-pc-at"]');
    await expect.poll(() => screen.getAttribute("data-boot-step"), { intervals: [10, 20, 50] }).toMatch(/^[1-9]$/);
    await expect(screen.locator("canvas")).toBeVisible();
    await boot.page.screenshot({ path: testInfo.outputPath("pc-memory-count.png") });
    await expect.poll(() => screen.getAttribute("data-boot-step"), { intervals: [10, 20, 50] }).toMatch(/^(1[89]|2\d)$/);
    await boot.page.screenshot({ path: testInfo.outputPath("pc-post-complete.png") });
  } finally {
    await boot.close();
  }
});

test("BBC boot uses the teletext face and fits the framebuffer", async ({ browser, page: currentPage }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop teletext coverage");
  const boot = await openDelayedRetroBoot({ browser, currentPage, mobile: false, randomValue: profileRandom("bbc-micro") });
  try {
    const screen = boot.page.locator('[data-boot-profile="bbc-micro"]');
    await expect.poll(() => screen.getAttribute("data-boot-step")).toMatch(/^[2-9]$/);
    await expect(screen.locator("canvas")).toBeVisible();
    expect(await boot.page.evaluate(() => document.fonts.check('16px "Retro SAA 5050"'))).toBe(true);
    await boot.page.screenshot({ path: testInfo.outputPath("bbc-mode7.png") });
  } finally {
    await boot.close();
  }
});

test("NeXT desktop uses a vertical floating menu opposite the dock", async ({ browser, page: currentPage }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop NeXT layout coverage");
  const boot = await openDelayedRetroBoot({ browser, currentPage, mobile: false, randomValue: profileRandom("nextcube") });
  try {
    const menu = boot.page.locator(".retro-next-menu");
    await expect(menu).toBeVisible();
    const title = await menu.locator("strong").boundingBox();
    const info = await menu.locator(":scope > span").first().boundingBox();
    const view = await menu.locator(":scope > span").last().boundingBox();
    const dock = await boot.page.locator(".retro-next-dock").boundingBox();
    expect(info!.y).toBeGreaterThan(title!.y);
    expect(view!.y).toBeGreaterThan(info!.y);
    expect(view!.x).toBe(info!.x);
    expect(dock!.x).toBeGreaterThan(info!.x + info!.width);
    await boot.page.screenshot({ path: testInfo.outputPath("next-workspace-menu.png") });
  } finally {
    await boot.close();
  }
});

for (const activation of ["click", "Enter"] as const) {
  test(`Guru Meditation acknowledges ${activation} without completing bootstrap`, async ({ browser, page: currentPage }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "desktop Guru interaction coverage");
    const boot = await openDelayedRetroBoot({ browser, currentPage, mobile: false, randomValue: profileRandom("amiga-guru-meditation") });
    try {
      const screen = boot.page.locator('[data-boot-profile="amiga-guru-meditation"]');
      const recovery = boot.page.getByRole("button", { name: "Continue after Amiga Guru Meditation" });
      await expect(recovery).toBeVisible();
      if (activation === "click") await recovery.click();
      else {
        await recovery.focus();
        await boot.page.keyboard.press("Enter");
      }
      await expect(screen).not.toHaveAttribute("data-boot-phase", "guru", { timeout: 1_500 });
      await expect(screen).toHaveAttribute("data-boot-phase", "artwork");
      await boot.page.screenshot({ path: testInfo.outputPath(`guru-recovery-${activation}.png`) });
      await expect(screen).toBeVisible();
      await expect(boot.page.locator("main.app-shell")).toHaveCount(0);
    } finally {
      await boot.close();
    }
  });
}

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
