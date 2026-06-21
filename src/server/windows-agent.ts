import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import type { MachineConfig, PaneState } from "./types.js";

interface AgentEvents {
  output: [string];
  title: [string];
  cwd: [string];
  exit: [number | null];
}

interface AgentSessionResponse {
  id: string;
  pid?: number;
  status?: string;
  exitCode?: number | null;
  cwd?: string;
  cursor?: number;
}

interface AgentOutputResponse {
  base?: number;
  cursor?: number;
  dataBase64?: string;
  exited?: boolean;
  exitCode?: number | null;
  cwd?: string;
}

export interface WindowsAgentHealth {
  ok?: boolean;
  version?: string;
  machine?: string;
  pid?: number;
  sessions?: number;
  backend?: string;
  conptyAvailable?: boolean;
  pywinptyAvailable?: boolean;
}

const MAX_REPLAY_BYTES = 2 * 1024 * 1024;
const MAX_CWD_CAPTURE_BYTES = 8192;

export const windowsAgentUrl = (machine: MachineConfig): string | undefined => {
  if (machine.agentUrl) return machine.agentUrl.replace(/\/+$/, "");
  if (!machine.host) return undefined;
  return `http://${machine.host}:${machine.agentPort ?? 3481}`;
};

export const shouldUseWindowsAgent = (machine: MachineConfig): boolean =>
  machine.kind === "powershell-ssh" && machine.sessionBackend === "agent";

export const probeWindowsAgent = async (
  machine: MachineConfig,
  timeoutMs = 1500,
): Promise<{ reachable: boolean; health?: WindowsAgentHealth; reason?: string; url?: string }> => {
  const url = windowsAgentUrl(machine);
  if (!url) return { reachable: false, reason: "missing Windows agent URL" };
  try {
    const health = await requestJson<WindowsAgentHealth>("GET", `${url}/health`, undefined, timeoutMs);
    return { reachable: health.ok === true, health, url, reason: health.ok === true ? undefined : "agent health check failed" };
  } catch (error) {
    return { reachable: false, url, reason: error instanceof Error ? error.message : "agent health check failed" };
  }
};

export class WindowsAgentSession extends EventEmitter<AgentEvents> {
  private replay: string[] = [];
  private replayBytes = 0;
  private exited = false;
  private exitCode: number | null = null;
  private cursor = 0;
  private pidValue = 0;
  private cwd = "";
  private cwdCaptureBuffer = "";
  private stopped = false;

  constructor(
    readonly pane: PaneState,
    private readonly machine: MachineConfig,
    private readonly cols: number,
    private readonly rows: number,
    private readonly extraEnv: Record<string, string> = {},
  ) {
    super();
    this.cwd = pane.cwd ?? "";
    void this.start();
  }

  get pid(): number {
    return this.pidValue;
  }

  get isExited(): boolean {
    return this.exited;
  }

  get replayOutput(): string {
    return this.replay.join("");
  }

  write(data: string): void {
    if (this.exited || this.stopped) return;
    void this.post(`/sessions/${encodeURIComponent(this.pane.id)}/input`, {
      dataBase64: Buffer.from(data, "utf8").toString("base64"),
    });
  }

  resize(cols: number, rows: number): void {
    if (this.exited || this.stopped || cols < 2 || rows < 1) return;
    void this.post(`/sessions/${encodeURIComponent(this.pane.id)}/resize`, { cols, rows });
  }

  kill(): void {
    if (this.stopped) return;
    this.stopped = true;
    void this.delete(`/sessions/${encodeURIComponent(this.pane.id)}`);
  }

  private async start(): Promise<void> {
    try {
      const response = await this.post<AgentSessionResponse>(`/sessions/${encodeURIComponent(this.pane.id)}`, {
        cols: this.cols,
        rows: this.rows,
        cwd: this.cwd || this.machine.cwd || "",
        shell: this.machine.shell || "",
        env: {
          WMUX_MACHINE_ID: this.machine.id,
          WMUX_MACHINE_NAME: this.machine.name,
          ...this.extraEnv,
        },
      });
      this.pidValue = response.pid ?? 0;
      this.cursor = response.cursor ?? 0;
      if (response.cwd) {
        this.cwd = response.cwd;
        this.emit("cwd", response.cwd);
      }
      this.emit("title", this.machine.name);
      void this.poll();
    } catch (error) {
      this.appendAndEmit(`\r\n[wmux] Windows agent attach failed: ${formatError(error)}\r\n`);
      this.exited = true;
      this.emit("exit", 1);
    }
  }

  private async poll(): Promise<void> {
    while (!this.stopped && !this.exited) {
      try {
        const response = await this.get<AgentOutputResponse>(
          `/sessions/${encodeURIComponent(this.pane.id)}/output?cursor=${this.cursor}&timeoutMs=15000`,
          20_000,
        );
        if (typeof response.cursor === "number") this.cursor = response.cursor;
        if (response.dataBase64) {
          const data = Buffer.from(response.dataBase64, "base64").toString("utf8");
          this.appendAndEmit(data);
        }
        if (response.cwd && response.cwd !== this.cwd) {
          this.cwd = response.cwd;
          this.emit("cwd", response.cwd);
        }
        if (response.exited) {
          this.exited = true;
          this.exitCode = response.exitCode ?? null;
          this.emit("exit", this.exitCode);
          return;
        }
      } catch (error) {
        if (this.stopped) return;
        this.appendAndEmit(`\r\n[wmux] Windows agent polling failed: ${formatError(error)}\r\n`);
        await delay(1000);
      }
    }
  }

  private async get<T>(path: string, timeoutMs = 5000): Promise<T> {
    const url = windowsAgentUrl(this.machine);
    if (!url) throw new Error(`machine ${this.machine.id} is missing Windows agent URL`);
    return requestJson<T>("GET", `${url}${path}`, undefined, timeoutMs);
  }

  private async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const url = windowsAgentUrl(this.machine);
    if (!url) throw new Error(`machine ${this.machine.id} is missing Windows agent URL`);
    return requestJson<T>("POST", `${url}${path}`, body, 5000);
  }

  private async delete<T = unknown>(path: string): Promise<T> {
    const url = windowsAgentUrl(this.machine);
    if (!url) throw new Error(`machine ${this.machine.id} is missing Windows agent URL`);
    return requestJson<T>("DELETE", `${url}${path}`, undefined, 5000);
  }

  private appendAndEmit(data: string): void {
    this.appendReplay(data);
    this.captureCwd(data);
    this.emit("output", data);
  }

  private appendReplay(data: string): void {
    this.replay.push(data);
    this.replayBytes += Buffer.byteLength(data);
    while (this.replayBytes > MAX_REPLAY_BYTES && this.replay.length > 1) {
      const removed = this.replay.shift() ?? "";
      this.replayBytes -= Buffer.byteLength(removed);
    }
  }

  private captureCwd(data: string): void {
    const combined = this.cwdCaptureBuffer + data;
    const pendingStart = combined.lastIndexOf("\x1b]7;");
    let searchable = combined;
    this.cwdCaptureBuffer = "";
    if (pendingStart !== -1) {
      const pending = combined.slice(pendingStart);
      if (!pending.includes("\x07") && !pending.includes("\x1b\\")) {
        searchable = combined.slice(0, pendingStart);
        this.cwdCaptureBuffer = pending.slice(-MAX_CWD_CAPTURE_BYTES);
      }
    }

    for (const match of searchable.matchAll(/\x1b]7;file:\/\/([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) {
      const cwd = cwdFromFileUri(match[1]);
      if (!cwd || cwd === this.cwd) continue;
      this.cwd = cwd;
      this.emit("cwd", cwd);
    }
  }
}

const requestJson = <T>(method: string, rawUrl: string, body: unknown, timeoutMs: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const url = new URL(rawUrl);
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(
      url,
      {
        method,
        timeout: timeoutMs,
        headers: data
          ? {
              "content-type": "application/json",
              "content-length": String(data.byteLength),
            }
          : undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`HTTP ${response.statusCode ?? 0}${raw ? `: ${raw.slice(0, 200)}` : ""}`));
            return;
          }
          try {
            resolve((raw ? JSON.parse(raw) : {}) as T);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("timeout", () => {
      request.destroy(new Error(`request timed out after ${timeoutMs}ms`));
    });
    request.on("error", reject);
    if (data) request.write(data);
    request.end();
  });

const cwdFromFileUri = (value: string): string | undefined => {
  const slash = value.indexOf("/");
  if (slash === -1) return undefined;
  const pathPart = value.slice(slash);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    decoded = pathPart;
  }
  if (/^\/[A-Za-z]:[\\/]/.test(decoded)) decoded = decoded.slice(1);
  if (decoded.length > 4096) return undefined;
  if (/[\x00-\x1f\x7f]/.test(decoded)) return undefined;
  if (/^[A-Za-z]:[\\/]/.test(decoded)) return decoded;
  if (!decoded.startsWith("/")) return undefined;
  return decoded;
};

const formatError = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
