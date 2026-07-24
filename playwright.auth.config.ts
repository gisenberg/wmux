import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { prepareAuthE2eRuntime } from "./e2e/auth-runtime.js";

const port = 3490;
const runtime = prepareAuthE2eRuntime();

export default defineConfig({
  testDir: "./e2e",
  testMatch: "auth-login-only.spec.ts",
  outputDir: "test-results/auth-playwright",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  globalTeardown: "./e2e/auth.global-teardown.ts",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    reducedMotion: "reduce",
    trace: "off",
    screenshot: "off",
  },
  webServer: {
    command: `node --import tsx src/server/index.ts --dev --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      HOME: runtime.home,
      WMUX_BROWSER_AUTH_MODE: "login-only",
      WMUX_CONFIG_PATH: path.resolve("e2e", "fixtures", "wmux.config.json"),
      WMUX_STATE_PATH: path.join(runtime.directory, "state.json"),
      WMUX_SETTINGS_PATH: path.join(runtime.directory, "settings.json"),
      WMUX_AGENT_TIMELINE_PATH: path.join(runtime.directory, "agent-timelines.json"),
      WMUX_ATTACHMENT_DIR: path.join(runtime.directory, "attachments"),
      WMUX_PUBLIC_URL: `http://127.0.0.1:${port}`,
      WMUX_CERT_FILE: "",
      WMUX_KEY_FILE: "",
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: "chromium", viewport: { width: 1440, height: 900 } } }],
});
