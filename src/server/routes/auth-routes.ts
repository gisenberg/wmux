import {
  issueSessionToken,
  verifyCredentials,
} from "../auth.js";
import { normalizeIpAddress, observedClientAddress } from "../proxy-address.js";
import {
  type ApiRoute,
  routePolicy,
} from "./route.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const authRoutes: readonly ApiRoute[] = [
  {
    id: "health",
    method: "GET",
    pattern: "/api/health",
    policy: routePolicy("health", "GET", "/api/health", "public"),
    handler: async ({ sendJson }) => {
      sendJson(200, { ok: true });
    },
  },
  {
    id: "auth-info",
    method: "GET",
    pattern: "/api/auth-info",
    policy: routePolicy("auth-info", "GET", "/api/auth-info", "public"),
    handler: async ({ deps, sendJson }) => {
      const { auth } = deps;
      sendJson(200, {
        authEnabled: auth.enabled,
        loginEnabled: auth.loginEnabled,
        browserAuthMode: auth.browserAuthMode ?? "shared-or-login",
      }, { "cache-control": "no-store" });
    },
  },
  {
    id: "login",
    method: "POST",
    pattern: "/api/login",
    policy: routePolicy("login", "POST", "/api/login", "public"),
    handler: async ({ deps, request, readJsonBody, sendJson }) => {
      const { auth, loginAttempts, trustedProxies } = deps;
      if (!auth.enabled || !auth.loginEnabled) {
        sendJson(404, { error: "login_disabled" }, { "cache-control": "no-store" });
        return;
      }
      const clientAddress = observedClientAddress(request, trustedProxies)
        ?? normalizeIpAddress(request.socket.remoteAddress)
        ?? "unknown";
      const attempt = loginAttempts.attempt(clientAddress);
      if (!attempt.allowed) {
        sendJson(
          429,
          { error: "login_rate_limited", retryAfterMs: attempt.retryAfterMs },
          {
            "retry-after": String(Math.max(1, Math.ceil(attempt.retryAfterMs / 1_000))),
            "cache-control": "no-store",
          },
        );
        return;
      }
      const body = (await readJsonBody()) as { username?: unknown; password?: unknown };
      if (typeof body.username !== "string" || typeof body.password !== "string") {
        sendJson(400, { error: "invalid_credentials_format" }, { "cache-control": "no-store" });
        return;
      }
      if (!await verifyCredentials(auth, body.username, body.password)) {
        sendJson(401, { error: "invalid_credentials" }, { "cache-control": "no-store" });
        return;
      }
      loginAttempts.reset(clientAddress);
      const token = issueSessionToken(auth.sessionSecret, SESSION_TTL_MS, Date.now());
      sendJson(200, { token, expiresInMs: SESSION_TTL_MS }, { "cache-control": "no-store" });
    },
  },
  {
    id: "auth-session",
    method: "GET",
    pattern: "/api/auth/session",
    policy: routePolicy(
      "auth-session",
      "GET",
      "/api/auth/session",
      "normal",
      undefined,
      true,
    ),
    handler: async ({ sendJson }) => {
      sendJson(200, { authenticated: true }, { "cache-control": "no-store" });
    },
  },
];
