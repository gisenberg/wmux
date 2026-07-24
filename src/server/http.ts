import fs from "node:fs";
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import { WebSocketServer } from "ws";
import { resolveKeybindings } from "../shared/keybindings.js";
import {
  DEFAULT_DELEGATION_WAIT_TIMEOUT_SECONDS,
  DEFAULT_TERMINAL_FONT_FAMILY,
  MAX_DELEGATION_WAIT_TIMEOUT_SECONDS,
  MIN_DELEGATION_WAIT_TIMEOUT_SECONDS,
  type DelegationConfig,
} from "../shared/protocol.js";
import {
  authenticateRequest,
  type AuthConfig,
  requestBearerToken,
  requestToken,
  registeredHostPrincipal,
  registrationPrincipal,
} from "./auth.js";
import type { AuthPrincipal } from "./auth.js";
import {
  authorizeHttpPrincipal,
  authorizeWebSocketPrincipal,
  classifyHttpRoute,
  classifyWebSocket,
} from "./auth-policy.js";
import { isAllowedOrigin, isAllowedRequestHost } from "./bind.js";
import { HostRegistryError, type HostRegistry } from "./host-registry.js";
import { LoginAttemptThrottle } from "./login-throttle.js";
import { readDurableSessionCwd } from "./durable-session.js";
import { resolveMachineStatuses } from "./machines.js";
import { RepositoryReviewError, RepositoryReviewService } from "./repository-review.js";
import { resolveStreamStatuses, StreamRequestStore } from "./streams.js";
import type {
  EventClientMessage,
  EventServerMessage,
  KeybindingMap,
  MachineConfig,
  MachineSource,
  MachineStatus,
  PaneState,
  StreamStatus,
  TerminalClipboard,
  TerminalMedia,
  TerminalNotification,
} from "./types.js";
import {
  StateIdConflictError,
  type StateStore,
} from "./state.js";
import type { SessionManager } from "./session-manager.js";
import type { SettingsStore } from "./settings.js";
import {
  MAX_PASTE_IMAGE_BYTES,
  PasteImageStageError,
} from "./paste-image-staging.js";
import { apiRoutes } from "./routes/index.js";
import {
  HttpError,
  matchApiRoute,
  type ServerDeps,
} from "./routes/route.js";

// Default cap for JSON control endpoints; upload endpoints pass a larger cap.
const MAX_JSON_BODY = 1024 * 1024;

export const HEALTH_EPOCH_PROCESS_STRIDE = 1024;
export const healthEpochForProcessStart = (startedAtMs: number): number => {
  const epoch = Math.trunc(startedAtMs) * HEALTH_EPOCH_PROCESS_STRIDE;
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("unsafe health epoch process start");
  return epoch;
};
export const nextHealthEpoch = (current: number): number => {
  if (!Number.isSafeInteger(current) || current >= Number.MAX_SAFE_INTEGER) {
    throw new Error("health epoch exhausted");
  }
  return current + 1;
};
// A later process must sort after same-revision state from an earlier process;
// the stride reserves room for ordinary in-process health increments.
export const PROCESS_HEALTH_EPOCH_BASE = healthEpochForProcessStart(Date.now());

const readBody = async (request: http.IncomingMessage, maxBytes = MAX_JSON_BODY): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      request.destroy();
      throw new HttpError(413, "payload_too_large");
    }
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "invalid_json");
  }
};

export const readBinaryBody = async (
  request: http.IncomingMessage,
  maxBytes = MAX_PASTE_IMAGE_BYTES,
): Promise<Buffer> => {
  const rawLength = request.headers["content-length"];
  if (typeof rawLength !== "string") throw new HttpError(411, "content_length_required");
  if (!/^\d+$/.test(rawLength)) throw new HttpError(400, "invalid_content_length");
  const expected = Number(rawLength);
  if (!Number.isSafeInteger(expected)) throw new HttpError(400, "invalid_content_length");
  if (expected > maxBytes) throw new HttpError(413, "paste_image_too_large");
  if (expected === 0) throw new HttpError(400, "paste_image_empty");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes || total > expected) {
      request.destroy();
      throw new HttpError(413, "paste_image_too_large");
    }
    chunks.push(Buffer.from(chunk));
  }
  if (total !== expected) throw new HttpError(400, "incomplete_body");
  return Buffer.concat(chunks, total);
};

const sendJson = (
  response: http.ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void => {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(payload));
};

const clientRoot = (): string => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../client");
};

const bundledMesloFontFiles = {
  regular: "meslo-lgm-nerd-font-mono-regular.woff2",
  bold: "meslo-lgm-nerd-font-mono-bold.woff2",
  italic: "meslo-lgm-nerd-font-mono-italic.woff2",
  "bold-italic": "meslo-lgm-nerd-font-mono-bold-italic.woff2",
} as const;

type BundledMesloFontFace = keyof typeof bundledMesloFontFiles;

type WmuxHttpServer = http.Server | https.Server;

export const createHttpServer = (
  bindHost: string,
  state: StateStore,
  machineSource: MachineSource,
  sessions: SessionManager,
  settings: SettingsStore,
  options: {
    dev?: boolean;
    auth: AuthConfig;
    tls?: https.ServerOptions;
    hostRegistry?: HostRegistry;
    registrationToken?: string;
    trustedProxies?: ReadonlySet<string>;
    terminalFontFamily?: string;
    healthRefreshIntervals?: { machines?: number; streams?: number };
    healthResolvers?: {
      machines?: typeof resolveMachineStatuses;
      streams?: typeof resolveStreamStatuses;
    };
    keybindings?: KeybindingMap;
    repositoryReviews?: RepositoryReviewService;
    delegation?: DelegationConfig;
  },
): Promise<WmuxHttpServer> => {
  const { auth, hostRegistry, registrationToken } = options;
  const machineStatusResolver = options.healthResolvers?.machines ?? resolveMachineStatuses;
  const streamStatusResolver = options.healthResolvers?.streams ?? resolveStreamStatuses;
  const trustedProxies = options.trustedProxies ?? new Set<string>();
  const loginAttempts = new LoginAttemptThrottle();
  const currentMachines = typeof machineSource === "function" ? machineSource : () => machineSource;
  const repositoryReviews = options.repositoryReviews
    ?? new RepositoryReviewService(state, machineSource);
  const root = clientRoot();
  const streamRequests = new StreamRequestStore();
  const healthEvents = new EventEmitter();
  let machineStatuses: MachineStatus[] = [];
  let streamStatuses: StreamStatus[] = [];
  let machineRefresh: Promise<void> | null = null;
  let streamRefresh: Promise<void> | null = null;
  let streamMutationRevision = 0;
  let machineStatusKey = "";
  let streamStatusKey = "";
  let machinePublishRequested = false;
  let streamPublishRequested = false;
  let healthEpoch = PROCESS_HEALTH_EPOCH_BASE;
  let vite: ViteDevServer | undefined;
  const protocol = options.tls ? "https" : "http";

  const resolveMachineId = (
    machines: MachineConfig[],
    requested?: string,
    fallback?: string,
  ): string => {
    const preferredMachine =
      machines.find((machine) => machine.source !== "registered") ??
      machines.find((machine) => machine.online !== false);
    const machineId = requested ?? fallback ?? preferredMachine?.id;
    if (!machineId) throw new HttpError(409, "no_machine_available");
    if (!machines.some((machine) => machine.id === machineId)) {
      throw new HttpError(400, "unknown_machine");
    }
    return machineId;
  };

  const machineCatalogFingerprint = (): string => JSON.stringify(
    currentMachines().map(({
      registeredAt: _registeredAt,
      lastSeenAt: _lastSeenAt,
      expiresAt: _expiresAt,
      ...machine
    }) => machine),
  );
  const streamCatalogFingerprint = (): string => JSON.stringify(
    currentMachines().map((machine) => ({ id: machine.id, host: machine.host, stream: machine.stream })),
  );
  const machineInputKey = (): string => machineCatalogFingerprint();
  const streamInputKey = (): string => `${streamMutationRevision}:${streamCatalogFingerprint()}`;

  const currentMachineStatuses = (statuses = machineStatuses): MachineStatus[] => {
    const latest = new Map(currentMachines().map((machine) => [machine.id, machine]));
    return statuses.map((status) => {
      const machine = latest.get(status.id);
      if (!machine) return status;
      return {
        ...status,
        source: machine.source,
        registeredAt: machine.registeredAt,
        lastSeenAt: machine.lastSeenAt,
        expiresAt: machine.expiresAt,
        online: machine.online,
      };
    });
  };
  const updatePublicMachineStatuses = (next: MachineStatus[]): boolean => {
    const publicNext = currentMachineStatuses(next);
    const changed = !samePublicHealth(machineStatuses, publicNext);
    machineStatuses = publicNext;
    return changed;
  };

  const currentPayload = () => {
    const snapshot = state.snapshot();
    return {
      revision: snapshot.revision,
      workspaceTreeRevision: snapshot.workspaceTreeRevision,
      healthEpoch,
      machines: currentMachineStatuses(),
      workspaces: snapshot.workspaces,
      activeWorkspaceId: snapshot.activeWorkspaceId,
      notifications: snapshot.notifications,
      agentEvents: snapshot.agentEvents,
      delegations: snapshot.delegations,
      runs: snapshot.runs,
      delegation: options.delegation ?? {
        waitTimeoutSeconds: DEFAULT_DELEGATION_WAIT_TIMEOUT_SECONDS,
        waitTimeoutBoundsSeconds: {
          min: MIN_DELEGATION_WAIT_TIMEOUT_SECONDS,
          max: MAX_DELEGATION_WAIT_TIMEOUT_SECONDS,
        },
      },
      terminalFontFamily: options.terminalFontFamily ?? DEFAULT_TERMINAL_FONT_FAMILY,
      settings: settings.snapshot(),
      keybindings: options.keybindings ?? resolveKeybindings(),
      settingsDefaults: settings.defaultsSnapshot(),
      streams: streamStatuses,
    };
  };

  const refreshMachineStatuses = async (publish = true, force = false): Promise<void> => {
    machinePublishRequested ||= publish;
    if (machineRefresh) {
      await machineRefresh;
      if (machineStatusKey !== machineInputKey()) await refreshMachineStatuses(publish);
      return;
    }
    const expectedKey = machineInputKey();
    if (!force && machineStatusKey === expectedKey) {
      const changed = updatePublicMachineStatuses(machineStatuses);
      if (changed && machinePublishRequested) healthEvents.emit("change", { machines: machineStatuses });
      machinePublishRequested = false;
      return;
    }

    const machines = currentMachines();
    const refreshKey = machineInputKey();
    machineRefresh = machineStatusResolver(machines, bindHost)
      .then((next) => {
        if (refreshKey !== machineInputKey()) return;
        const changed = updatePublicMachineStatuses(next);
        machineStatusKey = refreshKey;
        if (changed && machinePublishRequested) healthEvents.emit("change", { machines: machineStatuses });
        machinePublishRequested = false;
      })
      .finally(() => {
        machineRefresh = null;
      });
    await machineRefresh;
    if (machineStatusKey !== machineInputKey()) await refreshMachineStatuses(publish);
  };

  const refreshStreamStatuses = async (publish = true, force = false): Promise<void> => {
    streamPublishRequested ||= publish;
    if (streamRefresh) {
      await streamRefresh;
      if (streamStatusKey !== streamInputKey()) await refreshStreamStatuses(publish);
      return;
    }
    const expectedKey = streamInputKey();
    if (!force && streamStatusKey === expectedKey) {
      streamPublishRequested = false;
      return;
    }

    const machines = currentMachines();
    const refreshKey = streamInputKey();
    streamRefresh = (async () => {
      const next = await streamStatusResolver(machines, bindHost, streamRequests);
      if (refreshKey !== streamInputKey()) return;
      const changed = !samePublicHealth(streamStatuses, next);
      streamStatuses = next;
      streamStatusKey = refreshKey;
      if (changed && streamPublishRequested) healthEvents.emit("change", { streams: streamStatuses });
      streamPublishRequested = false;
    })().finally(() => {
      streamRefresh = null;
    });
    await streamRefresh;
    if (streamStatusKey !== streamInputKey()) await refreshStreamStatuses(publish);
  };

  const refreshHealthInBackground = (kind: "machines" | "streams", refresh: () => Promise<void>): void => {
    void refresh().catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`wmux: ${kind} health refresh failed: ${detail}`);
    });
  };

  const bootstrapFresh = async () => {
    await Promise.all([refreshMachineStatuses(false), refreshStreamStatuses(false)]);
    return currentPayload();
  };
  const serverDeps: ServerDeps = {
    bindHost,
    auth,
    trustedProxies,
    loginAttempts,
    state,
    sessions,
    settings,
    hostRegistry,
    streamRequests,
    repositoryReviews,
    currentMachines,
    currentPayload,
    bootstrapFresh,
    refreshMachineStatuses,
    refreshStreamStatuses,
    getMachineStatuses: () => machineStatuses,
    getStreamStatuses: () => streamStatuses,
    markStreamMutation: () => {
      streamMutationRevision += 1;
    },
    resolveMachineId,
    cwdForSourcePane: (machines, sourcePane, targetMachineId) =>
      cwdForSourcePane(state, machines, sourcePane, targetMachineId),
  };

  const onRegistryChange = (): void => {
    state.updateMachines(currentMachines());
    refreshHealthInBackground("machines", () => refreshMachineStatuses(true));
    refreshHealthInBackground("streams", () => refreshStreamStatuses(true));
  };
  hostRegistry?.on("change", onRegistryChange);

  const handleRequest = async (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
    if (
      !isAllowedRequestHost(request.headers.host, bindHost) ||
      !isAllowedOrigin(request.headers.origin, bindHost)
    ) {
      sendJson(response, 403, { error: "forbidden_host" });
      return;
    }

    const url = new URL(request.url ?? "/", `${protocol}://${request.headers.host ?? bindHost}`);
    const machines = currentMachines();

    const bundledMesloFont = request.method === "GET" || request.method === "HEAD"
      ? url.pathname.match(/^\/fonts\/meslo-v3\.4\.0\/(regular|bold|italic|bold-italic)$/)
      : null;
    const matchedApiRoute = matchApiRoute(apiRoutes, request.method, url.pathname);

    // Every API method/path is classified before authentication so new routes
    // cannot silently inherit a broad credential's authority.
    const routePolicy = matchedApiRoute?.route.policy
      ?? classifyHttpRoute(request.method, url.pathname);
    const registrationPost = routePolicy?.access === "registration";
    const registrationAuth = registrationPrincipal(registrationToken, requestBearerToken(request));
    const helperMatch = url.pathname.match(/^\/api\/helpers\/windows\/([^/]+)(?:\/bootstrap)?$/);
    const helperMachine = helperMatch
      ? machines.find((machine) => machine.id === helperMatch[1])
      : undefined;
    const registeredHelperPrincipal = registeredHostPrincipal(
      helperMachine?.id ?? "",
      request.method === "GET" &&
      url.pathname.endsWith("/bootstrap") &&
      helperMachine?.source === "registered" &&
      Boolean(hostRegistry?.acceptsBootstrapToken(helperMachine.id, requestToken(request, url))),
    );
    let principal: AuthPrincipal = { kind: "anonymous" };
    if (url.pathname.startsWith("/api/")) {
      if (!routePolicy) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      principal = registeredHelperPrincipal.kind === "registered-host"
        ? registeredHelperPrincipal
        : registrationPost
          ? registrationAuth
          : authenticateRequest(auth, request, url);
      const registeredWindowsEndpoint = helperMachine?.source === "registered"
        && (routePolicy.id === "windows-bootstrap" || routePolicy.id === "windows-helpers");
      const wrongRegisteredWindowsPrincipal = registeredWindowsEndpoint
        && (routePolicy.id === "windows-bootstrap"
          ? principal.kind !== "registered-host"
          : principal.kind === "helper" || principal.kind === "registered-host");
      if (wrongRegisteredWindowsPrincipal || !authorizeHttpPrincipal(auth, principal, routePolicy)) {
        sendJson(response, principal.kind === "anonymous" ? 401 : 403, { error: "unauthorized" });
        return;
      }
    }

    try {
      if (bundledMesloFont) {
        const face = bundledMesloFont[1] as BundledMesloFontFace;
        if (!serveBundledMesloFont(root, face, request.method === "HEAD", response)) {
          sendJson(response, 404, { error: "font_not_found" });
        }
        return;
      }

      if (matchedApiRoute) {
        await matchedApiRoute.route.handler({
          url,
          request,
          response,
          principal,
          machines,
          match: matchedApiRoute.match,
          deps: serverDeps,
          sendJson: (status, payload, headers) =>
            sendJson(response, status, payload, headers),
          readJsonBody: (maxBytes) => readBody(request, maxBytes),
          readBinaryBody: (maxBytes) => readBinaryBody(request, maxBytes),
        });
        return;
      }

      if (request.method === "GET") {
        if (vite && await serveViteRequest(vite, request, response, url, root)) return;

        const filePath =
          url.pathname === "/" ? path.join(root, "index.html") : path.join(root, url.pathname);
        const normalized = path.normalize(filePath);
        if (
          (normalized === root || normalized.startsWith(`${root}${path.sep}`)) &&
          fs.existsSync(normalized) &&
          fs.statSync(normalized).isFile()
        ) {
          response.writeHead(200, staticHeaders(normalized));
          fs.createReadStream(normalized).pipe(response);
          return;
        }
        const index = path.join(root, "index.html");
        if (fs.existsSync(index)) {
          response.writeHead(200, staticHeaders(index));
          fs.createReadStream(index).pipe(response);
          return;
        }
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (
        error instanceof HttpError
        || error instanceof HostRegistryError
        || error instanceof PasteImageStageError
        || error instanceof RepositoryReviewError
      ) {
        sendJson(response, error.status, { error: error.code });
        return;
      }
      if (error instanceof StateIdConflictError) {
        sendJson(response, 409, { error: "client_id_conflict" });
        return;
      }
      // Log full detail server-side but never leak internal messages/paths to
      // the client.
      console.error("wmux: request handler error:", error);
      sendJson(response, 500, { error: "server_error" });
    }
  };

  const server = options.tls ? https.createServer(options.tls, handleRequest) : http.createServer(handleRequest);

  const setupDevServer = async (): Promise<void> => {
    if (!options.dev) return;
    const { createServer: createViteServer } = await import("vite");
    vite = await createViteServer({
      configFile: path.resolve(process.cwd(), "vite.config.ts"),
      server: {
        middlewareMode: true,
        hmr: {
          server,
          path: "/ws/vite-hmr",
        },
      },
      appType: "custom",
    });
  };

  const wss = new WebSocketServer({ noServer: true });
  const eventSockets = new Set<import("ws").WebSocket>();

  const sendEventMessage = (ws: import("ws").WebSocket, message: EventServerMessage): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  };
  const broadcastEventMessage = (message: EventServerMessage): void => {
    if (eventSockets.size === 0) return;
    const serialized = JSON.stringify(message);
    for (const ws of eventSockets) {
      if (ws.readyState === ws.OPEN) ws.send(serialized);
    }
  };
  const broadcastSnapshot = (reason: string): void => {
    if (eventSockets.size === 0) return;
    const snapshot = currentPayload();
    broadcastEventMessage({ type: "snapshot", reason, revision: snapshot.revision, state: snapshot });
  };
  const onStateChange = () => broadcastSnapshot("state");
  const onSettingsChange = () => broadcastSnapshot("settings");
  const onHealthChange = (delta: { machines?: MachineStatus[]; streams?: StreamStatus[] }) => {
    healthEpoch = nextHealthEpoch(healthEpoch);
    broadcastEventMessage({ type: "health", revision: state.snapshot().revision, healthEpoch, ...delta });
  };
  const onNotification = (notification: TerminalNotification) => {
    broadcastEventMessage({ type: "notification", notification });
  };
  const onMedia = (media: TerminalMedia) => {
    broadcastEventMessage({ type: "media", media });
  };
  const onClipboard = (clipboard: TerminalClipboard) => {
    broadcastEventMessage({ type: "clipboard", clipboard });
  };
  state.on("change", onStateChange);
  settings.on("change", onSettingsChange);
  healthEvents.on("change", onHealthChange);
  state.on("notification", onNotification);
  state.on("media", onMedia);
  state.on("clipboard", onClipboard);

  // Heartbeat: half-open connections (mobile/VPN drops without a close frame)
  // never fire "close", so their PTY output buffers and resize-owner state
  // would leak. Ping every interval and terminate any socket that missed the
  // previous pong; terminate() fires "close" so the normal cleanup path runs.
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
  server.on("close", () => clearInterval(heartbeat));

  server.on("upgrade", (request, socket, head) => {
    if (
      !isAllowedRequestHost(request.headers.host, bindHost) ||
      !isAllowedOrigin(request.headers.origin, bindHost)
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const url = new URL(request.url ?? "/", `${protocol}://${request.headers.host ?? bindHost}`);
    if (options.dev && url.pathname === "/ws/vite-hmr") return;
    const socketClass = classifyWebSocket(url.pathname);
    if (!socketClass) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const principal = authenticateRequest(auth, request, url);
    if (!authorizeWebSocketPrincipal(auth, principal, socketClass)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    if (url.pathname === "/ws/events") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        markAlive(ws);
        eventSockets.add(ws);
        ws.on("message", (raw) => {
          const message = parseSocketMessage(raw.toString());
          if (!message) return;
          if (message.type === "stream-request" && machineExists(currentMachines(), message.machineId)) {
            streamRequests.touch(message.machineId, message.requestId, message.ttlMs);
            streamMutationRevision += 1;
            refreshHealthInBackground("streams", () => refreshStreamStatuses(true, true));
          }
          if (message.type === "stream-release" && machineExists(currentMachines(), message.machineId)) {
            streamRequests.release(message.machineId, message.requestId);
            streamMutationRevision += 1;
            refreshHealthInBackground("streams", () => refreshStreamStatuses(true, true));
          }
        });
        ws.on("close", () => {
          eventSockets.delete(ws);
        });
        sendEventMessage(ws, { type: "ready" });
      });
      return;
    }
    const outputMatch = url.pathname.match(/^\/ws\/panes\/([^/]+)\/output$/);
    if (outputMatch) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        markAlive(ws);
        sessions.watchOutput(
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
      sessions.attach(
        match[1],
        ws,
        Number(url.searchParams.get("cols") ?? 80),
        Number(url.searchParams.get("rows") ?? 24),
      );
    });
  });

  const machineHealthTimer = setInterval(
    () => refreshHealthInBackground("machines", () => refreshMachineStatuses(true, true)),
    options.healthRefreshIntervals?.machines ?? 15_000,
  );
  const streamHealthTimer = setInterval(
    () => refreshHealthInBackground("streams", () => refreshStreamStatuses(true, true)),
    options.healthRefreshIntervals?.streams ?? 5_000,
  );
  machineHealthTimer.unref();
  streamHealthTimer.unref();
  server.on("close", () => {
    clearInterval(machineHealthTimer);
    clearInterval(streamHealthTimer);
    hostRegistry?.off("change", onRegistryChange);
    state.off("change", onStateChange);
    settings.off("change", onSettingsChange);
    healthEvents.off("change", onHealthChange);
    state.off("notification", onNotification);
    state.off("media", onMedia);
    state.off("clipboard", onClipboard);
  });

  return setupDevServer().then(() => server);
};

// checkedAt is internal freshness metadata: polling updates it, but it must not
// cause a browser-wide state rebuild when the public health is unchanged.
const samePublicHealth = <T extends { checkedAt: string }>(previous: T[], next: T[]): boolean =>
  JSON.stringify(previous.map(({ checkedAt: _checkedAt, ...status }) => status)) ===
  JSON.stringify(next.map(({ checkedAt: _checkedAt, ...status }) => status));

const machineExists = (
  machines: MachineConfig[],
  machineId: string,
): boolean => machines.some((machine) => machine.id === machineId);

const serveViteRequest = async (
  vite: ViteDevServer,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  root: string,
): Promise<boolean> => {
  try {
    await new Promise<void>((resolve, reject) => {
      vite.middlewares(request, response, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (response.writableEnded || response.headersSent) return true;
    const indexPath = path.join(root, "index.html");
    if (!fs.existsSync(indexPath)) return false;
    const html = await vite.transformIndexHtml(url.pathname, fs.readFileSync(indexPath, "utf8"));
    response.writeHead(200, staticHeaders(indexPath));
    response.end(html);
    return true;
  } catch (error) {
    if (error instanceof Error) vite.ssrFixStacktrace(error);
    throw error;
  }
};

const cwdForSourcePane = async (
  state: StateStore,
  machines: MachineConfig[],
  sourcePane: PaneState | undefined,
  targetMachineId: string,
): Promise<string | undefined> => {
  if (!sourcePane || sourcePane.machineId !== targetMachineId) return undefined;
  const machine = machines.find((candidate) => candidate.id === sourcePane.machineId);
  const cwd = machine ? await readDurableSessionCwd(machine, sourcePane.id) : undefined;
  if (cwd && cwd !== sourcePane.cwd) state.updatePane(sourcePane.id, { cwd });
  return cwd ?? sourcePane.cwd;
};

const contentType = (filePath: string): string => {
  if (filePath.endsWith(".html")) return "text/html";
  if (filePath.endsWith(".js")) return "text/javascript";
  if (filePath.endsWith(".css")) return "text/css";
  if (filePath.endsWith(".woff")) return "font/woff";
  if (filePath.endsWith(".woff2")) return "font/woff2";
  if (filePath.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
};

const staticHeaders = (filePath: string): Record<string, string> => {
  const headers: Record<string, string> = { "content-type": contentType(filePath) };
  if (filePath.endsWith(".html")) {
    headers["cache-control"] = "no-store";
  } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
    headers["cache-control"] = "public, max-age=31536000, immutable";
  }
  return headers;
};

const serveBundledMesloFont = (
  root: string,
  face: BundledMesloFontFace,
  headOnly: boolean,
  response: http.ServerResponse,
): boolean => {
  const fileName = bundledMesloFontFiles[face];
  const candidates = [
    path.join(root, "fonts", "meslo", fileName),
    path.join(root, "public", "fonts", "meslo", fileName),
  ];
  const filePath = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!filePath) return false;
  const stat = fs.statSync(filePath);
  response.writeHead(200, {
    "content-type": "font/woff2",
    "content-length": String(stat.size),
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  });
  if (headOnly) response.end();
  else fs.createReadStream(filePath).pipe(response);
  return true;
};

const parseSocketMessage = (raw: string): EventClientMessage | null => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (message.type !== "stream-request" && message.type !== "stream-release") return null;
  if (typeof message.machineId !== "string" || typeof message.requestId !== "string") return null;
  if (!message.machineId.trim() || !message.requestId.trim()) return null;
  if (message.type === "stream-request" && message.ttlMs !== undefined && typeof message.ttlMs !== "number") return null;
  const base = {
    machineId: message.machineId.trim(),
    requestId: message.requestId.trim(),
  };
  return message.type === "stream-request"
    ? { type: "stream-request", ...base, ...(typeof message.ttlMs === "number" ? { ttlMs: message.ttlMs } : {}) }
    : { type: "stream-release", ...base };
};
