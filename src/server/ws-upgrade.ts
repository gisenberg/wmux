import type http from "node:http";
import type https from "node:https";
import { WebSocketServer } from "ws";
import { authenticateRequest, type AuthConfig } from "./auth.js";
import {
  authorizeWebSocketPrincipal,
  classifyWebSocket,
} from "./auth-policy.js";
import { isAllowedOrigin, isAllowedRequestHost } from "./bind.js";
import type { EventBroadcastRuntime } from "./event-broadcast.js";
import type { SessionManager } from "./session-manager.js";
import type { StreamRequestStore } from "./streams.js";
import type {
  EventClientMessage,
  MachineConfig,
} from "./types.js";

interface WebSocketUpgradeOptions {
  server: http.Server | https.Server;
  bindHost: string;
  protocol: "http" | "https";
  auth: AuthConfig;
  dev: boolean;
  sessions: SessionManager;
  currentMachines: () => MachineConfig[];
  streamRequests: StreamRequestStore;
  events: EventBroadcastRuntime;
}

const machineExists = (
  machines: MachineConfig[],
  machineId: string,
): boolean => machines.some((machine) => machine.id === machineId);

const parseSocketMessage = (raw: string): EventClientMessage | null => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (
    message.type !== "stream-request"
    && message.type !== "stream-release"
  ) {
    return null;
  }
  if (
    typeof message.machineId !== "string"
    || typeof message.requestId !== "string"
  ) {
    return null;
  }
  if (!message.machineId.trim() || !message.requestId.trim()) return null;
  if (
    message.type === "stream-request"
    && message.ttlMs !== undefined
    && typeof message.ttlMs !== "number"
  ) {
    return null;
  }
  const base = {
    machineId: message.machineId.trim(),
    requestId: message.requestId.trim(),
  };
  return message.type === "stream-request"
    ? {
      type: "stream-request",
      ...base,
      ...(typeof message.ttlMs === "number" ? { ttlMs: message.ttlMs } : {}),
    }
    : { type: "stream-release", ...base };
};

export const installWebSocketUpgrade = (
  options: WebSocketUpgradeOptions,
): void => {
  const wss = new WebSocketServer({ noServer: true });
  const aliveSockets = new WeakSet<import("ws").WebSocket>();
  const markAlive = (ws: import("ws").WebSocket): void => {
    aliveSockets.add(ws);
    ws.on("pong", () => aliveSockets.add(ws));
    ws.on("error", () => {
      /* surfaced via "close"; handler prevents an unhandled-error crash */
    });
  };

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!aliveSockets.has(ws)) {
        ws.terminate();
        continue;
      }
      aliveSockets.delete(ws);
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();
  options.server.on("close", () => clearInterval(heartbeat));

  options.server.on("upgrade", (request, socket, head) => {
    if (
      !isAllowedRequestHost(request.headers.host, options.bindHost)
      || !isAllowedOrigin(request.headers.origin, options.bindHost)
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const url = new URL(
      request.url ?? "/",
      `${options.protocol}://${request.headers.host ?? options.bindHost}`,
    );
    if (options.dev && url.pathname === "/ws/vite-hmr") return;
    const socketClass = classifyWebSocket(url.pathname);
    if (!socketClass) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const principal = authenticateRequest(options.auth, request, url);
    if (
      !authorizeWebSocketPrincipal(options.auth, principal, socketClass)
    ) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    if (url.pathname === "/ws/events") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        markAlive(ws);
        options.events.addEventSocket(ws);
        ws.on("message", (raw) => {
          const message = parseSocketMessage(raw.toString());
          if (!message) return;
          if (
            message.type === "stream-request"
            && machineExists(options.currentMachines(), message.machineId)
          ) {
            options.streamRequests.touch(
              message.machineId,
              message.requestId,
              message.ttlMs,
            );
            options.events.markStreamMutation();
            options.events.refreshInBackground(
              "streams",
              () => options.events.refreshStreamStatuses(true, true),
            );
          }
          if (
            message.type === "stream-release"
            && machineExists(options.currentMachines(), message.machineId)
          ) {
            options.streamRequests.release(
              message.machineId,
              message.requestId,
            );
            options.events.markStreamMutation();
            options.events.refreshInBackground(
              "streams",
              () => options.events.refreshStreamStatuses(true, true),
            );
          }
        });
      });
      return;
    }
    const outputMatch = url.pathname.match(/^\/ws\/panes\/([^/]+)\/output$/);
    if (outputMatch) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        markAlive(ws);
        options.sessions.watchOutput(
          outputMatch[1],
          ws,
          Number(url.searchParams.get("cols") ?? 96),
          Number(url.searchParams.get("rows") ?? 32),
        );
      });
      return;
    }

    const match = url.pathname.match(/^\/ws\/panes\/([^/]+)$/);
    if (!match) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      markAlive(ws);
      options.sessions.attach(
        match[1],
        ws,
        Number(url.searchParams.get("cols") ?? 80),
        Number(url.searchParams.get("rows") ?? 24),
      );
    });
  });
};
