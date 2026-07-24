import { authRoutes } from "./auth-routes.js";
import { bootstrapRoutes } from "./bootstrap-routes.js";
import { eventIngestRoutes } from "./event-ingest-routes.js";
import { mediaRoutes } from "./media-routes.js";
import { registryRoutes } from "./registry-routes.js";
import { repositoryRoutes } from "./repository-routes.js";
import { streamRoutes } from "./stream-routes.js";
import { workspaceRoutes } from "./workspace-routes.js";
import type { HttpRoutePolicy } from "./route.js";

export const apiRoutes = [
  ...authRoutes,
  ...bootstrapRoutes,
  ...eventIngestRoutes,
  ...mediaRoutes,
  ...registryRoutes,
  ...repositoryRoutes,
  ...streamRoutes,
  ...workspaceRoutes,
] as const;

export const HTTP_ROUTE_POLICIES: readonly HttpRoutePolicy[] =
  apiRoutes.map((route) => route.policy);

export const classifyHttpRoute = (
  method: string | undefined,
  pathname: string,
): HttpRoutePolicy | undefined =>
  HTTP_ROUTE_POLICIES.find(
    (candidate) =>
      candidate.method === method &&
      candidate.pattern.test(pathname),
  );
