import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const captureEnabled =
  process.env.WMUX_CAPTURE_DOCS === "1" || process.env.npm_lifecycle_event === "docs:screenshots";
const imageDir = path.resolve("docs", "images");

interface ScreenshotBootstrap {
  activeWorkspaceId: string;
  workspaces: Array<{
    id: string;
    tabs: Array<{ panes: Array<{ id: string }> }>;
  }>;
}

const terminalDemo = [
  "printf '\\033[2J\\033[H",
  "\\033[1;36mwmux\\033[0m  browser terminal multiplexer\\n\\n",
  "  \\033[32m●\\033[0m local session attached\\n",
  "  \\033[32m●\\033[0m durable workspace state\\n",
  "  \\033[32m●\\033[0m desktop + mobile controls\\n\\n",
  "'\r",
].join("");

async function paintTerminalDemo(request: APIRequestContext, paneId: string): Promise<void> {
  const response = await request.post(`/api/panes/${paneId}/input`, {
    data: { data: terminalDemo, cols: 120, rows: 36 },
  });
  expect(response.ok()).toBeTruthy();
}

async function seedTerminal(request: APIRequestContext): Promise<void> {
  const response = await request.get("/api/bootstrap");
  expect(response.ok()).toBeTruthy();
  const bootstrap = await response.json() as ScreenshotBootstrap;
  const workspace = bootstrap.workspaces.find((candidate) => candidate.id === bootstrap.activeWorkspaceId)
    ?? bootstrap.workspaces[0];
  const pane = workspace?.tabs[0]?.panes[0];
  if (!workspace || !pane) throw new Error("the screenshot fixture did not create an active pane");

  const titleResponse = await request.post(`/api/workspaces/${workspace.id}/title`, {
    data: { title: "Documentation Preview" },
  });
  expect(titleResponse.ok()).toBeTruthy();

  await paintTerminalDemo(request, pane.id);
}

async function openApp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Math.random = () => 0;
  });
  await page.goto("/");
  await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.waitForTimeout(500);
}

test.describe("documentation screenshots", () => {
  test.skip(!captureEnabled, "run npm run docs:screenshots to regenerate documentation images");

  test("captures the public desktop and mobile views", async ({ page, request }, testInfo) => {
    fs.mkdirSync(imageDir, { recursive: true });
    await seedTerminal(request);
    await openApp(page);

    if (testInfo.project.name === "chromium") {
      await page.screenshot({
        path: path.join(imageDir, "wmux-desktop.png"),
        animations: "disabled",
      });
      await page.keyboard.press("Control+K");
      await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
      await page.screenshot({
        path: path.join(imageDir, "wmux-command-palette.png"),
        animations: "disabled",
      });
      return;
    }

    const mobileChrome = page.getByRole("banner", { name: "Mobile session controls" });
    await mobileChrome.getByRole("button", { name: "Open terminal" }).click();
    await expect(page.locator(".terminal-pane.active")).toHaveClass(/terminal-ready/, { timeout: 10_000 });
    await page.screenshot({
      path: path.join(imageDir, "wmux-mobile-terminal.png"),
      animations: "disabled",
    });

    await mobileChrome.getByRole("button", { name: "Open workspaces and hosts" }).click();
    await expect(page.getByRole("complementary", { name: "Workspace navigation" })).toBeVisible();
    await page.screenshot({
      path: path.join(imageDir, "wmux-mobile-navigation.png"),
      animations: "disabled",
    });
  });
});
