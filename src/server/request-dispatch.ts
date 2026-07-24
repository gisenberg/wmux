import type http from "node:http";
import type { ViteDevServer } from "vite";
import {
  authenticateRequest,
  type AuthConfig,
  type AuthPrincipal,
  requestBearerToken,
  requestToken,
  registeredHostPrincipal,
  registrationPrincipal,
} from "./auth.js";
import {
  authorizeHttpPrincipal,
} from "./auth-policy.js";
import { isAllowedOrigin, isAllowedRequestHost } from "./bind.js";
import { HostRegistryError, type HostRegistry } from "./host-registry.js";
import {
  MAX_PASTE_IMAGE_BYTES,
  PasteImageStageError,
} from "./paste-image-staging.js";
import { RepositoryReviewError } from "./repository-review.js";
import {
  apiRoutes,
  classifyHttpRoute,
} from "./routes/index.js";
import {
  HttpError,
  matchApiRoute,
  type ServerDeps,
} from "./routes/route.js";
import { StateIdConflictError } from "./state.js";
import {
  serveBundledFontRequest,
  serveStaticRequest,
} from "./static-files.js";
import type { MachineConfig } from "./types.js";

const MAX_JSON_BODY = 1024 * 1024;

const readBody = async (
  request: http.IncomingMessage,
  maxBytes = MAX_JSON_BODY,
): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      request.destroy();
      throw new HttpError(413, "payload_too_large");
    }
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "invalid_json");
  }
};

export const readBinaryBody = async (
  request: http.IncomingMessage,
  maxBytes = MAX_PASTE_IMAGE_BYTES,
): Promise<Buffer> => {
  const rawLength = request.headers["content-length"];
  if (typeof rawLength !== "string") {
    throw new HttpError(411, "content_length_required");
  }
  if (!/^\d+$/.test(rawLength)) {
    throw new HttpError(400, "invalid_content_length");
  }
  const expected = Number(rawLength);
  if (!Number.isSafeInteger(expected)) {
    throw new HttpError(400, "invalid_content_length");
  }
  if (expected > maxBytes) throw new HttpError(413, "paste_image_too_large");
  if (expected === 0) throw new HttpError(400, "paste_image_empty");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes || total > expected) {
      request.destroy();
      throw new HttpError(413, "paste_image_too_large");
    }
    chunks.push(Buffer.from(chunk));
  }
  if (total !== expected) throw new HttpError(400, "incomplete_body");
  return Buffer.concat(chunks, total);
};

const sendJson = (
  response: http.ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void => {
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(payload));
};

interface RequestDispatcherOptions {
  bindHost: string;
  protocol: "http" | "https";
  auth: AuthConfig;
  registrationToken?: string;
  hostRegistry?: HostRegistry;
  currentMachines: () => MachineConfig[];
  deps: ServerDeps;
  root: string;
  getVite: () => ViteDevServer | undefined;
}

export const createRequestHandler = (
  options: RequestDispatcherOptions,
): ((
  request: http.IncomingMessage,
  response: http.ServerResponse,
) => Promise<void>) => async (request, response) => {
  if (
    !isAllowedRequestHost(request.headers.host, options.bindHost)
    || !isAllowedOrigin(request.headers.origin, options.bindHost)
  ) {
    sendJson(response, 403, { error: "forbidden_host" });
    return;
  }

  const url = new URL(
    request.url ?? "/",
    `${options.protocol}://${request.headers.host ?? options.bindHost}`,
  );
  const machines = options.currentMachines();
  const matchedApiRoute = matchApiRoute(
    apiRoutes,
    request.method,
    url.pathname,
  );

  const routePolicy = matchedApiRoute?.route.policy
    ?? classifyHttpRoute(request.method, url.pathname);
  const registrationPost = routePolicy?.access === "registration";
  const registrationAuth = registrationPrincipal(
    options.registrationToken,
    requestBearerToken(request),
  );
  const helperMatch = url.pathname.match(
    /^\/api\/helpers\/windows\/([^/]+)(?:\/bootstrap)?$/,
  );
  const helperMachine = helperMatch
    ? machines.find((machine) => machine.id === helperMatch[1])
    : undefined;
  const registeredHelperPrincipal = registeredHostPrincipal(
    helperMachine?.id ?? "",
    request.method === "GET"
      && url.pathname.endsWith("/bootstrap")
      && helperMachine?.source === "registered"
      && Boolean(
        options.hostRegistry?.acceptsBootstrapToken(
          helperMachine.id,
          requestToken(request, url),
        ),
      ),
  );
  let principal: AuthPrincipal = { kind: "anonymous" };
  if (url.pathname.startsWith("/api/")) {
    if (!routePolicy) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    principal = registeredHelperPrincipal.kind === "registered-host"
      ? registeredHelperPrincipal
      : registrationPost
        ? registrationAuth
        : authenticateRequest(options.auth, request, url);
    const registeredWindowsEndpoint = helperMachine?.source === "registered"
      && (
        routePolicy.id === "windows-bootstrap"
        || routePolicy.id === "windows-helpers"
      );
    const wrongRegisteredWindowsPrincipal = registeredWindowsEndpoint
      && (
        routePolicy.id === "windows-bootstrap"
          ? principal.kind !== "registered-host"
          : principal.kind === "helper"
            || principal.kind === "registered-host"
      );
    if (
      wrongRegisteredWindowsPrincipal
      || !authorizeHttpPrincipal(options.auth, principal, routePolicy)
    ) {
      sendJson(
        response,
        principal.kind === "anonymous" ? 401 : 403,
        { error: "unauthorized" },
      );
      return;
    }
  }

  try {
    if (
      (request.method === "GET" || request.method === "HEAD")
      && /^\/fonts\/meslo-v3\.4\.0\/(regular|bold|italic|bold-italic)$/.test(
        url.pathname,
      )
    ) {
      if (
        !serveBundledFontRequest(
          request,
          response,
          url.pathname,
          options.root,
        )
      ) {
        sendJson(response, 404, { error: "font_not_found" });
      }
      return;
    }

    if (matchedApiRoute) {
      await matchedApiRoute.route.handler({
        url,
        request,
        response,
        principal,
        machines,
        match: matchedApiRoute.match,
        deps: options.deps,
        sendJson: (status, payload, headers) =>
          sendJson(response, status, payload, headers),
        readJsonBody: (maxBytes) => readBody(request, maxBytes),
        readBinaryBody: (maxBytes) => readBinaryBody(request, maxBytes),
      });
      return;
    }

    if (
      await serveStaticRequest(
        request,
        response,
        url,
        options.root,
        options.getVite(),
      )
    ) {
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    if (
      error instanceof HttpError
      || error instanceof HostRegistryError
      || error instanceof PasteImageStageError
      || error instanceof RepositoryReviewError
    ) {
      sendJson(response, error.status, { error: error.code });
      return;
    }
    if (error instanceof StateIdConflictError) {
      sendJson(response, 409, { error: "client_id_conflict" });
      return;
    }
    console.error("wmux: request handler error:", error);
    sendJson(response, 500, { error: "server_error" });
  }
};
