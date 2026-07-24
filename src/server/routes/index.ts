import { authRoutes } from "./auth-routes.js";
import { bootstrapRoutes } from "./bootstrap-routes.js";
import { eventIngestRoutes } from "./event-ingest-routes.js";
import { mediaRoutes } from "./media-routes.js";
import { registryRoutes } from "./registry-routes.js";
import { repositoryRoutes } from "./repository-routes.js";
import { streamRoutes } from "./stream-routes.js";
import { workspaceRoutes } from "./workspace-routes.js";

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
