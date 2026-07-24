import http from "node:http";
import https from "node:https";
import path from "node:path";
import type { ViteDevServer } from "vite";
import type { DelegationConfig } from "../shared/protocol.js";
import type { AuthConfig } from "./auth.js";
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
import { HttpError, type ServerDeps } from "./routes/route.js";
import { clientRoot } from "./static-files.js";

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
    settings,
    streamRequests,
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
    trustedProxies,
    loginAttempts,
    state,
    sessions,
    settings,
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
    dev: Boolean(options.dev),
    sessions,
    currentMachines,
    streamRequests,
    events,
  });

  server.on("close", () => {
    hostRegistry?.off("change", onRegistryChange);
    events.dispose();
  });

  return setupDevServer().then(() => server);
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
