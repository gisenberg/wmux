import fs from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const port = 3489;
const runtimeDir = path.resolve("test-results", `e2e-runtime-${process.pid}`);
fs.mkdirSync(runtimeDir, { recursive: true });

export default defineConfig({
  testDir: "./e2e",
  testIgnore: "auth-login-only.spec.ts",
  outputDir: "test-results/playwright",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["line"], ["html", { outputFolder: "test-results/playwright-report", open: "never" }]] : "line",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `node --import tsx src/server/index.ts --dev --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      WMUX_DISABLE_AUTH: "1",
      WMUX_CONFIG_PATH: path.resolve("e2e", "fixtures", "wmux.config.json"),
      WMUX_STATE_PATH: path.join(runtimeDir, "state.json"),
      WMUX_SETTINGS_PATH: path.join(runtimeDir, "settings.json"),
      WMUX_ATTACHMENT_DIR: path.join(runtimeDir, "attachments"),
      WMUX_PUBLIC_URL: `http://127.0.0.1:${port}`,
      WMUX_CERT_FILE: "",
      WMUX_KEY_FILE: "",
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
    },
    {
      name: "mobile-webkit",
      use: { ...devices["iPhone 14"] },
    },
  ],
});
