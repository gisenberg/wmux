import assert from "node:assert/strict";
import test from "node:test";
import {
  HTTP_ROUTE_POLICIES,
  authorizeHttpPrincipal,
  authorizeWebSocketPrincipal,
  classifyHttpRoute,
  classifyWebSocket,
} from "../src/server/auth-policy.js";
import type { AuthConfig, AuthPrincipal } from "../src/server/auth.js";

const auth: AuthConfig = {
  enabled: true,
  token: "legacy",
  loginEnabled: true,
  sessionSecret: "session",
  browserAuthMode: "login-only",
  automationToken: "automation",
  helperToken: "helper",
};
const principal = (kind: AuthPrincipal["kind"]): AuthPrincipal => kind === "browser-session"
  ? { kind, expiresAt: Date.now() + 1_000 }
  : kind === "registered-host"
    ? { kind, machineId: "machine" }
    : { kind } as AuthPrincipal;

const routeCases: Array<[string, string, string]> = [
  ["health", "GET", "/api/health"], ["auth-info", "GET", "/api/auth-info"], ["login", "POST", "/api/login"],
  ["auth-session", "GET", "/api/auth/session"], ["bootstrap", "GET", "/api/bootstrap"],
  ["registry-list", "GET", "/api/registry/hosts"], ["registry-register", "POST", "/api/registry/hosts"],
  ["registry-delete", "DELETE", "/api/registry/hosts/host"], ["session-audit", "GET", "/api/session-audit"],
  ["doctor", "GET", "/api/doctor"], ["agent-profile", "GET", "/api/agent-profile"], ["streams", "GET", "/api/streams"],
  ["windows-bootstrap", "GET", "/api/helpers/windows/win/bootstrap"], ["windows-helpers", "GET", "/api/helpers/windows/win"],
  ["stream-request-status", "GET", "/api/streams/host/request"], ["stream-request", "POST", "/api/streams/host/request"],
  ["stream-release", "DELETE", "/api/streams/host/request/request"], ["session-cleanup", "DELETE", "/api/session-audit/tmux/name"],
  ["settings", "POST", "/api/settings"], ["workspace-create", "POST", "/api/workspaces"],
  ["workspace-reorder", "POST", "/api/workspaces/reorder"], ["notification-create", "POST", "/api/notifications"],
  ["agent-event", "POST", "/api/agent-events"], ["run-event", "POST", "/api/run-events"],
  ["media", "POST", "/api/media"], ["clipboard", "POST", "/api/clipboard"],
  ["pane-paste-image-stage", "POST", "/api/panes/pane/paste-images"],
  ["pane-paste-image-delete", "DELETE", "/api/panes/pane/paste-images/stage"],
  ["pane-attachment-create", "POST", "/api/panes/pane/attachments"],
  ["notification-read", "POST", "/api/notifications/n/read"],
  ["workspace-notifications-read", "POST", "/api/workspaces/ws/notifications/read"],
  ["workspace-close", "DELETE", "/api/workspaces/ws"], ["workspace-title", "POST", "/api/workspaces/ws/title"],
  ["workspace-auto-title", "POST", "/api/workspaces/ws/auto-title"], ["tab-create", "POST", "/api/workspaces/ws/tabs"],
  ["tab-close", "DELETE", "/api/workspaces/ws/tabs/tab"], ["tab-title", "POST", "/api/workspaces/ws/tabs/tab/title"],
  ["pane-split", "POST", "/api/tabs/tab/split"], ["split-ratio", "POST", "/api/tabs/tab/split-ratio"],
  ["pane-input", "POST", "/api/panes/pane/input"], ["pane-notifications-read", "POST", "/api/panes/pane/notifications/read"],
  ["pane-close", "DELETE", "/api/tabs/tab/panes/pane"], ["attachment-read", "GET", "/api/attachments/pane/file"],
];

test("every reviewed API route has one exact method/pattern policy", () => {
  assert.equal(routeCases.length, HTTP_ROUTE_POLICIES.length);
  assert.deepEqual(routeCases.map(([id, method, path]) => classifyHttpRoute(method, path)?.id), routeCases.map(([id]) => id));
  assert.equal(classifyHttpRoute("GET", "/api/workspaces"), undefined);
  assert.equal(classifyHttpRoute("POST", "/api/agent-events/extra"), undefined);
  assert.equal(classifyHttpRoute("GET", "/api/future-route"), undefined);
});

test("browser, automation, helper, registration, and legacy policies are separated", () => {
  const policy = (method: string, path: string) => {
    const found = classifyHttpRoute(method, path);
    assert.ok(found);
    return found;
  };
  assert.equal(authorizeHttpPrincipal(auth, principal("browser-session"), policy("POST", "/api/settings")), true);
  assert.equal(authorizeHttpPrincipal(auth, principal("browser-session"), policy("GET", "/api/helpers/windows/win")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("browser-session"), policy("GET", "/api/helpers/windows/win/bootstrap")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("automation"), policy("GET", "/api/bootstrap")), true);
  assert.equal(authorizeHttpPrincipal(auth, principal("automation"), policy("POST", "/api/notifications")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("helper"), policy("POST", "/api/notifications")), true);
  assert.equal(authorizeHttpPrincipal(auth, principal("helper"), policy("GET", "/api/streams/host/request")), true);
  assert.equal(authorizeHttpPrincipal(auth, principal("helper"), policy("POST", "/api/streams/host/request")), true);
  assert.equal(authorizeHttpPrincipal(auth, principal("helper"), policy("DELETE", "/api/streams/host/request/request")), true);
  assert.equal(authorizeHttpPrincipal(auth, principal("automation"), policy("POST", "/api/streams/host/request")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("automation"), policy("DELETE", "/api/streams/host/request/request")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("helper"), policy("POST", "/api/workspaces")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("registration"), policy("POST", "/api/registry/hosts")), true);
  assert.equal(authorizeHttpPrincipal(auth, principal("browser-session"), policy("POST", "/api/registry/hosts")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("registered-host"), policy("GET", "/api/helpers/windows/win/bootstrap")), true);
  assert.equal(authorizeHttpPrincipal(auth, principal("registered-host"), policy("GET", "/api/bootstrap")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("automation"), policy("GET", "/api/auth/session")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("legacy-shared"), policy("GET", "/api/bootstrap")), false);
  assert.equal(authorizeHttpPrincipal({ ...auth, browserAuthMode: "shared-or-login" }, principal("legacy-shared"), policy("GET", "/api/bootstrap")), true);
});

test("WebSocket classes deny unknown paths and reserve output-only access for automation", () => {
  assert.equal(classifyWebSocket("/ws/events"), "events");
  assert.equal(classifyWebSocket("/ws/panes/pane/output"), "pane-output");
  assert.equal(classifyWebSocket("/ws/panes/pane"), "pane-interactive");
  assert.equal(classifyWebSocket("/ws/future"), undefined);
  assert.equal(authorizeWebSocketPrincipal(auth, principal("automation"), "pane-output"), true);
  assert.equal(authorizeWebSocketPrincipal(auth, principal("automation"), "events"), false);
  assert.equal(authorizeWebSocketPrincipal(auth, principal("helper"), "pane-output"), false);
  assert.equal(authorizeWebSocketPrincipal(auth, principal("browser-session"), "pane-interactive"), true);
  assert.equal(authorizeWebSocketPrincipal(auth, principal("legacy-shared"), "events"), false);
  assert.equal(authorizeWebSocketPrincipal({ ...auth, browserAuthMode: "shared-or-login" }, principal("legacy-shared"), "events"), true);
});
