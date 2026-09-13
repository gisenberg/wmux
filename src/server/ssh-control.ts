import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostShellPath } from "./host-shell.js";

const controlRoot = (): string => {
  const base = process.env.XDG_RUNTIME_DIR?.startsWith("/")
    ? process.env.XDG_RUNTIME_DIR
    : path.join(os.homedir(), ".wmux", "run");
  return path.join(base, "wmux", "ssh-control");
};

export const sshControlPath = (paneId: string): string => {
  const root = controlRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("SSH control directory is not private");
  fs.chmodSync(root, 0o700);
  const digest = crypto.createHash("sha256").update(paneId).digest("hex").slice(0, 24);
  return hostShellPath(path.join(root, `pane-${digest}.sock`));
};

export const sshControlArgs = (paneId: string, create = false): string[] => process.platform === "win32"
  ? ["-o", "ControlMaster=no", "-o", "ControlPath=none"]
  : [
  "-o", `ControlPath=${sshControlPath(paneId)}`,
  ...(create ? ["-o", "ControlMaster=auto", "-o", "ControlPersist=3600"] : []),
];

// OpenSSH multiplex clients normally fall back to a fresh network connection
// when their control socket vanishes. The failing proxy is only reached by that
// direct-connect path; a live master is still selected through ControlPath.
export const sshControlOnlyArgs = (paneId: string): string[] => {
  if (process.platform === "win32") throw new Error("Pane-bound SSH file transfer is unavailable on a Windows host");
  return [
    ...sshControlArgs(paneId),
    "-o", "ControlMaster=no",
    "-o", "ProxyCommand=/usr/bin/false",
  ];
};
