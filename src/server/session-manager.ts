import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { WebSocket } from "ws";
import { OscColorQueryParser } from "../shared/terminal-color-queries.js";
import {
  isTerminalColorResponse,
  isTerminalProtocolResponse,
} from "../shared/terminal-protocol.js";
import type { BrowserAuthMode } from "./auth.js";
import { AgentSessionService } from "./agent-sessions.js";
import type { MachineConfig, MachineSource, PaneClientMessage, PaneServerMessage, PaneState } from "./types.js";
import type { StateStore } from "./state.js";
import type {
  AgentInputRegistrationCapability,
  AgentInputSessionBinding,
} from "./agent-input-credential-store.js";
import {
  createSessionBackend,
  type BackendRuntimeFile,
  type BackendSession,
  type SessionBackend,
} from "./backends/index.js";
import { streamPathForMachine } from "./streams.js";
import { resolveHelperUrl } from "./helper-url.js";
import type { AttachReplay } from "./terminal-checkpoint.js";
import { TerminalCheckpointStore } from "./terminal-checkpoint-store.js";
import {
  PasteImageStageError,
  PasteImageStaging,
  type PasteImageStager,
  type StagedPasteImage,
} from "./paste-image-staging.js";
import { DurableEndpointStore } from "./durable-endpoint-store.js";
import { cleanupStrandedDurableEndpoints } from "./durable-endpoint-cleanup.js";
import { WORKSPACE_CLOSE_GRACE_MS } from "../shared/workspace-close.js";
import {
  KittyGraphicsSourceError,
  readKittyGraphicsSource,
  type KittyGraphicsSourceRequest,
} from "./kitty-graphics-source.js";
import { terminalThemeFromEnvironment } from "./terminal-theme.js";
import { windowsAgentPort } from "./windows-agent.js";
import {
  sessionAgentOriginAtPort,
  sessionAgentOriginForEndpoint,
} from "./session-agent-origin.js";

export type ClientMessage = PaneClientMessage;

interface SocketState {
  paneId: string;
  cols: number;
  rows: number;
  foreground: boolean;
  inputSequence?: number;
}

// A session that exits cleanly (code 0) after running at least this long is
// treated as a deliberate shell exit, which collapses the pane/tab/workspace.
// Anything faster or with a non-zero code is treated as a spawn/connection
// failure (e.g. an unreachable SSH host) and the pane is preserved as "exited"
// so a transient failure never destroys persisted workspace state.
const MIN_DELIBERATE_EXIT_UPTIME_MS = 3000;

// A new durable session is created behind the PTY client. The first tmux cwd
// query can therefore win the startup race and find no session yet, especially
// while an SSH runtime is still being staged. Retry briefly so pane state is
// populated even when tmux consumed the shell's initial OSC 7 before attach.
const DURABLE_CWD_REFRESH_RETRY_DELAYS_MS = [100, 500, 1500, 3000] as const;
const DURABLE_CWD_OUTPUT_DELAY_MS = 250;
const DURABLE_CWD_OUTPUT_THROTTLE_MS = 3000;

/**
 * A deliberate shell exit (which collapses the pane/tab/workspace) is a clean
 * exit code after the session ran long enough to be a real session. Everything
 * else — non-zero codes, near-instant deaths — is a spawn/connection failure
 * and must preserve the pane.
 */
export const isDeliberateExit = (code: number | null, uptimeMs: number): boolean =>
  code === 0 && uptimeMs >= MIN_DELIBERATE_EXIT_UPTIME_MS;

// Codex may not emit its Stop hook when a user aborts a turn. Recognize only
// bare interrupt keystrokes here so arrow keys and other escape sequences do
// not clear an agent that is still working.
export const isAgentInterruptInput = (data: string): boolean => data === "\x03" || /^\x1b{1,2}$/.test(data);

export const sessionAccessTokenForMachine = (
  machine: MachineConfig,
  accessToken: string,
): string => (machine.source === "registered" ? "" : accessToken);

export const paneAuthEnvironmentForMachine = (
  machine: MachineConfig,
  accessToken: string,
  helperToken: string,
  browserAuthMode: BrowserAuthMode,
): Record<string, string> => {
  const scopedToken = sessionAccessTokenForMachine(machine, helperToken);
  return {
    ...(scopedToken ? { WMUX_HELPER_TOKEN: scopedToken } : {}),
    WMUX_TOKEN: helperToken || browserAuthMode === "login-only"
      ? ""
      : sessionAccessTokenForMachine(machine, accessToken),
    WMUX_BROWSER_AUTH_MODE: browserAuthMode,
  };
};

export const resolveDisposalMachine = (
  sessionMachine: MachineConfig | undefined,
  currentMachines: MachineConfig[],
  machineId: string | undefined,
): MachineConfig | undefined => sessionMachine ?? currentMachines.find((machine) => machine.id === machineId);

export const resolvePersistedPaneMachine = (
  pane: PaneState,
  configuredMachine: MachineConfig,
  recoveredEndpoint?: MachineConfig,
): MachineConfig => {
  if (configuredMachine.sessionBackend !== "agent") return configuredMachine;
  const recoveredOrigin = recoveredEndpoint
    ? sessionAgentOriginForEndpoint(recoveredEndpoint)
    : undefined;
  if (recoveredEndpoint && !recoveredOrigin) {
    throw new Error(`pane ${pane.id} has an invalid durable session-agent origin`);
  }
  if (recoveredEndpoint && recoveredEndpoint.id !== configuredMachine.id) {
    throw new Error(`pane ${pane.id} has a durable endpoint for the wrong machine`);
  }
  if (
    recoveredEndpoint
    && pane.agentPort !== undefined
    && Number(new URL(recoveredOrigin!).port) !== pane.agentPort
  ) {
    throw new Error(`pane ${pane.id} has inconsistent durable session-agent endpoint fields`);
  }
  if (recoveredOrigin) {
    const recoveredPort = Number(new URL(recoveredOrigin).port);
    const configuredOrigin = sessionAgentOriginForEndpoint(configuredMachine);
    const endpointChanged = configuredOrigin !== recoveredOrigin;
    return {
      ...configuredMachine,
      host: endpointChanged ? recoveredEndpoint?.host : configuredMachine.host,
      user: endpointChanged ? recoveredEndpoint?.user : configuredMachine.user,
      port: endpointChanged ? recoveredEndpoint?.port : configuredMachine.port,
      agentUrl: recoveredOrigin,
      agentPort: recoveredPort,
      agentToken: endpointChanged
        ? recoveredEndpoint?.agentToken
        : configuredMachine.agentToken ?? recoveredEndpoint?.agentToken,
    };
  }
  const configuredOrigin = sessionAgentOriginForEndpoint(configuredMachine);
  const pinnedOrigin = configuredOrigin && pane.agentPort !== undefined
    ? sessionAgentOriginAtPort(configuredOrigin, pane.agentPort)
    : configuredOrigin;
  if (!pinnedOrigin) throw new Error(`pane ${pane.id} is missing its session-agent origin`);
  return {
    ...configuredMachine,
    agentUrl: pinnedOrigin,
    agentPort: Number(new URL(pinnedOrigin).port),
  };
};

const sameMachineEndpoint = (left: MachineConfig, right: MachineConfig): boolean =>
  JSON.stringify({
    kind: left.kind,
    host: left.host,
    user: left.user,
    port: left.port,
    sessionBackend: left.sessionBackend,
    agentUrl: left.agentUrl,
    agentPort: left.agentPort,
  }) ===
  JSON.stringify({
    kind: right.kind,
    host: right.host,
    user: right.user,
    port: right.port,
    sessionBackend: right.sessionBackend,
    agentUrl: right.agentUrl,
    agentPort: right.agentPort,
  });

// Pause the PTY when a consumer socket's outbound buffer exceeds the high-water
// mark; resume once every consumer drains below the low-water mark.
const BACKPRESSURE_HIGH_WATER = 4 * 1024 * 1024;
const BACKPRESSURE_LOW_WATER = 1 * 1024 * 1024;
const AGENT_WORKSPACE_CLEANUP_SWEEP_MS = 5_000;
const STRANDED_ENDPOINT_CLEANUP_SWEEP_MS = 60_000;

export class SessionManager {
  private sessions = new Map<string, BackendSession>();
  private backends = new Map<string, SessionBackend>();
  private sockets = new Map<string, Set<WebSocket>>();
  private outputWatchers = new Map<string, Set<WebSocket>>();
  private resizeOwners = new Map<string, WebSocket>();
  private paneSizes = new Map<string, { cols: number; rows: number }>();
  private socketState = new Map<WebSocket, SocketState>();
  private ignoredSessionExits = new WeakSet<BackendSession>();
  private sessionMachines = new Map<string, MachineConfig>();
  private agentInputSessionBindings = new Map<string, AgentInputSessionBinding>();
  private paneInputEpochs = new Map<string, number>();
  private pausedSessions = new Map<string, ReturnType<typeof setInterval>>();
  private durableRefreshTimers = new Set<ReturnType<typeof setTimeout>>();
  private durableCwdRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private durableCwdRefreshInFlight = new Set<string>();
  private durableCwdLastReadAt = new Map<string, number>();
  private pendingWorkspaceCloses = new Map<string, {
    closeAt: string;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly agentWorkspaceCleanupTimer: ReturnType<typeof setInterval>;
  private readonly strandedEndpointCleanupTimer: ReturnType<typeof setInterval>;
  private strandedEndpointCleanupRunning = false;
  private readonly currentMachines: () => MachineConfig[];
  private readonly terminalCheckpoints: TerminalCheckpointStore;
  private readonly durableEndpoints: DurableEndpointStore;
  private agentInputCapabilityIssuer?: (
    paneId: string,
    binding: AgentInputSessionBinding,
  ) => AgentInputRegistrationCapability;
  private agentInputSourceRetirer?: (paneId: string, binding: AgentInputSessionBinding) => void;

  constructor(
    private readonly state: StateStore,
    machines: MachineSource,
    private readonly accessToken = "",
    private readonly bootstrapTokenForMachine: (machineId: string) => string | undefined = () => undefined,
    private readonly onPaneReferencesChanged: () => void = () => undefined,
    private readonly pasteImages: PasteImageStager = new PasteImageStaging(),
    private readonly terminalEnvironment: () => Record<string, string> = () => ({}),
    private readonly helperToken: string | (() => string) = "",
    private readonly browserAuthMode: BrowserAuthMode = "shared-or-login",
    readonly agentSessions = new AgentSessionService(state),
    terminalCheckpoints?: TerminalCheckpointStore,
    durableEndpoints?: DurableEndpointStore,
  ) {
    this.currentMachines = typeof machines === "function" ? machines : () => machines;
    this.terminalCheckpoints = terminalCheckpoints
      ?? new TerminalCheckpointStore(
        process.env.WMUX_TERMINAL_CHECKPOINT_DIR
          ?? path.join(state.storageDirectory(), "pane-checkpoints"),
      );
    this.terminalCheckpoints.prune(new Set(
      state.snapshot().workspaces.flatMap((workspace) =>
        workspace.tabs.flatMap((tab) => tab.panes.map((pane) => pane.id))),
    ));
    this.durableEndpoints = durableEndpoints
      ?? new DurableEndpointStore(
        process.env.WMUX_SESSION_ENDPOINT_PATH
          ?? path.join(state.storageDirectory(), "session-endpoints.json"),
      );
    const persistedPanes = state.snapshot().workspaces.flatMap((workspace) =>
      workspace.tabs.flatMap((tab) => tab.panes));
    const configuredMachines = this.currentMachines();
    const configuredById = new Map(configuredMachines.map((machine) => [machine.id, machine]));
    const persistedPaneMachines = new Map<string, MachineConfig>();
    for (const pane of persistedPanes) {
      const configured = configuredById.get(pane.machineId);
      if (!configured) continue;
      persistedPaneMachines.set(
        pane.id,
        resolvePersistedPaneMachine(
          pane,
          configured,
          this.durableEndpoints.activeForPane(pane.id)?.machine,
        ),
      );
    }
    this.durableEndpoints.reconcile(
      new Set(persistedPanes.map((pane) => pane.id)),
      configuredMachines,
      persistedPaneMachines,
    );
    this.sweepExpiredAgentWorkspaces();
    this.agentWorkspaceCleanupTimer = setInterval(
      () => this.sweepExpiredAgentWorkspaces(),
      AGENT_WORKSPACE_CLEANUP_SWEEP_MS,
    );
    this.agentWorkspaceCleanupTimer.unref?.();
    this.sweepStrandedEndpoints();
    this.strandedEndpointCleanupTimer = setInterval(
      () => this.sweepStrandedEndpoints(),
      STRANDED_ENDPOINT_CLEANUP_SWEEP_MS,
    );
    this.strandedEndpointCleanupTimer.unref?.();
  }

  hasLiveSessionsForMachine(machineId: string): boolean {
    return [...this.sessions.values()].some((session) => session.pane.machineId === machineId && !session.isExited);
  }

  setAgentInputCapabilityIssuer(
    issuer: ((paneId: string, binding: AgentInputSessionBinding) => AgentInputRegistrationCapability) | undefined,
  ): void {
    this.agentInputCapabilityIssuer = issuer;
  }

  setAgentInputSourceRetirer(
    retirer: ((paneId: string, binding: AgentInputSessionBinding) => void) | undefined,
  ): void {
    this.agentInputSourceRetirer = retirer;
  }

  hasLivePaneSession(paneId: string, expectedBinding?: AgentInputSessionBinding): boolean {
    const pane = this.state.findPane(paneId);
    const session = this.sessions.get(paneId);
    const binding = this.agentInputSessionBindings.get(paneId);
    return Boolean(pane?.status === "running" && session && !session.isExited
      && this.sessionMachines.has(paneId) && binding
      && (!expectedBinding || sameAgentInputSessionBinding(binding, expectedBinding)));
  }

  agentInputSessionBinding(paneId: string): AgentInputSessionBinding | undefined {
    const binding = this.agentInputSessionBindings.get(paneId);
    return binding ? structuredClone(binding) : undefined;
  }

  async readKittyGraphicsSource(paneId: string, request: KittyGraphicsSourceRequest): Promise<Buffer> {
    const pane = this.state.findPane(paneId);
    const session = this.sessions.get(paneId);
    const machine = this.sessionMachines.get(paneId);
    if (!pane) throw new KittyGraphicsSourceError(404, "pane_not_found");
    if (!session || session.isExited || !machine) {
      throw new KittyGraphicsSourceError(409, "kitty_source_pane_not_live");
    }
    const data = await readKittyGraphicsSource(machine, paneId, request);
    if (
      this.state.findPane(paneId) !== pane
      || this.sessions.get(paneId) !== session
      || session.isExited
      || this.sessionMachines.get(paneId) !== machine
    ) {
      throw new KittyGraphicsSourceError(409, "kitty_source_pane_not_live");
    }
    return data;
  }

  async stagePasteImage(paneId: string, data: Buffer): Promise<StagedPasteImage> {
    const pane = this.state.findPane(paneId);
    const session = this.sessions.get(paneId);
    const inputEpoch = this.paneInputEpochs.get(paneId) ?? 0;
    if (!pane) throw new PasteImageStageError(404, "pane_not_found");
    if (!session || session.isExited || !this.sessionMachines.has(paneId)) {
      throw new PasteImageStageError(409, "paste_image_pane_not_live");
    }
    const liveBackend = this.backends.get(paneId);
    const attachReady = liveBackend?.attach(session) ?? session.attachReady;
    if (attachReady) await attachReady;
    const machine = this.sessionMachines.get(paneId);
    if (this.state.findPane(paneId) !== pane || this.sessions.get(paneId) !== session || session.isExited || !machine) {
      throw new PasteImageStageError(409, "paste_image_pane_not_live");
    }
    const backend = this.backends.get(paneId) ?? createSessionBackend(machine, this.pasteImages);
    const staged = await backend.stageFile(paneId, data, { inputEpoch });
    if (
      this.state.findPane(paneId) !== pane
      || this.sessions.get(paneId) !== session
      || session.isExited
      || this.sessionMachines.get(paneId) !== machine
      || (this.paneInputEpochs.get(paneId) ?? 0) !== inputEpoch
    ) {
      await this.pasteImages.discard(paneId, staged.stageId).catch(() => undefined);
      if ((this.paneInputEpochs.get(paneId) ?? 0) !== inputEpoch) {
        throw new PasteImageStageError(409, "paste_image_input_changed");
      }
      throw new PasteImageStageError(409, "paste_image_pane_not_live");
    }
    return staged;
  }

  discardPasteImage(paneId: string, stageId: string): Promise<boolean> {
    return this.pasteImages.discard(paneId, stageId);
  }

  attach(paneId: string, socket: WebSocket, cols: number, rows: number): void {
    const pane = this.state.findPane(paneId);
    if (!pane) {
      socket.close(1008, "pane not found");
      return;
    }
    const initialSize = normalizeSize(cols, rows);
    this.recycleIdleDurableClient(pane);
    if (!this.sockets.has(paneId)) this.sockets.set(paneId, new Set());
    const paneSockets = this.sockets.get(paneId);
    paneSockets?.add(socket);
    this.socketState.set(socket, { paneId, ...initialSize, foreground: false });
    let session: BackendSession;
    try {
      session = this.ensureSession(pane, initialSize.cols, initialSize.rows);
    } catch (error) {
      this.socketState.delete(socket);
      paneSockets?.delete(socket);
      this.deleteEmptySocketSet(paneId);
      socket.close(1011, error instanceof Error ? error.message : "session start failed");
      return;
    }
    this.send(socket, { type: "starting", paneId, phase: "connecting", label: "Opening terminal…" });
    this.ensureResizeOwner(paneId, socket, session, initialSize);

    socket.on("message", (raw) => {
      const message = this.parse(raw.toString());
      if (!message) return;
      if (message.type === "input") {
        const terminalResponse = message.terminalResponse || isTerminalProtocolResponseInput(message.data);
        if (terminalResponse) {
          // The server owns palette query replies. Ignore color replies from
          // older browser clients so they cannot inject a duplicate answer.
          if (isTerminalColorResponse(message.data)) return;
          // Every attached browser renders pane output and can therefore answer
          // terminal queries. Only the authoritative viewer may forward that
          // answer or a multi-viewer pane will inject duplicate replies into
          // the application that issued the query.
          if (this.resizeOwners.get(paneId) !== socket) return;
          this.backends.get(paneId)?.write(session, message.data, true);
          return;
        }
        const socketState = this.socketState.get(socket);
        if (socketState && message.sequence !== undefined) socketState.inputSequence = message.sequence;
        this.promoteResizeOwner(paneId, socket, session);
        if (isAgentInterruptInput(message.data)) {
          this.agentSessions.interruptAgentForPane(paneId);
        }
        this.advancePaneInputEpoch(paneId);
        this.backends.get(paneId)?.write(session, message.data, false);
      }
      if (message.type === "resize") {
        const size = normalizeSize(message.cols, message.rows);
        const foreground = message.foreground !== false;
        this.socketState.set(socket, {
          ...this.socketState.get(socket),
          paneId,
          ...size,
          foreground,
        });
        // A resize report must not transfer ownership merely because browser
        // chrome temporarily moved focus. Explicit pane activation, input,
        // and owner disconnect remain the ownership handoff paths.
        if (this.resizeOwners.get(paneId) === socket) {
          this.applyResizeOwnerSize(paneId, socket, session);
        }
      }
      if (message.type === "activate") {
        const size = normalizeSize(message.cols, message.rows);
        const foreground = message.foreground !== false;
        this.socketState.set(socket, {
          ...this.socketState.get(socket),
          paneId,
          ...size,
          foreground,
        });
        if (foreground) this.activateResizeOwner(paneId, socket, session);
      }
    });

    socket.on("close", () => {
      this.socketState.delete(socket);
      this.sockets.get(paneId)?.delete(socket);
      this.reassignResizeOwner(paneId, socket, session);
    });

    const sendReady = () => {
      if (socket.readyState !== socket.OPEN || !this.socketState.has(socket)) return;
      const attachReplay = this.replayOutputFor(pane, session);
      const size = this.paneSizes.get(paneId) ?? initialSize;
      this.send(socket, {
        type: "ready",
        paneId,
        pid: session.pid,
        title: pane.title,
        status: pane.status,
        ...size,
        resizeOwner: this.resizeOwners.get(paneId) === socket,
        replay: attachReplay.data,
        replayKind: attachReplay.kind,
        ...(this.shouldUseDurableClientRefresh(pane) && attachReplay.kind === "raw" && attachReplay.data === ""
          ? { waitForRefresh: true as const }
          : {}),
      });
      this.scheduleDurableClientRefresh(pane, socket);
    };
    void (this.backends.get(paneId)?.attach(session) ?? Promise.resolve()).then(sendReady);
  }

  watchOutput(paneId: string, socket: WebSocket, cols = 96, rows = 32): void {
    const pane = this.state.findPane(paneId);
    if (!pane) {
      socket.close(1008, "pane not found");
      return;
    }
    const size = normalizeSize(cols, rows);
    let session: BackendSession;
    try {
      session = this.ensureSession(pane, size.cols, size.rows);
    } catch (error) {
      socket.close(1011, error instanceof Error ? error.message : "session start failed");
      return;
    }
    if (!this.outputWatchers.has(paneId)) this.outputWatchers.set(paneId, new Set());
    this.outputWatchers.get(paneId)?.add(socket);

    const sendReady = () => {
      if (socket.readyState !== socket.OPEN || !this.outputWatchers.get(paneId)?.has(socket)) return;
      const replay = this.outputReplayFor(session);
      const authoritativeSize = this.paneSizes.get(paneId) ?? size;
      this.send(socket, {
        type: "ready",
        paneId,
        pid: session.pid,
        title: pane.title,
        status: pane.status,
        ...authoritativeSize,
        resizeOwner: false,
        replay: replay.data,
        replayKind: replay.kind,
        outputOnly: true,
        ...(this.shouldUseDurableClientRefresh(pane) && replay.kind === "raw" && replay.data === ""
          ? { waitForRefresh: true as const }
          : {}),
      });
      this.scheduleDurableClientRefresh(pane, socket);
    };
    void (this.backends.get(paneId)?.attach(session) ?? Promise.resolve()).then(sendReady);

    socket.on("close", () => {
      this.outputWatchers.get(paneId)?.delete(socket);
      if ((this.outputWatchers.get(paneId)?.size ?? 0) === 0) this.outputWatchers.delete(paneId);
    });
  }

  closePane(paneId: string): boolean {
    const context = this.state.findPaneContext(paneId);
    if (!context) return false;
    if (context.tab.panes.length <= 1) {
      return context.workspace.tabs.length <= 1
        ? this.closeWorkspace(context.workspace.id)
        : this.closeTab(context.workspace.id, context.tab.id);
    }
    const machineId = context.pane.machineId;
    const removed = this.state.removePane(paneId);
    if (removed) {
      this.disposePaneProcess(paneId, machineId);
      this.onPaneReferencesChanged();
    }
    return removed;
  }

  closeTab(workspaceId: string, tabId: string): boolean {
    const workspace = this.state.snapshot().workspaces.find((candidate) => candidate.id === workspaceId);
    const tab = workspace?.tabs.find((candidate) => candidate.id === tabId);
    if (!workspace || !tab) return false;
    if (workspace.tabs.length <= 1) return this.closeWorkspace(workspaceId);
    const machineIds = this.machineIdsForTab(workspaceId, tabId);
    const paneIds = this.state.removeTab(workspaceId, tabId);
    for (const paneId of paneIds) this.disposePaneProcess(paneId, machineIds.get(paneId));
    if (paneIds.length > 0) this.onPaneReferencesChanged();
    return paneIds.length > 0;
  }

  closeWorkspace(workspaceId: string): boolean {
    this.cancelWorkspaceClose(workspaceId);
    const machineIds = this.machineIdsForWorkspace(workspaceId);
    const paneIds = this.state.removeWorkspace(workspaceId);
    for (const paneId of paneIds) this.disposePaneProcess(paneId, machineIds.get(paneId));
    if (paneIds.length > 0) this.onPaneReferencesChanged();
    return paneIds.length > 0;
  }

  scheduleWorkspaceClose(
    workspaceId: string,
    delayMs = WORKSPACE_CLOSE_GRACE_MS,
  ): string | undefined {
    const workspaceExists = this.state.snapshot().workspaces.some(
      (workspace) => workspace.id === workspaceId,
    );
    if (!workspaceExists) return undefined;
    const existing = this.pendingWorkspaceCloses.get(workspaceId);
    if (existing) return existing.closeAt;
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError("workspace close delay must be a non-negative finite number");
    }

    const closeAt = new Date(Date.now() + delayMs).toISOString();
    const timer = setTimeout(() => {
      this.pendingWorkspaceCloses.delete(workspaceId);
      this.closeWorkspace(workspaceId);
    }, delayMs);
    timer.unref?.();
    this.pendingWorkspaceCloses.set(workspaceId, { closeAt, timer });
    return closeAt;
  }

  cancelWorkspaceClose(workspaceId: string): boolean {
    const pending = this.pendingWorkspaceCloses.get(workspaceId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingWorkspaceCloses.delete(workspaceId);
    return true;
  }

  sweepExpiredAgentWorkspaces(nowMs = Date.now()): string[] {
    const closed: string[] = [];
    for (const workspaceId of this.state.expiredAgentWorkspaceIds(nowMs)) {
      if (this.closeWorkspace(workspaceId)) closed.push(workspaceId);
    }
    return closed;
  }

  private sweepStrandedEndpoints(): void {
    if (this.strandedEndpointCleanupRunning) return;
    this.strandedEndpointCleanupRunning = true;
    void cleanupStrandedDurableEndpoints(this.durableEndpoints)
      .finally(() => {
        this.strandedEndpointCleanupRunning = false;
      });
  }

  writePane(paneId: string, data: string, cols = 96, rows = 32): boolean {
    const pane = this.state.findPane(paneId);
    if (!pane) return false;
    const size = normalizeSize(cols, rows);
    const session = this.ensureSession(pane, size.cols, size.rows);
    this.advancePaneInputEpoch(paneId);
    this.backends.get(paneId)?.write(session, data);
    return true;
  }

  private ensureSession(pane: PaneState, cols: number, rows: number): BackendSession {
    const existing = this.sessions.get(pane.id);
    if (existing && !existing.isExited) return existing;
    const previousSessionMachine = this.sessionMachines.get(pane.id)
      ?? this.durableEndpoints.activeForPane(pane.id)?.machine;
    const configuredMachine = this.currentMachines().find((candidate) => candidate.id === pane.machineId);
    if (!configuredMachine) throw new Error(`machine ${pane.machineId} not found`);
    const machine = resolvePersistedPaneMachine(pane, configuredMachine, previousSessionMachine);
    const windowsAgentBasePort = pane.agentPort && configuredMachine.kind === "powershell-ssh"
      ? windowsAgentPort(configuredMachine)
      : undefined;
    if (machine.source === "registered" && machine.online === false) {
      throw new Error(`machine ${pane.machineId} is offline`);
    }
    const backend = createSessionBackend(machine, this.pasteImages, { windowsAgentBasePort });
    const agentInputBinding = createAgentInputSessionBinding(
      pane.id,
      backend,
      machine,
    );
    if (previousSessionMachine && !sameMachineEndpoint(previousSessionMachine, machine)) {
      const previousBackend = this.backends.get(pane.id)
        ?? createSessionBackend(previousSessionMachine, this.pasteImages);
      void previousBackend.dispose(pane.id, undefined, { kill: false });
    }
    const context = this.state.findPaneContext(pane.id);
    let agentInputEnvironment: Record<string, string> = {};
    let runtimeFiles: BackendRuntimeFile[] | undefined;
    if (this.agentInputCapabilityIssuer && (machine.kind === "local" || machine.kind === "ssh")) {
      try {
        const issued = this.agentInputCapabilityIssuer(pane.id, agentInputBinding);
        if (machine.sessionBackend === "agent") {
          runtimeFiles = [{ purpose: "agent-input-capability", data: Buffer.from(`${issued.capability}\n`, "utf8") }];
        } else {
          agentInputEnvironment = machine.kind === "local"
            ? stageLocalAgentInputCapability(pane.id, issued.capability)
            : { WMUX_AGENT_INPUT_REGISTRATION_CAPABILITY: issued.capability };
        }
      } catch {
        // Structured questions fail closed; terminal startup remains available.
      }
    } else if (machine.kind === "local") {
      removeLocalAgentInputCapability(pane.id);
    }
    const processReplacementRuntimeFiles = (): BackendRuntimeFile[] => {
      const previousBinding = this.agentInputSessionBindings.get(pane.id);
      if (previousBinding) this.agentInputSourceRetirer?.(pane.id, previousBinding);
      const replacementBinding = createAgentInputSessionBinding(pane.id, backend, machine);
      this.agentInputSessionBindings.set(pane.id, replacementBinding);
      if (!this.agentInputCapabilityIssuer || (machine.kind !== "local" && machine.kind !== "ssh")) {
        return [];
      }
      try {
        const issued = this.agentInputCapabilityIssuer(pane.id, replacementBinding);
        return [{ purpose: "agent-input-capability", data: Buffer.from(`${issued.capability}\n`, "utf8") }];
      } catch {
        return [];
      }
    };
    const streamHost = process.env.WMUX_STREAM_HOST ?? process.env.WMUX_HOST ?? "127.0.0.1";
    const streamPath = streamPathForMachine(machine.id);
    const sessionEnv = {
      ...this.terminalEnvironment(),
      ...paneAuthEnvironmentForMachine(
        machine,
        this.accessToken,
        typeof this.helperToken === "function"
          ? this.helperToken()
          : this.helperToken,
        this.browserAuthMode,
      ),
      ...agentInputEnvironment,
      WMUX_URL: resolveHelperUrl(`http://${process.env.WMUX_HOST ?? "127.0.0.1"}:${process.env.WMUX_PORT ?? "3478"}`),
      WMUX_WORKSPACE_ID: context?.workspace.id ?? "",
      WMUX_WORKSPACE_NAME: context?.workspace.name ?? "",
      WMUX_TAB_ID: context?.tab.id ?? "",
      WMUX_TAB_TITLE: context?.tab.title ?? "",
      WMUX_PANE_ID: pane.id,
      // A shared registration credential can update dynamic machine records.
      // Never forward the broader browser/API credential to those targets.
      WMUX_BOOTSTRAP_TOKEN:
        machine.source === "registered" && machine.kind === "powershell-ssh" && machine.sessionBackend !== "agent"
          ? (this.bootstrapTokenForMachine(machine.id) ?? "")
          : "",
      WMUX_START_CWD: pane.cwd ?? "",
      WMUX_STREAM_HOST: streamHost,
      WMUX_STREAM_PATH: streamPath,
      WMUX_STREAM_RTSP_URL: `rtsp://${streamHost}:8554/${streamPath}`,
      WMUX_STREAM_WHIP_URL: `${process.env.WMUX_MEDIAMTX_WEBRTC_ORIGIN ?? `http://${streamHost}:8889`}/${streamPath}/whip`,
      KITTY_WINDOW_ID: `wmux-${pane.id}`,
    };
    const restoredCheckpoint = backend.capabilities.persistentCheckpoint
      ? this.terminalCheckpoints.load(pane.id, backend.id)
      : undefined;
    const session = backend.spawn({
      pane,
      cols,
      rows,
      env: sessionEnv,
      ...(runtimeFiles ? { runtimeFiles } : {}),
      processReplacementRuntimeFiles,
      ...(restoredCheckpoint ? { restoredCheckpoint } : {}),
    });
    const startedAt = Date.now();
    this.sessions.set(pane.id, session);
    this.backends.set(pane.id, backend);
    this.sessionMachines.set(pane.id, structuredClone(machine));
    this.agentInputSessionBindings.set(pane.id, agentInputBinding);
    this.durableEndpoints.bind(pane.id, machine, backend.id);
    this.state.updatePane(pane.id, { status: "running", exitCode: undefined, title: pane.title });
    this.cancelPaneCwdRefresh(pane.id);
    this.schedulePaneCwdRefresh(pane, machine, session);
    const colorQueryParser = new OscColorQueryParser();
    const currentTerminalTheme = () => terminalThemeFromEnvironment(this.terminalEnvironment());

    session.on("output", (data) => {
      for (const response of colorQueryParser.push(data, currentTerminalTheme).responses) {
        backend.write(session, response, true);
      }
      this.broadcastOutput(pane.id, data);
      this.applyBackpressure(pane.id, session);
      this.scheduleTerminalCheckpoint(pane.id, session);
      this.schedulePaneCwdRefresh(pane, machine, session, {
        delayMs: DURABLE_CWD_OUTPUT_DELAY_MS,
        throttle: true,
      });
    });
    session.on("title", (title) => {
      this.state.updatePane(pane.id, { title });
      this.broadcast(pane.id, { type: "title", paneId: pane.id, title });
    });
    session.on("cwd", (cwd) => {
      this.state.updatePane(pane.id, { cwd });
    });
    session.on("agentPort", (agentPort, agentUrl) => {
      const pinnedOrigin = sessionAgentOriginAtPort(agentUrl, agentPort);
      if (!pinnedOrigin) {
        console.warn(`wmux: ignored invalid session-agent origin update for ${pane.id}`);
        return;
      }
      machine.agentPort = agentPort;
      machine.agentUrl = pinnedOrigin;
      this.sessionMachines.set(pane.id, structuredClone(machine));
      this.durableEndpoints.updateActive(pane.id, machine);
      this.state.updatePane(pane.id, { agentPort });
    });
    session.on("phase", (phase, label) => {
      this.broadcast(pane.id, { type: "starting", paneId: pane.id, phase, label });
    });
    session.on("exit", (code) => {
      if (this.ignoredSessionExits.has(session)) return;
      this.cancelPaneCwdRefresh(pane.id);
      this.broadcast(pane.id, { type: "exit", paneId: pane.id, code });
      const uptimeMs = Date.now() - startedAt;
      if (!isDeliberateExit(code, uptimeMs)) {
        const backend = this.backends.get(pane.id);
        if (backend?.capabilities.persistentCheckpoint) {
          try {
            this.terminalCheckpoints.save(
              pane.id,
              backend.id,
              backend.checkpoint(session),
            );
          } catch (error) {
            console.warn(
              `wmux: failed to persist final terminal checkpoint for ${pane.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
      this.sessions.delete(pane.id);
      const exitedAgentInputBinding = this.agentInputSessionBindings.get(pane.id);
      this.resizeOwners.delete(pane.id);
      this.paneSizes.delete(pane.id);
      const context = this.state.findPaneContext(pane.id);
      if (!context) return;

      if (!isDeliberateExit(code, uptimeMs)) {
        // Spawn/connection failure or a very fast exit: preserve the pane so a
        // flaky SSH host or transient error never deletes the workspace. The
        // pane is re-spawned when a client next attaches.
        this.state.updatePane(pane.id, { status: "exited", exitCode: code ?? null });
        if (exitedAgentInputBinding) this.agentInputSourceRetirer?.(pane.id, exitedAgentInputBinding);
        this.agentInputSessionBindings.delete(pane.id);
        return;
      }

      const exitedMachine = this.sessionMachines.get(pane.id);
      const exitedBackend = this.backends.get(pane.id);
      if (exitedBackend?.capabilities.agentOwned) {
        void exitedBackend.dispose(pane.id, undefined, { kill: false });
      }
      this.terminalCheckpoints.delete(pane.id);
      this.backends.delete(pane.id);
      this.sessionMachines.delete(pane.id);
      this.agentInputSessionBindings.delete(pane.id);
      this.durableEndpoints.deleteActiveForPane(pane.id);
      this.paneInputEpochs.delete(pane.id);
      if (exitedMachine) void this.pasteImages.cleanupPane(pane.id, exitedMachine);
      if (context.tab.panes.length > 1) {
        this.state.removePane(pane.id);
      } else if (context.workspace.tabs.length > 1) {
        this.state.removeTab(context.workspace.id, context.tab.id);
      } else {
        this.cancelWorkspaceClose(context.workspace.id);
        this.state.closeWorkspaceAfterExit(context.workspace.id);
      }
      this.onPaneReferencesChanged();
    });

    return session;
  }

  private schedulePaneCwdRefresh(
    pane: PaneState,
    machine: MachineConfig,
    session: BackendSession,
    options: {
      delayMs?: number;
      retryIndex?: number;
      throttle?: boolean;
    } = {},
  ): void {
    const backend = this.backends.get(pane.id);
    if (!backend || backend.capabilities.cwd !== "multiplexer") return;
    if (this.durableCwdRefreshTimers.has(pane.id) || this.durableCwdRefreshInFlight.has(pane.id)) return;

    const retryIndex = options.retryIndex ?? 0;
    const throttleDelay = options.throttle
      ? Math.max(
          0,
          (this.durableCwdLastReadAt.get(pane.id) ?? 0)
            + DURABLE_CWD_OUTPUT_THROTTLE_MS
            - Date.now(),
        )
      : 0;
    const delayMs = Math.max(options.delayMs ?? 0, throttleDelay);
    const refresh = async (): Promise<void> => {
      if (this.sessions.get(pane.id) !== session || session.isExited) return;
      this.durableCwdRefreshInFlight.add(pane.id);
      this.durableCwdLastReadAt.set(pane.id, Date.now());
      const cwdBeforeRead = this.state.findPane(pane.id)?.cwd;
      let cwd: string | undefined;
      try {
        cwd = await backend.readCwd(pane.id);
      } catch {
        cwd = undefined;
      } finally {
        this.durableCwdRefreshInFlight.delete(pane.id);
      }
      if (this.sessions.get(pane.id) !== session || session.isExited) return;
      const currentPane = this.state.findPane(pane.id);
      if (!currentPane || currentPane.machineId !== machine.id || currentPane.cwd !== cwdBeforeRead) return;
      if (cwd) {
        if (cwd !== currentPane.cwd) this.state.updatePane(pane.id, { cwd });
        return;
      }

      const delayMs = DURABLE_CWD_REFRESH_RETRY_DELAYS_MS[retryIndex];
      if (delayMs === undefined) return;
      this.schedulePaneCwdRefresh(pane, machine, session, {
        delayMs,
        retryIndex: retryIndex + 1,
      });
    };
    const timer = setTimeout(() => {
      this.durableRefreshTimers.delete(timer);
      this.durableCwdRefreshTimers.delete(pane.id);
      void refresh();
    }, delayMs);
    timer.unref?.();
    this.durableRefreshTimers.add(timer);
    this.durableCwdRefreshTimers.set(pane.id, timer);
  }

  private cancelPaneCwdRefresh(paneId: string): void {
    const timer = this.durableCwdRefreshTimers.get(paneId);
    if (timer) {
      clearTimeout(timer);
      this.durableRefreshTimers.delete(timer);
      this.durableCwdRefreshTimers.delete(paneId);
    }
    this.durableCwdRefreshInFlight.delete(paneId);
    this.durableCwdLastReadAt.delete(paneId);
  }

  private broadcast(paneId: string, payload: PaneServerMessage): void {
    for (const socket of this.sockets.get(paneId) ?? []) {
      this.send(socket, payload);
    }
    for (const socket of this.outputWatchers.get(paneId) ?? []) {
      this.send(socket, payload);
    }
  }

  private broadcastOutput(paneId: string, data: string): void {
    for (const socket of this.sockets.get(paneId) ?? []) {
      const inputSequence = this.socketState.get(socket)?.inputSequence;
      this.send(socket, {
        type: "output",
        paneId,
        data,
        ...(inputSequence === undefined ? {} : { inputSequence }),
      });
    }
    for (const socket of this.outputWatchers.get(paneId) ?? []) {
      this.send(socket, { type: "output", paneId, data });
    }
  }

  // Flow control: a fast PTY (e.g. `yes`) feeding a slow client would grow the
  // outbound socket buffer without bound. Pause the PTY when any consumer's
  // buffer crosses the high-water mark, and resume once every buffer drains.
  private applyBackpressure(paneId: string, session: BackendSession): void {
    if (this.pausedSessions.has(paneId)) return;
    if (this.maxBufferedFor(paneId) <= BACKPRESSURE_HIGH_WATER) return;
    session.pause();
    const timer = setInterval(() => {
      if (this.maxBufferedFor(paneId) > BACKPRESSURE_LOW_WATER && !session.isExited) return;
      clearInterval(timer);
      this.pausedSessions.delete(paneId);
      if (!session.isExited) session.resume();
    }, 50);
    timer.unref?.();
    this.pausedSessions.set(paneId, timer);
  }

  private maxBufferedFor(paneId: string): number {
    let max = 0;
    for (const socket of this.sockets.get(paneId) ?? []) max = Math.max(max, socket.bufferedAmount);
    for (const socket of this.outputWatchers.get(paneId) ?? []) max = Math.max(max, socket.bufferedAmount);
    return max;
  }

  /** Detach every live client and clear timers. Called on process shutdown. */
  disposeAll(): void {
    clearInterval(this.agentWorkspaceCleanupTimer);
    clearInterval(this.strandedEndpointCleanupTimer);
    try {
      this.terminalCheckpoints.flush();
    } catch (error) {
      console.warn(
        `wmux: failed to flush terminal checkpoints during shutdown: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const timer of this.durableRefreshTimers) clearTimeout(timer);
    this.durableRefreshTimers.clear();
    for (const pending of this.pendingWorkspaceCloses.values()) clearTimeout(pending.timer);
    this.pendingWorkspaceCloses.clear();
    this.durableCwdRefreshTimers.clear();
    this.durableCwdRefreshInFlight.clear();
    this.durableCwdLastReadAt.clear();
    for (const timer of this.pausedSessions.values()) clearInterval(timer);
    this.pausedSessions.clear();
    for (const [paneId, session] of this.sessions) {
      const binding = this.agentInputSessionBindings.get(paneId);
      if (binding) this.agentInputSourceRetirer?.(paneId, binding);
      this.ignoredSessionExits.add(session);
      this.backends.get(paneId)?.detach(session);
    }
    this.sessions.clear();
    this.backends.clear();
    this.sessionMachines.clear();
    this.agentInputSessionBindings.clear();
    this.paneInputEpochs.clear();
    this.resizeOwners.clear();
    this.paneSizes.clear();
    this.socketState.clear();
    this.pasteImages.dispose();
  }

  private replayOutputFor(pane: PaneState, session: BackendSession): AttachReplay {
    return this.backends.get(pane.id)?.readReplay(session, false) ?? {
      data: session.replayOutput,
      kind: "raw",
    };
  }

  private outputReplayFor(session: BackendSession): AttachReplay {
    // Output-only clients cannot perform the browser's durable-client refresh,
    // and textual automation must not receive a screen-shaped checkpoint that
    // can destroy line boundaries used for readiness and completion markers.
    return this.backends.get(session.pane.id)?.readReplay(session, true)
      ?? { data: session.replayOutput, kind: "raw" };
  }

  private scheduleDurableClientRefresh(pane: PaneState, socket: WebSocket): void {
    if (!this.shouldUseDurableClientRefresh(pane)) return;
    for (const delayMs of [120, 500]) {
      const timer = setTimeout(() => {
        this.durableRefreshTimers.delete(timer);
        if (socket.readyState !== socket.OPEN) return;
        const machine = this.currentMachines().find((candidate) => candidate.id === pane.machineId);
        if (machine && !(machine.source === "registered" && machine.online === false)) {
          void this.backends.get(pane.id)?.refreshClient(pane.id);
        }
      }, delayMs);
      timer.unref?.();
      this.durableRefreshTimers.add(timer);
    }
  }

  private shouldUseDurableClientRefresh(pane: PaneState): boolean {
    const machine = this.currentMachines().find((candidate) => candidate.id === pane.machineId);
    if (!machine || (machine.source === "registered" && machine.online === false)) return false;
    return this.backends.get(pane.id)?.capabilities.refreshClient
      ?? createSessionBackend(machine, this.pasteImages).capabilities.refreshClient;
  }

  private recycleIdleDurableClient(pane: PaneState): boolean {
    if (!this.shouldUseDurableClientRefresh(pane) || this.hasPaneConnections(pane.id)) return false;
    const existing = this.sessions.get(pane.id);
    if (!existing || existing.isExited) return false;
    this.ignoredSessionExits.add(existing);
    this.cancelPaneCwdRefresh(pane.id);
    this.sessions.delete(pane.id);
    this.resizeOwners.delete(pane.id);
    this.paneSizes.delete(pane.id);
    const backend = this.backends.get(pane.id);
    const binding = this.agentInputSessionBindings.get(pane.id);
    if (binding) this.agentInputSourceRetirer?.(pane.id, binding);
    this.agentInputSessionBindings.delete(pane.id);
    if (backend) {
      backend.detach(existing);
    } else {
      existing.kill();
    }
    this.backends.delete(pane.id);
    return true;
  }

  private hasPaneConnections(paneId: string): boolean {
    return (this.sockets.get(paneId)?.size ?? 0) > 0 || (this.outputWatchers.get(paneId)?.size ?? 0) > 0;
  }

  private ensureResizeOwner(
    paneId: string,
    socket: WebSocket,
    session: BackendSession,
    size: { cols: number; rows: number },
  ): void {
    const owner = this.resizeOwners.get(paneId);
    const paneSockets = this.sockets.get(paneId);
    if (owner && paneSockets?.has(owner) && owner.readyState === owner.OPEN) {
      return;
    }
    this.resizeOwners.set(paneId, socket);
    this.paneSizes.set(paneId, size);
    this.backends.get(paneId)?.resize(session, size.cols, size.rows);
  }

  private promoteResizeOwner(paneId: string, socket: WebSocket, session: BackendSession): void {
    const state = this.socketState.get(socket);
    if (!state) return;
    state.foreground = true;
    this.applyResizeOwnerSize(paneId, socket, session);
  }

  private activateResizeOwner(paneId: string, socket: WebSocket, session: BackendSession): void {
    const state = this.socketState.get(socket);
    if (!state) return;
    // `activate` is sent only for the visible pane in the focused browser.
    // Transfer ownership here so its settled geometry reaches the PTY before
    // the user's first input. A connected background viewer must not pin the
    // pane to its stale grid until input promotion happens.
    this.applyResizeOwnerSize(paneId, socket, session);
  }

  private reassignResizeOwner(paneId: string, closedSocket: WebSocket, session: BackendSession): void {
    if (this.resizeOwners.get(paneId) !== closedSocket) {
      this.deleteEmptySocketSet(paneId);
      return;
    }

    const candidates = [...(this.sockets.get(paneId) ?? [])].filter(
      (candidate) => candidate.readyState === candidate.OPEN,
    );
    const foregroundSocket = candidates.find((candidate) => this.socketState.get(candidate)?.foreground);
    const nextSocket = foregroundSocket ?? candidates[0];
    if (!nextSocket) {
      this.resizeOwners.delete(paneId);
      this.deleteEmptySocketSet(paneId);
      return;
    }

    if (foregroundSocket) {
      this.applyResizeOwnerSize(paneId, foregroundSocket, session);
      return;
    }
    this.resizeOwners.set(paneId, nextSocket);
    this.broadcastPaneSize(paneId);
  }

  private applyResizeOwnerSize(paneId: string, socket: WebSocket, session: BackendSession): void {
    const state = this.socketState.get(socket);
    if (!state) return;
    const previousOwner = this.resizeOwners.get(paneId);
    const previousSize = this.paneSizes.get(paneId);
    const sizeChanged = !previousSize || previousSize.cols !== state.cols || previousSize.rows !== state.rows;
    this.resizeOwners.set(paneId, socket);
    this.paneSizes.set(paneId, { cols: state.cols, rows: state.rows });
    if (sizeChanged && !session.isExited) {
      this.backends.get(paneId)?.resize(session, state.cols, state.rows);
    }
    if (previousOwner !== socket || sizeChanged) this.broadcastPaneSize(paneId);
  }

  private broadcastPaneSize(paneId: string): void {
    const size = this.paneSizes.get(paneId);
    if (!size) return;
    const owner = this.resizeOwners.get(paneId);
    for (const socket of this.sockets.get(paneId) ?? []) {
      this.send(socket, {
        type: "size",
        paneId,
        ...size,
        resizeOwner: owner === socket,
      });
    }
  }

  private deleteEmptySocketSet(paneId: string): void {
    if ((this.sockets.get(paneId)?.size ?? 0) === 0) this.sockets.delete(paneId);
  }

  private disposePaneProcess(paneId: string, machineId?: string): void {
    const session = this.sessions.get(paneId);
    const backend = this.backends.get(paneId);
    const sessionMachine = this.sessionMachines.get(paneId);
    const endpointRecords = this.durableEndpoints.recordsForPane(paneId);
    this.durableEndpoints.markPaneStranded(paneId);
    this.cancelPaneCwdRefresh(paneId);
    this.sessions.delete(paneId);
    this.backends.delete(paneId);
    this.sessionMachines.delete(paneId);
    this.agentInputSessionBindings.delete(paneId);
    this.paneInputEpochs.delete(paneId);
    this.resizeOwners.delete(paneId);
    this.paneSizes.delete(paneId);
    this.terminalCheckpoints.delete(paneId);
    const fallbackMachineId = machineId ?? session?.pane.machineId ?? this.state.findPane(paneId)?.machineId;
    const machine = resolveDisposalMachine(sessionMachine, this.currentMachines(), fallbackMachineId);
    void this.cleanupPaneEndpoints(
      paneId,
      endpointRecords,
      backend,
      session,
      machine,
    );
    if (machine) {
      void this.pasteImages.cleanupPane(paneId, machine);
    }
    this.broadcast(paneId, { type: "removed", paneId });
    for (const socket of this.sockets.get(paneId) ?? []) {
      this.socketState.delete(socket);
      socket.close(1000, "pane closed");
    }
    for (const socket of this.outputWatchers.get(paneId) ?? []) {
      socket.close(1000, "pane closed");
    }
    this.sockets.delete(paneId);
    this.outputWatchers.delete(paneId);
  }

  private async cleanupPaneEndpoints(
    paneId: string,
    endpointRecords: ReturnType<DurableEndpointStore["recordsForPane"]>,
    backend: SessionBackend | undefined,
    session: BackendSession | undefined,
    fallbackMachine: MachineConfig | undefined,
  ): Promise<void> {
    let liveRecordId: string | undefined;
    if (backend) {
      const active = endpointRecords.find((record) =>
        record.status === "active"
        && record.backend === backend.id
        && sameMachineEndpoint(record.machine, backend.machine));
      liveRecordId = active?.id;
      try {
        const cleaned = await backend.dispose(paneId, session, { kill: true });
        if (cleaned && liveRecordId) this.durableEndpoints.delete(liveRecordId);
      } catch {
        // The retained endpoint record keeps failed cleanup visible to audit.
      }
    } else if (fallbackMachine && endpointRecords.length === 0) {
      try {
        await createSessionBackend(fallbackMachine, this.pasteImages)
          .dispose(paneId, undefined, { kill: true });
      } catch {
        // Static machine cleanup remains best effort.
      }
    }

    for (const record of endpointRecords) {
      if (record.id === liveRecordId) continue;
      try {
        const cleaned = await createSessionBackend(record.machine, this.pasteImages)
          .dispose(paneId, undefined, { kill: true });
        if (cleaned) this.durableEndpoints.delete(record.id);
      } catch {
        // The retained endpoint record keeps failed cleanup visible to audit.
      }
    }
  }

  private scheduleTerminalCheckpoint(
    paneId: string,
    session: BackendSession,
  ): void {
    const backend = this.backends.get(paneId);
    if (!backend?.capabilities.persistentCheckpoint) return;
    this.terminalCheckpoints.schedule(
      paneId,
      backend.id,
      () =>
        this.sessions.get(paneId) === session && !session.isExited
          ? backend.checkpoint(session)
          : undefined,
    );
  }

  private machineIdsForTab(workspaceId: string, tabId: string): Map<string, string> {
    const workspace = this.state.snapshot().workspaces.find((candidate) => candidate.id === workspaceId);
    const tab = workspace?.tabs.find((candidate) => candidate.id === tabId);
    return new Map(tab?.panes.map((pane) => [pane.id, pane.machineId]) ?? []);
  }

  private machineIdsForWorkspace(workspaceId: string): Map<string, string> {
    const workspace = this.state.snapshot().workspaces.find((candidate) => candidate.id === workspaceId);
    return new Map(
      workspace?.tabs.flatMap((tab) => tab.panes.map((pane) => [pane.id, pane.machineId] as const)) ?? [],
    );
  }

  private send(socket: WebSocket, payload: PaneServerMessage): void {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(payload));
  }

  private advancePaneInputEpoch(paneId: string): void {
    this.paneInputEpochs.set(paneId, (this.paneInputEpochs.get(paneId) ?? 0) + 1);
  }

  private parse(raw: string): ClientMessage | null {
    return parseClientMessage(raw);
  }
}

export const parseClientMessage = (raw: string): ClientMessage | null => {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.type === "input" && typeof parsed.data === "string") {
      const sequence = parsed.sequence;
      if (sequence !== undefined && (!Number.isSafeInteger(sequence) || Number(sequence) < 1)) return null;
      return {
        type: "input",
        data: parsed.data,
        ...(parsed.terminalResponse === true ? { terminalResponse: true } : {}),
        ...(sequence === undefined ? {} : { sequence: Number(sequence) }),
      };
    }
    if (
      (parsed.type === "resize" || parsed.type === "activate") &&
      Number.isFinite(parsed.cols) &&
      Number.isFinite(parsed.rows)
    ) {
      return {
        type: parsed.type,
        cols: Number(parsed.cols),
        rows: Number(parsed.rows),
        ...(typeof parsed.foreground === "boolean" ? { foreground: parsed.foreground } : {}),
      };
    }
  } catch {
    return null;
  }
  return null;
};

const stageLocalAgentInputCapability = (
  paneId: string,
  capability: string,
): Record<string, string> => {
  const directory = path.join(os.homedir(), ".wmux", "agent-input");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
    || fs.realpathSync(directory) !== path.resolve(directory)
    || (typeof process.getuid === "function" && directoryStat.uid !== process.getuid())
    || (directoryStat.mode & 0o077) !== 0) {
    throw new Error("agent input staging directory is unsafe");
  }
  const capabilityPath = path.join(directory, `${paneId}.cap`);
  const credentialPath = path.join(directory, `${paneId}.json`);
  const temporary = `${capabilityPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    if (fs.existsSync(capabilityPath)) {
      const existing = fs.lstatSync(capabilityPath);
      if (!existing.isFile() || existing.isSymbolicLink()
        || (typeof process.getuid === "function" && existing.uid !== process.getuid())) {
        throw new Error("agent input capability path is unsafe");
      }
    }
    fs.writeFileSync(temporary, `${capability}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, capabilityPath);
    fs.chmodSync(capabilityPath, 0o600);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return {
    WMUX_AGENT_INPUT_CAPABILITY_PATH: capabilityPath,
    WMUX_AGENT_INPUT_CREDENTIAL_PATH: credentialPath,
  };
};

const removeLocalAgentInputCapability = (paneId: string): void => {
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(paneId)) return;
  const candidate = path.join(os.homedir(), ".wmux", "agent-input", `${paneId}.cap`);
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return;
    fs.rmSync(candidate);
  } catch {
    // Absence or an unsafe path is already fail-closed.
  }
};

export const isTerminalProtocolResponseInput = isTerminalProtocolResponse;

const normalizeSize = (cols: number, rows: number): { cols: number; rows: number } => ({
  cols: Number.isFinite(cols) && cols >= 2 ? Math.floor(cols) : 80,
  rows: Number.isFinite(rows) && rows >= 1 ? Math.floor(rows) : 24,
});

export const createAgentInputSessionBinding = (
  paneId: string,
  backend: Pick<SessionBackend, "id">,
  machine: MachineConfig,
): AgentInputSessionBinding => {
  const endpointFingerprint = crypto.createHash("sha256").update(JSON.stringify({
    id: machine.id,
    kind: machine.kind,
    host: machine.host,
    user: machine.user,
    port: machine.port,
    sessionBackend: machine.sessionBackend,
    agentUrl: machine.agentUrl,
    agentPort: machine.agentPort,
  })).digest("hex");
  // This authority epoch is created for one live wmux-to-backend attachment.
  // Client recycling, process replacement, exit, and restart all rotate it so
  // pane-id or endpoint reuse cannot revive an old source credential.
  void paneId;
  const sessionIncarnation = crypto.randomBytes(32).toString("hex");
  return { backendId: backend.id, sessionIncarnation, endpointFingerprint };
};

const sameAgentInputSessionBinding = (
  left: AgentInputSessionBinding,
  right: AgentInputSessionBinding,
): boolean => left.backendId === right.backendId
  && left.sessionIncarnation === right.sessionIncarnation
  && left.endpointFingerprint === right.endpointFingerprint;
