import {
  HttpError,
  type ApiRoute,
  policyForRoute,
} from "./route.js";

export const repositoryRoutes: readonly ApiRoute[] = [
  {
    id: "pane-review-create",
    method: "POST",
    pattern: /^\/api\/panes\/([^/]+)\/reviews$/,
    policy: policyForRoute("pane-review-create"),
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
        sendJson(201, { snapshot }, { "cache-control": "no-store" });
      } finally {
        request.removeListener("aborted", abort);
        response.removeListener("close", abortOnClose);
      }
    },
  },
];
