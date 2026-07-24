import type { AuthConfig, AuthPrincipal } from "./auth.js";
import { apiRoutes } from "./routes/index.js";

type ScopedPrincipal = "automation" | "helper";
export type RouteAccess = "public" | "normal" | "registration";

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

export const HTTP_ROUTE_POLICIES: readonly HttpRoutePolicy[] =
  apiRoutes.map((route) => route.policy);

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
