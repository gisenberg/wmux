import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import {
  buildWindowsHelperBundle,
  buildWindowsPowerShellBootstrap,
  buildWindowsHealthProbeScript,
  expectedWindowsAgentVersion,
  windowsHelperBundleVersion,
} from "../src/server/windows-helpers.js";
import type { MachineConfig } from "../src/server/types.js";

const machine: MachineConfig = { id: "winbox", name: "winbox", kind: "powershell-ssh", host: "win.ts.net" };

test("bundle files carry correct sha256 digests and a stable version", () => {
  const bundle = buildWindowsHelperBundle(machine);
  assert.ok(bundle.files.length > 0);
  for (const file of bundle.files) {
    const digest = crypto.createHash("sha256").update(Buffer.from(file.dataBase64, "base64")).digest("hex");
    assert.equal(file.sha256, digest, `sha256 mismatch for ${file.name}`);
  }
  assert.match(bundle.bundleVersion, /^[0-9a-f]{16}$/);
  assert.equal(bundle.bundleVersion, windowsHelperBundleVersion());
  assert.equal(buildWindowsHelperBundle(machine).bundleVersion, bundle.bundleVersion);
});

test("bootstrap stages, verifies, then swaps and records the bundle version", () => {
  const script = buildWindowsPowerShellBootstrap(machine, undefined, {});
  assert.ok(script.includes(".staging-"), "bootstrap must stage into a scratch directory");
  assert.ok(script.includes("failed hash verification"), "bootstrap must verify file hashes");
  assert.ok(script.includes("bundle-version.json"), "bootstrap must record the staged bundle version");
});

test("health probe reports the staged and expected bundle versions", () => {
  const script = buildWindowsHealthProbeScript("http://10.0.0.1:3478");
  assert.ok(script.includes(`'${windowsHelperBundleVersion()}'`), "probe must bake in the expected version");
  assert.ok(script.includes("bundleVersion"));
  assert.ok(script.includes("helpersCurrent"));
});

test("expected agent version reads the shipped script's VERSION constant", () => {
  assert.match(expectedWindowsAgentVersion(), /^\d+\.\d+$/);
});
