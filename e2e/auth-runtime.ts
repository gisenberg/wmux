import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashPassword } from "../src/server/auth.js";

const runtimeEnvironment = "WMUX_AUTH_E2E_RUNTIME";

export interface AuthE2eRuntime {
  directory: string;
  home: string;
  username: string;
  password: string;
  legacyToken: string;
  invalidSession: string;
}

const writeOwnerOnly = (filePath: string, contents: string): void => {
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
};

const secret = (): string => crypto.randomBytes(32).toString("base64url");

export const prepareAuthE2eRuntime = (): AuthE2eRuntime => {
  if (process.env[runtimeEnvironment]) return readAuthE2eRuntime();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-auth-e2e-"));
  const home = path.join(directory, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const wmuxHome = path.join(home, ".wmux");
  fs.mkdirSync(wmuxHome, { mode: 0o700 });
  fs.chmodSync(wmuxHome, 0o700);

  const runtime: AuthE2eRuntime = {
    directory,
    home,
    username: `e2e-${secret().slice(0, 12)}`,
    password: secret(),
    legacyToken: secret(),
    invalidSession: `wsess.${secret()}.${secret()}`,
  };
  writeOwnerOnly(path.join(wmuxHome, "auth.json"), JSON.stringify({
    username: runtime.username,
    passwordHash: hashPassword(runtime.password),
  }));
  writeOwnerOnly(path.join(wmuxHome, "session-secret"), secret());
  writeOwnerOnly(path.join(wmuxHome, "automation-token"), secret());
  writeOwnerOnly(path.join(wmuxHome, "helper-token"), secret());
  writeOwnerOnly(path.join(wmuxHome, "token"), runtime.legacyToken);
  writeOwnerOnly(path.join(wmuxHome, "runtime.json"), JSON.stringify(runtime));
  process.env[runtimeEnvironment] = directory;
  return runtime;
};

export const readAuthE2eRuntime = (): AuthE2eRuntime => {
  const directory = process.env[runtimeEnvironment];
  if (!directory) throw new Error("auth E2E runtime was not provisioned");
  return JSON.parse(fs.readFileSync(path.join(directory, "home", ".wmux", "runtime.json"), "utf8")) as AuthE2eRuntime;
};

export const cleanupAuthE2eRuntime = (): void => {
  const directory = process.env[runtimeEnvironment];
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
};
