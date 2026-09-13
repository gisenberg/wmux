import { HttpError, type ApiRoute, routePolicy } from "./route.js";
import { isValidTitle } from "../../shared/title.js";

const hasOnly = (body: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(body).every((key) => keys.includes(key));

const objectBody = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_binding_body");
  return value as Record<string, unknown>;
};

export const codexBindingRoutes: readonly ApiRoute[] = [
  {
    id: "codex-binding-observation",
    method: "POST",
    pattern: "/api/codex-bindings/observation",
    policy: routePolicy("codex-binding-observation", "POST", "/api/codex-bindings/observation", "normal", ["helper"]),
    handler: async ({ deps, readJsonBody, sendJson }) => {
      deps.sessions.codexTerminalBindings.recordObservation(objectBody(await readJsonBody()));
      sendJson(200, { recorded: true });
    },
  },
  {
    id: "codex-binding-revoke",
    method: "POST",
    pattern: "/api/codex-bindings/revoke",
    policy: routePolicy("codex-binding-revoke", "POST", "/api/codex-bindings/revoke", "normal", ["helper"]),
    handler: async ({ deps, readJsonBody, sendJson }) => {
      const body = objectBody(await readJsonBody());
      if (!hasOnly(body, ["sessionId", "receipts"])) throw new HttpError(400, "invalid_binding_body");
      deps.sessions.codexTerminalBindings.revoke(body.sessionId, body.receipts);
      sendJson(200, { revoked: true });
    },
  },
  {
    id: "codex-binding-issue",
    method: "POST",
    pattern: "/api/codex-bindings",
    policy: routePolicy("codex-binding-issue", "POST", "/api/codex-bindings", "normal", ["helper"]),
    handler: async ({ deps, readJsonBody, sendJson }) => {
      const body = objectBody(await readJsonBody());
      if (!hasOnly(body, ["sessionId", "turnId"])) throw new HttpError(400, "invalid_binding_body");
      const issued = deps.sessions.codexTerminalBindings.issue(body.sessionId, body.turnId);
      sendJson(201, issued);
    },
  },
  {
    id: "codex-binding-lifecycle",
    method: "POST",
    pattern: "/api/codex-bindings/lifecycle",
    policy: routePolicy("codex-binding-lifecycle", "POST", "/api/codex-bindings/lifecycle", "normal", ["helper"]),
    handler: async ({ deps, readJsonBody, sendJson }) => {
      const body = objectBody(await readJsonBody());
      if (!hasOnly(body, ["sessionId", "receipt", "turnId", "sequence", "state", "attention"])) throw new HttpError(400, "invalid_binding_body");
      try { sendJson(200, deps.sessions.codexLifecycle.publish(body as unknown as import("../codex-lifecycle.js").CodexLifecycleInput)); }
      catch (error) { if (error instanceof Error && error.message === "invalid_codex_lifecycle") throw new HttpError(400, error.message); throw error; }
    },
  },
  {
    id: "codex-binding-resolve",
    method: "POST",
    pattern: "/api/codex-bindings/resolve",
    policy: routePolicy("codex-binding-resolve", "POST", "/api/codex-bindings/resolve", "normal", ["helper"]),
    handler: async ({ deps, readJsonBody, sendJson }) => {
      const body = objectBody(await readJsonBody());
      if (!hasOnly(body, ["sessionId", "receipt"])) throw new HttpError(400, "invalid_binding_body");
      sendJson(200, deps.sessions.codexTerminalBindings.resolve(body.sessionId, body.receipt));
    },
  },
  {
    id: "codex-binding-title",
    method: "POST",
    pattern: "/api/codex-bindings/title",
    policy: routePolicy("codex-binding-title", "POST", "/api/codex-bindings/title", "normal", ["helper"]),
    handler: async ({ deps, readJsonBody, sendJson }) => {
      const body = objectBody(await readJsonBody());
      if (!hasOnly(body, ["sessionId", "receipt", "title", "mode"])) throw new HttpError(400, "invalid_binding_body");
      if (!isValidTitle(body.title)) throw new HttpError(400, "invalid_title");
      if (body.mode !== "auto") throw new HttpError(400, "invalid_title_mode");
      const binding = deps.sessions.codexTerminalBindings.resolve(body.sessionId, body.receipt);
      const result = deps.state.setAutoTitle({
          workspaceId: binding.workspaceId,
          tabId: binding.tabId,
          sourcePaneId: binding.paneId,
          title: body.title,
          exact: true,
          tabOnlyIfMultiple: false,
        });
      sendJson(200, { ...result, ...binding });
    },
  },
];
