import type http from "node:http";
import type { AgentSessionService } from "../agent-sessions.js";
import type { AuthConfig, AuthPrincipal } from "../auth.js";
import type { HttpRoutePolicy } from "../auth-policy.js";
import type { HostRegistry } from "../host-registry.js";
import type { LoginAttemptThrottle } from "../login-throttle.js";
import type { RepositoryReviewService } from "../repository-review.js";
import type { SessionManager } from "../session-manager.js";
import type { SettingsStore } from "../settings.js";
import type { StateStore } from "../state.js";
import type { StreamRequestStore } from "../streams.js";
import type {
  MachineConfig,
  MachineStatus,
  PaneState,
  StreamStatus,
} from "../types.js";

export type ApiMethod = "GET" | "POST" | "PUT" | "DELETE";

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

export interface ServerDeps {
  bindHost: string;
  auth: AuthConfig;
  agentSessions: AgentSessionService;
  trustedProxies: ReadonlySet<string>;
  loginAttempts: LoginAttemptThrottle;
  state: StateStore;
  sessions: SessionManager;
  settings: SettingsStore;
  hostRegistry?: HostRegistry;
  streamRequests: StreamRequestStore;
  repositoryReviews: RepositoryReviewService;
  currentMachines: () => MachineConfig[];
  currentPayload: () => unknown;
  bootstrapFresh: () => Promise<unknown>;
  refreshMachineStatuses: (publish?: boolean, force?: boolean) => Promise<void>;
  refreshStreamStatuses: (publish?: boolean, force?: boolean) => Promise<void>;
  getMachineStatuses: () => MachineStatus[];
  getStreamStatuses: () => StreamStatus[];
  markStreamMutation: () => void;
  resolveMachineId: (
    machines: MachineConfig[],
    requested?: string,
    fallback?: string,
  ) => string;
  cwdForSourcePane: (
    machines: MachineConfig[],
    sourcePane: PaneState | undefined,
    targetMachineId: string,
  ) => Promise<string | undefined>;
}

export interface RouteContext {
  url: URL;
  request: http.IncomingMessage;
  response: http.ServerResponse;
  principal: AuthPrincipal;
  machines: MachineConfig[];
  match?: RegExpMatchArray;
  deps: ServerDeps;
  sendJson: (
    status: number,
    payload: unknown,
    headers?: Record<string, string>,
  ) => void;
  readJsonBody: (maxBytes?: number) => Promise<unknown>;
  readBinaryBody: (maxBytes?: number) => Promise<Buffer>;
}

export interface ApiRoute {
  id: string;
  method: ApiMethod;
  pattern: RegExp | string;
  policy: HttpRoutePolicy;
  handler: (ctx: RouteContext) => Promise<void>;
}

const exactPattern = (pattern: string): RegExp =>
  new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

export const routePolicy = (
  id: string,
  method: ApiMethod,
  pattern: RegExp | string,
  access: HttpRoutePolicy["access"] = "normal",
  scoped?: HttpRoutePolicy["scoped"],
  browserSessionOnly = false,
  registeredHost = false,
  browserDenied = false,
): HttpRoutePolicy => ({
  id,
  method,
  pattern: typeof pattern === "string" ? exactPattern(pattern) : pattern,
  access,
  scoped,
  browserSessionOnly,
  registeredHost,
  browserDenied,
});

export interface MatchedApiRoute {
  route: ApiRoute;
  match?: RegExpMatchArray;
}

export const matchApiRoute = (
  routes: readonly ApiRoute[],
  method: string | undefined,
  pathname: string,
): MatchedApiRoute | undefined => {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (typeof route.pattern === "string") {
      if (route.pattern === pathname) return { route };
      continue;
    }
    const match = pathname.match(route.pattern);
    if (match) return { route, match };
  }
  return undefined;
};
