import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import {
  WINDOWS_AGENT_LONG_POLL,
  WINDOWS_AGENT_PATHS,
  POSIX_AGENT_RUNTIME_FILE_CAPABILITY,
  type WindowsAgentHealth,
  type WindowsAgentOutputResponse as AgentOutputResponse,
  type WindowsAgentPasteImageResponse,
  type WindowsAgentSessionListResponse as AgentSessionListResponse,
  type WindowsAgentSessionResponse as AgentSessionResponse,
} from "../shared/windows-agent-protocol.js";
import type { BackendRuntimeFile } from "./backends/backend.js";
import type { MachineConfig, PaneStartupPhase, PaneState } from "./types.js";
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
  phase: [PaneStartupPhase, string];
  exit: [number | null];
}

export type {
  WindowsAgentHealth,
  WindowsAgentHeartbeatHealth,
} from "../shared/windows-agent-protocol.js";

export type WindowsAgentUpdateActivator = (machine: MachineConfig, port?: number) => Promise<number | void>;

const MAX_REPLAY_BYTES = 2 * 1024 * 1024;
const SESSION_CREATE_TIMEOUT_MS = 30_000;
const UPDATE_ACTIVATION_TIMEOUT_MS = 30_000;
const UPDATE_RESTART_TIMEOUT_MS = 60_000;
const LIVE_RESIZE_SETTLE_MS = 100;
const RESIZE_REPAINT_QUIET_MS = 120;
const RESIZE_REPAINT_MAX_WAIT_MS = 1000;

export const windowsAgentUrl = (machine: MachineConfig): string | undefined => {
  if (machine.agentUrl) return machine.agentUrl.replace(/\/+$/, "");
  if (machine.kind === "local" && machine.sessionBackend === "agent") {
    return `http://127.0.0.1:${machine.agentPort ?? 3481}`;
  }
  if (!machine.host) return undefined;
  const host = net.isIP(machine.host) === 6 ? `[${machine.host}]` : machine.host;
  return `http://${host}:${machine.agentPort ?? 3481}`;
};

const agentPortFromUrl = (url: string): number => {
  const parsed = new URL(url);
  if (parsed.port) return Number(parsed.port);
  return parsed.protocol === "https:" ? 443 : 80;
};

export const windowsAgentPort = (machine: MachineConfig): number => {
  const url = windowsAgentUrl(machine);
  return url ? agentPortFromUrl(url) : machine.agentPort ?? 3481;
};

export const shouldUseWindowsAgent = (machine: MachineConfig): boolean =>
  machine.kind === "powershell-ssh" && machine.sessionBackend === "agent";

export const shouldUsePosixAgent = (machine: MachineConfig): boolean =>
  (machine.kind === "local" || machine.kind === "ssh")
  && machine.sessionBackend === "agent";

export const shouldUseSessionAgent = (machine: MachineConfig): boolean =>
  shouldUseWindowsAgent(machine) || shouldUsePosixAgent(machine);

export const deleteWindowsAgentSession = async (
  machine: MachineConfig,
  paneId: string,
): Promise<boolean> => {
  const url = windowsAgentUrl(machine);
  if (!url) return false;
  try {
    await requestJson(
      "DELETE",
      `${url}${WINDOWS_AGENT_PATHS.session(paneId)}`,
      undefined,
      5000,
      authHeaders(machine),
    );
    return true;
  } catch (error) {
    console.warn(`wmux: Windows agent delete failed for ${paneId}: ${formatError(error)}`);
    return false;
  }
};

export interface SessionAgentObservation {
  paneId: string;
  detail: string;
}

export interface SessionAgentObservationResult {
  reachable: boolean;
  detail?: string;
  sessions: SessionAgentObservation[];
}

export const listSessionAgentSessions = async (
  machine: MachineConfig,
): Promise<SessionAgentObservationResult> => {
  const url = windowsAgentUrl(machine);
  if (!url) {
    return {
      reachable: false,
      detail: "missing session agent URL",
      sessions: [],
    };
  }
  try {
    const response = await requestJson<AgentSessionListResponse>(
      "GET",
      `${url}${WINDOWS_AGENT_PATHS.sessions}`,
      undefined,
      5000,
      authHeaders(machine),
    );
    return {
      reachable: true,
      sessions: (response.sessions ?? []).flatMap((session) => {
        if (
          typeof session.id !== "string"
          || !session.id
          || session.id.length > 120
          || !/^[A-Za-z0-9_-]+$/.test(session.id)
        ) {
          return [];
        }
        const status = typeof session.status === "string"
          ? session.status.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 80)
          : "unknown";
        const pid = typeof session.pid === "number"
          && Number.isSafeInteger(session.pid)
          && session.pid > 0
          ? session.pid
          : undefined;
        return [{
          paneId: session.id,
          detail: `${status || "unknown"}${pid ? `, pid ${pid}` : ""}`,
        }];
      }),
    };
  } catch (error) {
    return {
      reachable: false,
      detail: error instanceof Error ? error.message : String(error),
      sessions: [],
    };
  }
};

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
  const health = await requestJson<WindowsAgentHealth>(
    "GET",
    `${url}${WINDOWS_AGENT_PATHS.health}`,
    undefined,
    3000,
    authHeaders(machine),
  );
  if ((health.protocolVersion ?? 0) < 4 || !health.capabilities?.includes("paste-images-v1")) {
    throw new WindowsAgentPasteImageUnsupportedError("Windows agent does not support paste image staging");
  }
  const response = await requestBinary<WindowsAgentPasteImageResponse>(
    "POST",
    `${url}${WINDOWS_AGENT_PATHS.pasteImage(paneId, stageId, extension)}`,
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
    `${url}${WINDOWS_AGENT_PATHS.pasteImage(paneId, stageId)}`,
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
      const health = await requestJson<WindowsAgentHealth>(
        "GET",
        `${candidateUrl}${WINDOWS_AGENT_PATHS.health}`,
        undefined,
        timeoutMs,
        authHeaders(machine),
      );
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

export const probePosixAgent = async (
  machine: MachineConfig,
  timeoutMs = 1500,
): Promise<{
  reachable: boolean;
  health?: WindowsAgentHealth;
  reason?: string;
  url?: string;
}> => {
  const url = windowsAgentUrl(machine);
  if (!url) return { reachable: false, reason: "missing POSIX agent URL" };
  try {
    const health = await requestJson<WindowsAgentHealth>(
      "GET",
      `${url}${WINDOWS_AGENT_PATHS.health}`,
      undefined,
      timeoutMs,
      authHeaders(machine),
    );
    return {
      reachable: health.ok === true,
      health,
      url,
      reason: health.ok === true ? undefined : "agent health check failed",
    };
  } catch (error) {
    return {
      reachable: false,
      url,
      reason: error instanceof Error
        ? error.message
        : "agent health check failed",
    };
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
  private desiredCols: number;
  private desiredRows: number;
  private pendingResize: { cols: number; rows: number } | undefined;
  private resizeInFlight: Promise<void> | undefined;
  private resizeSettleTimer: ReturnType<typeof setTimeout> | undefined;
  private resizeRepaintTimer: ReturnType<typeof setTimeout> | undefined;
  private resizeRepaintDeadline = 0;
  private resizeRepaintSawOutput = false;
  private pendingInput: Array<{ data: string; terminalResponse: boolean }> = [];
  private inputQueue: Promise<void> = Promise.resolve();
  private stopped = false;
  private paused = false;
  private lastTransportWarningAt = 0;
  private agentUrl: string | undefined;
  private liveResetEmitted = false;
  private liveOutputObserved = false;
  private disposal: Promise<boolean> | undefined;
  readonly attachReady: Promise<void>;
  private resolveAttachReady!: () => void;

  constructor(
    readonly pane: PaneState,
    private readonly machine: MachineConfig,
    private readonly cols: number,
    private readonly rows: number,
    private readonly extraEnv: Record<string, string> = {},
    private readonly activateUpdate: WindowsAgentUpdateActivator = activateWindowsAgentUpdate,
    private readonly updateRestartTimeoutMs = UPDATE_RESTART_TIMEOUT_MS,
    private readonly restoredCheckpoint?: AttachReplay,
    private readonly configuredBaseAgentPort?: number,
    private readonly runtimeFiles: BackendRuntimeFile[] = [],
    private readonly processReplacementRuntimeFiles?: () => BackendRuntimeFile[],
  ) {
    super();
    this.checkpoint = new TerminalCheckpoint(cols, rows, extraEnv);
    this.attachReady = new Promise((resolve) => {
      this.resolveAttachReady = resolve;
    });
    this.cwd = pane.cwd ?? "";
    this.agentUrl = windowsAgentUrl(machine);
    this.desiredCols = cols;
    this.desiredRows = rows;
    queueMicrotask(() => void this.start());
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
    const current = selectAttachReplay(
      this.replayOutput,
      this.replayTruncated,
      this.checkpoint,
      true,
    );
    if (current.kind === "checkpoint") {
      const seeded = this.checkpoint.snapshotWithScrollbackSeed();
      if (seeded) current.data = seeded;
    }
    if (!this.restoredCheckpoint || this.liveOutputObserved) return current;
    return this.restoredCheckpoint;
  }

  get restoredAttachReplay(): AttachReplay | undefined {
    return this.liveOutputObserved ? undefined : this.restoredCheckpoint;
  }

  get screenCheckpoint(): AttachReplay | undefined {
    const data = this.checkpoint.snapshot();
    return data ? { data, kind: "checkpoint" } : undefined;
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
    this.inputQueue = this.inputQueue.then(async () => {
      if (this.exited || this.stopped) return;
      await this.flushPendingResize();
      await this.post(WINDOWS_AGENT_PATHS.input(this.pane.id), {
        dataBase64: Buffer.from(data, "utf8").toString("base64"),
        terminalResponse,
      });
    }).catch((error) => this.reportTransportFailure("input", error));
  }

  resize(cols: number, rows: number): void {
    if (this.exited || this.stopped || cols < 2 || rows < 1) return;
    this.desiredCols = cols;
    this.desiredRows = rows;
    if (!sameSize(this.checkpoint.dimensions, cols, rows)) {
      this.checkpoint.reframe(cols, rows);
    }
    // The browser has already resized its renderer. Keep this checkpoint for
    // later attaches only: emitting its RIS-based snapshot here would clear
    // live scrollback and flash a full-screen repaint for every drag step.
    this.pendingResize = { cols, rows };
    if (!this.ready) {
      return;
    }
    this.schedulePendingResize();
  }

  kill(): void {
    void this.disposeRemote();
  }

  disposeRemote(): Promise<boolean> {
    if (this.disposal) return this.disposal;
    this.stopped = true;
    this.cancelResizeSettle();
    this.cancelResizeRepaint();
    this.checkpoint.dispose();
    this.resolveAttachReady();
    this.disposal = this.delete(WINDOWS_AGENT_PATHS.session(this.pane.id))
      .then(() => true)
      .catch((error) => {
        this.reportTransportFailure("delete", error, false);
        return false;
      })
      .finally(() => {
        if (this.exited) return;
        this.exited = true;
        this.emit("exit", this.exitCode);
      });
    return this.disposal;
  }

  detach(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelResizeSettle();
    this.cancelResizeRepaint();
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
      const windows = shouldUseWindowsAgent(this.machine);
      this.reportPhase(
        "checking-agent",
        windows ? "Checking Windows agent…" : "Checking POSIX agent…",
      );
      const helperBundle = windows
        ? buildWindowsHelperBundle(this.machine)
        : undefined;
      if (windows) {
        if (!await this.ensureCurrentAgent(helperBundle!)) return;
      } else {
        const health = await this.get<WindowsAgentHealth>(
          WINDOWS_AGENT_PATHS.health,
          3000,
        );
        if (
          health.ok !== true
          || (health.protocolVersion ?? 0)
            < expectedWindowsAgentProtocolVersion()
        ) {
          throw new Error("POSIX agent protocol is unavailable or outdated");
        }
        if (this.runtimeFiles.length > 0
          && !health.capabilities?.includes(POSIX_AGENT_RUNTIME_FILE_CAPABILITY)) {
          for (const file of this.runtimeFiles) file.data.fill(0);
          this.runtimeFiles.length = 0;
        }
      }
      this.reportPhase(
        "creating-session",
        windows
          ? `Opening PowerShell on ${this.machine.name}…`
          : `Opening shell on ${this.machine.name}…`,
      );
      const wireRuntimeFiles = this.runtimeFiles.map((file) => ({
        purpose: file.purpose,
        dataBase64: file.data.toString("base64"),
        sha256: crypto.createHash("sha256").update(file.data).digest("hex"),
      }));
      for (const file of this.runtimeFiles) file.data.fill(0);
      this.runtimeFiles.length = 0;
      const response = await this.post<AgentSessionResponse>(
        WINDOWS_AGENT_PATHS.session(this.pane.id),
        {
          cols: this.cols,
          rows: this.rows,
          cwd: this.cwd || this.machine.cwd || "",
          shell: this.machine.shell || "",
          loadPowerShellProfile: this.machine.loadPowerShellProfile === true,
          agentProfileOptionalAuth: this.machine.source === "registered",
          helperBundle: {
            bundleVersion: helperBundle?.bundleVersion ?? "",
            files: helperBundle?.files ?? [],
          },
          runtimeFiles: wireRuntimeFiles,
          env: {
            WMUX_MACHINE_ID: this.machine.id,
            WMUX_MACHINE_NAME: this.machine.name,
            ...this.extraEnv,
          },
        },
        SESSION_CREATE_TIMEOUT_MS,
      );
      await this.acceptSession(response, this.cols, this.rows, false);
      this.ready = true;
      await this.flushPendingOperations();
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
      const label = shouldUseWindowsAgent(this.machine)
        ? "Windows"
        : "POSIX";
      this.appendAndEmit(
        `\r\n[wmux] ${label} agent attach failed: ${formatError(error)}\r\n`,
      );
      this.exited = true;
      this.resolveAttachReady();
      this.emit("exit", 1);
    }
  }

  private sessionCreatePayload(
    cols: number,
    rows: number,
    helperBundle?: WindowsHelperBundle,
    runtimeFiles: Array<{ purpose: string; dataBase64: string; sha256: string }> = [],
  ): Record<string, unknown> {
    return {
      cols,
      rows,
      cwd: this.cwd || this.machine.cwd || "",
      shell: this.machine.shell || "",
      loadPowerShellProfile: this.machine.loadPowerShellProfile === true,
      agentProfileOptionalAuth: this.machine.source === "registered",
      helperBundle: {
        bundleVersion: helperBundle?.bundleVersion ?? "",
        files: helperBundle?.files ?? [],
      },
      runtimeFiles,
      env: {
        WMUX_MACHINE_ID: this.machine.id,
        WMUX_MACHINE_NAME: this.machine.name,
        ...this.extraEnv,
      },
    };
  }

  private async acceptSession(
    response: AgentSessionResponse,
    fallbackCols: number,
    fallbackRows: number,
    recreated: boolean,
  ): Promise<void> {
    if (recreated) {
      this.checkpoint.dispose();
      this.checkpoint = new TerminalCheckpoint(fallbackCols, fallbackRows, this.extraEnv);
      this.replay = [];
      this.replayBytes = 0;
      this.replayTruncated = false;
      this.cwdCaptureBuffer = "";
      this.observedCwdFromOutput = false;
      // A new remote process invalidates both the restored checkpoint and the
      // old live screen. Clear it before replaying the replacement shell.
      this.liveOutputObserved = true;
      this.liveResetEmitted = true;
      this.appendAndEmit(
        `\x1bc\r\n[wmux] Session agent restarted; opened a new shell for this pane.\r\n`,
      );
    }
    this.pidValue = response.pid ?? 0;
    this.cursor = typeof response.base === "number" ? response.base : 0;
    if (response.cwd) {
      this.cwd = response.cwd;
      this.emit("cwd", response.cwd);
    }
    const historyBytes = Math.max(0, (response.cursor ?? this.cursor) - this.cursor);
    const replayCols = response.cols ?? (historyBytes > 0 ? 80 : fallbackCols);
    const replayRows = response.rows ?? (historyBytes > 0 ? 24 : fallbackRows);
    this.checkpoint.reframe(replayCols, replayRows);
    if (historyBytes > 0) this.reportPhase("replaying", "Restoring terminal state…");
    await this.hydrateReplay(response.cursor ?? this.cursor);
    if (historyBytes > 0 && response.cols && response.rows) {
      this.liveOutputObserved = true;
    }
  }

  private async flushPendingOperations(): Promise<void> {
    await this.flushPendingResize();
    const pendingInput = this.pendingInput;
    this.pendingInput = [];
    for (const input of pendingInput) this.postInput(input.data, input.terminalResponse);
  }

  private startPendingResize(): void {
    if (!this.ready || this.resizeInFlight || this.stopped || this.exited) return;
    const next = this.pendingResize;
    if (!next) return;
    this.pendingResize = undefined;
    const request = this.post<void>(WINDOWS_AGENT_PATHS.resize(this.pane.id), next)
      .then(() => this.armResizeRepaint())
      .catch((error) => this.reportTransportFailure("resize", error));
    // The agent accepts requests concurrently, so permit only one resize on
    // the wire and retain just the newest geometry while it is in flight.
    this.resizeInFlight = request;
    void request.finally(() => {
      if (this.resizeInFlight !== request) return;
      this.resizeInFlight = undefined;
      if (this.pendingResize) this.schedulePendingResize();
    });
  }

  private schedulePendingResize(): void {
    this.cancelResizeSettle();
    this.resizeSettleTimer = setTimeout(() => {
      this.resizeSettleTimer = undefined;
      this.startPendingResize();
    }, LIVE_RESIZE_SETTLE_MS);
    this.resizeSettleTimer.unref?.();
  }

  private cancelResizeSettle(): void {
    if (this.resizeSettleTimer) clearTimeout(this.resizeSettleTimer);
    this.resizeSettleTimer = undefined;
  }

  private armResizeRepaint(): void {
    this.resizeRepaintDeadline = Date.now() + RESIZE_REPAINT_MAX_WAIT_MS;
    this.resizeRepaintSawOutput = false;
    this.scheduleResizeRepaint(RESIZE_REPAINT_MAX_WAIT_MS);
  }

  private noteResizeRepaintOutput(): void {
    if (!this.resizeRepaintDeadline) return;
    this.resizeRepaintSawOutput = true;
    this.scheduleResizeRepaint(RESIZE_REPAINT_QUIET_MS);
  }

  private scheduleResizeRepaint(delayMs: number): void {
    if (this.resizeRepaintTimer) clearTimeout(this.resizeRepaintTimer);
    this.resizeRepaintTimer = setTimeout(() => {
      this.resizeRepaintTimer = undefined;
      if (this.pendingResize || this.resizeInFlight) {
        this.scheduleResizeRepaint(RESIZE_REPAINT_QUIET_MS);
        return;
      }
      if (!this.resizeRepaintSawOutput && Date.now() < this.resizeRepaintDeadline) {
        this.scheduleResizeRepaint(this.resizeRepaintDeadline - Date.now());
        return;
      }
      this.resizeRepaintDeadline = 0;
      this.resizeRepaintSawOutput = false;
      if (!this.checkpoint.isAlternateScreen) return;
      const snapshot = this.checkpoint.snapshot();
      if (snapshot) this.emit("output", snapshot);
    }, Math.max(0, delayMs));
    this.resizeRepaintTimer.unref?.();
  }

  private cancelResizeRepaint(): void {
    if (this.resizeRepaintTimer) clearTimeout(this.resizeRepaintTimer);
    this.resizeRepaintTimer = undefined;
    this.resizeRepaintDeadline = 0;
    this.resizeRepaintSawOutput = false;
  }

  private async flushPendingResize(): Promise<void> {
    while (!this.stopped && !this.exited) {
      this.cancelResizeSettle();
      this.startPendingResize();
      const request = this.resizeInFlight;
      if (!request) return;
      await request;
    }
  }

  private async recreateMissingSession(): Promise<void> {
    this.ready = false;
    this.cancelResizeSettle();
    await this.resizeInFlight;
    const dimensions = { cols: this.desiredCols, rows: this.desiredRows };
    const helperBundle = shouldUseWindowsAgent(this.machine)
      ? buildWindowsHelperBundle(this.machine)
      : undefined;
    const runtimeFiles = this.processReplacementRuntimeFiles?.() ?? [];
    const wireRuntimeFiles = runtimeFiles.map((file) => ({
      purpose: file.purpose,
      dataBase64: file.data.toString("base64"),
      sha256: crypto.createHash("sha256").update(file.data).digest("hex"),
    }));
    for (const file of runtimeFiles) file.data.fill(0);
    const response = await this.post<AgentSessionResponse>(
      WINDOWS_AGENT_PATHS.session(this.pane.id),
      this.sessionCreatePayload(dimensions.cols, dimensions.rows, helperBundle, wireRuntimeFiles),
      SESSION_CREATE_TIMEOUT_MS,
    );
    if (this.stopped || this.exited) return;
    await this.acceptSession(response, dimensions.cols, dimensions.rows, true);
    this.ready = true;
    await this.flushPendingOperations();
    this.emit("title", this.machine.name);
  }

  private async ensureCurrentAgent(helperBundle: WindowsHelperBundle): Promise<boolean> {
    let health: WindowsAgentHealth;
    let sessions: AgentSessionResponse[];
    try {
      health = await this.get<WindowsAgentHealth>(WINDOWS_AGENT_PATHS.health, 1500);
      const listed = await this.get<AgentSessionListResponse>(WINDOWS_AGENT_PATHS.sessions, 3000);
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
    const existing = sessions.some((session) => session.id === this.pane.id && session.status !== "exited");
    const activeSessions = health.activeSessions ?? sessions.filter((session) => session.status !== "exited").length;
    if (!actualRelease) return !this.stopped;
    if (releaseCurrent && protocolCurrent && helpersCurrent) {
      // A staged helper bundle used to make an old base process look current.
      // If a current side-by-side generation already exists, keep established
      // panes pinned to the base but send new panes to the rollout generation.
      if (!existing && activeSessions > 0) {
        const currentGeneration = await this.findCurrentGeneration(helperBundle);
        if (currentGeneration !== undefined) {
          this.reportPhase("starting-generation", `Routing to Windows agent generation ${currentGeneration}…`);
          this.routeToAgentPort(currentGeneration);
          this.appendAndEmit(`\r\n[wmux] Current Windows agent generation is ready on port ${currentGeneration}; opening pane.\r\n`);
        }
      }
      return !this.stopped;
    }
    const actualDisplay = releaseCurrent && !protocolCurrent
      ? `${actualRelease}/protocol ${actualProtocol || "legacy"}`
      : actualRelease;
    const expectedDisplay = releaseCurrent && !protocolCurrent
      ? `${expectedRelease}/protocol ${expectedProtocol}`
      : expectedRelease;

    if (existing) return !this.stopped;

    const supportsDrain =
      actualProtocol >= 1
      || legacyAgentSupportsDrain(actualRelease);
    if (!supportsDrain) return !this.stopped;

    // A legacy update drain blocks every create request. Cancel it before
    // staging or creating this pane; the current service helper will re-arm a
    // compatibility watcher after the new session exists.
    if (health.draining && activeSessions > 0) {
      await this.delete(WINDOWS_AGENT_PATHS.drain);
      health.draining = false;
    }

    if (activeSessions === 0) this.reportPendingUpdate(actualDisplay, expectedDisplay, activeSessions);
    else this.reportRollingUpdate(actualDisplay, expectedDisplay, activeSessions);
    if (!health.draining) {
      if (health.helperBundleVersion !== helperBundle.bundleVersion) {
        this.reportPhase("staging-helpers", "Staging current Windows helpers…");
        const stagingId = `__wmux_update_${this.pane.id}_${Date.now().toString(36)}`;
        try {
          await this.post(WINDOWS_AGENT_PATHS.session(stagingId), {
            cols: 80,
            rows: 24,
            shell: this.machine.shell || "",
            helperBundle: { bundleVersion: helperBundle.bundleVersion, files: helperBundle.files },
            env: { WMUX_MACHINE_ID: this.machine.id, WMUX_MACHINE_NAME: this.machine.name },
          });
        } finally {
          await this.delete(WINDOWS_AGENT_PATHS.session(stagingId)).catch(() => undefined);
        }
      }
    }

    if (activeSessions === 0) {
      // Nothing is owned by the outdated process, so replace it in place.
      // A pane restored on a side-by-side generation must refresh that exact
      // generation instead of arming an unrelated base-agent restart.
      this.reportPhase("starting-generation", "Updating the Windows agent…");
      const currentPort = this.currentAgentPort();
      await this.activateUpdate(
        this.machine,
        currentPort === this.baseAgentPort() ? undefined : currentPort,
      );
    } else {
      const currentGeneration = await this.findCurrentGeneration(helperBundle);
      if (currentGeneration !== undefined) {
        this.reportPhase("starting-generation", `Routing to Windows agent generation ${currentGeneration}…`);
        this.routeToAgentPort(currentGeneration);
        this.appendAndEmit(`\r\n[wmux] Updated Windows agent generation is ready on port ${currentGeneration}; opening pane.\r\n`);
        return !this.stopped;
      }

      const rolloutPort = await this.selectRolloutPort();
      this.reportPhase("starting-generation", `Starting Windows agent generation ${rolloutPort}…`);
      const activatedPort = await this.activateUpdate(this.machine, rolloutPort);
      if (typeof activatedPort === "number") {
        const basePort = this.baseAgentPort();
        const activatedUrl = this.urlForAgentPort(activatedPort);
        let current: WindowsAgentHealth;
        try {
          current = await requestJson<WindowsAgentHealth>(
            "GET",
            `${activatedUrl}${WINDOWS_AGENT_PATHS.health}`,
            undefined,
            3000,
            authHeaders(this.machine),
          );
        } catch (error) {
          throw new Error(
            `new Windows agent generation on port ${activatedPort} is not reachable from wmux; `
            + `allow inbound TCP ${basePort}-${basePort + 8} from the wmux server `
            + `(wmux-windows-setup configure-agent-firewall <wmux-server-internal-ip>): ${formatError(error)}`,
          );
        }
        const currentRelease = current.releaseVersion ?? current.version;
        if (
          current.ok !== true
          || currentRelease !== expectedRelease
          || (current.protocolVersion ?? 0) < expectedProtocol
          || current.helperBundleVersion !== helperBundle.bundleVersion
        ) {
          throw new Error(`new Windows agent generation on port ${activatedPort} did not report the staged version`);
        }
        // Persist the selected generation only after it is reachable and reports
        // the staged version. Otherwise a failed rollout would strand retries on
        // an unavailable adjacent port instead of the still-running base agent.
        this.routeToAgentPort(activatedPort);
        this.appendAndEmit(`\r\n[wmux] Updated Windows agent generation is ready on port ${activatedPort}; opening pane.\r\n`);
        return !this.stopped;
      }

      // Compatibility path for custom activators that replace the base listener
      // instead of returning a side-by-side generation port.
      this.reportPendingUpdate(actualDisplay, expectedDisplay, activeSessions);
    }

    const updateDeadline = Date.now() + this.updateRestartTimeoutMs;
    while (!this.stopped && Date.now() < updateDeadline) {
      await delay(Math.min(500, Math.max(1, updateDeadline - Date.now())));
      try {
        const current = await this.get<WindowsAgentHealth>(WINDOWS_AGENT_PATHS.health, 1500);
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
    if (!this.stopped) {
      throw new Error(
        `Windows agent update on ${this.machine.id} did not become current within `
        + `${Math.ceil(this.updateRestartTimeoutMs / 1000)} seconds`,
      );
    }
    return false;
  }

  private baseAgentPort(): number {
    return this.configuredBaseAgentPort ?? windowsAgentPort(this.machine);
  }

  private currentAgentPort(): number {
    return this.agentUrl ? agentPortFromUrl(this.agentUrl) : windowsAgentPort(this.machine);
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
        `${this.urlForAgentPort(port)}${WINDOWS_AGENT_PATHS.health}`,
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
    const candidates = await Promise.all(
      Array.from({ length: 8 }, (_, offset) => basePort + offset + 1)
        .map(async (port) => ({ port, health: await this.generationHealth(port) })),
    );
    return candidates.find(({ health }) =>
      health?.ok === true
      && (health.releaseVersion ?? health.version) === expectedRelease
      && (health.protocolVersion ?? 0) >= expectedProtocol
      && health.helperBundleVersion === helperBundle.bundleVersion
    )?.port;
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

  private reportPhase(phase: PaneStartupPhase, label: string): void {
    this.emit("phase", phase, label);
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
        WINDOWS_AGENT_PATHS.output(this.pane.id, this.cursor, 0),
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
          WINDOWS_AGENT_PATHS.output(
            this.pane.id,
            this.cursor,
            WINDOWS_AGENT_LONG_POLL.defaultTimeoutMs,
          ),
          WINDOWS_AGENT_LONG_POLL.requestTimeoutMs,
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
        if (isUnknownAgentSessionError(error)) {
          try {
            await this.recreateMissingSession();
            continue;
          } catch (recoveryError) {
            if (this.stopped) return;
            this.reportTransportFailure("session recovery", recoveryError);
            await delay(1000);
            continue;
          }
        }
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
    // A long poll can describe geometry captured before a newer browser
    // resize. Preserve its byte-boundary replay above, then converge the
    // attach checkpoint on the latest requested viewport.
    if (!sameSize(this.checkpoint.dimensions, this.desiredCols, this.desiredRows)) {
      this.checkpoint.reframe(this.desiredCols, this.desiredRows);
    }
  }

  private async get<T>(path: string, timeoutMs = 5000): Promise<T> {
    const url = this.agentUrl;
    if (!url) throw new Error(`machine ${this.machine.id} is missing Windows agent URL`);
    return requestJson<T>("GET", `${url}${path}`, undefined, timeoutMs, authHeaders(this.machine));
  }

  private async post<T = unknown>(path: string, body: unknown, timeoutMs = 5000): Promise<T> {
    const url = this.agentUrl;
    if (!url) throw new Error(`machine ${this.machine.id} is missing Windows agent URL`);
    return requestJson<T>("POST", `${url}${path}`, body, timeoutMs, authHeaders(this.machine));
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
    if (emit) {
      this.emit(
        "output",
        this.restoredCheckpoint && !this.liveResetEmitted
          ? `\x1bc${data}`
          : data,
      );
      this.liveResetEmitted = true;
      this.liveOutputObserved = true;
    }
    this.noteResizeRepaintOutput();
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

interface WindowsAgentUpdateSshInvocation {
  args: string[];
  acknowledgementAction: "activate-update" | "rollout-update";
}

export const buildWindowsAgentUpdateSshInvocation = (
  machine: MachineConfig,
  port?: number,
): WindowsAgentUpdateSshInvocation => {
  if (!machine.host) throw new Error(`machine ${machine.id} is missing an SSH host`);
  const target = machine.user ? `${machine.user}@${machine.host}` : machine.host;
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"];
  if (machine.port) args.push("-p", String(machine.port));
  const acknowledgementAction = port ? "rollout-update" : "activate-update";
  const script = `
$Service = Join-Path $env:LOCALAPPDATA 'wmux\\bin\\wmux-windows-agent-service.ps1'
if (-not (Test-Path -LiteralPath $Service -PathType Leaf)) {
  Write-Error "wmux Windows agent service helper is not staged at $Service"
  exit 127
}
& pwsh -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Service ${port ? `rollout-update --port ${port}` : acknowledgementAction}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
[pscustomobject]@{
  wmuxUpdateActivation = $true
  action = '${acknowledgementAction}'
  port = ${port ?? "$null"}
} | ConvertTo-Json -Compress
exit 0
`;
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
  args.push(
    target,
    machine.shell || "pwsh",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    encodedCommand,
  );
  return { args, acknowledgementAction };
};

export const parseWindowsAgentUpdateAcknowledgement = (
  stdout: string,
  expectedAction: "activate-update" | "rollout-update",
  expectedPort?: number,
): number | void => {
  const lines = stdout.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const payload = JSON.parse(line) as {
        wmuxUpdateActivation?: boolean;
        action?: string;
        port?: number | null;
      };
      if (payload.wmuxUpdateActivation !== true) continue;
      if (payload.action !== expectedAction) {
        throw new Error(`expected ${expectedAction}, received ${payload.action ?? "none"}`);
      }
      if (expectedPort !== undefined && payload.port !== expectedPort) {
        throw new Error(`expected port ${expectedPort}, received ${payload.port ?? "none"}`);
      }
      return expectedPort;
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  throw new Error(`missing ${expectedAction} acknowledgement`);
};

export const activateWindowsAgentUpdate: WindowsAgentUpdateActivator = async (machine, port) => {
  const invocation = buildWindowsAgentUpdateSshInvocation(machine, port);
  return new Promise<number | void>((resolve, reject) => {
    const child = spawn("ssh", invocation.args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else {
        try {
          resolve(parseWindowsAgentUpdateAcknowledgement(stdout, invocation.acknowledgementAction, port));
        } catch (parseError) {
          reject(new Error(`invalid Windows agent update response: ${formatError(parseError)}`));
        }
      }
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`timed out activating the Windows agent update on ${machine.id}`));
    }, UPDATE_ACTIVATION_TIMEOUT_MS);
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
  });
};

class AgentHttpError extends Error {
  readonly agentCode?: string;

  constructor(readonly statusCode: number, rawBody: string) {
    super(`HTTP ${statusCode}${rawBody ? `: ${rawBody.slice(0, 200)}` : ""}`);
    this.name = "AgentHttpError";
    try {
      const payload = JSON.parse(rawBody) as { error?: unknown };
      if (typeof payload.error === "string") this.agentCode = payload.error;
    } catch {
      // Preserve the HTTP failure even when the agent returned non-JSON text.
    }
  }
}

const isUnknownAgentSessionError = (error: unknown): boolean =>
  error instanceof AgentHttpError
  && error.statusCode === 404
  && error.agentCode === "unknown_session";

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
            reject(new AgentHttpError(response.statusCode ?? 0, raw));
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
