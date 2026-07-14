import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { MachineConfig, MachinePlatform, MachineStatus } from "./types.js";
import { POSIX_RUNTIME_VERSION } from "./spawn-backends.js";
import {
  buildWindowsHealthProbeScript,
  expectedWindowsAgentVersion,
  windowsHelperBundleVersion,
} from "./windows-helpers.js";
import { probeWindowsAgent, shouldUseWindowsAgent } from "./windows-agent.js";

const WINDOWS_HEALTH_CACHE_MS = 15_000;
const WMUX_SERVER_VERSION = (() => {
  try {
    const packageJson = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof packageJson.version === "string" && packageJson.version ? packageJson.version : "dev";
  } catch {
    return "dev";
  }
})();

const nodeMachinePlatform = (nodePlatform: NodeJS.Platform): MachinePlatform => {
  if (nodePlatform === "darwin") return "mac";
  if (nodePlatform === "win32") return "win";
  return "linux";
};

export const resolveMachinePlatform = (
  machine: MachineConfig,
  nodePlatform: NodeJS.Platform = process.platform,
): MachinePlatform => {
  if (machine.platform) return machine.platform;
  if (machine.kind === "local") return nodeMachinePlatform(nodePlatform);
  if (machine.kind === "powershell" || machine.kind === "powershell-ssh") return "win";
  return "linux";
};

export const machineReleaseVersion = (
  machine: MachineConfig,
  nodePlatform: NodeJS.Platform = process.platform,
): string => `v${WMUX_SERVER_VERSION.replace(/^v/i, "")}-${resolveMachinePlatform(machine, nodePlatform)}`;

export const resolveMachineVersionStatus = ({
  reachable,
  runtimeVersion,
  expectedRuntimeVersion,
  helperBundleVersion,
  expectedHelperBundleVersion,
}: {
  reachable: boolean;
  runtimeVersion?: string;
  expectedRuntimeVersion?: string;
  helperBundleVersion?: string;
  expectedHelperBundleVersion?: string;
}): MachineStatus["versionStatus"] => {
  if (!reachable || !runtimeVersion || !expectedRuntimeVersion) return "unknown";
  if (runtimeVersion !== expectedRuntimeVersion) return "outdated";
  if (helperBundleVersion && expectedHelperBundleVersion && helperBundleVersion !== expectedHelperBundleVersion) {
    return "outdated";
  }
  return "current";
};

interface WindowsHealthProbe {
  reachable: boolean;
  reason?: string;
  health?: Record<string, unknown>;
  backendDetail?: string;
}

const windowsHealthCache = new Map<string, { checkedAt: number; result: WindowsHealthProbe }>();

const probeTcp = (host: string, port: number, timeoutMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (reachable: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });

const probeWindowsPowerShellSsh = async (
  machine: MachineConfig,
  localEndpoint: string,
): Promise<WindowsHealthProbe> => {
  if (!machine.host) return { reachable: false, reason: "missing host" };
  const wmuxUrl =
    process.env.WMUX_PUBLIC_URL ??
    process.env.WMUX_URL ??
    `http://${localEndpoint}:${process.env.WMUX_PORT ?? "3478"}`;
  const cacheKey = `${machine.id}:${machine.user ?? ""}@${machine.host}:${machine.port ?? 22}:${wmuxUrl}`;
  const cached = windowsHealthCache.get(cacheKey);
  if (cached && Date.now() - cached.checkedAt < WINDOWS_HEALTH_CACHE_MS) return cached.result;

  const target = machine.user ? `${machine.user}@${machine.host}` : machine.host;
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=3"];
  if (machine.port) args.push("-p", String(machine.port));
  const script = buildWindowsHealthProbeScript(wmuxUrl);
  args.push(target, machine.shell ?? "pwsh", "-NoLogo", "-NoProfile", "-Command", "-");
  const result = await runSshProbe(args, script, 7_000);
  const health = parseWindowsHealth(result.stdout);
  const probe: WindowsHealthProbe =
    result.status === 0 && health
      ? {
          reachable: true,
          health,
          backendDetail: windowsBackendDetail(health),
        }
      : {
          reachable: false,
          reason: result.timedOut
            ? "PowerShell SSH health check timed out"
            : `PowerShell SSH health check failed${result.stderr ? `: ${trimProbeError(result.stderr)}` : ""}`,
          health: health ?? undefined,
          backendDetail: backendDetail(machine),
        };
  windowsHealthCache.set(cacheKey, { checkedAt: Date.now(), result: probe });
  return probe;
};

const runSshProbe = (
  args: string[],
  script: string | undefined,
  timeoutMs: number,
): Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }> =>
  new Promise((resolve) => {
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 500).unref();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: 1, stdout, stderr: error.message, timedOut });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, timedOut });
    });
    child.stdin.end(script ? `${script}\n` : undefined);
  });

const parseWindowsHealth = (stdout: string): Record<string, unknown> | undefined => {
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* keep searching */
    }
  }
  return undefined;
};

const windowsBackendDetail = (health: Record<string, unknown>): string => {
  const version = typeof health.powerShellVersion === "string" ? `pwsh ${health.powerShellVersion}` : "pwsh";
  const helpers =
    health.helpersReady !== true
      ? `helpers ${health.helperCount ?? 0}/${health.helperTotal ?? "?"}`
      : health.helpersCurrent === false
        ? "helpers stale (respawn a pane to restage)"
        : "helpers ready";
  const streamTask = typeof health.streamTaskState === "string" ? `stream task ${health.streamTaskState}` : "stream task unknown";
  const agentTask = typeof health.agentTaskState === "string" ? `agent task ${health.agentTaskState}` : "agent task unknown";
  const sunshine =
    health.sunshine === true
      ? health.sunshineApiReachable === true
        ? "sunshine ready"
        : "sunshine installed"
      : "sunshine missing";
  const captureTools = [
    health.ffmpeg === true ? "ffmpeg" : "",
    health.python === true || health.py === true ? "python" : "",
  ].filter(Boolean);
  const tools = captureTools.length ? captureTools.join("+") : "capture tools missing";
  return `SSH-launched PowerShell; ${version}; ${helpers}; ${streamTask}; ${agentTask}; ${sunshine}; ${tools}`;
};

const trimProbeError = (stderr: string): string => {
  const cleaned = stderr.replace(/#< CLIXML[\s\S]*/g, "PowerShell returned an error").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 240);
};

const commandExists = (command: string): boolean => {
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return fs.existsSync(command);
  }
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((directory) => extensions.some((extension) => {
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }));
};

const relativeAge = (iso: string | undefined): string => {
  const then = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(then)) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
};

export const resolveMachineStatuses = async (
  machines: MachineConfig[],
  localEndpoint = "127.0.0.1",
): Promise<MachineStatus[]> => {
  return Promise.all(
    machines.map(async (machine) => {
      const checkedAt = new Date().toISOString();
      const publicMachine = publicMachineStatusBase(machine);
      if (machine.source === "registered" && machine.online === false) {
        return {
          ...publicMachine,
          reachable: false,
          reason: `Offline; last seen ${relativeAge(machine.lastSeenAt)}`,
          checkedAt,
          endpoint: machine.host,
          backendDetail: backendDetail(machine),
        };
      }
      if (machine.kind === "local") {
        return {
          ...publicMachine,
          reachable: true,
          checkedAt,
          endpoint: localEndpoint === "localhost" ? "127.0.0.1" : localEndpoint,
          runtimeVersion: WMUX_SERVER_VERSION,
          expectedRuntimeVersion: WMUX_SERVER_VERSION,
          versionStatus: "current" as const,
          backendDetail: localBackendDetail(machine),
        };
      }
      if (machine.kind === "powershell" && process.platform !== "win32") {
        const hasPwsh = commandExists("pwsh");
        return {
          ...publicMachine,
          reachable: false,
          reason: hasPwsh
            ? "WSMan PowerShell remoting is not supported from this non-Windows wmux host"
            : "local pwsh client is not installed; WSMan PowerShell remoting is not supported from this non-Windows wmux host",
          checkedAt,
          endpoint: machine.host ? `${machine.host}:${machine.port ?? 5985}` : undefined,
          backendDetail: "PowerShell remoting transport unavailable",
        };
      }
      if (!machine.host) {
        return {
          ...publicMachine,
          reachable: false,
          reason: "missing host",
          checkedAt,
          backendDetail: backendDetail(machine),
        };
      }
      if (machine.kind === "powershell-ssh") {
        const hasSsh = commandExists("ssh");
        const port = machine.port ?? 22;
        const agent = shouldUseWindowsAgent(machine) ? await probeWindowsAgent(machine) : undefined;
        if (shouldUseWindowsAgent(machine)) {
          const sshReachable = hasSsh ? await probeTcp(machine.host, port, 900) : false;
          const agentReachable = agent?.reachable === true;
          const runtimeVersion = agent?.health?.version;
          const helperBundleVersion = agent?.health?.helperBundleVersion;
          const expectedRuntimeVersion = expectedWindowsAgentVersion();
          const expectedHelperBundleVersion = windowsHelperBundleVersion();
          return {
            ...publicMachine,
            reachable: agentReachable,
            checkedAt,
            endpoint: agent?.url ?? `${machine.host}:${machine.agentPort ?? 3481}`,
            backendDetail: windowsStatusDetail(backendDetail(machine), agent),
            runtimeVersion,
            expectedRuntimeVersion,
            helperBundleVersion,
            expectedHelperBundleVersion,
            versionStatus: resolveMachineVersionStatus({
              reachable: agentReachable,
              runtimeVersion,
              expectedRuntimeVersion,
              helperBundleVersion,
              expectedHelperBundleVersion,
            }),
            reason: agentReachable ? undefined : `Windows agent unavailable: ${agent?.reason ?? "unknown error"}`,
            health: {
              sshReachable,
              agentReachable: agent?.reachable ?? false,
              agentUrl: agent?.url,
              agentHealth: agent?.health,
              agentReason: agent?.reason,
            },
          };
        }
        const reachable = hasSsh ? await probeTcp(machine.host, port, 900) : false;
        const health = reachable
          ? await probeWindowsPowerShellSsh(machine, localEndpoint)
          : {
              reachable: false,
              reason: hasSsh ? `no TCP response on ${machine.host}:${port}` : "local ssh client is not installed or not executable",
            };
        const runtimeVersion =
          typeof health.health?.bundleVersion === "string" && health.health.bundleVersion
            ? health.health.bundleVersion
            : undefined;
        const expectedRuntimeVersion = windowsHelperBundleVersion();
        return {
          ...publicMachine,
          reachable: health.reachable,
          checkedAt,
          endpoint: `${machine.host}:${port}`,
          backendDetail: windowsStatusDetail(health.backendDetail ?? backendDetail(machine), agent),
          runtimeVersion,
          expectedRuntimeVersion,
          versionStatus: resolveMachineVersionStatus({ reachable: health.reachable, runtimeVersion, expectedRuntimeVersion }),
          reason: health.reason,
          health: {
            ...(health.health ?? {}),
            ...(agent
              ? {
                  agentReachable: agent.reachable,
                  agentUrl: agent.url,
                  agentHealth: agent.health,
                  agentReason: agent.reason,
                }
              : {}),
          },
        };
      }
      const port = machine.port ?? (machine.kind === "ssh" ? 22 : machine.kind === "powershell" ? 5985 : 3478);
      const reachable = await probeTcp(machine.host, port, 900);
      const runtimeVersion = machine.kind === "ssh" ? POSIX_RUNTIME_VERSION : undefined;
      return {
        ...publicMachine,
        reachable,
        checkedAt,
        endpoint: `${machine.host}:${port}`,
        runtimeVersion,
        expectedRuntimeVersion: runtimeVersion,
        versionStatus: runtimeVersion
          ? resolveMachineVersionStatus({ reachable, runtimeVersion, expectedRuntimeVersion: runtimeVersion })
          : undefined,
        backendDetail: backendDetail(machine),
        reason: reachable ? undefined : `no TCP response on ${machine.host}:${port}`,
      };
    }),
  );
};

const publicMachineStatusBase = (machine: MachineConfig): Omit<MachineStatus, "reachable" | "checkedAt"> => ({
  id: machine.id,
  name: machine.name,
  kind: machine.kind,
  platform: resolveMachinePlatform(machine),
  host: machine.host,
  user: machine.user,
  port: machine.port,
  sessionBackend: machine.sessionBackend,
  agentUrl: machine.agentUrl,
  agentPort: machine.agentPort,
  releaseVersion: machineReleaseVersion(machine),
  stream: machine.stream
    ? {
        provider: machine.stream.provider,
        gatewayUrl: machine.stream.gatewayUrl,
        gatewayOpenUrl: machine.stream.gatewayOpenUrl,
      }
    : undefined,
  source: machine.source,
  registeredAt: machine.registeredAt,
  lastSeenAt: machine.lastSeenAt,
  expiresAt: machine.expiresAt,
  online: machine.online,
});

const localBackendDetail = (machine: MachineConfig): string => {
  const backend = machine.sessionBackend ?? "auto";
  if (backend === "pty") return "raw PTY; not restart-durable";
  const tmux = commandExists("tmux") ? "tmux available" : "tmux missing";
  const screen = commandExists("screen") ? "screen available" : "screen missing";
  return `${backend} backend; ${tmux}; ${screen}`;
};

export const backendDetail = (machine: MachineConfig): string => {
  const backend = machine.sessionBackend ?? "auto";
  if (machine.kind === "ssh") return `SSH client; ${backend} durable backend on attach`;
  if (machine.kind === "powershell") return "PowerShell remoting; no durable backend";
  if (machine.kind === "powershell-ssh" && backend === "agent") return "Windows agent backend";
  if (machine.kind === "powershell-ssh") return "SSH-launched PowerShell; no durable backend";
  if (machine.kind === "service") return "wmux remote service probe";
  return localBackendDetail(machine);
};

const windowsStatusDetail = (
  detail: string,
  agent: Awaited<ReturnType<typeof probeWindowsAgent>> | undefined,
): string => {
  if (!agent) return detail;
  const backend = agent.health?.backend ? ` ${agent.health.backend}` : "";
  const processTree = agent.health?.processTree ? `, ${agent.health.processTree}` : "";
  const drainState = agent.health?.draining
    ? `, draining ${agent.health.activeSessions ?? agent.health.sessions ?? 0} pane(s)`
    : "";
  const dependency =
    agent.health?.backend === "conpty" && agent.health.conptyAvailable === false ? "; pywinpty missing" : "";
  const expectedVersion = expectedWindowsAgentVersion();
  const versionNote =
    agent.reachable && expectedVersion && agent.health?.version && agent.health.version !== expectedVersion
      ? ` (expected ${expectedVersion} — run wmux-windows-agent-service activate-update)`
      : "";
  const agentDetail = agent.reachable
    ? `agent ${agent.health?.version ?? "ready"}${versionNote}${backend}${processTree}${drainState} at ${agent.url}${dependency}`
    : `agent unavailable at ${agent.url ?? "unknown URL"}`;
  return `${detail}; ${agentDetail}`;
};

