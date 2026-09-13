import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hasPrivatePermissions, protectWindowsStateDirectory } from "../src/server/private-permissions.js";

test("Windows ACL checks protect inherited files and detect later broad grants", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-acl-"));
  try {
    protectWindowsStateDirectory(root);
    assert.equal(hasPrivatePermissions(root, fs.statSync(root), true), true);
    const file = path.join(root, "credential.txt");
    fs.writeFileSync(file, "fixture");
    assert.equal(hasPrivatePermissions(file, fs.statSync(file)), true);
    execFileSync("icacls.exe", [file, "/grant", "*S-1-1-0:R"], { windowsHide: true });
    assert.equal(hasPrivatePermissions(file, fs.statSync(file)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
