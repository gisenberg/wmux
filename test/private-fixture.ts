import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { hasPrivatePermissions, protectWindowsStateDirectory } from "../src/server/private-permissions.js";

export const privateTempDirectory = (prefix: string): string => {
  const directory = fs.mkdtempSync(prefix);
  protectWindowsStateDirectory(directory);
  return directory;
};

export const assertPrivateFile = (filePath: string): void => {
  const stat = fs.statSync(filePath);
  assert.ok(hasPrivatePermissions(filePath, stat, stat.isDirectory()), "fixture must have private permissions");
};

export const makeFilePublic = (filePath: string): void => {
  if (process.platform !== "win32") fs.chmodSync(filePath, 0o644);
  else execFileSync("icacls.exe", [filePath, "/grant", "*S-1-1-0:RX"], { windowsHide: true });
};

export const setDirectoryPrivate = (directory: string, secure: boolean): void => {
  if (process.platform !== "win32") { fs.chmodSync(directory, secure ? 0o700 : 0o755); return; }
  if (secure) protectWindowsStateDirectory(directory);
  else execFileSync("icacls.exe", [directory, "/grant", "*S-1-1-0:(OI)(CI)RX"], { windowsHide: true });
};
