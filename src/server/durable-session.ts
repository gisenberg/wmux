import type { MachineConfig } from "./types.js";
import { runCommand } from "./child-process.js";
import { sshControlArgs } from "./ssh-control.js";

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
const remotePathBootstrap = (): string => `export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$PATH"`;
const CWD_OUTPUT_PREFIX = "wmux-cwd:";
const TMUX_AUDIT_PREFIX = "__WMUX_TMUX__";
const SCREEN_AUDIT_PREFIX = "__WMUX_SCREEN__";

export const durableSessionName = (paneId?: string): string =>
  `wmux_${(paneId || "unknown").replace(/[^A-Za-z0-9_-]/g, "_")}`;

export const canRefreshDurableSessionClient = (machine: MachineConfig): boolean => {
  const backend = machine.sessionBackend ?? "auto";
  return process.platform !== "win32" && machine.kind === "local" && !machine.command?.length && (backend === "auto" || backend === "tmux");
};

export const readDurableSessionCwd = async (
  machine: MachineConfig,
  paneId: string,
): Promise<string | undefined> => {
  if (machine.kind === "local" && process.platform === "win32") return undefined;
  const backend = machine.sessionBackend ?? "auto";
  if (backend === "screen" || backend === "pty" || backend === "agent" || machine.command?.length) return undefined;
  if (machine.kind !== "local" && machine.kind !== "ssh") return undefined;
  const sessionName = durableSessionName(paneId);
  const query =
    `${machine.kind === "ssh" ? `${remotePathBootstrap()}; ` : ""}` +
    `command -v tmux >/dev/null 2>&1 && tmux display-message -p -t ${shellQuote(sessionName)} ` +
    `${shellQuote(`${CWD_OUTPUT_PREFIX}#{pane_current_path}`)} 2>/dev/null`;
  const result = machine.kind === "local"
    ? await runCommand("/bin/sh", ["-lc", query], { timeoutMs: 1500 })
    : await runRemote(machine, query, 4000, true, paneId);
  if (!result || result.status !== 0) return undefined;
  return cwdFromDurableSessionOutput(result.stdout);
};

export const cwdFromDurableSessionOutput = (stdout: string): string | undefined => {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith(CWD_OUTPUT_PREFIX)) continue;
    const cwd = sanitizeCwd(lines[index].slice(CWD_OUTPUT_PREFIX.length));
    if (cwd) return cwd;
  }
  return undefined;
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

export const disposeDurableSession = async (
  machine: MachineConfig,
  paneId: string,
): Promise<boolean> => {
  const backend = machine.sessionBackend ?? "auto";
  if (machine.kind === "local" && process.platform === "win32") return false;
  if (backend === "pty" || backend === "agent" || machine.command?.length) return false;
  if (machine.kind !== "local" && machine.kind !== "ssh") return false;
  const sessionName = durableSessionName(paneId);
  const killScript = [
    machine.kind === "ssh" ? remotePathBootstrap() : "",
    backend !== "screen" ? `command -v tmux >/dev/null 2>&1 && tmux kill-session -t ${shellQuote(sessionName)} 2>/dev/null || true` : "",
    backend !== "tmux" ? `command -v screen >/dev/null 2>&1 && screen -S ${shellQuote(sessionName)} -X quit 2>/dev/null || true` : "",
  ]
    .filter(Boolean)
    .join("; ");
  if (machine.kind === "local") {
    const result = await runCommand("/bin/sh", ["-lc", killScript], { timeoutMs: 3000, captureOutput: false });
    return result.status === 0;
  }
  const result = await runRemote(machine, killScript, 5000, false);
  return result?.status === 0;
};

export interface DurableSessionObservation {
  backend: "tmux" | "screen";
  name: string;
  paneId: string;
  attached: boolean;
  detail: string;
}

export interface DurableSessionObservationResult {
  reachable: boolean;
  detail?: string;
  sessions: DurableSessionObservation[];
}

export const listDurableSessionsOnMachine = async (
  machine: MachineConfig,
): Promise<DurableSessionObservationResult> => {
  if (machine.kind !== "local" && machine.kind !== "ssh") {
    return { reachable: false, detail: "unsupported machine kind", sessions: [] };
  }
  const tmuxFormat = "#{session_name}\t#{session_attached}\t#{session_windows}";
  const script = [
    machine.kind === "ssh" ? remotePathBootstrap() : "",
    `printf '${TMUX_AUDIT_PREFIX}\\n'`,
    `command -v tmux >/dev/null 2>&1 && tmux list-sessions -F ${shellQuote(tmuxFormat)} 2>/dev/null || true`,
    `printf '${SCREEN_AUDIT_PREFIX}\\n'`,
    "command -v screen >/dev/null 2>&1 && screen -ls 2>/dev/null || true",
  ].filter(Boolean).join("; ");
  const result = machine.kind === "local"
    ? await runCommand("/bin/sh", ["-lc", script], { timeoutMs: 3000 })
    : await runRemote(machine, script, 5000);
  if (!result || result.status !== 0) {
    return {
      reachable: false,
      detail: result?.stderr.trim() || result?.stdout.trim() || "endpoint unreachable",
      sessions: [],
    };
  }
  return {
    reachable: true,
    sessions: parseDurableSessionObservations(result.stdout),
  };
};

export const parseDurableSessionObservations = (
  output: string,
): DurableSessionObservation[] => {
  const tmuxStart = output.indexOf(TMUX_AUDIT_PREFIX);
  const screenStart = output.indexOf(SCREEN_AUDIT_PREFIX);
  if (tmuxStart < 0 || screenStart < tmuxStart) return [];
  const tmux = output
    .slice(tmuxStart + TMUX_AUDIT_PREFIX.length, screenStart)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line): DurableSessionObservation[] => {
      const [name, attached, windows] = line.split("\t");
      if (!name?.startsWith("wmux_")) return [];
      return [{
        backend: "tmux",
        name,
        paneId: paneIdFromDurableSession(name),
        attached: Number(attached) > 0,
        detail: `${attached || 0} attached, ${windows || 0} windows`,
      }];
    });
  const screen = output
    .slice(screenStart + SCREEN_AUDIT_PREFIX.length)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .flatMap((line): DurableSessionObservation[] => {
      const match = line.match(/^(?:\d+\.)?(wmux_[^\s]+)\s+\([^)]+\)\s+\(([^)]+)\)/);
      if (!match) return [];
      return [{
        backend: "screen",
        name: match[1],
        paneId: paneIdFromDurableSession(match[1]),
        attached: /attached/i.test(match[2]),
        detail: match[2],
      }];
    });
  return [...tmux, ...screen];
};

const paneIdFromDurableSession = (name: string): string =>
  name.startsWith("wmux_") ? name.slice("wmux_".length) : "";

const runRemote = async (
  machine: MachineConfig,
  command: string,
  timeoutMs: number,
  captureOutput = true,
  paneId?: string,
) => {
  if (!machine.host) return undefined;
  const target = machine.user ? `${machine.user}@${machine.host}` : machine.host;
  const args = [
    ...(paneId ? sshControlArgs(paneId) : []),
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=3",
  ];
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
