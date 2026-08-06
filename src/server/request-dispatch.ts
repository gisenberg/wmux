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
import { StaticMachineStoreError } from "./static-machine-store.js";
import {
  MAX_PASTE_IMAGE_BYTES,
  PasteImageStageError,
} from "./paste-image-staging.js";
import { RepositoryReviewError } from "./repository-review.js";
import { AgentFollowUpError } from "./agent-follow-up.js";
import { KittyGraphicsSourceError } from "./kitty-graphics-source.js";
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
import type { BrowserSessionStore } from "./browser-session-store.js";
import type { ScopedCredentialStore } from "./scoped-credential-store.js";
import type { AgentInputCredentialStore } from "./agent-input-credential-store.js";
import { mapAgentInputRouteError } from "./routes/agent-input-routes.js";
import {
  expiredBrowserSessionCookie,
  requestBrowserSessionCookie,
} from "./browser-session-cookie.js";
import { normalizeIpAddress, observedClientAddress } from "./proxy-address.js";

const MAX_JSON_BODY = 1024 * 1024;

const readBody = async (
  request: http.IncomingMessage,
  maxBytes = MAX_JSON_BODY,
): Promise<unknown> => {
  const contentLength = request.headers["content-length"];
  if (typeof contentLength === "string") {
    if (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(Number(contentLength))) {
      throw new HttpError(400, "invalid_content_length");
    }
    if (Number(contentLength) > maxBytes) {
      request.resume();
      throw new HttpError(413, "payload_too_large");
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      request.resume();
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
  browserSessions?: BrowserSessionStore;
  scopedCredentials?: ScopedCredentialStore;
  agentInputCredentials?: AgentInputCredentialStore;
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
        : authenticateRequest(
          options.auth,
          request,
          url,
          Date.now(),
          options.browserSessions,
          options.scopedCredentials,
          {
            device: typeof request.headers["user-agent"] === "string"
              ? request.headers["user-agent"]
              : undefined,
            address: observedClientAddress(
              request,
              options.deps.trustedProxies,
            ) ?? normalizeIpAddress(request.socket.remoteAddress) ?? "unknown",
          },
          routePolicy.access === "agent-input-registration" || routePolicy.access === "agent-input-source"
            ? options.agentInputCredentials
            : undefined,
        );
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
      const clearInvalidBrowserSession = principal.kind === "anonymous"
        && (options.auth.browserAuthMode ?? "shared-or-login") === "login-only"
        && Boolean(requestBrowserSessionCookie(request));
      sendJson(
        response,
        principal.kind === "anonymous" ? 401 : 403,
        { error: "unauthorized" },
        {
          ...(routePolicy.id.startsWith("agent-input-") ? { "cache-control": "no-store" } : {}),
          ...(clearInvalidBrowserSession ? {
              "set-cookie": expiredBrowserSessionCookie(
                Boolean(options.deps.browserSessionCookieSecure),
              ),
            } : {}),
        },
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
    const errorHeaders = matchedApiRoute?.route.id.startsWith("agent-input-")
      ? { "cache-control": "no-store" }
      : undefined;
    const agentInputError = mapAgentInputRouteError(error);
    if (agentInputError) {
      sendJson(response, agentInputError.status, { error: agentInputError.code }, { "cache-control": "no-store" });
      return;
    }
    if (
      error instanceof HttpError
      || error instanceof HostRegistryError
      || error instanceof StaticMachineStoreError
      || error instanceof PasteImageStageError
      || error instanceof KittyGraphicsSourceError
      || error instanceof RepositoryReviewError
      || error instanceof AgentFollowUpError
    ) {
      sendJson(response, error.status, { error: error.code }, errorHeaders);
      return;
    }
    if (error instanceof StateIdConflictError) {
      sendJson(response, 409, { error: "client_id_conflict" }, errorHeaders);
      return;
    }
    console.error("wmux: request handler error:", error);
    sendJson(response, 500, { error: "server_error" }, errorHeaders);
  }
};
