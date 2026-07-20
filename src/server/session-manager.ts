import type { WebSocket } from "ws";
import { isTerminalProtocolResponse } from "../shared/terminal-protocol.js";
import type { BrowserAuthMode } from "./auth.js";
import type { MachineConfig, MachineSource, PaneClientMessage, PaneServerMessage, PaneState } from "./types.js";
import type { StateStore } from "./state.js";
import { sessionDriverForMachine, type ManagedSession } from "./session-driver.js";
import { streamPathForMachine } from "./streams.js";
import { resolveHelperUrl } from "./helper-url.js";
import type { AttachReplay } from "./terminal-checkpoint.js";
import {
  PasteImageStageError,
  PasteImageStaging,
  type PasteImageStager,
  type StagedPasteImage,
} from "./paste-image-staging.js";

export type ClientMessage = PaneClientMessage;

interface SocketState {
  paneId: string;
  cols: number;
  rows: number;
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

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private sockets = new Map<string, Set<WebSocket>>();
  private outputWatchers = new Map<string, Set<WebSocket>>();
  private resizeOwners = new Map<string, WebSocket>();
  private socketState = new Map<WebSocket, SocketState>();
  private ignoredSessionExits = new WeakSet<ManagedSession>();
  private sessionMachines = new Map<string, MachineConfig>();
  private paneInputEpochs = new Map<string, number>();
  private pausedSessions = new Map<string, ReturnType<typeof setInterval>>();
  private durableRefreshTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly currentMachines: () => MachineConfig[];

  constructor(
    private readonly state: StateStore,
    machines: MachineSource,
    private readonly accessToken = "",
    private readonly bootstrapTokenForMachine: (machineId: string) => string | undefined = () => undefined,
    private readonly onPaneReferencesChanged: () => void = () => undefined,
    private readonly pasteImages: PasteImageStager = new PasteImageStaging(),
    private readonly terminalEnvironment: () => Record<string, string> = () => ({}),
    private readonly helperToken = "",
    private readonly browserAuthMode: BrowserAuthMode = "shared-or-login",
  ) {
    this.currentMachines = typeof machines === "function" ? machines : () => machines;
  }

  hasLiveSessionsForMachine(machineId: string): boolean {
    return [...this.sessions.values()].some((session) => session.pane.machineId === machineId && !session.isExited);
  }

  hasLivePaneSession(paneId: string): boolean {
    const session = this.sessions.get(paneId);
    return Boolean(this.state.findPane(paneId) && session && !session.isExited && this.sessionMachines.has(paneId));
  }

  async stagePasteImage(paneId: string, data: Buffer): Promise<StagedPasteImage> {
    const pane = this.state.findPane(paneId);
    const session = this.sessions.get(paneId);
    const inputEpoch = this.paneInputEpochs.get(paneId) ?? 0;
    if (!pane) throw new PasteImageStageError(404, "pane_not_found");
    if (!session || session.isExited || !this.sessionMachines.has(paneId)) {
      throw new PasteImageStageError(409, "paste_image_pane_not_live");
    }
    if (session.attachReady) await session.attachReady;
    const machine = this.sessionMachines.get(paneId);
    if (this.state.findPane(paneId) !== pane || this.sessions.get(paneId) !== session || session.isExited || !machine) {
      throw new PasteImageStageError(409, "paste_image_pane_not_live");
    }
    const staged = await this.pasteImages.stage(paneId, structuredClone(machine), data);
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
    this.socketState.set(socket, { paneId, ...initialSize });
    let session: ManagedSession;
    try {
      session = this.ensureSession(pane, initialSize.cols, initialSize.rows);
    } catch (error) {
      this.socketState.delete(socket);
      paneSockets?.delete(socket);
      this.deleteEmptySocketSet(paneId);
      socket.close(1011, error instanceof Error ? error.message : "session start failed");
      return;
    }
    const resizeOwner = this.ensureResizeOwner(paneId, socket, session, initialSize);

    socket.on("message", (raw) => {
      const message = this.parse(raw.toString());
      if (!message) return;
      if (message.type === "input") {
        this.promoteResizeOwner(paneId, socket, session);
        if (isAgentInterruptInput(message.data)) this.state.interruptAgentForPane(paneId);
        const terminalResponse = message.terminalResponse || isTerminalProtocolResponseInput(message.data);
        if (!terminalResponse) this.advancePaneInputEpoch(paneId);
        if (terminalResponse && session.writeTerminalResponse) {
          session.writeTerminalResponse(message.data);
        }
        else session.write(message.data);
      }
      if (message.type === "resize") {
        const size = normalizeSize(message.cols, message.rows);
        this.socketState.set(socket, { paneId, ...size });
        if (message.foreground === false) {
          this.releaseResizeOwner(paneId, socket);
          return;
        }
        if (this.resizeOwners.get(paneId) === socket) session.resize(size.cols, size.rows);
      }
      if (message.type === "activate") {
        const size = normalizeSize(message.cols, message.rows);
        this.socketState.set(socket, { paneId, ...size });
        if (message.foreground === false) {
          this.releaseResizeOwner(paneId, socket);
          return;
        }
        this.activateResizeOwner(paneId, socket, session);
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
      this.send(socket, {
        type: "ready",
        paneId,
        pid: session.pid,
        title: pane.title,
        status: pane.status,
        resizeOwner,
        replay: attachReplay.data,
        replayKind: attachReplay.kind,
        ...(this.shouldUseDurableClientRefresh(pane) && attachReplay.kind === "raw" && attachReplay.data === ""
          ? { waitForRefresh: true as const }
          : {}),
      });
      this.scheduleDurableClientRefresh(pane, socket);
    };
    if (session.attachReady) void session.attachReady.then(sendReady);
    else sendReady();
  }

  watchOutput(paneId: string, socket: WebSocket, cols = 96, rows = 32): void {
    const pane = this.state.findPane(paneId);
    if (!pane) {
      socket.close(1008, "pane not found");
      return;
    }
    const size = normalizeSize(cols, rows);
    let session: ManagedSession;
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
      this.send(socket, {
        type: "ready",
        paneId,
        pid: session.pid,
        title: pane.title,
        status: pane.status,
        replay: replay.data,
        replayKind: replay.kind,
        outputOnly: true,
      });
    };
    if (session.attachReady) void session.attachReady.then(sendReady);
    else sendReady();

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
    const machineIds = this.machineIdsForWorkspace(workspaceId);
    const paneIds = this.state.removeWorkspace(workspaceId);
    for (const paneId of paneIds) this.disposePaneProcess(paneId, machineIds.get(paneId));
    if (paneIds.length > 0) this.onPaneReferencesChanged();
    return paneIds.length > 0;
  }

  writePane(paneId: string, data: string, cols = 96, rows = 32): boolean {
    const pane = this.state.findPane(paneId);
    if (!pane) return false;
    const size = normalizeSize(cols, rows);
    const session = this.ensureSession(pane, size.cols, size.rows);
    this.advancePaneInputEpoch(paneId);
    session.write(data);
    return true;
  }

  private ensureSession(pane: PaneState, cols: number, rows: number): ManagedSession {
    const existing = this.sessions.get(pane.id);
    if (existing && !existing.isExited) return existing;
    const previousSessionMachine = this.sessionMachines.get(pane.id);
    const configuredMachine = this.currentMachines().find((candidate) => candidate.id === pane.machineId);
    if (!configuredMachine) throw new Error(`machine ${pane.machineId} not found`);
    const machine = pane.agentPort && configuredMachine.kind === "powershell-ssh"
      ? { ...configuredMachine, agentPort: pane.agentPort, agentUrl: undefined }
      : configuredMachine;
    if (machine.source === "registered" && machine.online === false) {
      throw new Error(`machine ${pane.machineId} is offline`);
    }
    const driver = sessionDriverForMachine(machine);
    if (previousSessionMachine && !sameMachineEndpoint(previousSessionMachine, machine)) {
      void sessionDriverForMachine(previousSessionMachine).dispose(previousSessionMachine, pane.id, false);
    }
    const context = this.state.findPaneContext(pane.id);
    const streamHost = process.env.WMUX_STREAM_HOST ?? process.env.WMUX_HOST ?? "127.0.0.1";
    const streamPath = streamPathForMachine(machine.id);
    const sessionEnv = {
      ...this.terminalEnvironment(),
      ...paneAuthEnvironmentForMachine(machine, this.accessToken, this.helperToken, this.browserAuthMode),
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
    const session = driver.create(pane, machine, cols, rows, sessionEnv);
    const startedAt = Date.now();
    this.sessions.set(pane.id, session);
    this.sessionMachines.set(pane.id, structuredClone(machine));
    this.state.updatePane(pane.id, { status: "running", exitCode: undefined, title: pane.title });
    this.schedulePaneCwdRefresh(pane, machine, session);

    session.on("output", (data) => {
      this.broadcast(pane.id, { type: "output", paneId: pane.id, data });
      this.applyBackpressure(pane.id, session);
    });
    session.on("title", (title) => {
      this.state.updatePane(pane.id, { title });
      this.broadcast(pane.id, { type: "title", paneId: pane.id, title });
    });
    session.on("cwd", (cwd) => {
      this.state.updatePane(pane.id, { cwd });
    });
    session.on("agentPort", (agentPort) => {
      machine.agentPort = agentPort;
      machine.agentUrl = undefined;
      this.sessionMachines.set(pane.id, structuredClone(machine));
      this.state.updatePane(pane.id, { agentPort });
    });
    session.on("exit", (code) => {
      if (this.ignoredSessionExits.has(session)) return;
      this.broadcast(pane.id, { type: "exit", paneId: pane.id, code });
      this.sessions.delete(pane.id);
      this.resizeOwners.delete(pane.id);
      const context = this.state.findPaneContext(pane.id);
      if (!context) return;

      const uptimeMs = Date.now() - startedAt;
      if (!isDeliberateExit(code, uptimeMs)) {
        // Spawn/connection failure or a very fast exit: preserve the pane so a
        // flaky SSH host or transient error never deletes the workspace. The
        // pane is re-spawned when a client next attaches.
        this.state.updatePane(pane.id, { status: "exited", exitCode: code ?? null });
        return;
      }

      const exitedMachine = this.sessionMachines.get(pane.id);
      if (exitedMachine && sessionDriverForMachine(exitedMachine).capabilities(exitedMachine).agentOwned) {
        void sessionDriverForMachine(exitedMachine).dispose(exitedMachine, pane.id, false);
      }
      this.sessionMachines.delete(pane.id);
      this.paneInputEpochs.delete(pane.id);
      if (exitedMachine) void this.pasteImages.cleanupPane(pane.id, exitedMachine);
      if (context.tab.panes.length > 1) {
        this.state.removePane(pane.id);
      } else if (context.workspace.tabs.length > 1) {
        this.state.removeTab(context.workspace.id, context.tab.id);
      } else {
        this.state.closeWorkspaceAfterExit(context.workspace.id);
      }
      this.onPaneReferencesChanged();
    });

    return session;
  }

  private schedulePaneCwdRefresh(pane: PaneState, machine: MachineConfig, session: ManagedSession): void {
    const driver = sessionDriverForMachine(machine);
    if (driver.capabilities(machine).cwd !== "multiplexer") return;

    let retryIndex = 0;
    const refresh = async (): Promise<void> => {
      if (this.sessions.get(pane.id) !== session || session.isExited) return;
      const cwdBeforeRead = this.state.findPane(pane.id)?.cwd;
      let cwd: string | undefined;
      try {
        cwd = await driver.readCwd(machine, pane.id);
      } catch {
        cwd = undefined;
      }
      if (this.sessions.get(pane.id) !== session || session.isExited) return;
      const currentPane = this.state.findPane(pane.id);
      if (!currentPane || currentPane.machineId !== machine.id || currentPane.cwd !== cwdBeforeRead) return;
      if (cwd) {
        if (cwd !== currentPane.cwd) this.state.updatePane(pane.id, { cwd });
        return;
      }

      const delayMs = DURABLE_CWD_REFRESH_RETRY_DELAYS_MS[retryIndex];
      retryIndex += 1;
      if (delayMs === undefined) return;
      const timer = setTimeout(() => {
        this.durableRefreshTimers.delete(timer);
        void refresh();
      }, delayMs);
      timer.unref?.();
      this.durableRefreshTimers.add(timer);
    };
    void refresh();
  }

  private broadcast(paneId: string, payload: PaneServerMessage): void {
    for (const socket of this.sockets.get(paneId) ?? []) {
      this.send(socket, payload);
    }
    for (const socket of this.outputWatchers.get(paneId) ?? []) {
      this.send(socket, payload);
    }
  }

  // Flow control: a fast PTY (e.g. `yes`) feeding a slow client would grow the
  // outbound socket buffer without bound. Pause the PTY when any consumer's
  // buffer crosses the high-water mark, and resume once every buffer drains.
  private applyBackpressure(paneId: string, session: ManagedSession): void {
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
    for (const timer of this.durableRefreshTimers) clearTimeout(timer);
    this.durableRefreshTimers.clear();
    for (const timer of this.pausedSessions.values()) clearInterval(timer);
    this.pausedSessions.clear();
    for (const session of this.sessions.values()) {
      this.ignoredSessionExits.add(session);
      if (session.detach) session.detach();
      else session.kill();
    }
    this.sessions.clear();
    this.sessionMachines.clear();
    this.paneInputEpochs.clear();
    this.pasteImages.dispose();
  }

  private replayOutputFor(pane: PaneState, session: ManagedSession): AttachReplay {
    if (this.shouldUseDurableClientRefresh(pane)) return { data: "", kind: "raw" };
    return session.attachReplay ?? {
      data: session.replayOutput,
      kind: "raw",
    };
  }

  private outputReplayFor(session: ManagedSession): AttachReplay {
    // Output-only clients cannot perform the browser's durable-client refresh,
    // and textual automation must not receive a screen-shaped checkpoint that
    // can destroy line boundaries used for readiness and completion markers.
    return {
      data: session.replayOutput,
      kind: "raw",
    };
  }

  private scheduleDurableClientRefresh(pane: PaneState, socket: WebSocket): void {
    if (!this.shouldUseDurableClientRefresh(pane)) return;
    for (const delayMs of [120, 500]) {
      const timer = setTimeout(() => {
        this.durableRefreshTimers.delete(timer);
        if (socket.readyState !== socket.OPEN) return;
        const machine = this.currentMachines().find((candidate) => candidate.id === pane.machineId);
        if (machine && !(machine.source === "registered" && machine.online === false)) {
          void sessionDriverForMachine(machine).refreshClient(machine, pane.id);
        }
      }, delayMs);
      timer.unref?.();
      this.durableRefreshTimers.add(timer);
    }
  }

  private shouldUseDurableClientRefresh(pane: PaneState): boolean {
    const machine = this.currentMachines().find((candidate) => candidate.id === pane.machineId);
    if (!machine || (machine.source === "registered" && machine.online === false)) return false;
    return sessionDriverForMachine(machine).capabilities(machine).refreshClient;
  }

  private recycleIdleDurableClient(pane: PaneState): boolean {
    if (!this.shouldUseDurableClientRefresh(pane) || this.hasPaneConnections(pane.id)) return false;
    const existing = this.sessions.get(pane.id);
    if (!existing || existing.isExited) return false;
    this.ignoredSessionExits.add(existing);
    this.sessions.delete(pane.id);
    this.resizeOwners.delete(pane.id);
    existing.kill();
    return true;
  }

  private hasPaneConnections(paneId: string): boolean {
    return (this.sockets.get(paneId)?.size ?? 0) > 0 || (this.outputWatchers.get(paneId)?.size ?? 0) > 0;
  }

  private ensureResizeOwner(
    paneId: string,
    socket: WebSocket,
    session: ManagedSession,
    size: { cols: number; rows: number },
  ): boolean {
    const owner = this.resizeOwners.get(paneId);
    const paneSockets = this.sockets.get(paneId);
    if (owner && paneSockets?.has(owner) && owner.readyState === owner.OPEN) {
      return owner === socket;
    }
    this.resizeOwners.set(paneId, socket);
    session.resize(size.cols, size.rows);
    return true;
  }

  private promoteResizeOwner(paneId: string, socket: WebSocket, session: ManagedSession): void {
    if (this.resizeOwners.get(paneId) === socket) return;
    const state = this.socketState.get(socket);
    if (!state) return;
    this.resizeOwners.set(paneId, socket);
    session.resize(state.cols, state.rows);
  }

  private activateResizeOwner(paneId: string, socket: WebSocket, session: ManagedSession): void {
    const state = this.socketState.get(socket);
    if (!state) return;
    const owner = this.resizeOwners.get(paneId);
    const paneSockets = this.sockets.get(paneId);
    if (owner && owner !== socket && paneSockets?.has(owner) && owner.readyState === owner.OPEN) return;
    this.resizeOwners.set(paneId, socket);
    session.resize(state.cols, state.rows);
  }

  private releaseResizeOwner(paneId: string, socket: WebSocket): void {
    if (this.resizeOwners.get(paneId) === socket) this.resizeOwners.delete(paneId);
  }

  private reassignResizeOwner(paneId: string, closedSocket: WebSocket, session: ManagedSession): void {
    if (this.resizeOwners.get(paneId) !== closedSocket) {
      this.deleteEmptySocketSet(paneId);
      return;
    }

    const nextSocket = [...(this.sockets.get(paneId) ?? [])].find((candidate) => candidate.readyState === candidate.OPEN);
    if (!nextSocket) {
      this.resizeOwners.delete(paneId);
      this.deleteEmptySocketSet(paneId);
      return;
    }

    const nextSize = this.socketState.get(nextSocket);
    this.resizeOwners.set(paneId, nextSocket);
    if (nextSize && !session.isExited) session.resize(nextSize.cols, nextSize.rows);
  }

  private deleteEmptySocketSet(paneId: string): void {
    if ((this.sockets.get(paneId)?.size ?? 0) === 0) this.sockets.delete(paneId);
  }

  private disposePaneProcess(paneId: string, machineId?: string): void {
    const session = this.sessions.get(paneId);
    const sessionMachine = this.sessionMachines.get(paneId);
    this.sessions.delete(paneId);
    this.sessionMachines.delete(paneId);
    this.paneInputEpochs.delete(paneId);
    this.resizeOwners.delete(paneId);
    if (session) session.kill();
    const fallbackMachineId = machineId ?? session?.pane.machineId ?? this.state.findPane(paneId)?.machineId;
    const machine = resolveDisposalMachine(sessionMachine, this.currentMachines(), fallbackMachineId);
    if (machine) {
      void sessionDriverForMachine(machine).dispose(machine, paneId, Boolean(session));
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
      return {
        type: "input",
        data: parsed.data,
        ...(parsed.terminalResponse === true ? { terminalResponse: true } : {}),
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

export const isTerminalProtocolResponseInput = isTerminalProtocolResponse;

const normalizeSize = (cols: number, rows: number): { cols: number; rows: number } => ({
  cols: Number.isFinite(cols) && cols >= 2 ? Math.floor(cols) : 80,
  rows: Number.isFinite(rows) && rows >= 1 ? Math.floor(rows) : 24,
});
