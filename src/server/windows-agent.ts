import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { MachineConfig, PaneState } from "./types.js";
import {
  buildWindowsHelperBundle,
  expectedWindowsAgentProtocolVersion,
  expectedWindowsAgentReleaseVersion,
  type WindowsHelperBundle,
} from "./windows-helpers.js";
import { appendBoundedReplay } from "./replay-buffer.js";
import { captureOsc7 } from "./osc7.js";
import { selectAttachReplay, TerminalCheckpoint, type AttachReplay } from "./terminal-checkpoint.js";

interface AgentEvents {
  output: [string];
  title: [string];
  cwd: [string];
  agentPort: [number];
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
  cols?: number;
  rows?: number;
}

interface AgentSessionListResponse {
  sessions?: AgentSessionResponse[];
}

interface AgentResizeEvent {
  cursor: number;
  cols: number;
  rows: number;
}

interface AgentOutputResponse {
  base?: number;
  startCursor?: number;
  cursor?: number;
  cols?: number;
  rows?: number;
  resizes?: AgentResizeEvent[];
  dataBase64?: string;
  exited?: boolean;
  exitCode?: number | null;
  cwd?: string;
}

export interface WindowsAgentHealth {
  ok?: boolean;
  releaseVersion?: string;
  protocolVersion?: number;
  /** Transition alias returned by agents released before structured version fields. */
  version?: string;
  machine?: string;
  pid?: number;
  sessions?: number;
  activeSessions?: number;
  draining?: boolean;
  updatePending?: boolean;
  restartWhenIdle?: boolean;
  backend?: string;
  processTree?: string;
  helperBundleVersion?: string;
  conptyAvailable?: boolean;
  pywinptyAvailable?: boolean;
  capabilities?: string[];
}

export type WindowsAgentUpdateActivator = (machine: MachineConfig, port?: number) => Promise<number | void>;

const MAX_REPLAY_BYTES = 2 * 1024 * 1024;

export const windowsAgentUrl = (machine: MachineConfig): string | undefined => {
  if (machine.agentUrl) return machine.agentUrl.replace(/\/+$/, "");
  if (!machine.host) return undefined;
  const host = net.isIP(machine.host) === 6 ? `[${machine.host}]` : machine.host;
  return `http://${host}:${machine.agentPort ?? 3481}`;
};

export const shouldUseWindowsAgent = (machine: MachineConfig): boolean =>
  machine.kind === "powershell-ssh" && machine.sessionBackend === "agent";

export const deleteWindowsAgentSession = (machine: MachineConfig, paneId: string): void => {
  const url = windowsAgentUrl(machine);
  if (!url) return;
  void requestJson("DELETE", `${url}/sessions/${encodeURIComponent(paneId)}`, undefined, 5000, authHeaders(machine))
    .catch((error) => console.warn(`wmux: Windows agent delete failed for ${paneId}: ${formatError(error)}`));
};

interface WindowsAgentPasteImageResponse {
  stageId: string;
  targetPath: string;
  bytes: number;
}

export class WindowsAgentPasteImageUnsupportedError extends Error {}

export const stageWindowsAgentPasteImage = async (
  machine: MachineConfig,
  paneId: string,
  stageId: string,
  extension: string,
  data: Buffer,
): Promise<string> => {
  const url = windowsAgentUrl(machine);
  if (!url) throw new Error("missing Windows agent URL");
  const health = await requestJson<WindowsAgentHealth>("GET", `${url}/health`, undefined, 3000, authHeaders(machine));
  if ((health.protocolVersion ?? 0) < 4 || !health.capabilities?.includes("paste-images-v1")) {
    throw new WindowsAgentPasteImageUnsupportedError("Windows agent does not support paste image staging");
  }
  const response = await requestBinary<WindowsAgentPasteImageResponse>(
    "POST",
    `${url}/sessions/${encodeURIComponent(paneId)}/paste-images/${encodeURIComponent(stageId)}?extension=${encodeURIComponent(extension)}`,
    data,
    15_000,
    authHeaders(machine),
  );
  if (
    response.stageId !== stageId
    || response.bytes !== data.length
    || typeof response.targetPath !== "string"
  ) throw new Error("invalid Windows agent staging response");
  return response.targetPath;
};

export const deleteWindowsAgentPasteImage = async (
  machine: MachineConfig,
  paneId: string,
  stageId: string,
): Promise<void> => {
  const url = windowsAgentUrl(machine);
  if (!url) return;
  await requestJson(
    "DELETE",
    `${url}/sessions/${encodeURIComponent(paneId)}/paste-images/${encodeURIComponent(stageId)}`,
    undefined,
    5000,
    authHeaders(machine),
  );
};

const authHeaders = (machine: MachineConfig): Record<string, string> =>
  machine.agentToken ? { authorization: `Bearer ${machine.agentToken}` } : {};

export const probeWindowsAgent = async (
  machine: MachineConfig,
  timeoutMs = 1500,
): Promise<{ reachable: boolean; health?: WindowsAgentHealth; reason?: string; url?: string }> => {
  const url = windowsAgentUrl(machine);
  if (!url) return { reachable: false, reason: "missing Windows agent URL" };
  const probe = async (candidateUrl: string) => {
    try {
      const health = await requestJson<WindowsAgentHealth>("GET", `${candidateUrl}/health`, undefined, timeoutMs, authHeaders(machine));
      return { reachable: health.ok === true, health, url: candidateUrl, reason: health.ok === true ? undefined : "agent health check failed" };
    } catch (error) {
      return { reachable: false, url: candidateUrl, reason: error instanceof Error ? error.message : "agent health check failed" };
    }
  };
  const primary = await probe(url);
  const expectedRelease = expectedWindowsAgentReleaseVersion();
  const expectedProtocol = expectedWindowsAgentProtocolVersion();
  const expectedHelpers = buildWindowsHelperBundle(machine).bundleVersion;
  const isCurrent = (result: Awaited<ReturnType<typeof probe>>) =>
    result.reachable
    && (result.health?.releaseVersion ?? result.health?.version) === expectedRelease
    && (result.health?.protocolVersion ?? 0) >= expectedProtocol
    && result.health?.helperBundleVersion === expectedHelpers;
  if (isCurrent(primary)) return primary;

  try {
    const parsed = new URL(url);
    const basePort = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    const candidates = await Promise.all(Array.from({ length: 8 }, (_, index) => {
      const candidate = new URL(parsed);
      candidate.port = String(basePort + index + 1);
      return probe(candidate.toString().replace(/\/+$/, ""));
    }));
    return candidates.find(isCurrent) ?? primary;
  } catch {
    return primary;
  }
};

export class WindowsAgentSession extends EventEmitter<AgentEvents> {
  private replay: string[] = [];
  private replayBytes = 0;
  private replayTruncated = false;
  private checkpoint: TerminalCheckpoint;
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
  private agentUrl: string | undefined;
  readonly attachReady: Promise<void>;
  private resolveAttachReady!: () => void;

  constructor(
    readonly pane: PaneState,
    private readonly machine: MachineConfig,
    private readonly cols: number,
    private readonly rows: number,
    private readonly extraEnv: Record<string, string> = {},
    private readonly activateUpdate: WindowsAgentUpdateActivator = activateWindowsAgentUpdate,
  ) {
    super();
    this.checkpoint = new TerminalCheckpoint(cols, rows);
    this.attachReady = new Promise((resolve) => {
      this.resolveAttachReady = resolve;
    });
    this.cwd = pane.cwd ?? "";
    this.agentUrl = windowsAgentUrl(machine);
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
    return selectAttachReplay(this.replayOutput, this.replayTruncated, this.checkpoint, true);
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
    if (!this.ready) {
      this.pendingResize = { cols, rows };
      return;
    }
    if (sameSize(this.checkpoint.dimensions, cols, rows)) return;
    this.checkpoint.reframe(cols, rows);
    void this.post(`/sessions/${encodeURIComponent(this.pane.id)}/resize`, { cols, rows })
      .catch((error) => this.reportTransportFailure("resize", error));
    const snapshot = this.checkpoint.snapshot();
    if (snapshot) this.emit("output", snapshot);
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
    this.resolveAttachReady();
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
      if (!await this.ensureCurrentAgent(helperBundle)) return;
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
      if (response.cwd) {
        this.cwd = response.cwd;
        this.emit("cwd", response.cwd);
      }
      const historyBytes = Math.max(0, (response.cursor ?? this.cursor) - this.cursor);
      const replayCols = response.cols ?? (historyBytes > 0 ? 80 : this.cols);
      const replayRows = response.rows ?? (historyBytes > 0 ? 24 : this.rows);
      this.checkpoint.reframe(replayCols, replayRows);
      await this.hydrateReplay(response.cursor ?? this.cursor);
      this.ready = true;
      const pendingResize = this.pendingResize;
      this.pendingResize = undefined;
      if (pendingResize && !sameSize(this.checkpoint.dimensions, pendingResize.cols, pendingResize.rows)) {
        this.checkpoint.reframe(pendingResize.cols, pendingResize.rows);
        await this.post(`/sessions/${encodeURIComponent(this.pane.id)}/resize`, pendingResize);
      }
      const pendingInput = this.pendingInput;
      this.pendingInput = [];
      for (const input of pendingInput) this.postInput(input.data, input.terminalResponse);
      this.resolveAttachReady();
      this.emit("title", this.machine.name);
      void this.poll();
    } catch (error) {
      this.pendingResize = undefined;
      this.pendingInput = [];
      if (this.stopped) {
        this.resolveAttachReady();
        return;
      }
      this.appendAndEmit(`\r\n[wmux] Windows agent attach failed: ${formatError(error)}\r\n`);
      this.exited = true;
      this.resolveAttachReady();
      this.emit("exit", 1);
    }
  }

  private async ensureCurrentAgent(helperBundle: WindowsHelperBundle): Promise<boolean> {
    let health: WindowsAgentHealth;
    let sessions: AgentSessionResponse[];
    try {
      health = await this.get<WindowsAgentHealth>("/health", 1500);
      const listed = await this.get<AgentSessionListResponse>("/sessions", 3000);
      sessions = listed.sessions ?? [];
    } catch {
      // Health/listing are update-control capabilities, not prerequisites for
      // attaching. Older agents and protocol test doubles can still serve a
      // session through the established create endpoint.
      return !this.stopped;
    }

    const actualRelease = health.releaseVersion ?? health.version;
    const expectedRelease = expectedWindowsAgentReleaseVersion();
    const actualProtocol = health.protocolVersion ?? 0;
    const expectedProtocol = expectedWindowsAgentProtocolVersion();
    const releaseCurrent = actualRelease === expectedRelease;
    const protocolCurrent = actualProtocol >= expectedProtocol;
    const helpersCurrent = health.helperBundleVersion === helperBundle.bundleVersion;
    if (!actualRelease || (releaseCurrent && protocolCurrent && helpersCurrent)) return !this.stopped;
    const actualDisplay = releaseCurrent && !protocolCurrent
      ? `${actualRelease}/protocol ${actualProtocol || "legacy"}`
      : actualRelease;
    const expectedDisplay = releaseCurrent && !protocolCurrent
      ? `${expectedRelease}/protocol ${expectedProtocol}`
      : expectedRelease;

    const existing = sessions.some((session) => session.id === this.pane.id && session.status !== "exited");
    if (existing) return !this.stopped;

    const supportsDrain =
      actualProtocol >= 1
      || legacyAgentSupportsDrain(actualRelease);
    if (!supportsDrain) return !this.stopped;

    const activeSessions = health.activeSessions ?? sessions.filter((session) => session.status !== "exited").length;
    // A legacy update drain blocks every create request. Cancel it before
    // staging or creating this pane; the current service helper will re-arm a
    // compatibility watcher after the new session exists.
    if (health.draining && activeSessions > 0) {
      await this.delete("/drain");
      health.draining = false;
    }

    this.reportRollingUpdate(actualDisplay, expectedDisplay, activeSessions);
    if (!health.draining) {
      if (health.helperBundleVersion !== helperBundle.bundleVersion) {
        const stagingId = `__wmux_update_${this.pane.id}_${Date.now().toString(36)}`;
        try {
          await this.post(`/sessions/${encodeURIComponent(stagingId)}`, {
            cols: 80,
            rows: 24,
            shell: this.machine.shell || "",
            helperBundle: { bundleVersion: helperBundle.bundleVersion, files: helperBundle.files },
            env: { WMUX_MACHINE_ID: this.machine.id, WMUX_MACHINE_NAME: this.machine.name },
          });
        } finally {
          await this.delete(`/sessions/${encodeURIComponent(stagingId)}`).catch(() => undefined);
        }
      }
    }

    const currentGeneration = await this.findCurrentGeneration(helperBundle);
    if (currentGeneration !== undefined) {
      this.routeToAgentPort(currentGeneration);
      this.appendAndEmit(`\r\n[wmux] Updated Windows agent generation is ready on port ${currentGeneration}; opening pane.\r\n`);
      return !this.stopped;
    }

    const rolloutPort = await this.selectRolloutPort();
    const activatedPort = await this.activateUpdate(this.machine, rolloutPort);
    if (typeof activatedPort === "number") {
      this.routeToAgentPort(activatedPort);
      const current = await this.get<WindowsAgentHealth>("/health", 3000);
      const currentRelease = current.releaseVersion ?? current.version;
      if (
        current.ok !== true
        || currentRelease !== expectedRelease
        || (current.protocolVersion ?? 0) < expectedProtocol
        || current.helperBundleVersion !== helperBundle.bundleVersion
      ) {
        throw new Error(`new Windows agent generation on port ${activatedPort} did not report the staged version`);
      }
      this.appendAndEmit(`\r\n[wmux] Updated Windows agent generation is ready on port ${activatedPort}; opening pane.\r\n`);
      return !this.stopped;
    }

    // Compatibility path for custom activators that replace the base listener
    // instead of returning a side-by-side generation port.
    this.reportPendingUpdate(actualDisplay, expectedDisplay, health.activeSessions ?? 0);

    while (!this.stopped) {
      await delay(500);
      try {
        const current = await this.get<WindowsAgentHealth>("/health", 1500);
        const currentRelease = current.releaseVersion ?? current.version;
        const currentProtocol = current.protocolVersion ?? 0;
        const currentHelpers = current.helperBundleVersion === helperBundle.bundleVersion;
        if (current.ok === true && currentRelease === expectedRelease && currentProtocol >= expectedProtocol && currentHelpers) {
          this.appendAndEmit(`\r\n[wmux] Windows agent updated to ${expectedDisplay}; opening pane.\r\n`);
          return true;
        }
      } catch {
        // The Scheduled Task briefly drops the listener while replacing the
        // drained process. Keep waiting; no remote pane is owned by this
        // pending session yet.
      }
    }
    return false;
  }

  private baseAgentPort(): number {
    if (this.machine.agentPort) return this.machine.agentPort;
    if (!this.agentUrl) return 3481;
    const parsed = new URL(this.agentUrl);
    return parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  }

  private urlForAgentPort(port: number): string {
    if (!this.agentUrl) throw new Error(`machine ${this.machine.id} is missing Windows agent URL`);
    const parsed = new URL(this.agentUrl);
    parsed.port = String(port);
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  }

  private async generationHealth(port: number, timeoutMs = 750): Promise<WindowsAgentHealth | undefined> {
    try {
      return await requestJson<WindowsAgentHealth>(
        "GET",
        `${this.urlForAgentPort(port)}/health`,
        undefined,
        timeoutMs,
        authHeaders(this.machine),
      );
    } catch {
      return undefined;
    }
  }

  private async findCurrentGeneration(helperBundle: WindowsHelperBundle): Promise<number | undefined> {
    const expectedRelease = expectedWindowsAgentReleaseVersion();
    const expectedProtocol = expectedWindowsAgentProtocolVersion();
    const basePort = this.baseAgentPort();
    for (let port = basePort + 1; port <= basePort + 8; port += 1) {
      const health = await this.generationHealth(port);
      if (
        health?.ok === true
        && (health.releaseVersion ?? health.version) === expectedRelease
        && (health.protocolVersion ?? 0) >= expectedProtocol
        && health.helperBundleVersion === helperBundle.bundleVersion
      ) return port;
    }
    return undefined;
  }

  private async selectRolloutPort(): Promise<number> {
    const basePort = this.baseAgentPort();
    let idleOutdatedPort: number | undefined;
    for (let port = basePort + 1; port <= basePort + 8; port += 1) {
      const health = await this.generationHealth(port);
      if (!health?.ok) return port;
      if ((health.activeSessions ?? health.sessions ?? 0) === 0 && idleOutdatedPort === undefined) {
        idleOutdatedPort = port;
      }
    }
    if (idleOutdatedPort !== undefined) return idleOutdatedPort;
    throw new Error("all Windows agent rollout ports are occupied by active generations");
  }

  private routeToAgentPort(port: number): void {
    this.agentUrl = this.urlForAgentPort(port);
    this.emit("agentPort", port);
  }

  private reportPendingUpdate(actual: string, expected: string, activeSessions: number): void {
    if (activeSessions > 0) {
      this.appendAndEmit(
        `\r\n[wmux] Windows agent update staged (${actual} → ${expected}). Waiting for ${activeSessions} existing pane(s) to close; they will not be interrupted.\r\n`,
      );
      return;
    }
    this.appendAndEmit(`\r\n[wmux] Updating Windows agent ${actual} → ${expected}; waiting for its service to restart.\r\n`);
  }

  private reportRollingUpdate(actual: string, expected: string, activeSessions: number): void {
    this.appendAndEmit(
      `\r\n[wmux] Preparing Windows agent ${actual} → ${expected} for this pane on a new generation. ${activeSessions} existing pane(s) will remain on their current generation.\r\n`,
    );
  }

  private async hydrateReplay(targetCursor: number): Promise<void> {
    while (!this.stopped && !this.exited && this.cursor < targetCursor) {
      const before = this.cursor;
      const response = await this.get<AgentOutputResponse>(
        `/sessions/${encodeURIComponent(this.pane.id)}/output?cursor=${this.cursor}&timeoutMs=0`,
        5000,
      );
      this.applyOutputResponse(response, false);
      if (this.cursor <= before) break;
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
        this.applyOutputResponse(response, true);
        // Agent versions before 0.5 report the session's startup cwd forever.
        // Accept that value only until the shell has emitted an OSC 7 update;
        // otherwise every output poll immediately reverts the live cwd.
        if (!this.observedCwdFromOutput && response.cwd && response.cwd !== this.cwd) {
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

  private applyOutputResponse(response: AgentOutputResponse, emit: boolean): void {
    const requestedCursor = this.cursor;
    const base = typeof response.base === "number" ? response.base : requestedCursor;
    const startCursor = typeof response.startCursor === "number" ? response.startCursor : Math.max(requestedCursor, base);
    const endCursor = typeof response.cursor === "number" ? response.cursor : startCursor;
    if (base > requestedCursor) this.replayTruncated = true;

    if (response.cols && response.rows && !sameSize(this.checkpoint.dimensions, response.cols, response.rows)) {
      this.checkpoint.reframe(response.cols, response.rows);
    }

    const data = response.dataBase64 ? Buffer.from(response.dataBase64, "base64") : Buffer.alloc(0);
    let offset = 0;
    const resizes = (response.resizes ?? [])
      .filter((event) => event.cursor > startCursor && event.cursor <= endCursor)
      .sort((left, right) => left.cursor - right.cursor);
    for (const event of resizes) {
      const nextOffset = Math.min(data.length, Math.max(offset, event.cursor - startCursor));
      this.appendAndEmit(data.subarray(offset, nextOffset).toString("utf8"), emit);
      this.checkpoint.reframe(event.cols, event.rows);
      offset = nextOffset;
    }
    this.appendAndEmit(data.subarray(offset).toString("utf8"), emit);
    this.cursor = endCursor;
  }

  private async get<T>(path: string, timeoutMs = 5000): Promise<T> {
    const url = this.agentUrl;
    if (!url) throw new Error(`machine ${this.machine.id} is missing Windows agent URL`);
    return requestJson<T>("GET", `${url}${path}`, undefined, timeoutMs, authHeaders(this.machine));
  }

  private async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const url = this.agentUrl;
    if (!url) throw new Error(`machine ${this.machine.id} is missing Windows agent URL`);
    return requestJson<T>("POST", `${url}${path}`, body, 5000, authHeaders(this.machine));
  }

  private async delete<T = unknown>(path: string): Promise<T> {
    const url = this.agentUrl;
    if (!url) throw new Error(`machine ${this.machine.id} is missing Windows agent URL`);
    return requestJson<T>("DELETE", `${url}${path}`, undefined, 5000, authHeaders(this.machine));
  }

  private appendAndEmit(data: string, emit = true): void {
    if (!data) return;
    this.checkpoint.write(data);
    this.appendReplay(data);
    this.captureCwd(data);
    if (emit) this.emit("output", data);
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

const sameSize = (
  dimensions: { cols: number; rows: number } | undefined,
  cols: number,
  rows: number,
): boolean => dimensions?.cols === cols && dimensions.rows === rows;

const legacyAgentSupportsDrain = (release: string): boolean => {
  const match = /^(\d+)\.(\d+)(?:\.|$)/.exec(release);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || minor >= 7;
};

export const activateWindowsAgentUpdate: WindowsAgentUpdateActivator = async (machine, port) => {
  if (!machine.host) throw new Error(`machine ${machine.id} is missing an SSH host`);
  const target = machine.user ? `${machine.user}@${machine.host}` : machine.host;
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"];
  if (machine.port) args.push("-p", String(machine.port));
  args.push(target, machine.shell ?? "pwsh", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-");
  const script = `
$Service = Join-Path $env:LOCALAPPDATA 'wmux\\bin\\wmux-windows-agent-service.ps1'
if (-not (Test-Path -LiteralPath $Service -PathType Leaf)) {
  Write-Error "wmux Windows agent service helper is not staged at $Service"
  exit 127
}
& pwsh -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Service ${port ? `rollout-update --port ${port}` : "activate-update"}
exit $LASTEXITCODE
`;
  return new Promise<number | void>((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else if (port) {
        const line = stdout.trim().split(/\r?\n/).reverse().find((candidate) => candidate.trim().startsWith("{"));
        if (!line) resolve(port);
        else {
          try {
            const payload = JSON.parse(line) as { port?: number };
            if (payload.port !== port) throw new Error(`expected port ${port}, received ${payload.port ?? "none"}`);
            resolve(port);
          } catch (parseError) {
            reject(new Error(`invalid Windows agent rollout response: ${formatError(parseError)}`));
          }
        }
      } else resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`timed out activating the Windows agent update on ${machine.id}`));
    }, 15_000);
    child.stderr.setEncoding("utf8");
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 8192) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += chunk;
    });
    child.once("error", (error) => finish(error));
    child.once("close", (status) => {
      if (status === 0) finish();
      else finish(new Error(`remote update activation failed with exit ${status ?? "unknown"}${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""}`));
    });
    child.stdin.end(script);
  });
};

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

const requestBinary = <T>(
  method: string,
  rawUrl: string,
  data: Buffer,
  timeoutMs: number,
  extraHeaders: Record<string, string> = {},
): Promise<T> => new Promise((resolve, reject) => {
  const url = new URL(rawUrl);
  const client = url.protocol === "https:" ? https : http;
  const request = client.request(url, {
    method,
    timeout: timeoutMs,
    headers: {
      ...extraHeaders,
      "content-type": "application/octet-stream",
      "content-length": String(data.length),
    },
  }, (response) => {
    const chunks: Buffer[] = [];
    let responseBytes = 0;
    response.on("data", (chunk) => {
      responseBytes += chunk.length;
      if (responseBytes <= 64 * 1024) chunks.push(Buffer.from(chunk));
    });
    response.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        reject(new Error(`HTTP ${response.statusCode ?? 0}`));
        return;
      }
      try {
        resolve(JSON.parse(raw) as T);
      } catch (error) {
        reject(error);
      }
    });
  });
  request.on("timeout", () => request.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
  request.on("error", reject);
  request.end(data);
});

const formatError = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
