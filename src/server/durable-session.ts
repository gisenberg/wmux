import type { MachineConfig } from "./types.js";
import { runCommand } from "./child-process.js";

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
const remotePathBootstrap = (): string => `export PATH="/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$PATH"`;

export const durableSessionName = (paneId?: string): string =>
  `wmux_${(paneId || "unknown").replace(/[^A-Za-z0-9_-]/g, "_")}`;

export const canRefreshDurableSessionClient = (machine: MachineConfig): boolean => {
  const backend = machine.sessionBackend ?? "auto";
  return machine.kind === "local" && !machine.command?.length && (backend === "auto" || backend === "tmux");
};

export const readDurableSessionCwd = async (
  machine: MachineConfig,
  paneId: string,
): Promise<string | undefined> => {
  const backend = machine.sessionBackend ?? "auto";
  if (backend === "screen" || backend === "pty" || backend === "agent" || machine.command?.length) return undefined;
  if (machine.kind !== "local" && machine.kind !== "ssh") return undefined;
  const sessionName = durableSessionName(paneId);
  const query =
    `${machine.kind === "ssh" ? `${remotePathBootstrap()}; ` : ""}` +
    `command -v tmux >/dev/null 2>&1 && tmux display-message -p -t ${shellQuote(sessionName)} '#{pane_current_path}' 2>/dev/null`;
  const result = machine.kind === "local"
    ? await runCommand("/bin/sh", ["-lc", query], { timeoutMs: 1500 })
    : await runRemote(machine, query, 4000);
  if (!result || result.status !== 0) return undefined;
  return sanitizeCwd(result.stdout.split(/\r?\n/)[0]);
};

export const refreshDurableSessionClient = async (
  machine: MachineConfig,
  paneId: string,
): Promise<boolean> => {
  if (!canRefreshDurableSessionClient(machine)) return false;
  const sessionName = durableSessionName(paneId);
  const clients = await runCommand("tmux", ["list-clients", "-t", sessionName, "-F", "#{client_name}"], {
    timeoutMs: 1000,
  });
  if (clients.status !== 0 || !clients.stdout.trim()) return false;
  const results = await Promise.all(
    clients.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((client) => runCommand("tmux", ["refresh-client", "-t", client], {
        timeoutMs: 1000,
        captureOutput: false,
      })),
  );
  return results.some((result) => result.status === 0);
};

export const disposeDurableSession = async (machine: MachineConfig, paneId: string): Promise<void> => {
  const backend = machine.sessionBackend ?? "auto";
  if (backend === "pty" || backend === "agent" || machine.command?.length) return;
  if (machine.kind !== "local" && machine.kind !== "ssh") return;
  const sessionName = durableSessionName(paneId);
  const killScript = [
    machine.kind === "ssh" ? remotePathBootstrap() : "",
    backend !== "screen" ? `command -v tmux >/dev/null 2>&1 && tmux kill-session -t ${shellQuote(sessionName)} 2>/dev/null || true` : "",
    backend !== "tmux" ? `command -v screen >/dev/null 2>&1 && screen -S ${shellQuote(sessionName)} -X quit 2>/dev/null || true` : "",
  ]
    .filter(Boolean)
    .join("; ");
  if (machine.kind === "local") {
    await runCommand("/bin/sh", ["-lc", killScript], { timeoutMs: 3000, captureOutput: false });
    return;
  }
  await runRemote(machine, killScript, 5000, false);
};

const runRemote = async (
  machine: MachineConfig,
  command: string,
  timeoutMs: number,
  captureOutput = true,
) => {
  if (!machine.host) return undefined;
  const target = machine.user ? `${machine.user}@${machine.host}` : machine.host;
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=3"];
  if (machine.port) args.push("-p", String(machine.port));
  args.push(target, command);
  return runCommand("ssh", args, { timeoutMs, captureOutput });
};

const sanitizeCwd = (value?: string): string | undefined => {
  const cwd = value?.trim();
  if (!cwd || cwd.length > 4096) return undefined;
  if (/[\x00-\x1f\x7f]/.test(cwd)) return undefined;
  if (!cwd.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(cwd)) return undefined;
  return cwd;
};
