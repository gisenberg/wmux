import { z } from "zod";
import type {
  AgentInputRegistrationPrincipal,
  AgentInputSourcePrincipal,
} from "../agent-input-credential-store.js";
import { AgentInputCredentialError } from "../agent-input-credential-store.js";
import { contextSessionBinding } from "../agent-input-credential-store.js";
import { AgentInputRequestStoreError } from "../agent-input-request-store.js";
import {
  OPENCODE_QUESTION_CONTRACT_DIGEST,
  OPENCODE_RUNTIME_HANDSHAKE_SCHEMA,
  openCodeRuntimeAttestationSchema,
} from "../opencode-question-contract.js";
import type { ApiRoute, RouteContext } from "./route.js";
import { HttpError, routePolicy } from "./route.js";

const NO_STORE = { "cache-control": "no-store" };
const MAX_SOURCE_BODY = 128 * 1024;
// A broker-control snapshot is capped at 128 KiB. Adding 256 occurrence IDs,
// hashes, ordinals, and the duplicate cut-scope key list expands it by less
// than another 128 KiB, so the exact native-list envelope remains bounded here.
const MAX_NATIVE_LIST_BODY = 256 * 1024;
const MAX_CHALLENGE_BODY = 1_024;
const MAX_ANSWER_BODY = 256 * 1024;
const MAX_ANSWER_VALUES = 129;
const MAX_ANSWER_VALUE_BYTES = 4_096;
const MAX_ANSWER_BYTES = 16_384;
const text = (max = 256) => z.string().min(1).max(max);
const questionSchema = z.object({
  header: text(120),
  question: text(16_384),
  options: z.array(z.object({ label: text(1_024), description: z.string().max(4_096) }).strict()).max(128),
  multiple: z.boolean(),
  custom: z.boolean(),
}).strict();
const registerSchema = z.object({
  instanceNonce: text(),
  kind: z.literal("opencode"),
  runtimeAttestation: openCodeRuntimeAttestationSchema,
  relaySecretSeed: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
}).strict();
const refreshSchema = registerSchema.omit({ relaySecretSeed: true });
const challengeSchema = z.object({ kind: z.literal("opencode") }).strict();
const captureSchema = z.object({
  occurrenceId: text(),
  occurrenceKey: z.string().regex(/^[a-f0-9]{64}$/),
  ordinal: z.number().int().positive().safe(),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sessionID: text(),
  id: text(),
  questions: z.array(questionSchema).min(1).max(32),
}).strict();
const answerValueSchema = z.string().min(1).max(MAX_ANSWER_VALUE_BYTES).refine(
  (value) => Buffer.byteLength(value, "utf8") <= MAX_ANSWER_VALUE_BYTES,
);
const answerSchema = z.object({
  expectedGeneration: z.number().int().positive(),
  idempotencyKey: text(),
  // A 128-option multiple-choice question may also permit one custom value.
  answers: z.array(z.array(answerValueSchema).min(1).max(MAX_ANSWER_VALUES)).min(1).max(32),
}).strict().refine(
  ({ answers }) => answers.flat().reduce(
    (total, value) => total + Buffer.byteLength(value, "utf8"), 0,
  ) <= MAX_ANSWER_BYTES,
);
const ackSchema = z.object({
  id: text(),
  generation: z.number().int().positive(),
  outcome: z.enum(["applied", "already_resolved", "sdk_error"]),
  code: z.string().regex(/^[A-Za-z0-9_.-]{1,120}$/).optional(),
  retryable: z.boolean().optional(),
}).strict();
const deliveryIdentitySchema = z.object({
  id: text(),
  generation: z.number().int().positive(),
}).strict();
const resolveSchema = z.object({
  generation: z.number().int().positive(),
  occurrenceId: text(),
  result: z.enum(["replied", "rejected"]),
}).strict();
const nativeListSchema = z.object({
  complete: z.literal(true),
  cutSequence: z.number().int().nonnegative().safe(),
  occurrenceKeys: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(256).optional(),
  members: z.array(z.object({
    occurrenceId: text(),
    occurrenceKey: z.string().regex(/^[a-f0-9]{64}$/),
    ordinal: z.number().int().positive().safe(),
    payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
    sessionID: text(),
    requestID: text(),
    questions: z.array(questionSchema).min(1).max(32),
  }).strict()).max(256),
}).strict();

const sourcePrincipal = (ctx: RouteContext, sourceId: string): AgentInputSourcePrincipal => {
  if (ctx.principal.kind !== "agent-input-source" || ctx.principal.sourceId !== sourceId) {
    throw new HttpError(401, "unauthorized");
  }
  return ctx.principal;
};

const parse = <T>(schema: z.ZodType<T>, value: unknown, status = 400): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(status, "invalid_request");
  return parsed.data;
};

const liveContext = (ctx: RouteContext, context: {
  workspaceId: string;
  tabId: string;
  paneId: string;
  machineId?: string;
  backendId?: "raw-pty" | "durable-multiplexer" | "windows-agent";
  sessionIncarnation?: string;
  endpointFingerprint?: string;
}): boolean => {
  const found = ctx.deps.state.findPaneContext(context.paneId);
  const binding = contextSessionBinding({ ...context, sourceKind: "opencode" });
  return Boolean(binding && found && found.pane.status === "running"
    && found.workspace.id === context.workspaceId
    && found.tab.id === context.tabId
    && found.pane.machineId === context.machineId
    && ctx.deps.sessions.hasLivePaneSession?.(context.paneId, binding));
};

export const agentInputRoutes: readonly ApiRoute[] = [
  {
    id: "agent-input-registration-challenge",
    method: "POST",
    pattern: "/api/agent-input/sources/challenge",
    policy: routePolicy("agent-input-registration-challenge", "POST", "/api/agent-input/sources/challenge", "agent-input-registration"),
    handler: async (ctx) => {
      if (!ctx.deps.agentInputEnabled || ctx.principal.kind !== "agent-input-registration") {
        throw new HttpError(503, "agent_input_disabled");
      }
      parse(challengeSchema, await ctx.readJsonBody(MAX_CHALLENGE_BODY));
      const context = ctx.deps.agentInputCredentials.registrationContext(ctx.principal.capabilityId);
      if (!context || !liveContext(ctx, context)) throw new HttpError(409, "pane_unavailable");
      const challenge = ctx.deps.agentInputCredentials.issueRuntimeChallenge(ctx.principal);
      ctx.sendJson(201, {
        type: "server_challenge",
        handshakeSchema: OPENCODE_RUNTIME_HANDSHAKE_SCHEMA,
        contractDigest: OPENCODE_QUESTION_CONTRACT_DIGEST,
        ...challenge,
      }, NO_STORE);
    },
  },
  {
    id: "agent-input-source-challenge",
    method: "POST",
    pattern: /^\/api\/agent-input\/sources\/([^/]+)\/challenge$/,
    policy: routePolicy("agent-input-source-challenge", "POST", /^\/api\/agent-input\/sources\/([^/]+)\/challenge$/, "agent-input-source"),
    handler: async (ctx) => {
      if (!ctx.deps.agentInputEnabled) throw new HttpError(503, "agent_input_disabled");
      const principal = sourcePrincipal(ctx, ctx.match![1]);
      parse(challengeSchema, await ctx.readJsonBody(MAX_CHALLENGE_BODY));
      const source = ctx.deps.agentInputCredentials.sourceForPrincipal(principal);
      if (!source || !liveContext(ctx, source.context)) throw new HttpError(409, "pane_unavailable");
      const challenge = ctx.deps.agentInputCredentials.issueRuntimeChallenge(principal);
      ctx.sendJson(201, {
        type: "server_challenge",
        handshakeSchema: OPENCODE_RUNTIME_HANDSHAKE_SCHEMA,
        contractDigest: OPENCODE_QUESTION_CONTRACT_DIGEST,
        ...challenge,
      }, NO_STORE);
    },
  },
  {
    id: "agent-input-source-register",
    method: "POST",
    pattern: "/api/agent-input/sources/register",
    policy: routePolicy("agent-input-source-register", "POST", "/api/agent-input/sources/register", "agent-input-registration"),
    handler: async (ctx) => {
      if (!ctx.deps.agentInputEnabled || ctx.principal.kind !== "agent-input-registration") {
        throw new HttpError(503, "agent_input_disabled");
      }
      const context = ctx.deps.agentInputCredentials.registrationContext(ctx.principal.capabilityId);
      if (!context || !liveContext(ctx, context)) throw new HttpError(409, "pane_unavailable");
      const body = parse(registerSchema, await ctx.readJsonBody(MAX_SOURCE_BODY));
      const currentContext = ctx.deps.agentInputCredentials.registrationContext(ctx.principal.capabilityId);
      if (!currentContext || !liveContext(ctx, currentContext)) throw new HttpError(409, "pane_unavailable");
      const result = ctx.deps.agentInputCredentials.exchange(
        ctx.principal as AgentInputRegistrationPrincipal,
        body,
      );
      if (result.outcome === "already_exchanged") {
        ctx.sendJson(200, result, NO_STORE);
        return;
      }
      ctx.sendJson(201, {
        ...result,
        limits: { maxQuestions: 32, maxOptions: 128, maxAnswerBytes: 16_384, maxPollWaitMs: 30_000 },
      }, NO_STORE);
    },
  },
  {
    id: "agent-input-source-refresh",
    method: "POST",
    pattern: /^\/api\/agent-input\/sources\/([^/]+)\/refresh$/,
    policy: routePolicy("agent-input-source-refresh", "POST", /^\/api\/agent-input\/sources\/([^/]+)\/refresh$/, "agent-input-source"),
    handler: async (ctx) => {
      if (!ctx.deps.agentInputEnabled) throw new HttpError(503, "agent_input_disabled");
      const principal = sourcePrincipal(ctx, ctx.match![1]);
      const body = parse(refreshSchema, await ctx.readJsonBody(MAX_SOURCE_BODY));
      const source = ctx.deps.agentInputCredentials.sourceForPrincipal(principal);
      if (!source || !liveContext(ctx, source.context)) throw new HttpError(409, "pane_unavailable");
      ctx.sendJson(200, ctx.deps.agentInputCredentials.refresh(principal, body), NO_STORE);
    },
  },
  {
    id: "agent-input-request-capture",
    method: "POST",
    pattern: /^\/api\/agent-input\/sources\/([^/]+)\/requests$/,
    policy: routePolicy("agent-input-request-capture", "POST", /^\/api\/agent-input\/sources\/([^/]+)\/requests$/, "agent-input-source"),
    handler: async (ctx) => {
      if (!ctx.deps.agentInputEnabled) throw new HttpError(503, "agent_input_disabled");
      const principal = sourcePrincipal(ctx, ctx.match![1]);
      const body = parse(captureSchema, await ctx.readJsonBody(MAX_SOURCE_BODY));
      // Authentication happened before the bounded body read. Re-read the
      // exact credential record so rotation, revocation, expiry, or pane
      // replacement during upload cannot mutate state under stale authority.
      const source = ctx.deps.agentInputCredentials.sourceForPrincipal(principal);
      if (!source || !liveContext(ctx, source.context)) throw new HttpError(401, "unauthorized");
      if (!source.runtimeReady || !source.supported) throw new HttpError(409, "source_unsupported");
      const result = ctx.deps.agentInputRequests.capture({
        occurrenceId: body.occurrenceId,
        occurrenceKey: body.occurrenceKey,
        occurrenceOrdinal: body.ordinal,
        payloadDigest: body.payloadDigest,
        sourceId: source.id,
        workspaceId: source.context.workspaceId,
        tabId: source.context.tabId,
        paneId: source.context.paneId,
        machineId: source.context.machineId,
        openCodeSessionId: body.sessionID,
        openCodeRequestId: body.id,
        questions: body.questions,
      });
      if (result.outcome === "conflict") throw new HttpError(409, result.code);
      if (result.outcome === "retired") {
        ctx.sendJson(200, { outcome: "retired", generation: result.generation }, NO_STORE);
        return;
      }
      if (result.outcome === "created") ctx.deps.agentInputRelay.settleClosed(result.superseded);
      const payload = ctx.deps.currentPayload() as { eventRevision?: unknown };
      ctx.sendJson(result.outcome === "created" ? 201 : 200, {
        outcome: result.outcome === "created" ? "created" : "exact",
        id: result.request.id,
        generation: result.request.generation,
        state: result.request.state,
        eventRevision: typeof payload.eventRevision === "number" ? payload.eventRevision : 0,
      }, NO_STORE);
    },
  },
  {
    id: "agent-input-native-list-reconcile",
    method: "POST",
    pattern: /^\/api\/agent-input\/sources\/([^/]+)\/native-list$/,
    policy: routePolicy("agent-input-native-list-reconcile", "POST", /^\/api\/agent-input\/sources\/([^/]+)\/native-list$/, "agent-input-source"),
    handler: async (ctx) => {
      const principal = sourcePrincipal(ctx, ctx.match![1]);
      const body = parse(nativeListSchema, await ctx.readJsonBody(MAX_NATIVE_LIST_BODY));
      ctx.sendJson(200, ctx.deps.agentInputRelay.reconcileNativeList(principal, body.members, body.occurrenceKeys), NO_STORE);
    },
  },
  {
    id: "agent-input-delivery-poll",
    method: "GET",
    pattern: /^\/api\/agent-input\/sources\/([^/]+)\/deliveries$/,
    policy: routePolicy("agent-input-delivery-poll", "GET", /^\/api\/agent-input\/sources\/([^/]+)\/deliveries$/, "agent-input-source"),
    handler: async (ctx) => {
      if (!ctx.deps.agentInputEnabled) throw new HttpError(503, "agent_input_disabled");
      const principal = sourcePrincipal(ctx, ctx.match![1]);
      const clientEpoch = ctx.url.searchParams.get("epoch");
      if (!clientEpoch || clientEpoch.length > 128 || !/^[A-Za-z0-9._-]+$/.test(clientEpoch)) {
        throw new HttpError(400, "invalid_poll_query");
      }
      const number = (name: string, fallback: number): number => {
        const raw = ctx.url.searchParams.get(name);
        if (raw === null) return fallback;
        if (!/^\d+$/.test(raw)) throw new HttpError(400, "invalid_poll_query");
        return Number(raw);
      };
      const abort = new AbortController();
      const disconnect = () => abort.abort();
      ctx.request.once("aborted", disconnect);
      ctx.response.once("close", disconnect);
      let result;
      try {
        result = await ctx.deps.agentInputRelay.poll(
          principal,
          number("after", 0),
          number("limit", 1),
          number("waitMs", 0),
          abort.signal,
          clientEpoch,
        );
      } finally {
        ctx.request.removeListener("aborted", disconnect);
        ctx.response.removeListener("close", disconnect);
      }
      if (abort.signal.aborted || ctx.response.destroyed) return;
      ctx.sendJson(200, result, NO_STORE);
    },
  },
  {
    id: "agent-input-delivery-start",
    method: "POST",
    pattern: /^\/api\/agent-input\/sources\/([^/]+)\/deliveries\/([^/]+)\/start$/,
    policy: routePolicy("agent-input-delivery-start", "POST", /^\/api\/agent-input\/sources\/([^/]+)\/deliveries\/([^/]+)\/start$/, "agent-input-source"),
    handler: async (ctx) => {
      const principal = sourcePrincipal(ctx, ctx.match![1]);
      const body = parse(deliveryIdentitySchema, await ctx.readJsonBody(MAX_SOURCE_BODY));
      ctx.sendJson(200, ctx.deps.agentInputRelay.startDelivery(
        principal,
        ctx.match![2],
        body.id,
        body.generation,
      ), NO_STORE);
    },
  },
  {
    id: "agent-input-delivery-ack",
    method: "POST",
    pattern: /^\/api\/agent-input\/sources\/([^/]+)\/deliveries\/([^/]+)\/ack$/,
    policy: routePolicy("agent-input-delivery-ack", "POST", /^\/api\/agent-input\/sources\/([^/]+)\/deliveries\/([^/]+)\/ack$/, "agent-input-source"),
    handler: async (ctx) => {
      const principal = sourcePrincipal(ctx, ctx.match![1]);
      const body = parse(ackSchema, await ctx.readJsonBody(MAX_SOURCE_BODY));
      const result = ctx.deps.agentInputRelay.acknowledge(principal, ctx.match![2], {
        requestId: body.id,
        generation: body.generation,
        outcome: body.outcome,
        code: body.code,
        retryable: body.retryable,
      });
      ctx.sendJson(200, result, NO_STORE);
    },
  },
  {
    id: "agent-input-native-pending-reconcile",
    method: "POST",
    pattern: /^\/api\/agent-input\/sources\/([^/]+)\/requests\/([^/]+)\/pending$/,
    policy: routePolicy("agent-input-native-pending-reconcile", "POST", /^\/api\/agent-input\/sources\/([^/]+)\/requests\/([^/]+)\/pending$/, "agent-input-source"),
    handler: async (ctx) => {
      const principal = sourcePrincipal(ctx, ctx.match![1]);
      const body = parse(z.object({ generation: z.number().int().positive(), occurrenceId: text() }).strict(), await ctx.readJsonBody(MAX_SOURCE_BODY));
      const result = ctx.deps.agentInputRelay.reconcileNativePending(principal, ctx.match![2], body.generation, body.occurrenceId);
      ctx.sendJson(200, result, NO_STORE);
    },
  },
  {
    id: "agent-input-native-resolve",
    method: "POST",
    pattern: /^\/api\/agent-input\/sources\/([^/]+)\/requests\/([^/]+)\/resolve$/,
    policy: routePolicy("agent-input-native-resolve", "POST", /^\/api\/agent-input\/sources\/([^/]+)\/requests\/([^/]+)\/resolve$/, "agent-input-source"),
    handler: async (ctx) => {
      const principal = sourcePrincipal(ctx, ctx.match![1]);
      const body = parse(resolveSchema, await ctx.readJsonBody(MAX_SOURCE_BODY));
      const result = ctx.deps.agentInputRelay.resolveNative(principal, ctx.match![2], body.generation, body.occurrenceId, body.result);
      ctx.sendJson(200, result, NO_STORE);
    },
  },
  {
    id: "agent-input-answer",
    method: "POST",
    pattern: /^\/api\/agent-input\/requests\/([^/]+)\/answer$/,
    policy: {
      ...routePolicy("agent-input-answer", "POST", /^\/api\/agent-input\/requests\/([^/]+)\/answer$/),
      userOnly: true,
    },
    handler: async (ctx) => {
      if (!ctx.deps.agentInputEnabled) throw new HttpError(503, "agent_input_disabled");
      const parsed = answerSchema.safeParse(await ctx.readJsonBody(MAX_ANSWER_BODY));
      if (!parsed.success) {
        ctx.sendJson(422, { outcome: "invalid_answers" }, NO_STORE);
        return;
      }
      const body = parsed.data;
      const abort = new AbortController();
      const disconnect = () => abort.abort();
      ctx.request.once("aborted", disconnect);
      ctx.response.once("close", disconnect);
      let result;
      try {
        result = await ctx.deps.agentInputRelay.submit(
          ctx.match![1],
          body.expectedGeneration,
          body.idempotencyKey,
          body.answers,
          abort.signal,
        );
      } finally {
        ctx.request.removeListener("aborted", disconnect);
        ctx.response.removeListener("close", disconnect);
      }
      if (abort.signal.aborted || ctx.response.destroyed) return;
      const status = result.outcome === "delivered" || result.outcome === "already_resolved" ? 200
        : result.outcome === "invalid_answers" ? 422
          : result.outcome === "conflict" ? 409
            : result.outcome === "source_unavailable" || result.outcome === "delivery_timeout" ? 503
              : result.outcome === "sdk_error" && result.retryable ? 503 : 502;
      ctx.sendJson(status, result, NO_STORE);
    },
  },
];

export const mapAgentInputRouteError = (error: unknown): HttpError | undefined => {
  if (error instanceof AgentInputCredentialError) {
    return new HttpError(error.code === "unauthorized" || error.code === "invalid_capability" ? 401 : 409, error.code);
  }
  if (error instanceof AgentInputRequestStoreError) {
    if (error.code === "invalid_answer_shape") return new HttpError(422, error.code);
    if (error.code === "unauthorized_source") return new HttpError(401, "unauthorized");
    if (error.code === "invalid_poll_query") return new HttpError(400, error.code);
    if (error.code === "poll_limit") return new HttpError(429, error.code);
    if (error.code.endsWith("_limit")) return new HttpError(429, error.code);
    return new HttpError(409, error.code);
  }
  return undefined;
};
