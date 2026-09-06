import { HttpError, type ApiRoute, routePolicy } from "./route.js";

const hasOnly = (body: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(body).every((key) => keys.includes(key));

const objectBody = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_binding_body");
  return value as Record<string, unknown>;
};

const validTitle = (value: unknown): value is string =>
  typeof value === "string"
  && value.length <= 80
  && Boolean(value.trim())
  && !/[\x00-\x1f\x7f-\x9f]/.test(value);

export const codexBindingRoutes: readonly ApiRoute[] = [
  {
    id: "codex-binding-issue",
    method: "POST",
    pattern: "/api/codex-bindings",
    policy: routePolicy("codex-binding-issue", "POST", "/api/codex-bindings", "normal", ["helper"]),
    handler: async ({ deps, readJsonBody, sendJson }) => {
      const body = objectBody(await readJsonBody());
      if (!hasOnly(body, ["sessionId"])) throw new HttpError(400, "invalid_binding_body");
      const issued = deps.sessions.codexTerminalBindings.issue(body.sessionId);
      sendJson(201, issued);
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
      if (!validTitle(body.title)) throw new HttpError(400, "invalid_title");
      if (body.mode !== "auto") throw new HttpError(400, "invalid_title_mode");
      const binding = deps.sessions.codexTerminalBindings.resolve(body.sessionId, body.receipt);
      const result = deps.state.setAutoTitle({
          workspaceId: binding.workspaceId,
          tabId: binding.tabId,
          sourcePaneId: binding.paneId,
          title: body.title,
          tabOnlyIfMultiple: false,
        });
      sendJson(200, { ...result, ...binding });
    },
  },
];
