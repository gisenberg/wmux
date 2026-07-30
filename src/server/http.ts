import http from "node:http";
import https from "node:https";
import path from "node:path";
import type { ViteDevServer } from "vite";
import type { DelegationConfig } from "../shared/protocol.js";
import { AgentFollowUpService } from "./agent-follow-up.js";
import { AgentSessionService } from "./agent-sessions.js";
import type { AuthConfig } from "./auth.js";
import { BrowserSessionStore } from "./browser-session-store.js";
import { ScopedCredentialStore } from "./scoped-credential-store.js";
import {
  EventBroadcastRuntime,
  HEALTH_EPOCH_PROCESS_STRIDE,
  PROCESS_HEALTH_EPOCH_BASE,
  healthEpochForProcessStart,
  nextHealthEpoch,
} from "./event-broadcast.js";
import type { HostRegistry } from "./host-registry.js";
import { LoginAttemptThrottle } from "./login-throttle.js";
import { readDurableSessionCwd } from "./durable-session.js";
import { resolveMachineStatuses } from "./machines.js";
import { createRequestHandler } from "./request-dispatch.js";
import { RepositoryReviewService } from "./repository-review.js";
import { resolveStreamStatuses, StreamRequestStore } from "./streams.js";
import type {
  KeybindingMap,
  MachineConfig,
  MachineSource,
  PaneState,
} from "./types.js";
import { installWebSocketUpgrade } from "./ws-upgrade.js";
import type { StateStore } from "./state.js";
import type { SessionManager } from "./session-manager.js";
import type { SettingsStore } from "./settings.js";
import type { StaticMachineStore } from "./static-machine-store.js";
import { HttpError, type ServerDeps } from "./routes/route.js";
import { clientRoot } from "./static-files.js";
import {
  AgentInputCredentialStore,
  issueAgentInputRegistrationCapabilityForPane,
  loadOrCreateAgentInputSecret,
} from "./agent-input-credential-store.js";
import { AgentInputRequestStore } from "./agent-input-request-store.js";
import { AgentInputRelay } from "./agent-input-relay.js";

export { readBinaryBody } from "./request-dispatch.js";

export {
  HEALTH_EPOCH_PROCESS_STRIDE,
  PROCESS_HEALTH_EPOCH_BASE,
  healthEpochForProcessStart,
  nextHealthEpoch,
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
    staticMachines?: StaticMachineStore;
    registrationToken?: string;
    trustedProxies?: ReadonlySet<string>;
    terminalFontFamily?: string;
    healthRefreshIntervals?: {
      agentNotifications?: number;
      machines?: number;
      streams?: number;
    };
    healthResolvers?: {
      machines?: typeof resolveMachineStatuses;
      streams?: typeof resolveStreamStatuses;
    };
    keybindings?: KeybindingMap;
    repositoryReviews?: RepositoryReviewService;
    agentSessions?: AgentSessionService;
    agentFollowUps?: AgentFollowUpService;
    delegation?: DelegationConfig;
    browserSessions?: BrowserSessionStore;
    scopedCredentials?: ScopedCredentialStore;
    browserSessionCookieSecure?: boolean;
    agentInputCredentials?: AgentInputCredentialStore;
    agentInputRequests?: AgentInputRequestStore;
    agentInputRelay?: AgentInputRelay;
    agentInputEnabled?: boolean;
  },
): Promise<WmuxHttpServer> => {
  const {
    auth,
    hostRegistry,
    registrationToken,
    staticMachines,
  } = options;
  const machineStatusResolver = options.healthResolvers?.machines ?? resolveMachineStatuses;
  const streamStatusResolver = options.healthResolvers?.streams ?? resolveStreamStatuses;
  const trustedProxies = options.trustedProxies ?? new Set<string>();
  const loginAttempts = new LoginAttemptThrottle();
  const browserSessionCookieSecure = options.browserSessionCookieSecure
    ?? (
      Boolean(options.tls)
      || isHttpsUrl(process.env.WMUX_PUBLIC_URL)
    );
  const browserSessions = (auth.browserAuthMode ?? "shared-or-login") === "login-only"
    ? options.browserSessions
      ?? BrowserSessionStore.persistent(
        auth.sessionSecret,
        path.join(state.storageDirectory(), "browser-sessions.json"),
      )
    : undefined;
  const scopedCredentials = auth.enabled
    && (auth.automationToken || auth.helperToken)
    ? options.scopedCredentials
      ?? new ScopedCredentialStore(
        auth,
        path.join(state.storageDirectory(), "scoped-credentials.json"),
      )
    : undefined;
  const currentMachines = typeof machineSource === "function" ? machineSource : () => machineSource;
  const repositoryReviews = options.repositoryReviews
    ?? new RepositoryReviewService(state, machineSource);
  const agentSessions = options.agentSessions
    ?? sessions.agentSessions
    ?? new AgentSessionService(state);
  const agentFollowUps = options.agentFollowUps
    ?? new AgentFollowUpService(state, agentSessions, repositoryReviews);
  const root = clientRoot();
  const streamRequests = new StreamRequestStore();
  const agentInputSecret = options.agentInputCredentials && options.agentInputRequests
    ? undefined
    : loadOrCreateAgentInputSecret(
      process.env.WMUX_AGENT_INPUT_SECRET_PATH
      ?? path.join(state.storageDirectory(), "agent-input-secret"),
    );
  const agentInputCredentials = options.agentInputCredentials
    ?? new AgentInputCredentialStore(
      process.env.WMUX_AGENT_INPUT_CREDENTIAL_PATH
      ?? path.join(state.storageDirectory(), "agent-input-credentials.json"),
      { hashKey: agentInputSecret! },
    );
  const agentInputRequests = options.agentInputRequests
    ?? new AgentInputRequestStore(
      process.env.WMUX_AGENT_INPUT_REQUEST_PATH
      ?? path.join(state.storageDirectory(), "agent-input-requests.json"),
      { answerDigestKey: agentInputSecret! },
    );
  const agentInputEnabled = options.agentInputEnabled ?? process.env.WMUX_AGENT_INPUT_ENABLED !== "0";
  agentInputCredentials.prune();
  agentInputRequests.prune();
  const agentInputRelay = options.agentInputRelay
    ?? new AgentInputRelay(agentInputRequests, agentInputCredentials, {
      enabled: agentInputEnabled,
      isPaneLive: (source) => {
        const context = state.findPaneContext(source.context.paneId);
        return Boolean(context
          && context.workspace.id === source.context.workspaceId
          && context.tab.id === source.context.tabId
          && context.pane.machineId === source.context.machineId);
      },
    });
  sessions.setAgentInputCapabilityIssuer?.(agentInputEnabled
    ? (paneId) => issueAgentInputRegistrationCapabilityForPane(agentInputCredentials, state, paneId)
    : undefined);
  const reconcileAgentInputSources = (): void => {
    for (const source of agentInputCredentials.snapshot().sources) {
      if (source.revokedAt !== undefined) continue;
      const context = state.findPaneContext(source.context.paneId);
      const live = Boolean(context
        && context.workspace.id === source.context.workspaceId
        && context.tab.id === source.context.tabId
        && context.pane.machineId === source.context.machineId);
      if (!live) {
        agentInputRequests.resolvePane(source.context.paneId);
        agentInputCredentials.revoke(source.id);
      }
    }
  };
  state.on("change", reconcileAgentInputSources);
  reconcileAgentInputSources();
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

  const events = new EventBroadcastRuntime({
    bindHost,
    state,
    agentSessions,
    settings,
    streamRequests,
    agentInputRequests,
    currentMachines,
    machineStatusResolver,
    streamStatusResolver,
    terminalFontFamily: options.terminalFontFamily,
    keybindings: options.keybindings,
    delegation: options.delegation,
    refreshIntervals: options.healthRefreshIntervals,
  });
  const serverDeps: ServerDeps = {
    bindHost,
    auth,
    browserSessions,
    scopedCredentials,
    agentInputRequests,
    agentInputCredentials,
    agentInputRelay,
    agentInputEnabled,
    issueAgentInputRegistrationCapability: (paneId) =>
      issueAgentInputRegistrationCapabilityForPane(agentInputCredentials, state, paneId),
    browserSessionCookieSecure,
    agentFollowUps,
    agentSessions,
    trustedProxies,
    loginAttempts,
    state,
    sessions,
    settings,
    staticMachines,
    hostRegistry,
    streamRequests,
    repositoryReviews,
    currentMachines,
    currentPayload: events.currentPayload,
    bootstrapFresh: events.bootstrapFresh,
    refreshMachineStatuses: events.refreshMachineStatuses,
    refreshStreamStatuses: events.refreshStreamStatuses,
    getMachineStatuses: events.getMachineStatuses,
    getStreamStatuses: events.getStreamStatuses,
    markStreamMutation: events.markStreamMutation,
    resolveMachineId,
    cwdForSourcePane: (machines, sourcePane, targetMachineId) =>
      cwdForSourcePane(state, machines, sourcePane, targetMachineId),
  };

  const onRegistryChange = (): void => {
    state.updateMachines(currentMachines());
    events.refreshInBackground(
      "machines",
      () => events.refreshMachineStatuses(true),
    );
    events.refreshInBackground(
      "streams",
      () => events.refreshStreamStatuses(true),
    );
  };
  hostRegistry?.on("change", onRegistryChange);

  const handleRequest = createRequestHandler({
    bindHost,
    protocol,
    auth,
    browserSessions,
    scopedCredentials,
    agentInputCredentials,
    registrationToken,
    hostRegistry,
    currentMachines,
    deps: serverDeps,
    root,
    getVite: () => vite,
  });

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

  installWebSocketUpgrade({
    server,
    bindHost,
    protocol,
    auth,
    browserSessions,
    scopedCredentials,
    trustedProxies,
    dev: Boolean(options.dev),
    sessions,
    currentMachines,
    streamRequests,
    events,
  });

  server.on("close", () => {
    hostRegistry?.off("change", onRegistryChange);
    state.off("change", reconcileAgentInputSources);
    agentFollowUps.dispose();
    agentInputRelay.dispose();
    agentInputRequests.dispose();
    agentInputCredentials.dispose();
    events.dispose();
  });
  server.on("wmux-shutdown", () => {
    agentFollowUps.dispose();
    agentInputRelay.dispose();
    agentInputRequests.dispose();
    agentInputCredentials.dispose();
  });

  return setupDevServer().then(() => server);
};

const isHttpsUrl = (value: string | undefined): boolean => {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
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
