import fs from "node:fs";
import path from "node:path";

export const posixHostShell = (): string => {
  if (process.platform !== "win32") return "/bin/sh";
  const candidates = [
    process.env.WMUX_GIT_BASH,
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe"),
  ];
  const shell = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!shell) throw new Error("Install Git for Windows or set WMUX_GIT_BASH to its bash.exe");
  return shell;
};

export const hostShellPath = (value: string): string =>
  process.platform === "win32" ? value.replaceAll("\\", "/") : value;

export const configureWindowsHostTools = (): void => {
  if (process.platform !== "win32") return;
  const gitRoot = path.resolve(path.dirname(posixHostShell()), "..");
  const tools = path.join(gitRoot, "usr", "bin");
  if (!fs.existsSync(path.join(tools, "ssh.exe"))) throw new Error("Git for Windows SSH client is missing");
  process.env.PATH = `${tools}${path.delimiter}${process.env.PATH ?? ""}`;
};
