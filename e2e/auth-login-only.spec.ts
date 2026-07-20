import { expect, test } from "@playwright/test";
import { readAuthE2eRuntime } from "./auth-runtime.js";

const runtime = readAuthE2eRuntime();

test("login-only gates legacy browser credentials and permits browser sessions", async ({ page }) => {
  const responses: Array<{ path: string; status: number }> = [];
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith("/api/")) responses.push({ path, status: response.status() });
  });
  await page.addInitScript(() => {
    const storageKey = "wmux.auth-e2e.paths";
    const paths: string[] = JSON.parse(window.sessionStorage.getItem(storageKey) ?? "[]");
    const record = (value: string | URL) => {
      paths.push(new URL(String(value), location.href).pathname);
      window.sessionStorage.setItem(storageKey, JSON.stringify(paths));
    };
    const originalFetch = window.fetch;
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      record(input instanceof Request ? input.url : input);
      return originalFetch(input, init);
    }) as typeof window.fetch;
    const OriginalWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(OriginalWebSocket, {
      construct(target, args) {
        record(args[0] as string | URL);
        return Reflect.construct(target, args) as WebSocket;
      },
    });
    (window as unknown as { __authE2ePaths: string[] }).__authE2ePaths = paths;
  });
  await page.addInitScript((legacyToken) => {
    if (!window.localStorage.getItem("wmux.token")) window.localStorage.setItem("wmux.token", legacyToken);
  }, runtime.legacyToken);
  await page.goto(`/?token=${encodeURIComponent(runtime.legacyToken)}`);

  await expect(page.getByRole("textbox", { name: "Username" })).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByText(/access token required/i)).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
  expect(await page.evaluate(() => window.localStorage.getItem("wmux.token") === null)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { __authE2ePaths: string[] }).__authE2ePaths)).not.toContain("/api/bootstrap");
  expect(await page.evaluate(() => (window as unknown as { __authE2ePaths: string[] }).__authE2ePaths)).not.toContain("/ws/events");
  expect(await page.evaluate(() => (window as unknown as { __authE2ePaths: string[] }).__authE2ePaths.some((path) => path.startsWith("/ws/panes/")))).toBe(false);

  await page.getByRole("textbox", { name: "Username" }).fill(runtime.username);
  await page.getByLabel("Password").fill(runtime.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  try {
    await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
  } catch {
    const ui = await page.evaluate(() => ({
      login: Boolean(document.querySelector(".wmux-login")),
      app: Boolean(document.querySelector("main.app-shell")),
      loadState: Boolean(document.querySelector(".load-state")),
      boot: Boolean(document.querySelector(".retro-boot-screen, .retro-graphical-boot-screen")),
    }));
    throw new Error(`post-login UI did not mount; api=${JSON.stringify(responses)} ui=${JSON.stringify(ui)}`);
  }
  await expect.poll(() => page.evaluate(() => (window as unknown as { __authE2ePaths: string[] }).__authE2ePaths)).toContain("/api/bootstrap");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __authE2ePaths: string[] }).__authE2ePaths)).toContain("/ws/events");
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __authE2ePaths: string[] }).__authE2ePaths.some((path) => path.startsWith("/ws/panes/")),
  )).toBe(true);

  await page.reload();
  try {
    await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
  } catch {
    const ui = await page.evaluate(() => ({
      login: Boolean(document.querySelector(".wmux-login")),
      app: Boolean(document.querySelector("main.app-shell")),
      loadState: Boolean(document.querySelector(".load-state")),
      boot: Boolean(document.querySelector(".retro-boot-screen, .retro-graphical-boot-screen")),
    }));
    throw new Error(`post-reload UI did not mount; api=${JSON.stringify(responses)} ui=${JSON.stringify(ui)}`);
  }
  await expect.poll(() => page.evaluate(() => (window as unknown as { __authE2ePaths: string[] }).__authE2ePaths.filter((path) => path === "/ws/events").length)).toBeGreaterThan(1);
});

test("login-only clears an invalid stored browser session", async ({ page }) => {
  await page.addInitScript((invalidSession) => window.localStorage.setItem("wmux.token", invalidSession), runtime.invalidSession);
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Username" })).toBeVisible();
  expect(await page.evaluate(() => window.localStorage.getItem("wmux.token") === null)).toBe(true);
});
