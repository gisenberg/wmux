import { withTokenParam } from "./token";
import type { PaneServerMessage } from "./types";

interface PaneSocketCallbacks {
  url: () => string;
  paneId: string;
  onSocketChange: (socket: WebSocket | null) => void;
  onOpen: (socket: WebSocket) => void;
  onMessage: (message: PaneServerMessage, socket: WebSocket) => void;
  onConnectionChange: (connected: boolean, issue: string) => void;
}

export class PaneSocketController {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | undefined;
  private reconnectDelayMs = 350;
  private disposed = false;
  private removed = false;

  constructor(private readonly callbacks: PaneSocketCallbacks) {}

  start(): void {
    this.connect();
  }

  reconnect(issue = "Reconnecting pane"): void {
    if (this.disposed || this.removed) return;
    this.callbacks.onConnectionChange(false, issue);
    this.reconnectDelayMs = 350;
    const stale = this.socket;
    this.setSocket(null);
    stale?.close();
    if (!stale) this.connect();
  }

  markRemoved(): void {
    this.removed = true;
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.setSocket(null);
    socket?.close();
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.setSocket(null);
    socket?.close();
  }

  private connect(): void {
    if (this.disposed || this.removed || this.socket) return;
    const socket = new WebSocket(withTokenParam(this.callbacks.url()));
    this.setSocket(socket);

    socket.onopen = () => {
      if (this.disposed || this.removed || this.socket !== socket) {
        socket.close();
        return;
      }
      this.reconnectDelayMs = 350;
      this.callbacks.onConnectionChange(true, "");
      this.callbacks.onOpen(socket);
    };
    socket.onclose = (event) => {
      if (this.disposed) return;
      if (this.socket === socket) this.setSocket(null);
      this.callbacks.onConnectionChange(false, this.removed ? "" : event.reason || "Connection lost; retrying");
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      if (this.disposed || this.removed || this.socket !== socket) return;
      this.callbacks.onConnectionChange(false, "Pane connection failed; retrying");
    };
    socket.onmessage = (event) => {
      if (this.disposed || this.removed || this.socket !== socket) return;
      let message: PaneServerMessage;
      try {
        message = JSON.parse(String(event.data)) as PaneServerMessage;
      } catch {
        return;
      }
      if (typeof message.paneId === "string" && message.paneId !== this.callbacks.paneId) return;
      this.callbacks.onMessage(message, socket);
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.removed || this.reconnectTimer !== undefined) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(3000, Math.round(this.reconnectDelayMs * 1.6));
  }

  private setSocket(socket: WebSocket | null): void {
    this.socket = socket;
    this.callbacks.onSocketChange(socket);
  }
}
