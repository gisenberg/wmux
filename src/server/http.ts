import fs from "node:fs";
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import { WebSocketServer } from "ws";
import { readAgentProfileBundle } from "./agent-profile.js";
import {
  type AuthConfig,
  isAuthorized,
  issueSessionToken,
  requestBearerToken,
  requestToken,
  tokensMatch,
  verifyCredentials,
} from "./auth.js";
import { isAllowedOrigin, isAllowedRequestHost } from "./bind.js";
import { buildDoctorReport } from "./doctor.js";
import { HostRegistryError, type HostRegistry } from "./host-registry.js";
import { LoginAttemptThrottle } from "./login-throttle.js";
import { readDurableSessionCwd } from "./durable-session.js";
import { resolveMachineStatuses } from "./machines.js";
import { normalizeIpAddress, observedClientAddress } from "./proxy-address.js";
import { auditDurableSessions, cleanupDurableSession } from "./session-audit.js";
import { resolveStreamStatuses, StreamRequestStore } from "./streams.js";
import type {
  EventClientMessage,
  EventServerMessage,
  MachineConfig,
  MachineSource,
  MachineStatus,
  PaneState,
  StreamStatus,
  TerminalClipboard,
  TerminalMedia,
  TerminalNotification,
  WmuxSettings,
} from "./types.js";
import { buildWindowsHelperBundle, buildWindowsPowerShellBootstrap } from "./windows-helpers.js";
import type { StateStore } from "./state.js";
import type { SessionManager } from "./session-manager.js";
import type { SettingsStore } from "./settings.js";
import {
  MAX_PASTE_IMAGE_BYTES,
  PasteImageStageError,
} from "./paste-image-staging.js";

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

// Default cap for JSON control endpoints; upload endpoints pass a larger cap.
const MAX_JSON_BODY = 1024 * 1024;
const MAX_UPLOAD_BODY = 12 * 1024 * 1024;

// Lifetime of a login-issued session token. Long enough to be convenient on a
// trusted network; a restart with a rotated secret invalidates all sessions.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
    healthRefreshIntervals?: { machines?: number; streams?: number };
    healthResolvers?: {
      machines?: typeof resolveMachineStatuses;
      streams?: typeof resolveStreamStatuses;
    };
  },
): Promise<WmuxHttpServer> => {
  const { auth, hostRegistry, registrationToken } = options;
  const machineStatusResolver = options.healthResolvers?.machines ?? resolveMachineStatuses;
  const streamStatusResolver = options.healthResolvers?.streams ?? resolveStreamStatuses;
  const trustedProxies = options.trustedProxies ?? new Set<string>();
  const loginAttempts = new LoginAttemptThrottle();
  const currentMachines = typeof machineSource === "function" ? machineSource : () => machineSource;
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

  const currentMachineStatuses = (): MachineStatus[] => {
    const latest = new Map(currentMachines().map((machine) => [machine.id, machine]));
    return machineStatuses.map((status) => {
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

  const currentPayload = () => {
    const snapshot = state.snapshot();
    return {
      revision: snapshot.revision,
      machines: currentMachineStatuses(),
      workspaces: snapshot.workspaces,
      activeWorkspaceId: snapshot.activeWorkspaceId,
      notifications: snapshot.notifications,
      agentEvents: snapshot.agentEvents,
      runs: snapshot.runs,
      settings: settings.snapshot(),
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
      if (machinePublishRequested) healthEvents.emit("change", "machines");
      machinePublishRequested = false;
      return;
    }

    const machines = currentMachines();
    const refreshKey = machineInputKey();
    machineRefresh = machineStatusResolver(machines, bindHost)
      .then((next) => {
        if (refreshKey !== machineInputKey()) return;
        machineStatuses = next;
        machineStatusKey = refreshKey;
        if (machinePublishRequested) healthEvents.emit("change", "machines");
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
      streamStatuses = next;
      streamStatusKey = refreshKey;
      if (streamPublishRequested) healthEvents.emit("change", "streams");
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

    // Token gate: everything under /api requires a valid token, except the
    // unauthenticated bootstrap endpoints (liveness, auth capability probe, and
    // login itself). The static app shell is served unauthenticated so the
    // browser can load and then present its stored token.
    const unauthenticatedApi = new Set(["/api/health", "/api/auth-info", "/api/login"]);
    const registrationPost = url.pathname === "/api/registry/hosts" && request.method === "POST";
    const registrationAuthorized =
      Boolean(registrationToken) && tokensMatch(registrationToken ?? "", requestBearerToken(request));
    const helperMatch = url.pathname.match(/^\/api\/helpers\/windows\/([^/]+)(?:\/bootstrap)?$/);
    const helperMachine = helperMatch
      ? machines.find((machine) => machine.id === helperMatch[1])
      : undefined;
    const registeredHelperAuthorized =
      request.method === "GET" &&
      url.pathname.endsWith("/bootstrap") &&
      helperMachine?.source === "registered" &&
      Boolean(hostRegistry?.acceptsBootstrapToken(helperMachine.id, requestToken(request, url)));
    if (registrationPost && !registrationAuthorized) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    if (
      url.pathname.startsWith("/api/") &&
      !registrationPost &&
      !unauthenticatedApi.has(url.pathname) &&
      !registeredHelperAuthorized &&
      !isAuthorized(auth, request, url)
    ) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }

    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (url.pathname === "/api/auth-info" && request.method === "GET") {
        // Lets the browser decide whether to show a login form vs. a token hint.
        sendJson(response, 200, { authEnabled: auth.enabled, loginEnabled: auth.loginEnabled });
        return;
      }

      if (url.pathname === "/api/login" && request.method === "POST") {
        if (!auth.enabled || !auth.loginEnabled) {
          sendJson(response, 404, { error: "login_disabled" });
          return;
        }
        const clientAddress = observedClientAddress(request, trustedProxies)
          ?? normalizeIpAddress(request.socket.remoteAddress)
          ?? "unknown";
        const attempt = loginAttempts.attempt(clientAddress);
        if (!attempt.allowed) {
          sendJson(
            response,
            429,
            { error: "login_rate_limited", retryAfterMs: attempt.retryAfterMs },
            { "retry-after": String(Math.max(1, Math.ceil(attempt.retryAfterMs / 1_000))) },
          );
          return;
        }
        const body = (await readBody(request)) as { username?: unknown; password?: unknown };
        if (typeof body.username !== "string" || typeof body.password !== "string") {
          sendJson(response, 400, { error: "invalid_credentials_format" });
          return;
        }
        if (!await verifyCredentials(auth, body.username, body.password)) {
          sendJson(response, 401, { error: "invalid_credentials" });
          return;
        }
        loginAttempts.reset(clientAddress);
        const token = issueSessionToken(auth.sessionSecret, SESSION_TTL_MS, Date.now());
        sendJson(response, 200, { token, expiresInMs: SESSION_TTL_MS });
        return;
      }

      if (url.pathname === "/api/bootstrap" && request.method === "GET") {
        sendJson(response, 200, await bootstrapFresh());
        return;
      }

      if (url.pathname === "/api/registry/hosts" && request.method === "GET") {
        sendJson(response, 200, { hosts: hostRegistry?.snapshot() ?? [] });
        return;
      }

      if (url.pathname === "/api/registry/hosts" && request.method === "POST") {
        if (!hostRegistry) {
          sendJson(response, 404, { error: "registry_disabled" });
          return;
        }
        const host = hostRegistry.register(
          await readBody(request),
          observedClientAddress(request, trustedProxies),
        );
        sendJson(response, 200, {
          host: { id: host.id, lastSeenAt: host.lastSeenAt, expiresAt: host.expiresAt },
        });
        return;
      }

      const registeredHost = url.pathname.match(/^\/api\/registry\/hosts\/([^/]+)$/);
      if (registeredHost && request.method === "DELETE") {
        if (!hostRegistry) {
          sendJson(response, 404, { error: "registry_disabled" });
          return;
        }
        const removed = hostRegistry.unregister(decodeURIComponent(registeredHost[1]));
        sendJson(response, removed ? 200 : 404, { removed });
        return;
      }

      if (url.pathname === "/api/session-audit" && request.method === "GET") {
        sendJson(response, 200, await auditDurableSessions());
        return;
      }

      if (url.pathname === "/api/doctor" && request.method === "GET") {
        await refreshMachineStatuses(false);
        sendJson(response, 200, buildDoctorReport(state.snapshot(), machines, machineStatuses, await auditDurableSessions()));
        return;
      }

      if (url.pathname === "/api/agent-profile" && request.method === "GET") {
        response.setHeader("cache-control", "no-store");
        sendJson(response, 200, readAgentProfileBundle());
        return;
      }

      if (url.pathname === "/api/streams" && request.method === "GET") {
        await refreshStreamStatuses(false, true);
        sendJson(response, 200, { streams: streamStatuses });
        return;
      }

      const windowsBootstrap = url.pathname.match(/^\/api\/helpers\/windows\/([^/]+)\/bootstrap$/);
      if (windowsBootstrap && request.method === "GET") {
        const machineId = decodeURIComponent(windowsBootstrap[1]);
        const machine = machines.find((candidate) => candidate.id === machineId);
        if (!machine) {
          sendJson(response, 404, { error: "unknown_machine" });
          return;
        }
        if (machine.kind !== "powershell-ssh") {
          sendJson(response, 400, { error: "not_windows_machine" });
          return;
        }
        const startCwd = url.searchParams.get("WMUX_START_CWD") ?? undefined;
        const extraEnv: Record<string, string> = {};
        for (const key of windowsBootstrapEnvKeys) {
          const value = url.searchParams.get(key);
          if (value) extraEnv[key] = value;
        }
        if (machine.source !== "registered" && auth.token) {
          extraEnv.WMUX_TOKEN = auth.token;
        }
        response.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        });
        const bundleMachine = machine.source === "registered" ? { ...machine, agentToken: undefined } : machine;
        response.end(
          buildWindowsPowerShellBootstrap(
            machine,
            startCwd,
            extraEnv,
            undefined,
            machine.source === "registered" ? buildWindowsHelperBundle(bundleMachine, bindHost) : undefined,
          ),
        );
        return;
      }

      const windowsHelpers = url.pathname.match(/^\/api\/helpers\/windows\/([^/]+)$/);
      if (windowsHelpers && request.method === "GET") {
        const machineId = decodeURIComponent(windowsHelpers[1]);
        const machine = machines.find((candidate) => candidate.id === machineId);
        if (!machine) {
          sendJson(response, 404, { error: "unknown_machine" });
          return;
        }
        if (machine.kind !== "powershell-ssh") {
          sendJson(response, 400, { error: "not_windows_machine" });
          return;
        }
        const bundleMachine = machine.source === "registered" ? { ...machine, agentToken: undefined } : machine;
        sendJson(response, 200, buildWindowsHelperBundle(bundleMachine, bindHost));
        return;
      }

      const streamRequestStatus = url.pathname.match(/^\/api\/streams\/([^/]+)\/request$/);
      if (streamRequestStatus && request.method === "GET") {
        const machineId = decodeURIComponent(streamRequestStatus[1]);
        if (!machineExists(machines, machineId)) {
          sendJson(response, 404, { error: "unknown_machine" });
          return;
        }
        sendJson(response, 200, streamRequests.snapshot(machineId));
        return;
      }

      if (streamRequestStatus && request.method === "POST") {
        const machineId = decodeURIComponent(streamRequestStatus[1]);
        if (!machineExists(machines, machineId)) {
          sendJson(response, 404, { error: "unknown_machine" });
          return;
        }
        const body = (await readBody(request)) as { requestId?: string; ttlMs?: number };
        const requestId = body.requestId?.trim() || cryptoRandomId();
        const requestStatus = streamRequests.touch(machineId, requestId, body.ttlMs);
        streamMutationRevision += 1;
        await refreshStreamStatuses(true, true);
        sendJson(response, 200, {
          requestId,
          ...requestStatus,
          streams: streamStatuses,
        });
        return;
      }

      const streamRequestRelease = url.pathname.match(/^\/api\/streams\/([^/]+)\/request\/([^/]+)$/);
      if (streamRequestRelease && request.method === "DELETE") {
        const machineId = decodeURIComponent(streamRequestRelease[1]);
        if (!machineExists(machines, machineId)) {
          sendJson(response, 404, { error: "unknown_machine" });
          return;
        }
        const requestStatus = streamRequests.release(machineId, decodeURIComponent(streamRequestRelease[2]));
        streamMutationRevision += 1;
        await refreshStreamStatuses(true, true);
        sendJson(response, 200, {
          ...requestStatus,
          streams: streamStatuses,
        });
        return;
      }

      const cleanupSession = url.pathname.match(/^\/api\/session-audit\/(tmux|screen)\/([^/]+)$/);
      if (cleanupSession && request.method === "DELETE") {
        sendJson(
          response,
          200,
          await cleanupDurableSession(cleanupSession[1] as "tmux" | "screen", decodeURIComponent(cleanupSession[2])),
        );
        return;
      }

      if (url.pathname === "/api/settings" && request.method === "POST") {
        const body = (await readBody(request)) as {
          terminalFontSize?: number;
          terminalScrollbackRows?: number;
          colorScheme?: WmuxSettings["colorScheme"];
          machineAliases?: Record<string, string>;
        };
        settings.update({
          terminalFontSize: body.terminalFontSize,
          terminalScrollbackRows: body.terminalScrollbackRows,
          colorScheme: body.colorScheme,
          machineAliases: body.machineAliases,
        });
        sendJson(response, 200, { settings: settings.snapshot(), state: currentPayload() });
        return;
      }

      if (url.pathname === "/api/workspaces" && request.method === "POST") {
        const body = (await readBody(request)) as {
          machineId?: string;
          sourcePaneId?: string;
          createdBy?: "user" | "agent";
        };
        const machineId = resolveMachineId(machines, body.machineId);
        const sourcePane = body.sourcePaneId ? state.findPane(body.sourcePaneId) ?? undefined : undefined;
        const workspace = state.createWorkspace(
          machineId,
          await cwdForSourcePane(state, machines, sourcePane, machineId),
          body.createdBy === "agent" ? "agent" : "user",
        );
        sendJson(response, 201, { workspace, state: currentPayload() });
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
        sendJson(response, 201, { notification, state: currentPayload() });
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
          message?: string;
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
          message: body.message,
          body: body.body,
        });
        sendJson(response, 201, { ...result, state: currentPayload() });
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
        sendJson(response, 201, { run, state: currentPayload() });
        return;
      }

      if (url.pathname === "/api/media" && request.method === "POST") {
        const body = (await readBody(request, MAX_UPLOAD_BODY)) as {
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
        if (!isBase64Data(body.data.replace(/\s+/g, ""))) {
          sendJson(response, 400, { error: "invalid_media_data" });
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

      const panePasteImages = url.pathname.match(/^\/api\/panes\/([^/]+)\/paste-images$/);
      if (panePasteImages && request.method === "POST") {
        const paneId = decodeURIComponent(panePasteImages[1]);
        if (!sessions.hasLivePaneSession(paneId)) {
          sendJson(response, state.findPane(paneId) ? 409 : 404, {
            error: state.findPane(paneId) ? "paste_image_pane_not_live" : "pane_not_found",
          });
          return;
        }
        if ((request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase() !== "application/octet-stream") {
          throw new HttpError(415, "paste_image_content_type_required");
        }
        const staged = await sessions.stagePasteImage(paneId, await readBinaryBody(request));
        sendJson(response, 201, {
          stageId: staged.stageId,
          targetPath: staged.targetPath,
          mimeType: staged.mimeType,
          bytes: staged.bytes,
          expiresAt: staged.expiresAt,
        });
        return;
      }

      const panePasteImage = url.pathname.match(/^\/api\/panes\/([^/]+)\/paste-images\/([^/]+)$/);
      if (panePasteImage && request.method === "DELETE") {
        const removed = await sessions.discardPasteImage(
          decodeURIComponent(panePasteImage[1]),
          decodeURIComponent(panePasteImage[2]),
        );
        sendJson(response, removed ? 200 : 404, { removed });
        return;
      }

      const paneAttachment = url.pathname.match(/^\/api\/panes\/([^/]+)\/attachments$/);
      if (paneAttachment && request.method === "POST") {
        const paneId = decodeURIComponent(paneAttachment[1]);
        if (!state.findPane(paneId)) {
          sendJson(response, 404, { error: "pane_not_found" });
          return;
        }
        const body = (await readBody(request, MAX_UPLOAD_BODY)) as { name?: unknown; mimeType?: unknown; data?: unknown };
        if (typeof body.data !== "string" || !body.data.trim()) {
          sendJson(response, 400, { error: "missing_attachment_data" });
          return;
        }
        const mimeType = typeof body.mimeType === "string" ? body.mimeType.trim().toLowerCase() : "";
        const extension = attachmentExtensionForMimeType(mimeType);
        if (!extension) {
          sendJson(response, 400, { error: "unsupported_attachment_type" });
          return;
        }
        const encodedData = body.data.replace(/\s+/g, "");
        if (!isBase64Data(encodedData)) {
          sendJson(response, 400, { error: "invalid_attachment_data" });
          return;
        }
        const buffer = Buffer.from(encodedData, "base64");
        if (buffer.length === 0) {
          sendJson(response, 400, { error: "empty_attachment" });
          return;
        }
        if (buffer.length > maxAttachmentBytes) {
          sendJson(response, 413, { error: "attachment_too_large" });
          return;
        }
        const attachment = savePaneAttachment(paneId, {
          name: typeof body.name === "string" ? body.name : undefined,
          mimeType,
          extension,
          buffer,
        });
        sendJson(response, 201, { attachment });
        return;
      }

      const readNotification = url.pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
      if (readNotification && request.method === "POST") {
        state.markNotificationRead(readNotification[1]);
        sendJson(response, 200, currentPayload());
        return;
      }

      const readWorkspaceNotifications = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/notifications\/read$/);
      if (readWorkspaceNotifications && request.method === "POST") {
        state.markWorkspaceNotificationsRead(readWorkspaceNotifications[1]);
        sendJson(response, 200, currentPayload());
        return;
      }

      const closeWorkspace = url.pathname.match(/^\/api\/workspaces\/([^/]+)$/);
      if (closeWorkspace && request.method === "DELETE") {
        const removed = sessions.closeWorkspace(closeWorkspace[1]);
        sendJson(response, removed ? 200 : 409, { removed, state: currentPayload() });
        return;
      }

      const workspaceTitle = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/title$/);
      if (workspaceTitle && request.method === "POST") {
        const body = (await readBody(request)) as { title?: string; clear?: boolean };
        const workspace = body.clear
          ? state.clearWorkspaceTitle(workspaceTitle[1])
          : state.setWorkspaceTitle(workspaceTitle[1], body.title ?? "");
        sendJson(response, 200, { workspace, state: currentPayload() });
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
        sendJson(response, 200, { ...result, state: currentPayload() });
        return;
      }

      const tabs = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/tabs$/);
      if (tabs && request.method === "POST") {
        const body = (await readBody(request)) as { machineId?: string; sourcePaneId?: string };
        const snapshot = state.snapshot();
        const workspace = snapshot.workspaces.find((candidate) => candidate.id === tabs[1]);
        const sourcePane = body.sourcePaneId
          ? workspace?.tabs.flatMap((tab) => tab.panes).find((pane) => pane.id === body.sourcePaneId)
          : undefined;
        const machineId = resolveMachineId(machines, body.machineId, workspace?.machineId);
        const tab = state.createTab(tabs[1], machineId, await cwdForSourcePane(state, machines, sourcePane, machineId));
        sendJson(response, 201, { tab, state: currentPayload() });
        return;
      }

      const closeTab = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/tabs\/([^/]+)$/);
      if (closeTab && request.method === "DELETE") {
        const removed = sessions.closeTab(closeTab[1], closeTab[2]);
        sendJson(response, removed ? 200 : 409, { removed, state: currentPayload() });
        return;
      }

      const tabTitle = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/tabs\/([^/]+)\/title$/);
      if (tabTitle && request.method === "POST") {
        const body = (await readBody(request)) as { title?: string };
        const tab = state.setTabTitle(tabTitle[1], tabTitle[2], body.title ?? "");
        sendJson(response, 200, { tab, state: currentPayload() });
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
        const machineId = resolveMachineId(machines, body.machineId, sourcePane?.machineId);
        const tab = state.splitPane(
          split[1],
          body.paneId,
          body.direction,
          machineId,
          await cwdForSourcePane(state, machines, sourcePane, machineId),
        );
        sendJson(response, 201, { tab, state: currentPayload() });
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
        sendJson(response, 200, { tab, state: currentPayload() });
        return;
      }

      const paneInput = url.pathname.match(/^\/api\/panes\/([^/]+)\/input$/);
      if (paneInput && request.method === "POST") {
        const body = (await readBody(request)) as { data?: unknown; cols?: unknown; rows?: unknown };
        if (typeof body.data !== "string") {
          sendJson(response, 400, { error: "invalid_input" });
          return;
        }
        if (body.data.length > 256 * 1024) {
          sendJson(response, 413, { error: "input_too_large" });
          return;
        }
        const written = sessions.writePane(
          decodeURIComponent(paneInput[1]),
          body.data,
          typeof body.cols === "number" ? body.cols : undefined,
          typeof body.rows === "number" ? body.rows : undefined,
        );
        if (!written) {
          sendJson(response, 404, { error: "pane_not_found" });
          return;
        }
        sendJson(response, 200, currentPayload());
        return;
      }

      const readPaneNotifications = url.pathname.match(/^\/api\/panes\/([^/]+)\/notifications\/read$/);
      if (readPaneNotifications && request.method === "POST") {
        state.markPaneNotificationsRead(decodeURIComponent(readPaneNotifications[1]));
        sendJson(response, 200, currentPayload());
        return;
      }

      const closePane = url.pathname.match(/^\/api\/tabs\/([^/]+)\/panes\/([^/]+)$/);
      if (closePane && request.method === "DELETE") {
        const removed = sessions.closePane(closePane[2]);
        sendJson(response, removed ? 200 : 409, { removed, state: currentPayload() });
        return;
      }

      if (request.method === "GET") {
        const attachment = url.pathname.match(/^\/api\/attachments\/([^/]+)\/([^/]+)$/);
        if (attachment) {
          if (servePaneAttachment(decodeURIComponent(attachment[1]), decodeURIComponent(attachment[2]), response)) return;
          sendJson(response, 404, { error: "attachment_not_found" });
          return;
        }

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
      if (error instanceof HttpError || error instanceof HostRegistryError || error instanceof PasteImageStageError) {
        sendJson(response, error.status, { error: error.code });
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
  const onHealthChange = (reason: string) => broadcastSnapshot(reason);
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
    // WebSockets can't set an Authorization header from the browser, so the
    // token rides on the query string; enforce it before any handshake.
    if (!isAuthorized(auth, request, url)) {
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

const maxAttachmentBytes = 8 * 1024 * 1024;

const attachmentExtensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/heic": "heic",
  "image/heif": "heif",
};

interface SavedPaneAttachment {
  id: string;
  paneId: string;
  name: string;
  mimeType: string;
  bytes: number;
  url: string;
  createdAt: string;
}

const attachmentRoot = (): string =>
  path.resolve(process.env.WMUX_ATTACHMENT_DIR ?? path.join(os.homedir(), ".wmux", "attachments"));

const attachmentExtensionForMimeType = (mimeType: string): string | null =>
  attachmentExtensions[mimeType.toLowerCase()] ?? null;

const isBase64Data = (value: string): boolean =>
  value.length % 4 !== 1 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);

const savePaneAttachment = (
  paneId: string,
  input: { name?: string; mimeType: string; extension: string; buffer: Buffer },
): SavedPaneAttachment => {
  const paneSegment = safePathSegment(paneId, "pane");
  const id = `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const displayName = safeDisplayName(input.name, `pasted-image.${input.extension}`);
  const baseName = safeFileBaseName(displayName, "pasted-image");
  const fileName = `${id}-${baseName}.${input.extension}`;
  const paneDirectory = path.join(attachmentRoot(), paneSegment);
  fs.mkdirSync(paneDirectory, { recursive: true });
  fs.writeFileSync(path.join(paneDirectory, fileName), input.buffer, { flag: "wx" });
  return {
    id,
    paneId,
    name: displayName,
    mimeType: input.mimeType,
    bytes: input.buffer.length,
    url: `/api/attachments/${encodeURIComponent(paneSegment)}/${encodeURIComponent(fileName)}`,
    createdAt: new Date().toISOString(),
  };
};

const servePaneAttachment = (paneSegment: string, fileName: string, response: http.ServerResponse): boolean => {
  if (safePathSegment(paneSegment, "") !== paneSegment || path.basename(fileName) !== fileName) return false;
  if (!/^[A-Za-z0-9._-]+$/.test(fileName)) return false;
  const paneDirectory = path.resolve(attachmentRoot(), paneSegment);
  const filePath = path.resolve(paneDirectory, fileName);
  if (!filePath.startsWith(`${paneDirectory}${path.sep}`)) return false;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const stat = fs.statSync(filePath);
  response.writeHead(200, {
    "content-type": attachmentContentType(fileName),
    "content-length": String(stat.size),
    "cache-control": "private, max-age=86400",
    "x-content-type-options": "nosniff",
  });
  fs.createReadStream(filePath).pipe(response);
  return true;
};

const safeDisplayName = (name: string | undefined, fallback: string): string => {
  const trimmed = (name ?? "").trim();
  const baseName = trimmed ? path.basename(trimmed) : fallback;
  return baseName.replace(/[^\w .()[\]-]+/g, "-").replace(/\s+/g, " ").slice(0, 120) || fallback;
};

const safeFileBaseName = (name: string, fallback: string): string => {
  const withoutExtension = name.replace(/\.[^.]+$/, "");
  return safePathSegment(withoutExtension, fallback).slice(0, 80);
};

const safePathSegment = (value: string, fallback: string): string => {
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || fallback;
};

const attachmentContentType = (filePath: string): string => {
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".gif")) return "image/gif";
  if (filePath.endsWith(".webp")) return "image/webp";
  if (filePath.endsWith(".avif")) return "image/avif";
  if (filePath.endsWith(".bmp")) return "image/bmp";
  if (filePath.endsWith(".heic")) return "image/heic";
  if (filePath.endsWith(".heif")) return "image/heif";
  return "application/octet-stream";
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

const machineExists = (machines: MachineConfig[], machineId: string): boolean =>
  machines.some((machine) => machine.id === machineId);

const windowsBootstrapEnvKeys = [
  "WMUX_WORKSPACE_ID",
  "WMUX_WORKSPACE_NAME",
  "WMUX_TAB_ID",
  "WMUX_TAB_TITLE",
  "WMUX_PANE_ID",
  "KITTY_WINDOW_ID",
];

const cryptoRandomId = (): string =>
  `stream-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

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
