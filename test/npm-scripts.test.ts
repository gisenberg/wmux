import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

test("npm build and screenshot scripts work in Windows command shells", () => {
  assert.equal(packageJson.scripts["build:client"], "node scripts/build-client.mjs");
  assert.equal(packageJson.scripts["check:scripts"], "node scripts/check-scripts.mjs");
  assert.equal(
    packageJson.scripts["check:contracts"],
    "node --import tsx scripts/generate-agent-contract.mjs --check",
  );
  assert.equal(
    packageJson.scripts["docs:screenshots"],
    "playwright test e2e/docs-screenshots.spec.ts --project=chromium --project=mobile-chromium",
  );
});

test("the portable client build wrapper selects production before loading Vite", () => {
  const source = fs.readFileSync(path.join(repoRoot, "scripts", "build-client.mjs"), "utf8");
  const productionAt = source.indexOf('process.env.NODE_ENV = "production"');
  const viteAt = source.indexOf('await import("vite")');

  assert.ok(productionAt >= 0, "wrapper sets NODE_ENV to production");
  assert.ok(viteAt > productionAt, "wrapper imports Vite after setting NODE_ENV");
});

test("the npm screenshot lifecycle enables documentation capture", () => {
  const source = fs.readFileSync(path.join(repoRoot, "e2e", "docs-screenshots.spec.ts"), "utf8");

  assert.match(source, /process\.env\.WMUX_CAPTURE_DOCS === "1"/);
  assert.match(source, /process\.env\.npm_lifecycle_event === "docs:screenshots"/);
});
