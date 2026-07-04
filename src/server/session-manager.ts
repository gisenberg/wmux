import type { WebSocket } from "ws";
import type { MachineConfig, PaneState } from "./types.js";
import { PtySession } from "./pty-session.js";
import type { StateStore } from "./state.js";
import { disposeDurableSession } from "./machines.js";
import { streamPathForMachine } from "./streams.js";
import { shouldUseWindowsAgent, WindowsAgentSession } from "./windows-agent.js";

type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

interface SocketState {
  paneId: string;
  cols: number;
  rows: number;
}

type ManagedSession = PtySession | WindowsAgentSession;

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private sockets = new Map<string, Set<WebSocket>>();
  private resizeOwners = new Map<string, WebSocket>();
  private socketState = new Map<WebSocket, SocketState>();

  constructor(
    private readonly state: StateStore,
    private readonly machines: MachineConfig[],
  ) {}

  attach(paneId: string, socket: WebSocket, cols: number, rows: number): void {
    const pane = this.state.findPane(paneId);
    if (!pane) {
      socket.close(1008, "pane not found");
      return;
    }
    const initialSize = normalizeSize(cols, rows);
    const session = this.ensureSession(pane, initialSize.cols, initialSize.rows);
    if (!this.sockets.has(paneId)) this.sockets.set(paneId, new Set());
    const paneSockets = this.sockets.get(paneId);
    paneSockets?.add(socket);
    this.socketState.set(socket, { paneId, ...initialSize });
    const resizeOwner = this.ensureResizeOwner(paneId, socket, session, initialSize);

    this.send(socket, {
      type: "ready",
      paneId,
      pid: session.pid,
      title: pane.title,
      status: pane.status,
      resizeOwner,
      replay: session.replayOutput,
    });

    socket.on("message", (raw) => {
      const message = this.parse(raw.toString());
      if (!message) return;
      if (message.type === "input") {
        this.promoteResizeOwner(paneId, socket, session);
        session.write(message.data);
      }
      if (message.type === "resize") {
        const size = normalizeSize(message.cols, message.rows);
        this.socketState.set(socket, { paneId, ...size });
        if (this.resizeOwners.get(paneId) === socket) session.resize(size.cols, size.rows);
      }
    });

    socket.on("close", () => {
      this.socketState.delete(socket);
      this.sockets.get(paneId)?.delete(socket);
      this.reassignResizeOwner(paneId, socket, session);
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
    if (removed) this.disposePaneProcess(paneId, machineId);
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
    return paneIds.length > 0;
  }

  closeWorkspace(workspaceId: string): boolean {
    const machineIds = this.machineIdsForWorkspace(workspaceId);
    const paneIds = this.state.removeWorkspace(workspaceId);
    for (const paneId of paneIds) this.disposePaneProcess(paneId, machineIds.get(paneId));
    return paneIds.length > 0;
  }

  writePane(paneId: string, data: string, cols = 96, rows = 32): boolean {
    const pane = this.state.findPane(paneId);
    if (!pane) return false;
    const size = normalizeSize(cols, rows);
    const session = this.ensureSession(pane, size.cols, size.rows);
    session.write(data);
    return true;
  }

  private ensureSession(pane: PaneState, cols: number, rows: number): ManagedSession {
    const existing = this.sessions.get(pane.id);
    if (existing && !existing.isExited) return existing;
    const machine = this.machines.find((candidate) => candidate.id === pane.machineId);
    if (!machine) throw new Error(`machine ${pane.machineId} not found`);
    const context = this.state.findPaneContext(pane.id);
    const streamHost = process.env.WMUX_STREAM_HOST ?? process.env.WMUX_HOST ?? "127.0.0.1";
    const streamPath = streamPathForMachine(machine.id);
    const sessionEnv = {
      WMUX_URL: process.env.WMUX_PUBLIC_URL ?? `http://${process.env.WMUX_HOST ?? "127.0.0.1"}:${process.env.WMUX_PORT ?? "3478"}`,
      WMUX_WORKSPACE_ID: context?.workspace.id ?? "",
      WMUX_WORKSPACE_NAME: context?.workspace.name ?? "",
      WMUX_TAB_ID: context?.tab.id ?? "",
      WMUX_TAB_TITLE: context?.tab.title ?? "",
      WMUX_PANE_ID: pane.id,
      WMUX_START_CWD: pane.cwd ?? "",
      WMUX_STREAM_HOST: streamHost,
      WMUX_STREAM_PATH: streamPath,
      WMUX_STREAM_RTSP_URL: `rtsp://${streamHost}:8554/${streamPath}`,
      WMUX_STREAM_WHIP_URL: `${process.env.WMUX_MEDIAMTX_WEBRTC_ORIGIN ?? `http://${streamHost}:8889`}/${streamPath}/whip`,
      KITTY_WINDOW_ID: `wmux-${pane.id}`,
    };
    const session = shouldUseWindowsAgent(machine)
      ? new WindowsAgentSession(pane, machine, cols, rows, sessionEnv)
      : new PtySession(pane, machine, cols, rows, sessionEnv);
    this.sessions.set(pane.id, session);
    this.state.updatePane(pane.id, { status: "running", exitCode: undefined, title: pane.title });

    session.on("output", (data) => this.broadcast(pane.id, { type: "output", paneId: pane.id, data }));
    session.on("title", (title) => {
      this.state.updatePane(pane.id, { title });
      this.broadcast(pane.id, { type: "title", paneId: pane.id, title });
    });
    session.on("cwd", (cwd) => {
      this.state.updatePane(pane.id, { cwd });
    });
    session.on("exit", (code) => {
      this.broadcast(pane.id, { type: "exit", paneId: pane.id, code });
      this.sessions.delete(pane.id);
      this.resizeOwners.delete(pane.id);
      const context = this.state.findPaneContext(pane.id);
      if (!context) return;
      if (context.tab.panes.length > 1) {
        this.state.removePane(pane.id);
      } else if (context.workspace.tabs.length > 1) {
        this.state.removeTab(context.workspace.id, context.tab.id);
      } else {
        this.state.closeWorkspaceAfterExit(context.workspace.id);
      }
    });

    return session;
  }

  private broadcast(paneId: string, payload: unknown): void {
    for (const socket of this.sockets.get(paneId) ?? []) {
      this.send(socket, payload);
    }
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
    this.sessions.delete(paneId);
    this.resizeOwners.delete(paneId);
    if (session) session.kill();
    const fallbackMachineId = machineId ?? session?.pane.machineId ?? this.state.findPane(paneId)?.machineId;
    const machine = fallbackMachineId
      ? this.machines.find((candidate) => candidate.id === fallbackMachineId)
      : undefined;
    if (machine) disposeDurableSession(machine, paneId);
    this.broadcast(paneId, { type: "removed", paneId });
    for (const socket of this.sockets.get(paneId) ?? []) {
      this.socketState.delete(socket);
      socket.close(1000, "pane closed");
    }
    this.sockets.delete(paneId);
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

  private send(socket: WebSocket, payload: unknown): void {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(payload));
  }

  private parse(raw: string): ClientMessage | null {
    try {
      const parsed = JSON.parse(raw) as ClientMessage;
      if (parsed.type === "input" && typeof parsed.data === "string") return parsed;
      if (
        parsed.type === "resize" &&
        Number.isFinite(parsed.cols) &&
        Number.isFinite(parsed.rows)
      ) {
        return parsed;
      }
    } catch {
      return null;
    }
    return null;
  }
}

const normalizeSize = (cols: number, rows: number): { cols: number; rows: number } => ({
  cols: Number.isFinite(cols) && cols >= 2 ? Math.floor(cols) : 80,
  rows: Number.isFinite(rows) && rows >= 1 ? Math.floor(rows) : 24,
});
