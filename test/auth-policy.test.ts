import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeHttpPrincipal,
  authorizeWebSocketPrincipal,
} from "../src/server/auth-policy.js";
import type { AuthConfig, AuthPrincipal } from "../src/server/auth.js";
import {
  HTTP_ROUTE_POLICIES,
  classifyHttpRoute,
} from "../src/server/routes/index.js";
import { classifyWebSocket } from "../src/server/websocket-route.js";

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
  ["auth-session", "GET", "/api/auth/session"],
  ["auth-sessions", "GET", "/api/auth/sessions"],
  ["auth-session-revoke", "DELETE", "/api/auth/sessions/session"],
  ["auth-credentials", "GET", "/api/auth/credentials"],
  ["auth-credential-rotate", "POST", "/api/auth/credentials/helper/rotate"],
  ["bootstrap", "GET", "/api/bootstrap"],
  ["codex-binding-issue", "POST", "/api/codex-bindings"],
  ["codex-binding-resolve", "POST", "/api/codex-bindings/resolve"],
  ["codex-binding-title", "POST", "/api/codex-bindings/title"],
  ["agent-session-timeline", "GET", "/api/agent-sessions/session"],
  ["agent-session-follow-up", "POST", "/api/agent-sessions/session/turns"],
  ["agent-input-registration-challenge", "POST", "/api/agent-input/sources/challenge"],
  ["agent-input-source-challenge", "POST", "/api/agent-input/sources/source/challenge"],
  ["agent-input-source-register", "POST", "/api/agent-input/sources/register"],
  ["agent-input-source-refresh", "POST", "/api/agent-input/sources/source/refresh"],
  ["agent-input-request-capture", "POST", "/api/agent-input/sources/source/requests"],
  ["agent-input-native-list-reconcile", "POST", "/api/agent-input/sources/source/native-list"],
  ["agent-input-delivery-poll", "GET", "/api/agent-input/sources/source/deliveries"],
  ["agent-input-delivery-start", "POST", "/api/agent-input/sources/source/deliveries/delivery/start"],
  ["agent-input-delivery-ack", "POST", "/api/agent-input/sources/source/deliveries/delivery/ack"],
  ["agent-input-native-pending-reconcile", "POST", "/api/agent-input/sources/source/requests/request/pending"],
  ["agent-input-native-resolve", "POST", "/api/agent-input/sources/source/requests/request/resolve"],
  ["agent-input-answer", "POST", "/api/agent-input/requests/request/answer"],
  ["delegation-status", "GET", "/api/delegations/run"],
  ["machine-management-list", "GET", "/api/machines/manage"],
  ["machine-management-create", "POST", "/api/machines"],
  ["machine-management-update", "PUT", "/api/machines/host"],
  ["machine-management-delete", "DELETE", "/api/machines/host"],
  ["registry-update", "PUT", "/api/registry/hosts/host"],
  ["registry-list", "GET", "/api/registry/hosts"], ["registry-register", "POST", "/api/registry/hosts"],
  ["registry-delete", "DELETE", "/api/registry/hosts/host"], ["session-audit", "GET", "/api/session-audit"],
  ["doctor", "GET", "/api/doctor"], ["streams", "GET", "/api/streams"],
  ["windows-bootstrap", "GET", "/api/helpers/windows/win/bootstrap"], ["windows-helpers", "GET", "/api/helpers/windows/win"],
  ["stream-request-status", "GET", "/api/streams/host/request"], ["stream-request", "POST", "/api/streams/host/request"],
  ["stream-release", "DELETE", "/api/streams/host/request/request"], ["session-cleanup", "DELETE", "/api/session-audit/tmux/name"],
  ["settings", "POST", "/api/settings"], ["workspace-create", "POST", "/api/workspaces"],
  ["workspace-cleanup-configure", "POST", "/api/workspaces/ws/cleanup"],
  ["workspace-reorder", "POST", "/api/workspaces/reorder"], ["notification-create", "POST", "/api/notifications"],
  ["agent-event", "POST", "/api/agent-events"], ["run-event", "POST", "/api/run-events"],
  ["media", "POST", "/api/media"], ["clipboard", "POST", "/api/clipboard"],
  ["pane-kitty-graphics-source", "POST", "/api/panes/pane/kitty-graphics/source"],
  ["pane-paste-image-stage", "POST", "/api/panes/pane/paste-images"],
  ["pane-paste-image-delete", "DELETE", "/api/panes/pane/paste-images/stage"],
  ["pane-attachment-create", "POST", "/api/panes/pane/attachments"],
  ["notification-read", "POST", "/api/notifications/n/read"],
  ["workspace-notifications-read", "POST", "/api/workspaces/ws/notifications/read"],
  ["workspace-close-schedule", "POST", "/api/workspaces/ws/pending-close"],
  ["workspace-close-cancel", "DELETE", "/api/workspaces/ws/pending-close"],
  ["workspace-close", "DELETE", "/api/workspaces/ws"], ["workspace-title", "POST", "/api/workspaces/ws/title"],
  ["workspace-auto-title", "POST", "/api/workspaces/ws/auto-title"], ["tab-create", "POST", "/api/workspaces/ws/tabs"],
  ["tab-close", "DELETE", "/api/workspaces/ws/tabs/tab"], ["tab-title", "POST", "/api/workspaces/ws/tabs/tab/title"],
  ["pane-split", "POST", "/api/tabs/tab/split"], ["split-ratio", "POST", "/api/tabs/tab/split-ratio"],
  ["pane-input", "POST", "/api/panes/pane/input"], ["pane-review-create", "POST", "/api/panes/pane/reviews"],
  ["repository-snapshot-read", "GET", "/api/repository-snapshots/snapshot"],
  ["pane-notifications-read", "POST", "/api/panes/pane/notifications/read"],
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
  assert.equal(authorizeHttpPrincipal(auth, principal("browser-session"), policy("POST", "/api/workspaces/ws/pending-close")), true);
  assert.equal(authorizeHttpPrincipal(auth, principal("automation"), policy("POST", "/api/workspaces/ws/pending-close")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("automation"), policy("POST", "/api/workspaces/ws/cleanup")), true);
  assert.equal(authorizeHttpPrincipal(auth, principal("browser-session"), policy("POST", "/api/workspaces/ws/cleanup")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("automation"), policy("GET", "/api/delegations/run")), true);
  assert.equal(authorizeHttpPrincipal(auth, principal("browser-session"), policy("POST", "/api/agent-sessions/session/turns")), true);
  assert.equal(authorizeHttpPrincipal(auth, principal("automation"), policy("POST", "/api/agent-sessions/session/turns")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("helper"), policy("POST", "/api/agent-sessions/session/turns")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("helper"), policy("GET", "/api/delegations/run")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("automation"), policy("POST", "/api/notifications")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("helper"), policy("POST", "/api/notifications")), true);
  for (const route of ["/api/codex-bindings", "/api/codex-bindings/resolve", "/api/codex-bindings/title"]) {
    assert.equal(authorizeHttpPrincipal(auth, principal("helper"), policy("POST", route)), true);
    assert.equal(authorizeHttpPrincipal(auth, principal("automation"), policy("POST", route)), false);
    assert.equal(authorizeHttpPrincipal(auth, principal("registration"), policy("POST", route)), false);
  }
  assert.equal(authorizeHttpPrincipal(auth, principal("helper"), policy("GET", "/api/streams/host/request")), true);
  assert.equal(authorizeHttpPrincipal(auth, principal("helper"), policy("POST", "/api/streams/host/request")), true);
  assert.equal(authorizeHttpPrincipal(auth, principal("helper"), policy("DELETE", "/api/streams/host/request/request")), true);
  assert.equal(authorizeHttpPrincipal(auth, principal("automation"), policy("POST", "/api/streams/host/request")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("automation"), policy("DELETE", "/api/streams/host/request/request")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("helper"), policy("POST", "/api/workspaces")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("browser-session"), policy("POST", "/api/panes/pane/kitty-graphics/source")), true);
  assert.equal(authorizeHttpPrincipal(auth, principal("helper"), policy("POST", "/api/panes/pane/kitty-graphics/source")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("automation"), policy("POST", "/api/panes/pane/kitty-graphics/source")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("browser-session"), policy("POST", "/api/panes/pane/reviews")), true);
  assert.equal(authorizeHttpPrincipal(auth, principal("automation"), policy("POST", "/api/panes/pane/reviews")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("helper"), policy("POST", "/api/panes/pane/reviews")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("registration"), policy("POST", "/api/panes/pane/reviews")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("registered-host"), policy("POST", "/api/panes/pane/reviews")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("registration"), policy("POST", "/api/registry/hosts")), true);
  assert.equal(authorizeHttpPrincipal(auth, principal("browser-session"), policy("POST", "/api/registry/hosts")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("registered-host"), policy("GET", "/api/helpers/windows/win/bootstrap")), true);
  assert.equal(authorizeHttpPrincipal(auth, principal("registered-host"), policy("GET", "/api/bootstrap")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("automation"), policy("GET", "/api/auth/session")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("browser-session"), policy("GET", "/api/auth/sessions")), true);
  assert.equal(authorizeHttpPrincipal(auth, principal("automation"), policy("GET", "/api/auth/sessions")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("helper"), policy("POST", "/api/auth/credentials/helper/rotate")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("legacy-shared"), policy("GET", "/api/bootstrap")), false);
  assert.equal(authorizeHttpPrincipal({ ...auth, browserAuthMode: "shared-or-login" }, principal("legacy-shared"), policy("GET", "/api/bootstrap")), true);
  assert.equal(authorizeHttpPrincipal(auth, principal("agent-input-registration"), policy("POST", "/api/agent-input/sources/register")), true);
  assert.equal(authorizeHttpPrincipal(auth, principal("agent-input-source"), policy("POST", "/api/agent-input/sources/register")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("agent-input-registration"), policy("POST", "/api/agent-input/sources/challenge")), true);
  assert.equal(authorizeHttpPrincipal(auth, principal("agent-input-source"), policy("POST", "/api/agent-input/sources/challenge")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("agent-input-source"), policy("POST", "/api/agent-input/sources/source/challenge")), true);
  assert.equal(authorizeHttpPrincipal(auth, principal("agent-input-registration"), policy("POST", "/api/agent-input/sources/source/challenge")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("agent-input-source"), policy("GET", "/api/agent-input/sources/source/deliveries")), true);
  assert.equal(authorizeHttpPrincipal(auth, principal("browser-session"), policy("GET", "/api/agent-input/sources/source/deliveries")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("agent-input-source"), policy("POST", "/api/agent-input/requests/request/answer")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("browser-session"), policy("POST", "/api/agent-input/requests/request/answer")), true);
  assert.equal(authorizeHttpPrincipal(auth, principal("automation"), policy("POST", "/api/agent-input/requests/request/answer")), false);
  assert.equal(authorizeHttpPrincipal(auth, principal("helper"), policy("POST", "/api/agent-input/requests/request/answer")), false);
});

test("WebSocket classes deny unknown paths and reserve output-only access for automation", () => {
  assert.equal(classifyWebSocket("/ws/events"), "events");
  assert.equal(classifyWebSocket("/ws/panes/pane/output"), "pane-output");
  assert.equal(classifyWebSocket("/ws/panes/pane"), "pane-interactive");
  assert.equal(classifyWebSocket("/ws/future"), undefined);
  assert.equal(authorizeWebSocketPrincipal(auth, principal("automation"), "pane-output"), true);
  assert.equal(authorizeWebSocketPrincipal(auth, principal("automation"), "events"), false);
  assert.equal(authorizeWebSocketPrincipal(auth, principal("helper"), "pane-output"), false);
  assert.equal(authorizeWebSocketPrincipal(auth, principal("agent-input-source"), "pane-output"), false);
  assert.equal(authorizeWebSocketPrincipal(auth, principal("agent-input-source"), "events"), false);
  assert.equal(authorizeWebSocketPrincipal(auth, principal("browser-session"), "pane-interactive"), true);
  assert.equal(authorizeWebSocketPrincipal(auth, principal("legacy-shared"), "events"), false);
  assert.equal(authorizeWebSocketPrincipal({ ...auth, browserAuthMode: "shared-or-login" }, principal("legacy-shared"), "events"), true);
});
