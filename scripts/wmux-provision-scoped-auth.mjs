#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const secretPattern = /^[A-Za-z0-9_-]{32,256}$/;
const home = os.homedir();
const wmuxHome = path.join(home, ".wmux");
const automationPath = path.resolve(process.env.WMUX_AUTOMATION_TOKEN_PATH || path.join(wmuxHome, "automation-token"));
const helperPath = path.resolve(process.env.WMUX_HELPER_TOKEN_PATH || path.join(wmuxHome, "helper-token"));

const fail = (message) => {
  throw new Error(`wmux scoped-auth provisioning refused: ${message}`);
};

const assertOwnerOnlyDirectory = (directory, create = false, harden = false) => {
  if (!fs.existsSync(directory)) {
    if (!create) fail("token parent directory does not exist");
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  let stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== path.resolve(directory)) {
    fail("token parent must be a real directory without symlinks");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) fail("token parent has the wrong owner");
  if ((stat.mode & 0o077) !== 0 && harden) {
    fs.chmodSync(directory, 0o700);
    stat = fs.lstatSync(directory);
  }
  if ((stat.mode & 0o077) !== 0) fail("token parent must be owner-only");
};

assertOwnerOnlyDirectory(wmuxHome, true, true);
for (const target of [automationPath, helperPath]) {
  assertOwnerOnlyDirectory(path.dirname(target), path.dirname(target) === wmuxHome);
}

const readOptional = (filePath) => {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
};

const readScoped = (filePath, label) => {
  if (!fs.existsSync(filePath)) return "";
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(filePath) !== filePath) fail(`${label} is not a regular file`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) fail(`${label} has the wrong owner`);
  if ((stat.mode & 0o777) !== 0o600) fail(`${label} permissions must be 0600`);
  const value = readOptional(filePath);
  if (!secretPattern.test(value)) fail(`${label} is empty or malformed`);
  return value;
};

const known = new Set([
  process.env.WMUX_TOKEN?.trim(),
  process.env.WMUX_SESSION_SECRET?.trim(),
  process.env.WMUX_REGISTRATION_TOKEN?.trim(),
  readOptional(process.env.WMUX_TOKEN_PATH || path.join(wmuxHome, "token")),
  readOptional(process.env.WMUX_SESSION_SECRET_PATH || path.join(wmuxHome, "session-secret")),
  readOptional(process.env.WMUX_REGISTRATION_TOKEN_PATH || path.join(wmuxHome, "registration-token")),
].filter(Boolean));

const collectNamedSecrets = (value) => {
  if (Array.isArray(value)) {
    value.forEach(collectNamedSecrets);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["agentToken", "gatewayToken", "bootstrapToken", "previousBootstrapToken"].includes(key) && typeof child === "string" && child) {
      known.add(child);
    } else {
      collectNamedSecrets(child);
    }
  }
};

const readSecretDocument = (filePath, required) => {
  if (!fs.existsSync(filePath)) {
    if (required) fail("an explicitly configured secret-bearing file is missing");
    return;
  }
  try {
    collectNamedSecrets(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    fail("a secret-bearing configuration file is unreadable or invalid");
  }
};

if (process.env.WMUX_CONFIG_PATH) {
  readSecretDocument(path.resolve(process.env.WMUX_CONFIG_PATH), true);
} else {
  const projectConfig = path.join(process.cwd(), "wmux.config.json");
  const homeConfig = path.join(wmuxHome, "config.json");
  readSecretDocument(fs.existsSync(projectConfig) ? projectConfig : homeConfig, false);
}
readSecretDocument(path.resolve(process.env.WMUX_REGISTRY_PATH || path.join(wmuxHome, "host-registry.json")), false);

const existingAutomation = readScoped(automationPath, "automation token file");
const existingHelper = readScoped(helperPath, "helper token file");
for (const [label, value] of [["automation token", existingAutomation], ["helper token", existingHelper]]) {
  if (!value) continue;
  if (known.has(value)) fail(`${label} duplicates another configured secret`);
  known.add(value);
}

const newSecret = () => {
  let value;
  do value = crypto.randomBytes(32).toString("base64url"); while (known.has(value));
  known.add(value);
  return value;
};

const writeAtomic = (filePath, value) => {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${value}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch {}
  }
};

if (!existingAutomation) writeAtomic(automationPath, newSecret());
if (!existingHelper) writeAtomic(helperPath, newSecret());
console.log("wmux: scoped authentication token files are provisioned with owner-only permissions.");
