import type { WebSocket } from "ws";
import type { MachineConfig, PaneState } from "./types.js";
import { PtySession } from "./pty-session.js";
import type { StateStore } from "./state.js";
import { disposeDurableSession } from "./machines.js";

type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export class SessionManager {
  private sessions = new Map<string, PtySession>();
  private sockets = new Map<string, Set<WebSocket>>();

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
    const session = this.ensureSession(pane, cols, rows);
    session.resize(cols, rows);
    if (!this.sockets.has(paneId)) this.sockets.set(paneId, new Set());
    this.sockets.get(paneId)?.add(socket);

    this.send(socket, {
      type: "ready",
      paneId,
      pid: session.pid,
      title: pane.title,
      status: pane.status,
      replay: session.replayOutput,
    });

    socket.on("message", (raw) => {
      const message = this.parse(raw.toString());
      if (!message) return;
      if (message.type === "input") session.write(message.data);
      if (message.type === "resize") session.resize(message.cols, message.rows);
    });

    socket.on("close", () => {
      this.sockets.get(paneId)?.delete(socket);
    });
  }

  closePane(paneId: string): boolean {
    const machineId = this.state.findPane(paneId)?.machineId;
    const removed = this.state.removePane(paneId);
    this.disposePaneProcess(paneId, machineId);
    return removed;
  }

  closeTab(workspaceId: string, tabId: string): boolean {
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

  private ensureSession(pane: PaneState, cols: number, rows: number): PtySession {
    const existing = this.sessions.get(pane.id);
    if (existing && !existing.isExited) return existing;
    const machine = this.machines.find((candidate) => candidate.id === pane.machineId);
    if (!machine) throw new Error(`machine ${pane.machineId} not found`);
    const context = this.state.findPaneContext(pane.id);
    const session = new PtySession(pane, machine, cols, rows, {
      WMUX_URL: process.env.WMUX_PUBLIC_URL ?? `http://${process.env.WMUX_HOST ?? "127.0.0.1"}:${process.env.WMUX_PORT ?? "3478"}`,
      WMUX_WORKSPACE_ID: context?.workspace.id ?? "",
      WMUX_WORKSPACE_NAME: context?.workspace.name ?? "",
      WMUX_TAB_ID: context?.tab.id ?? "",
      WMUX_TAB_TITLE: context?.tab.title ?? "",
      WMUX_PANE_ID: pane.id,
      WMUX_START_CWD: pane.cwd ?? "",
      KITTY_WINDOW_ID: `wmux-${pane.id}`,
    });
    this.sessions.set(pane.id, session);
    this.state.updatePane(pane.id, { status: "running", exitCode: undefined, title: pane.title });

    session.on("output", (data) => this.broadcast(pane.id, { type: "output", data }));
    session.on("title", (title) => {
      this.state.updatePane(pane.id, { title });
      this.broadcast(pane.id, { type: "title", title });
    });
    session.on("cwd", (cwd) => {
      this.state.updatePane(pane.id, { cwd });
    });
    session.on("exit", (code) => {
      this.broadcast(pane.id, { type: "exit", code });
      this.sessions.delete(pane.id);
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

  private disposePaneProcess(paneId: string, machineId?: string): void {
    const session = this.sessions.get(paneId);
    this.sessions.delete(paneId);
    if (session) session.kill();
    const fallbackMachineId = machineId ?? session?.pane.machineId ?? this.state.findPane(paneId)?.machineId;
    const machine = fallbackMachineId
      ? this.machines.find((candidate) => candidate.id === fallbackMachineId)
      : undefined;
    if (machine) disposeDurableSession(machine, paneId);
    this.broadcast(paneId, { type: "removed" });
    for (const socket of this.sockets.get(paneId) ?? []) {
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
