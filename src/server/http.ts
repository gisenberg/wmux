import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { isAllowedOrigin, isAllowedRequestHost } from "./bind.js";
import { readDurableSessionCwd, resolveMachineStatuses } from "./machines.js";
import { auditDurableSessions, cleanupDurableSession } from "./session-audit.js";
import type { MachineConfig, PaneState } from "./types.js";
import type { StateStore } from "./state.js";
import type { SessionManager } from "./session-manager.js";
import type { SettingsStore } from "./settings.js";

const readBody = async (request: http.IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
};

const sendJson = (response: http.ServerResponse, status: number, payload: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
};

const clientRoot = (): string => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../client");
};

export const createHttpServer = (
  bindHost: string,
  state: StateStore,
  machines: MachineConfig[],
  sessions: SessionManager,
  settings: SettingsStore,
): http.Server => {
  const root = clientRoot();
  const bootstrap = async () => {
    const snapshot = state.snapshot();
    return {
      machines: await resolveMachineStatuses(machines, bindHost),
      workspaces: snapshot.workspaces,
      activeWorkspaceId: snapshot.activeWorkspaceId,
      notifications: snapshot.notifications,
      agentEvents: snapshot.agentEvents,
      runs: snapshot.runs,
      settings: settings.snapshot(),
    };
  };

  const server = http.createServer(async (request, response) => {
    if (
      !isAllowedRequestHost(request.headers.host, bindHost) ||
      !isAllowedOrigin(request.headers.origin, bindHost)
    ) {
      sendJson(response, 403, { error: "forbidden_host" });
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? bindHost}`);
    try {
      if (url.pathname === "/api/bootstrap" && request.method === "GET") {
        sendJson(response, 200, await bootstrap());
        return;
      }

      if (url.pathname === "/api/session-audit" && request.method === "GET") {
        sendJson(response, 200, auditDurableSessions());
        return;
      }

      const cleanupSession = url.pathname.match(/^\/api\/session-audit\/(tmux|screen)\/([^/]+)$/);
      if (cleanupSession && request.method === "DELETE") {
        sendJson(response, 200, cleanupDurableSession(cleanupSession[1] as "tmux" | "screen", decodeURIComponent(cleanupSession[2])));
        return;
      }

      if (url.pathname === "/api/settings" && request.method === "POST") {
        const body = (await readBody(request)) as {
          terminalFontSize?: number;
          machineAliases?: Record<string, string>;
        };
        settings.update({
          terminalFontSize: body.terminalFontSize,
          machineAliases: body.machineAliases,
        });
        sendJson(response, 200, { settings: settings.snapshot(), state: await bootstrap() });
        return;
      }

      if (url.pathname === "/api/workspaces" && request.method === "POST") {
        const body = (await readBody(request)) as { machineId?: string };
        const machineId = body.machineId ?? "local";
        const workspace = state.createWorkspace(machineId, cwdForActivePane(state, machines, machineId));
        sendJson(response, 201, { workspace });
        return;
      }

      if (url.pathname === "/api/notifications" && request.method === "POST") {
        const body = (await readBody(request)) as {
          workspaceId?: string;
          tabId?: string;
          paneId?: string;
          title?: string;
          subtitle?: string;
          body?: string;
        };
        const notification = state.createNotification({
          workspaceId: body.workspaceId,
          tabId: body.tabId,
          paneId: body.paneId,
          title: body.title ?? "wmux",
          subtitle: body.subtitle,
          body: body.body,
        });
        sendJson(response, 201, { notification, state: await bootstrap() });
        return;
      }

      if (url.pathname === "/api/agent-events" && request.method === "POST") {
        const body = (await readBody(request)) as {
          workspaceId?: string;
          tabId?: string;
          paneId?: string;
          agent?: string;
          status?: string;
          title?: string;
          summary?: string;
          body?: string;
        };
        const result = state.recordAgentEvent({
          workspaceId: body.workspaceId,
          tabId: body.tabId,
          paneId: body.paneId,
          agent: body.agent,
          status: body.status,
          title: body.title,
          summary: body.summary,
          body: body.body,
        });
        sendJson(response, 201, { ...result, state: await bootstrap() });
        return;
      }

      if (url.pathname === "/api/run-events" && request.method === "POST") {
        const body = (await readBody(request)) as {
          workspaceId?: string;
          tabId?: string;
          paneId?: string;
          runId?: string;
          command?: string;
          status?: "started" | "completed" | "failed";
          exitCode?: number | null;
          startedAt?: string;
          completedAt?: string;
        };
        if (body.status && !["started", "completed", "failed"].includes(body.status)) {
          sendJson(response, 400, { error: "invalid_run_status" });
          return;
        }
        const run = state.recordRunEvent({
          workspaceId: body.workspaceId,
          tabId: body.tabId,
          paneId: body.paneId,
          runId: body.runId,
          command: body.command,
          status: body.status,
          exitCode: body.exitCode,
          startedAt: body.startedAt,
          completedAt: body.completedAt,
        });
        sendJson(response, 201, { run, state: await bootstrap() });
        return;
      }

      if (url.pathname === "/api/media" && request.method === "POST") {
        const body = (await readBody(request)) as {
          workspaceId?: string;
          tabId?: string;
          paneId?: string;
          name?: string;
          mimeType?: string;
          data?: string;
        };
        if (!body.data) {
          sendJson(response, 400, { error: "missing_media_data" });
          return;
        }
        const media = state.createMedia({
          workspaceId: body.workspaceId,
          tabId: body.tabId,
          paneId: body.paneId,
          name: body.name ?? "media",
          mimeType: body.mimeType ?? "application/octet-stream",
          data: body.data,
        });
        sendJson(response, 201, { media });
        return;
      }

      if (url.pathname === "/api/clipboard" && request.method === "POST") {
        const body = (await readBody(request)) as {
          workspaceId?: string;
          tabId?: string;
          paneId?: string;
          text?: string;
        };
        if (typeof body.text !== "string" || body.text.length === 0) {
          sendJson(response, 400, { error: "missing_clipboard_text" });
          return;
        }
        const clipboard = state.createClipboard({
          workspaceId: body.workspaceId,
          tabId: body.tabId,
          paneId: body.paneId,
          text: body.text,
        });
        sendJson(response, 201, { clipboard });
        return;
      }

      const readNotification = url.pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
      if (readNotification && request.method === "POST") {
        state.markNotificationRead(readNotification[1]);
        sendJson(response, 200, await bootstrap());
        return;
      }

      const readWorkspaceNotifications = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/notifications\/read$/);
      if (readWorkspaceNotifications && request.method === "POST") {
        state.markWorkspaceNotificationsRead(readWorkspaceNotifications[1]);
        sendJson(response, 200, await bootstrap());
        return;
      }

      const closeWorkspace = url.pathname.match(/^\/api\/workspaces\/([^/]+)$/);
      if (closeWorkspace && request.method === "DELETE") {
        const removed = sessions.closeWorkspace(closeWorkspace[1]);
        sendJson(response, removed ? 200 : 409, { removed, state: await bootstrap() });
        return;
      }

      const workspaceTitle = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/title$/);
      if (workspaceTitle && request.method === "POST") {
        const body = (await readBody(request)) as { title?: string; clear?: boolean };
        const workspace = body.clear
          ? state.clearWorkspaceTitle(workspaceTitle[1])
          : state.setWorkspaceTitle(workspaceTitle[1], body.title ?? "");
        sendJson(response, 200, { workspace, state: await bootstrap() });
        return;
      }

      const workspaceAutoTitle = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/auto-title$/);
      if (workspaceAutoTitle && request.method === "POST") {
        const body = (await readBody(request)) as {
          title?: string;
          tabId?: string;
          descriptor?: string;
          tabOnlyIfMultiple?: boolean;
        };
        const result = state.setAutoTitle({
          workspaceId: workspaceAutoTitle[1],
          title: body.title ?? "",
          tabId: body.tabId,
          descriptor: body.descriptor,
          tabOnlyIfMultiple: body.tabOnlyIfMultiple,
        });
        sendJson(response, 200, { ...result, state: await bootstrap() });
        return;
      }

      const activeWorkspace = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/active$/);
      if (activeWorkspace && request.method === "POST") {
        state.setActiveWorkspace(activeWorkspace[1]);
        sendJson(response, 200, await bootstrap());
        return;
      }

      const tabs = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/tabs$/);
      if (tabs && request.method === "POST") {
        const body = (await readBody(request)) as { machineId?: string };
        const snapshot = state.snapshot();
        const workspace = snapshot.workspaces.find((candidate) => candidate.id === tabs[1]);
        const activeTab = workspace?.tabs.find((candidate) => candidate.id === workspace.activeTabId);
        const activePane = activeTab?.panes.find((candidate) => candidate.id === activeTab.activePaneId);
        const machineId = body.machineId ?? workspace?.machineId ?? "local";
        const tab = state.createTab(tabs[1], machineId, cwdForSourcePane(state, machines, activePane, machineId));
        sendJson(response, 201, { tab, state: await bootstrap() });
        return;
      }

      const activeTab = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/tabs\/([^/]+)\/active$/);
      if (activeTab && request.method === "POST") {
        state.setActiveTab(activeTab[1], activeTab[2]);
        sendJson(response, 200, await bootstrap());
        return;
      }

      const closeTab = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/tabs\/([^/]+)$/);
      if (closeTab && request.method === "DELETE") {
        const removed = sessions.closeTab(closeTab[1], closeTab[2]);
        sendJson(response, removed ? 200 : 409, { removed, state: await bootstrap() });
        return;
      }

      const tabTitle = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/tabs\/([^/]+)\/title$/);
      if (tabTitle && request.method === "POST") {
        const body = (await readBody(request)) as { title?: string };
        const tab = state.setTabTitle(tabTitle[1], tabTitle[2], body.title ?? "");
        sendJson(response, 200, { tab, state: await bootstrap() });
        return;
      }

      const split = url.pathname.match(/^\/api\/tabs\/([^/]+)\/split$/);
      if (split && request.method === "POST") {
        const body = (await readBody(request)) as {
          paneId?: string;
          direction?: "horizontal" | "vertical";
          machineId?: string;
        };
        if (!body.paneId || (body.direction !== "horizontal" && body.direction !== "vertical")) {
          sendJson(response, 400, { error: "invalid_split" });
          return;
        }
        const snapshot = state.snapshot();
        const sourcePane = snapshot.workspaces
          .flatMap((workspace) => workspace.tabs)
          .flatMap((tab) => tab.panes)
          .find((pane) => pane.id === body.paneId);
        const machineId = body.machineId ?? sourcePane?.machineId ?? "local";
        const tab = state.splitPane(
          split[1],
          body.paneId,
          body.direction,
          machineId,
          cwdForSourcePane(state, machines, sourcePane, machineId),
        );
        sendJson(response, 201, { tab, state: await bootstrap() });
        return;
      }

      const splitRatio = url.pathname.match(/^\/api\/tabs\/([^/]+)\/split-ratio$/);
      if (splitRatio && request.method === "POST") {
        const body = (await readBody(request)) as { path?: string; ratio?: number };
        const ratio = body.ratio;
        if (typeof body.path !== "string" || typeof ratio !== "number" || !Number.isFinite(ratio)) {
          sendJson(response, 400, { error: "invalid_split_ratio" });
          return;
        }
        const tab = state.setSplitRatio(splitRatio[1], body.path, ratio);
        sendJson(response, 200, { tab, state: await bootstrap() });
        return;
      }

      const activePane = url.pathname.match(/^\/api\/tabs\/([^/]+)\/panes\/([^/]+)\/active$/);
      if (activePane && request.method === "POST") {
        state.setActivePane(activePane[1], activePane[2]);
        sendJson(response, 200, await bootstrap());
        return;
      }

      const closePane = url.pathname.match(/^\/api\/tabs\/([^/]+)\/panes\/([^/]+)$/);
      if (closePane && request.method === "DELETE") {
        const removed = sessions.closePane(closePane[2]);
        sendJson(response, removed ? 200 : 409, { removed, state: await bootstrap() });
        return;
      }

      if (request.method === "GET") {
        const filePath =
          url.pathname === "/" ? path.join(root, "index.html") : path.join(root, url.pathname);
        const normalized = path.normalize(filePath);
        if (normalized.startsWith(root) && fs.existsSync(normalized) && fs.statSync(normalized).isFile()) {
          response.writeHead(200, { "content-type": contentType(normalized) });
          fs.createReadStream(normalized).pipe(response);
          return;
        }
        const index = path.join(root, "index.html");
        if (fs.existsSync(index)) {
          response.writeHead(200, { "content-type": "text/html" });
          fs.createReadStream(index).pipe(response);
          return;
        }
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "server_error" });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (
      !isAllowedRequestHost(request.headers.host, bindHost) ||
      !isAllowedOrigin(request.headers.origin, bindHost)
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? bindHost}`);
    if (url.pathname === "/ws/events") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        const onChange = () => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "state" }));
        };
        const onNotification = (notification: unknown) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "notification", notification }));
        };
        const onMedia = (media: unknown) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "media", media }));
        };
        const onClipboard = (clipboard: unknown) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "clipboard", clipboard }));
        };
        state.on("change", onChange);
        settings.on("change", onChange);
        state.on("notification", onNotification);
        state.on("media", onMedia);
        state.on("clipboard", onClipboard);
        ws.on("close", () => {
          state.off("change", onChange);
          settings.off("change", onChange);
          state.off("notification", onNotification);
          state.off("media", onMedia);
          state.off("clipboard", onClipboard);
        });
        ws.send(JSON.stringify({ type: "ready" }));
      });
      return;
    }
    const match = url.pathname.match(/^\/ws\/panes\/([^/]+)$/);
    if (!match) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      sessions.attach(
        match[1],
        ws,
        Number(url.searchParams.get("cols") ?? 80),
        Number(url.searchParams.get("rows") ?? 24),
      );
    });
  });

  return server;
};

const cwdForActivePane = (state: StateStore, machines: MachineConfig[], targetMachineId: string): string | undefined => {
  const snapshot = state.snapshot();
  const workspace = snapshot.workspaces.find((candidate) => candidate.id === snapshot.activeWorkspaceId);
  const tab = workspace?.tabs.find((candidate) => candidate.id === workspace.activeTabId);
  const pane = tab?.panes.find((candidate) => candidate.id === tab.activePaneId);
  return cwdForSourcePane(state, machines, pane, targetMachineId);
};

const cwdForSourcePane = (
  state: StateStore,
  machines: MachineConfig[],
  sourcePane: PaneState | undefined,
  targetMachineId: string,
): string | undefined => {
  if (!sourcePane || sourcePane.machineId !== targetMachineId) return undefined;
  const machine = machines.find((candidate) => candidate.id === sourcePane.machineId);
  const cwd = machine ? readDurableSessionCwd(machine, sourcePane.id) : undefined;
  if (cwd && cwd !== sourcePane.cwd) state.updatePane(sourcePane.id, { cwd });
  return cwd ?? sourcePane.cwd;
};

const contentType = (filePath: string): string => {
  if (filePath.endsWith(".html")) return "text/html";
  if (filePath.endsWith(".js")) return "text/javascript";
  if (filePath.endsWith(".css")) return "text/css";
  if (filePath.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
};
