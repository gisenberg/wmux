import {
  HttpError,
  type ApiRoute,
  routePolicy,
} from "./route.js";

export const repositoryRoutes: readonly ApiRoute[] = [
  {
    id: "pane-review-create",
    method: "POST",
    pattern: /^\/api\/panes\/([^/]+)\/reviews$/,
    policy: routePolicy(
      "pane-review-create",
      "POST",
      /^\/api\/panes\/[^/]+\/reviews$/,
    ),
    handler: async ({
      deps,
      match,
      readJsonBody,
      request,
      response,
      sendJson,
    }) => {
      if (!match) throw new Error("pane review route matched without captures");
      let paneId: string;
      try {
        paneId = decodeURIComponent(match[1]);
      } catch {
        throw new HttpError(400, "invalid_pane_id");
      }
      const body = await readJsonBody();
      if (
        typeof body !== "object"
        || body === null
        || Array.isArray(body)
        || Object.keys(body).length !== 1
        || !("kind" in body)
        || body.kind !== "working-tree"
      ) {
        throw new HttpError(400, "invalid_repository_review_request");
      }
      const abortController = new AbortController();
      const abort = (): void => abortController.abort();
      const abortOnClose = (): void => {
        if (!response.writableEnded) abort();
      };
      request.once("aborted", abort);
      response.once("close", abortOnClose);
      try {
        const snapshot = await deps.repositoryReviews.workingTreeSnapshot(
          paneId,
          abortController.signal,
        );
        const archive = deps.agentSessions.archiveRepositorySnapshot(
          paneId,
          snapshot,
        );
        sendJson(
          201,
          { snapshot, ...(archive ? { archive } : {}) },
          { "cache-control": "no-store" },
        );
      } finally {
        request.removeListener("aborted", abort);
        response.removeListener("close", abortOnClose);
      }
    },
  },
  {
    id: "repository-snapshot-read",
    method: "GET",
    pattern: /^\/api\/repository-snapshots\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/,
    policy: routePolicy(
      "repository-snapshot-read",
      "GET",
      /^\/api\/repository-snapshots\/[^/]+$/,
      "normal",
      ["automation"],
    ),
    handler: async ({ deps, match, sendJson }) => {
      if (!match) {
        throw new Error("repository snapshot route matched without captures");
      }
      const snapshot = deps.agentSessions.repositorySnapshot(match[1]);
      if (!snapshot) {
        sendJson(404, { error: "repository_snapshot_not_found" });
        return;
      }
      sendJson(200, { snapshot }, { "cache-control": "no-store" });
    },
  },
];
