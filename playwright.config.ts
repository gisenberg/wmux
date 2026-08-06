import { defineConfig, devices } from "@playwright/test";
import { resolveExternalE2eToken } from "./e2e/config-auth.js";
import { resolveE2ePort } from "./e2e/config-port.js";
import { prepareStandardE2eRuntime } from "./e2e/standard-runtime.js";

const port = resolveE2ePort();
const externalBaseURL = process.env.WMUX_E2E_BASE_URL?.trim().replace(/\/+$/, "");
const baseURL = externalBaseURL || `http://127.0.0.1:${port}`;
const externalToken = resolveExternalE2eToken(externalBaseURL);
const runtime = externalBaseURL ? undefined : prepareStandardE2eRuntime({ baseURL });
const externalStorageState = externalBaseURL && externalToken ? {
  cookies: [],
  origins: [{
    origin: new URL(externalBaseURL).origin,
    localStorage: [{ name: "wmux.token", value: externalToken }],
  }],
} : undefined;

export default defineConfig({
  testDir: "./e2e",
  testIgnore: "auth-login-only.spec.ts",
  outputDir: "test-results/playwright",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["line"], ["html", { outputFolder: "test-results/playwright-report", open: "never" }]] : "line",
  use: {
    baseURL,
    reducedMotion: "reduce",
    trace: externalBaseURL ? "off" : "retain-on-failure",
    screenshot: "only-on-failure",
    ...(externalStorageState ? { storageState: externalStorageState } : {}),
  },
  webServer: runtime ? {
    command: `node --import tsx src/server/index.ts --dev --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      ...runtime.environment,
    },
  } : undefined,
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
