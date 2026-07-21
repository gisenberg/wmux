import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const provisioner = path.join(repoRoot, "scripts", "wmux-provision-scoped-auth.mjs");

test("scoped auth provisioning is atomic, owner-only, distinct, and secret-silent", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-provision-"));
  try {
    const result = await execFileAsync(process.execPath, [provisioner], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, WMUX_CONFIG_PATH: "" },
    });
    const directory = path.join(home, ".wmux");
    const automation = fs.readFileSync(path.join(directory, "automation-token"), "utf8").trim();
    const helper = fs.readFileSync(path.join(directory, "helper-token"), "utf8").trim();
    assert.match(automation, /^[A-Za-z0-9_-]{43}$/);
    assert.match(helper, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(automation, helper);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(directory, "automation-token")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(directory, "helper-token")).mode & 0o777, 0o600);
    assert.equal(result.stdout.includes(automation), false);
    assert.equal(result.stdout.includes(helper), false);
    assert.equal(fs.existsSync(path.join(directory, "token")), false);
    const second = await execFileAsync(process.execPath, [provisioner], { cwd: repoRoot, env: { ...process.env, HOME: home, WMUX_CONFIG_PATH: "" } });
    assert.equal(second.stdout.includes(automation), false);
    assert.equal(fs.readFileSync(path.join(directory, "automation-token"), "utf8").trim(), automation);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("scoped auth provisioning hardens the standard state directory but rejects unsafe custom parents", async () => {
  const unsafeHome = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-provision-unsafe-"));
  try {
    fs.mkdirSync(path.join(unsafeHome, ".wmux"), { mode: 0o755 });
    await execFileAsync(process.execPath, [provisioner], {
      cwd: repoRoot,
      env: { ...process.env, HOME: unsafeHome, WMUX_CONFIG_PATH: "" },
    });
    assert.equal(fs.statSync(path.join(unsafeHome, ".wmux")).mode & 0o777, 0o700);
  } finally {
    fs.rmSync(unsafeHome, { recursive: true, force: true });
  }

  const customHome = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-provision-custom-"));
  try {
    const customParent = path.join(customHome, "tokens");
    fs.mkdirSync(customParent, { mode: 0o755 });
    await assert.rejects(execFileAsync(process.execPath, [provisioner], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: customHome,
        WMUX_AUTOMATION_TOKEN_PATH: path.join(customParent, "automation-token"),
        WMUX_CONFIG_PATH: "",
      },
    }), /owner-only/);
  } finally {
    fs.rmSync(customHome, { recursive: true, force: true });
  }
});

test("scoped auth provisioning rejects symlinks and duplicate or malformed secrets", async () => {
  const linkedHome = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-provision-link-"));
  try {
    const state = path.join(linkedHome, ".wmux");
    fs.mkdirSync(state, { mode: 0o700 });
    const target = path.join(state, "target");
    fs.writeFileSync(target, `${"A".repeat(43)}\n`, { mode: 0o600 });
    fs.symlinkSync(target, path.join(state, "automation-token"));
    await assert.rejects(execFileAsync(process.execPath, [provisioner], { cwd: repoRoot, env: { ...process.env, HOME: linkedHome, WMUX_CONFIG_PATH: "" } }), /regular file/);
  } finally {
    fs.rmSync(linkedHome, { recursive: true, force: true });
  }

  const duplicateHome = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-provision-duplicate-"));
  try {
    const state = path.join(duplicateHome, ".wmux");
    fs.mkdirSync(state, { mode: 0o700 });
    fs.writeFileSync(path.join(state, "automation-token"), `${"D".repeat(43)}\n`, { mode: 0o600 });
    await assert.rejects(execFileAsync(process.execPath, [provisioner], {
      cwd: repoRoot,
      env: { ...process.env, HOME: duplicateHome, WMUX_TOKEN: "D".repeat(43), WMUX_CONFIG_PATH: "" },
    }), /duplicates another configured secret/);
  } finally {
    fs.rmSync(duplicateHome, { recursive: true, force: true });
  }

  const malformedHome = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-provision-malformed-"));
  try {
    const state = path.join(malformedHome, ".wmux");
    fs.mkdirSync(state, { mode: 0o700 });
    fs.writeFileSync(path.join(state, "helper-token"), "short\n", { mode: 0o600 });
    await assert.rejects(execFileAsync(process.execPath, [provisioner], {
      cwd: repoRoot,
      env: { ...process.env, HOME: malformedHome, WMUX_CONFIG_PATH: "" },
    }), /empty or malformed/);
  } finally {
    fs.rmSync(malformedHome, { recursive: true, force: true });
  }
});
