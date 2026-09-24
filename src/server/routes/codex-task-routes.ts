import { z } from "zod";
import { CodexCatalogError } from "../codex-task-catalog.js";
import { HttpError, routePolicy, type ApiRoute, type RouteContext } from "./route.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const target = z.object({ workspaceId: id, tabId: id, paneId: id }).strict();
const listInput = z.object({ endpointId: id, cursor: z.string().max(4096).nullable().optional(), archived: z.boolean().optional() }).strict();
const readInput = z.object({ endpointId: id, threadId: id, history: z.boolean().optional() }).strict();
const associateInput = z.object({ id: z.string().uuid().optional(), endpointId: id, endpointIdentity: z.string().regex(/^[0-9a-f]{64}$/), threadId: id, target }).strict();
const launchFields = { requestId: z.string().uuid(), endpointId: id, endpointIdentity: z.string().regex(/^[0-9a-f]{64}$/) };
const launchInput = z.union([
  z.object({ ...launchFields, operation: z.literal("fresh").optional(), cwd: z.string().max(4096).regex(/^\/[^\x00-\x1f\x7f]*$/) }).strict(),
  z.object({ ...launchFields, operation: z.literal("attach"), threadId: z.string().uuid(), generation: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
]);
const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, "invalid_codex_task_request");
  return result.data;
};
const route = (id: string, method: ApiRoute["method"], pattern: string | RegExp, handler: (ctx: RouteContext) => Promise<void>): ApiRoute => ({
  id, method, pattern,
  // Broad inventory and launch authority is deliberately separate from helper
  // tokens and the exactly-bound plugin tools.
  policy: { ...routePolicy(id, method, pattern), userOnly: true },
  handler: async ctx => {
    try { await handler(ctx); }
    catch (error) {
      if (error instanceof HttpError) throw error;
      if (error instanceof CodexCatalogError) throw new HttpError(error.status, error.code);
      if (error && typeof error === "object" && "statusCode" in error && error.statusCode === 409) throw new HttpError(409, "launch_request_conflict");
      throw new HttpError(503, "codex_task_operation_unavailable");
    }
  },
});

export const codexTaskRoutes: readonly ApiRoute[] = [
  route("codex-task-endpoints", "GET", "/api/codex-tasks/endpoints", async ({ deps, sendJson }) => {
    sendJson(200, { endpoints: deps.codexTasks.catalog.listEndpoints() });
  }),
  route("codex-task-list", "POST", "/api/codex-tasks/list", async ({ deps, readJsonBody, sendJson }) => {
    const body = parse(listInput, await readJsonBody(16 * 1024));
    sendJson(200, await deps.codexTasks.catalog.list(body.endpointId, body.cursor, body.archived));
  }),
  route("codex-task-read", "POST", "/api/codex-tasks/read", async ({ deps, readJsonBody, sendJson }) => {
    const body = parse(readInput, await readJsonBody(16 * 1024));
    const detail = await deps.codexTasks.detail(body.endpointId, body.threadId, body.history);
    if (!detail.task.stale) deps.codexTasks.associations.observe(detail.task);
    sendJson(200, detail);
  }),
  route("codex-task-associations", "GET", "/api/codex-task-associations", async ({ deps, sendJson }) => {
    sendJson(200, { associations: deps.codexTasks.associations.list() });
  }),
  route("codex-task-associate", "POST", "/api/codex-task-associations", async ({ deps, readJsonBody, sendJson }) => {
    const body = parse(associateInput, await readJsonBody(16 * 1024));
    if (deps.codexTasks.catalog.identity(body.endpointId) !== body.endpointIdentity) throw new HttpError(409, "endpoint_identity_changed");
    const pane = deps.state.findPaneContext(body.target.paneId);
    if (!pane || pane.workspace.id !== body.target.workspaceId || pane.tab.id !== body.target.tabId) throw new HttpError(404, "display_target_not_found");
    if (body.id && !deps.codexTasks.associations.list().some(a => a.id === body.id)) throw new HttpError(404, "association_not_found");
    // Verify native identity without loading or resuming the task.
    const detail = await deps.codexTasks.catalog.read(body.endpointId, body.threadId);
    if (detail.task.stale) throw new HttpError(409, "native_task_unavailable");
    const current = deps.state.findPaneContext(body.target.paneId);
    if (!current || current.workspace.id !== body.target.workspaceId || current.tab.id !== body.target.tabId) throw new HttpError(404, "display_target_not_found");
    const association = deps.codexTasks.associations.put(body);
    deps.codexTasks.associations.observe(detail.task);
    sendJson(200, { association });
  }),
  route("codex-task-association-remove", "DELETE", /^\/api\/codex-task-associations\/([A-Za-z0-9_-]{1,128})$/, async ({ deps, match, sendJson }) => {
    sendJson(200, { removed: deps.codexTasks.associations.remove(match![1]) });
  }),
  route("codex-task-launch", "POST", "/api/codex-task-launches", async ({ deps, readJsonBody, sendJson }) => {
    const body = parse(launchInput, await readJsonBody(16 * 1024));
    if (deps.codexTasks.catalog.identity(body.endpointId) !== body.endpointIdentity) throw new HttpError(409, "endpoint_identity_changed");
    if (body.operation === "attach") await deps.codexTasks.requireAttachment(body);
    else deps.codexTasks.catalog.launchConfig(body.endpointId);
    sendJson(200, { launch: await deps.codexTasks.launches.launch(body) });
  }),
  route("codex-task-launches", "GET", "/api/codex-task-launches", async ({ deps, sendJson }) => {
    // History is not live terminal proof. Reconcile one selected attempt through its GET route.
    sendJson(200, { launches: deps.codexTasks.launches.list() });
  }),
  route("codex-task-launch-read", "GET", /^\/api\/codex-task-launches\/([A-Za-z0-9_-]{1,128})$/, async ({ deps, match, sendJson }) => {
    const launch = deps.codexTasks.launches.get(parse(z.string().uuid(), match![1]));
    if (!launch) throw new HttpError(404, "launch_not_found");
    sendJson(200, { launch: await deps.codexTasks.launches.reconcile(launch) });
  }),
  route("codex-task-launch-acknowledge", "POST", /^\/api\/codex-task-launches\/([A-Za-z0-9_-]{1,128})\/acknowledge$/, async ({ deps, match, sendJson }) => {
    const requestId = parse(z.string().uuid(), match![1]);
    if (!deps.codexTasks.launches.get(requestId)) throw new HttpError(404, "launch_not_found");
    sendJson(200, { launch: deps.codexTasks.launches.acknowledge(requestId) });
  }),
];
