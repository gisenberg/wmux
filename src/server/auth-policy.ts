import type { AuthConfig, AuthPrincipal } from "./auth.js";

type ScopedPrincipal = "automation" | "helper";
type RouteAccess = "public" | "normal" | "registration";

export interface HttpRoutePolicy {
  id: string;
  method: string;
  pattern: RegExp;
  access: RouteAccess;
  scoped?: readonly ScopedPrincipal[];
  browserSessionOnly?: boolean;
  browserDenied?: boolean;
  registeredHost?: boolean;
}

const exact = (path: string): RegExp => new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const route = (
  id: string,
  method: string,
  pattern: string | RegExp,
  access: RouteAccess = "normal",
  scoped?: readonly ScopedPrincipal[],
  browserSessionOnly = false,
  registeredHost = false,
  browserDenied = false,
): HttpRoutePolicy => ({ id, method, pattern: typeof pattern === "string" ? exact(pattern) : pattern, access, scoped, browserSessionOnly, browserDenied, registeredHost });

export const HTTP_ROUTE_POLICIES: readonly HttpRoutePolicy[] = [
  route("health", "GET", "/api/health", "public"),
  route("auth-info", "GET", "/api/auth-info", "public"),
  route("login", "POST", "/api/login", "public"),
  route("auth-session", "GET", "/api/auth/session", "normal", undefined, true),
  route("bootstrap", "GET", "/api/bootstrap", "normal", ["automation"]),
  route("registry-list", "GET", "/api/registry/hosts"),
  route("registry-register", "POST", "/api/registry/hosts", "registration"),
  route("registry-delete", "DELETE", /^\/api\/registry\/hosts\/[^/]+$/),
  route("session-audit", "GET", "/api/session-audit"),
  route("doctor", "GET", "/api/doctor", "normal", ["helper"]),
  route("agent-profile", "GET", "/api/agent-profile", "normal", ["helper"]),
  route("streams", "GET", "/api/streams"),
  route("windows-bootstrap", "GET", /^\/api\/helpers\/windows\/[^/]+\/bootstrap$/, "normal", ["helper"], false, true, true),
  route("windows-helpers", "GET", /^\/api\/helpers\/windows\/[^/]+$/, "normal", ["helper"], false, false, true),
  route("stream-request-status", "GET", /^\/api\/streams\/[^/]+\/request$/, "normal", ["helper"]),
  route("stream-request", "POST", /^\/api\/streams\/[^/]+\/request$/, "normal", ["helper"]),
  route("stream-release", "DELETE", /^\/api\/streams\/[^/]+\/request\/[^/]+$/, "normal", ["helper"]),
  route("session-cleanup", "DELETE", /^\/api\/session-audit\/(tmux|screen)\/[^/]+$/),
  route("settings", "POST", "/api/settings"),
  route("workspace-create", "POST", "/api/workspaces", "normal", ["automation"]),
  route("workspace-reorder", "POST", "/api/workspaces/reorder"),
  route("notification-create", "POST", "/api/notifications", "normal", ["helper"]),
  route("agent-event", "POST", "/api/agent-events", "normal", ["automation", "helper"]),
  route("run-event", "POST", "/api/run-events", "normal", ["helper"]),
  route("media", "POST", "/api/media", "normal", ["helper"]),
  route("clipboard", "POST", "/api/clipboard", "normal", ["helper"]),
  route("pane-paste-image-stage", "POST", /^\/api\/panes\/[^/]+\/paste-images$/),
  route("pane-paste-image-delete", "DELETE", /^\/api\/panes\/[^/]+\/paste-images\/[^/]+$/),
  route("pane-attachment-create", "POST", /^\/api\/panes\/[^/]+\/attachments$/),
  route("notification-read", "POST", /^\/api\/notifications\/[^/]+\/read$/),
  route("workspace-notifications-read", "POST", /^\/api\/workspaces\/[^/]+\/notifications\/read$/),
  route("workspace-close", "DELETE", /^\/api\/workspaces\/[^/]+$/, "normal", ["automation"]),
  route("workspace-title", "POST", /^\/api\/workspaces\/[^/]+\/title$/, "normal", ["automation", "helper"]),
  route("workspace-auto-title", "POST", /^\/api\/workspaces\/[^/]+\/auto-title$/, "normal", ["helper"]),
  route("tab-create", "POST", /^\/api\/workspaces\/[^/]+\/tabs$/, "normal", ["automation"]),
  route("tab-close", "DELETE", /^\/api\/workspaces\/[^/]+\/tabs\/[^/]+$/, "normal", ["automation"]),
  route("tab-title", "POST", /^\/api\/workspaces\/[^/]+\/tabs\/[^/]+\/title$/, "normal", ["automation"]),
  route("pane-split", "POST", /^\/api\/tabs\/[^/]+\/split$/),
  route("split-ratio", "POST", /^\/api\/tabs\/[^/]+\/split-ratio$/),
  route("pane-input", "POST", /^\/api\/panes\/[^/]+\/input$/, "normal", ["automation"]),
  route("pane-notifications-read", "POST", /^\/api\/panes\/[^/]+\/notifications\/read$/),
  route("pane-close", "DELETE", /^\/api\/tabs\/[^/]+\/panes\/[^/]+$/),
  route("attachment-read", "GET", /^\/api\/attachments\/[^/]+\/[^/]+$/),
];

export const classifyHttpRoute = (method: string | undefined, pathname: string): HttpRoutePolicy | undefined =>
  HTTP_ROUTE_POLICIES.find((candidate) => candidate.method === method && candidate.pattern.test(pathname));

export const authorizeHttpPrincipal = (
  auth: AuthConfig,
  principal: AuthPrincipal,
  policy: HttpRoutePolicy,
): boolean => {
  if (policy.access === "public") return true;
  if (policy.access === "registration") return principal.kind === "registration";
  if (principal.kind === "registered-host") return Boolean(policy.registeredHost);
  if (!auth.enabled) return true;
  if (policy.browserSessionOnly) return principal.kind === "browser-session";
  if (principal.kind === "browser-session") return !policy.browserDenied;
  if (principal.kind === "legacy-shared") return (auth.browserAuthMode ?? "shared-or-login") === "shared-or-login";
  return (principal.kind === "automation" || principal.kind === "helper")
    && Boolean(policy.scoped?.includes(principal.kind));
};

export type WebSocketClass = "events" | "pane-output" | "pane-interactive";

export const classifyWebSocket = (pathname: string): WebSocketClass | undefined => {
  if (pathname === "/ws/events") return "events";
  if (/^\/ws\/panes\/[^/]+\/output$/.test(pathname)) return "pane-output";
  if (/^\/ws\/panes\/[^/]+$/.test(pathname)) return "pane-interactive";
  return undefined;
};

export const authorizeWebSocketPrincipal = (
  auth: AuthConfig,
  principal: AuthPrincipal,
  socketClass: WebSocketClass,
): boolean => {
  if (!auth.enabled) return true;
  if (principal.kind === "browser-session") return true;
  if (principal.kind === "legacy-shared") return (auth.browserAuthMode ?? "shared-or-login") === "shared-or-login";
  return socketClass === "pane-output" && principal.kind === "automation";
};
