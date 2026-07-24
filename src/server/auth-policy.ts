import type { AuthConfig, AuthPrincipal } from "./auth.js";
import type { HttpRoutePolicy } from "./routes/route.js";
import type { WebSocketClass } from "./websocket-route.js";

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
