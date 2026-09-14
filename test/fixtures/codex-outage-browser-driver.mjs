import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const required = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`missing ${key}`);
  return value;
};
const base = required("WMUX_OUTAGE_URL"), token = required("WMUX_OUTAGE_TOKEN");
const workspaceId = required("WMUX_OUTAGE_WORKSPACE"), tabId = required("WMUX_OUTAGE_TAB");
const otherWorkspaceId = required("WMUX_OUTAGE_OTHER_WORKSPACE"), otherTabId = required("WMUX_OUTAGE_OTHER_TAB");
const route = `${base}/workspaces/${workspaceId}/tabs/${tabId}`;

const bootstrap = async (page) => page.evaluate((value) => fetch("/api/bootstrap", { headers: { authorization: `Bearer ${value}` } }).then((response) => response.json()), token);
const run = async (page, mobile, command) => {
  if (mobile) {
    await page.getByRole("button", { name: "Open chat", exact: true }).click();
    await page.getByRole("button", { name: "Actions", exact: true }).click();
  } else await page.keyboard.press("Control+K");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.waitFor({ state: "visible", timeout: 8_000 });
  const search = palette.getByPlaceholder("Search commands, workspaces, tabs, hosts");
  await search.fill(command);
  if (mobile) await palette.getByRole("button", { name: new RegExp(command) }).click();
  else await search.press("Enter");
  await palette.waitFor({ state: "detached", timeout: 8_000 });
};
const rename = async (page, mobile, command, value) => {
  await run(page, mobile, command);
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: /name$/i }).fill(value);
  await dialog.getByRole("button", { name: "[OK] Save name" }).click();
  await dialog.waitFor({ state: "detached", timeout: 8_000 });
};

const browser = await chromium.launch({ headless: true });
try {
  // Mobile first: a desktop-only renderer stall is then reported separately.
  for (const profile of [
    // Match the known-good M2 mobile fixture rather than the Pixel device
    // profile, whose browser renderer can stall in this isolated harness.
    { name: "mobile", options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, mobile: true },
    { name: "desktop", options: { viewport: { width: 1440, height: 900 } }, mobile: false },
  ]) {
    const context = await browser.newContext(profile.options);
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    await page.addInitScript((value) => window.localStorage.setItem("wmux.token", value), token);
    await page.goto(route, { waitUntil: "domcontentloaded", timeout: 12_000 });
    await page.locator("main.app-shell").waitFor({ state: "visible", timeout: 12_000 });
    await page.locator(".retro-boot-screen").waitFor({ state: "detached", timeout: 20_000 });
    await rename(page, profile.mobile, "Rename current workspace", `${profile.name} workspace pin`);
    await rename(page, profile.mobile, "Rename current tab", `${profile.name} tab pin`);
    await run(page, profile.mobile, "Use automatic workspace name");
    let state = await bootstrap(page), target = state.workspaces.find((item) => item.id === workspaceId), other = state.workspaces.find((item) => item.id === otherWorkspaceId);
    assert.equal(target.nameSource, "default"); assert.equal(target.tabs.find((item) => item.id === tabId).titleSource, "user");
    assert.equal(other.name, "Other workspace pin"); assert.equal(other.tabs.find((item) => item.id === otherTabId).title, "Other tab pin");
    await rename(page, profile.mobile, "Rename current workspace", `${profile.name} workspace repin`);
    await run(page, profile.mobile, "Use automatic tab name");
    state = await bootstrap(page); target = state.workspaces.find((item) => item.id === workspaceId);
    assert.equal(target.nameSource, "user"); assert.equal(target.tabs.find((item) => item.id === tabId).titleSource, "default");
    await run(page, profile.mobile, "Use automatic workspace name");
    await run(page, profile.mobile, "Rename current workspace");
    assert.match(await page.getByRole("dialog").innerText(), /automatic name awaiting a native title/i);
    await page.keyboard.press("Escape");
    await run(page, profile.mobile, "Rename current tab");
    assert.match(await page.getByRole("dialog").innerText(), /automatic name awaiting a native title/i);
    await page.keyboard.press("Escape");
    await context.close();
  }
  process.stdout.write("browser outage controls passed\n");
} finally {
  await browser.close();
}
