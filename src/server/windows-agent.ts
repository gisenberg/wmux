import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import type { MachineConfig, PaneState } from "./types.js";
import { buildWindowsHelperBundle } from "./windows-helpers.js";
import { appendBoundedReplay } from "./replay-buffer.js";
import { captureOsc7 } from "./osc7.js";
import { selectAttachReplay, TerminalCheckpoint, type AttachReplay } from "./terminal-checkpoint.js";

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
  base?: number;
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
  helperBundleVersion?: string;
  conptyAvailable?: boolean;
  pywinptyAvailable?: boolean;
}

const MAX_REPLAY_BYTES = 2 * 1024 * 1024;

export const windowsAgentUrl = (machine: MachineConfig): string | undefined => {
  if (machine.agentUrl) return machine.agentUrl.replace(/\/+$/, "");
  if (!machine.host) return undefined;
  return `http://${machine.host}:${machine.agentPort ?? 3481}`;
};

export const shouldUseWindowsAgent = (machine: MachineConfig): boolean =>
  machine.kind === "powershell-ssh" && machine.sessionBackend === "agent";

export const deleteWindowsAgentSession = (machine: MachineConfig, paneId: string): void => {
  const url = windowsAgentUrl(machine);
  if (!url) return;
  void requestJson("DELETE", `${url}/sessions/${encodeURIComponent(paneId)}`, undefined, 5000, authHeaders(machine))
    .catch((error) => console.warn(`wmux: Windows agent delete failed for ${paneId}: ${formatError(error)}`));
};

const authHeaders = (machine: MachineConfig): Record<string, string> =>
  machine.agentToken ? { authorization: `Bearer ${machine.agentToken}` } : {};

export const probeWindowsAgent = async (
  machine: MachineConfig,
  timeoutMs = 1500,
): Promise<{ reachable: boolean; health?: WindowsAgentHealth; reason?: string; url?: string }> => {
  const url = windowsAgentUrl(machine);
  if (!url) return { reachable: false, reason: "missing Windows agent URL" };
  try {
    const health = await requestJson<WindowsAgentHealth>("GET", `${url}/health`, undefined, timeoutMs, authHeaders(machine));
    return { reachable: health.ok === true, health, url, reason: health.ok === true ? undefined : "agent health check failed" };
  } catch (error) {
    return { reachable: false, url, reason: error instanceof Error ? error.message : "agent health check failed" };
  }
};

export class WindowsAgentSession extends EventEmitter<AgentEvents> {
  private replay: string[] = [];
  private replayBytes = 0;
  private replayTruncated = false;
  private readonly checkpoint: TerminalCheckpoint;
  private exited = false;
  private exitCode: number | null = null;
  private cursor = 0;
  private pidValue = 0;
  private cwd = "";
  private cwdCaptureBuffer = "";
  private observedCwdFromOutput = false;
  private ready = false;
  private pendingResize: { cols: number; rows: number } | undefined;
  private pendingInput: Array<{ data: string; terminalResponse: boolean }> = [];
  private stopped = false;
  private paused = false;
  private lastTransportWarningAt = 0;

  constructor(
    readonly pane: PaneState,
    private readonly machine: MachineConfig,
    private readonly cols: number,
    private readonly rows: number,
    private readonly extraEnv: Record<string, string> = {},
  ) {
    super();
    this.checkpoint = new TerminalCheckpoint(cols, rows);
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

  get attachReplay(): AttachReplay {
    return selectAttachReplay(this.replayOutput, this.replayTruncated, this.checkpoint);
  }

  write(data: string): void {
    this.postInput(data, false);
  }

  writeTerminalResponse(data: string): void {
    this.postInput(data, true);
  }

  private postInput(data: string, terminalResponse: boolean): void {
    if (this.exited || this.stopped) return;
    if (!this.ready) {
      this.pendingInput.push({ data, terminalResponse });
      return;
    }
    void this.post(`/sessions/${encodeURIComponent(this.pane.id)}/input`, {
      dataBase64: Buffer.from(data, "utf8").toString("base64"),
      terminalResponse,
    }).catch((error) => this.reportTransportFailure("input", error));
  }

  resize(cols: number, rows: number): void {
    if (this.exited || this.stopped || cols < 2 || rows < 1) return;
    this.checkpoint.resize(cols, rows);
    if (!this.ready) {
      this.pendingResize = { cols, rows };
      return;
    }
    void this.post(`/sessions/${encodeURIComponent(this.pane.id)}/resize`, { cols, rows })
      .catch((error) => this.reportTransportFailure("resize", error));
  }

  kill(): void {
    if (this.stopped) return;
    this.detach();
    void this.delete(`/sessions/${encodeURIComponent(this.pane.id)}`)
      .catch((error) => this.reportTransportFailure("delete", error, false));
  }

  detach(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.checkpoint.dispose();
  }

  pause(): void {
    // Output is buffered agent-side and replayed from the cursor, so halting the
    // poll loop is a safe backpressure valve — no data is dropped.
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  private async start(): Promise<void> {
    try {
      const helperBundle = buildWindowsHelperBundle(this.machine);
      const response = await this.post<AgentSessionResponse>(`/sessions/${encodeURIComponent(this.pane.id)}`, {
        cols: this.cols,
        rows: this.rows,
        cwd: this.cwd || this.machine.cwd || "",
        shell: this.machine.shell || "",
        helperBundle: { bundleVersion: helperBundle.bundleVersion, files: helperBundle.files },
        env: {
          WMUX_MACHINE_ID: this.machine.id,
          WMUX_MACHINE_NAME: this.machine.name,
          ...this.extraEnv,
        },
      });
      this.pidValue = response.pid ?? 0;
      this.cursor = typeof response.base === "number" ? response.base : 0;
      this.ready = true;
      if (response.cwd) {
        this.cwd = response.cwd;
        this.emit("cwd", response.cwd);
      }
      const pendingResize = this.pendingResize;
      this.pendingResize = undefined;
      if (pendingResize) this.resize(pendingResize.cols, pendingResize.rows);
      const pendingInput = this.pendingInput;
      this.pendingInput = [];
      for (const input of pendingInput) this.postInput(input.data, input.terminalResponse);
      this.emit("title", this.machine.name);
      void this.poll();
    } catch (error) {
      this.pendingResize = undefined;
      this.pendingInput = [];
      this.appendAndEmit(`\r\n[wmux] Windows agent attach failed: ${formatError(error)}\r\n`);
      this.exited = true;
      this.emit("exit", 1);
    }
  }

  private async poll(): Promise<void> {
    while (!this.stopped && !this.exited) {
      if (this.paused) {
        await delay(50);
        continue;
      }
      try {
        const response = await this.get<AgentOutputResponse>(
          `/sessions/${encodeURIComponent(this.pane.id)}/output?cursor=${this.cursor}&timeoutMs=15000`,
          20_000,
        );
        if (typeof response.cursor === "number") this.cursor = response.cursor;
        // Agent versions before 0.5 report the session's startup cwd forever.
        // Accept that value only until the shell has emitted an OSC 7 update;
        // otherwise every output poll immediately reverts the live cwd.
        if (!this.observedCwdFromOutput && response.cwd && response.cwd !== this.cwd) {
          this.cwd = response.cwd;
          this.emit("cwd", response.cwd);
        }
        if (response.dataBase64) {
          const data = Buffer.from(response.dataBase64, "base64").toString("utf8");
          this.appendAndEmit(data);
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
    return requestJson<T>("GET", `${url}${path}`, undefined, timeoutMs, authHeaders(this.machine));
  }

  private async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const url = windowsAgentUrl(this.machine);
    if (!url) throw new Error(`machine ${this.machine.id} is missing Windows agent URL`);
    return requestJson<T>("POST", `${url}${path}`, body, 5000, authHeaders(this.machine));
  }

  private async delete<T = unknown>(path: string): Promise<T> {
    const url = windowsAgentUrl(this.machine);
    if (!url) throw new Error(`machine ${this.machine.id} is missing Windows agent URL`);
    return requestJson<T>("DELETE", `${url}${path}`, undefined, 5000, authHeaders(this.machine));
  }

  private appendAndEmit(data: string): void {
    this.checkpoint.write(data);
    this.appendReplay(data);
    this.captureCwd(data);
    this.emit("output", data);
  }

  private appendReplay(data: string): void {
    if (this.replayBytes + Buffer.byteLength(data) > MAX_REPLAY_BYTES) this.replayTruncated = true;
    this.replayBytes = appendBoundedReplay(this.replay, this.replayBytes, data, MAX_REPLAY_BYTES);
  }

  private captureCwd(data: string): void {
    const { cwds, pending } = captureOsc7(this.cwdCaptureBuffer, data);
    this.cwdCaptureBuffer = pending;
    for (const cwd of cwds) {
      this.observedCwdFromOutput = true;
      if (cwd === this.cwd) continue;
      this.cwd = cwd;
      this.emit("cwd", cwd);
    }
  }

  private reportTransportFailure(operation: string, error: unknown, showInPane = true): void {
    const detail = formatError(error);
    const timestamp = Date.now();
    if (showInPane && timestamp - this.lastTransportWarningAt < 5000) return;
    if (showInPane) this.lastTransportWarningAt = timestamp;
    console.warn(`wmux: Windows agent ${operation} failed for ${this.pane.id}: ${detail}`);
    if (!showInPane || this.stopped) return;
    this.appendAndEmit(`\r\n[wmux] Windows agent ${operation} failed: ${detail}\r\n`);
  }
}

const requestJson = <T>(
  method: string,
  rawUrl: string,
  body: unknown,
  timeoutMs: number,
  extraHeaders: Record<string, string> = {},
): Promise<T> =>
  new Promise((resolve, reject) => {
    const url = new URL(rawUrl);
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(
      url,
      {
        method,
        timeout: timeoutMs,
        headers: {
          ...extraHeaders,
          ...(data
            ? {
                "content-type": "application/json",
                "content-length": String(data.byteLength),
              }
            : {}),
        },
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

const formatError = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
