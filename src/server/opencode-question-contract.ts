import type {
  EventQuestionAsked,
  EventQuestionRejected,
  EventQuestionReplied,
  QuestionInfo,
} from "@opencode-ai/sdk/v2/client";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { z } from "zod";
import type { AgentInputQuestion } from "../shared/protocol.js";

export const SUPPORTED_OPENCODE_SDK_VERSION = "1.18.9";
export const SUPPORTED_OPENCODE_SOURCE_COMMIT = "4da7bb44c84e013fa53e9c5d02ac753d1435c81a";
export const OPENCODE_RUNTIME_HANDSHAKE_SCHEMA = 4;
export const OPENCODE_HEALTH_EVIDENCE_SOURCE = "plugin.injectedTransport:/global/health" as const;
export const OPENCODE_QUESTION_COMPATIBILITY_FINGERPRINT =
  "opencode-question-occurrence-stream-v9-bounded-snapshot-injected-transport-global-health-server-challenge-1.18.9";
export const OPENCODE_QUESTION_CONTRACT_DIGEST = "b37166e892fe20db37c2c501ab58c093da1db95a19ef6951393e67f38766f5b8";
export const OPENCODE_QUESTION_EVENT_ENVELOPE = "legacy-properties";

export type OpenCodeQuestionReply = Parameters<OpencodeClient["question"]["reply"]>[0];

// These assignments intentionally compile against the supported SDK rather than
// duplicating its reply or event contract in wmux types.
const _compileReplyInput = (requestID: string, answers: string[][]): OpenCodeQuestionReply => ({
  requestID,
  answers,
});
const _compileQuestion = (question: QuestionInfo): AgentInputQuestion => ({
  header: question.header,
  question: question.question,
  options: question.options,
  multiple: question.multiple ?? false,
  custom: question.custom ?? true,
});
void _compileReplyInput;
void _compileQuestion;

const attestationCapabilitySchema = z.object({
  globalHealth: z.boolean(),
  questionList: z.boolean(),
  questionReply: z.boolean(),
  sessionGet: z.boolean(),
}).strict();

export const openCodeServerChallengeSchema = z.object({
  id: z.string().uuid(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  issuedAt: z.number().int().nonnegative(),
  deadline: z.number().int().positive(),
}).strict();

export type OpenCodeServerChallenge = z.infer<typeof openCodeServerChallengeSchema>;

export const openCodeRuntimeAttestationSchema = z.object({
  type: z.literal("runtime_attestation"),
  handshakeSchema: z.literal(OPENCODE_RUNTIME_HANDSHAKE_SCHEMA),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  serverChallenge: openCodeServerChallengeSchema,
  challengeIssuedAt: z.number().int().nonnegative(),
  challengeDeadline: z.number().int().positive(),
  observedAt: z.number().int().nonnegative(),
  contractDigest: z.string().regex(/^[a-f0-9]{64}$/),
  compatibilityFingerprint: z.string().min(1).max(256),
  eventEnvelope: z.string().min(1).max(64),
  release: z.string().max(64),
  health: z.object({
    source: z.enum([OPENCODE_HEALTH_EVIDENCE_SOURCE]),
    called: z.boolean(),
    outcome: z.enum([
      "ok",
      "unavailable",
      "timeout",
      "transport_error",
      "status",
      "shape_invalid",
      "release_mismatch",
    ]),
    status: z.number().int().min(0).max(999),
    healthy: z.boolean(),
    release: z.string().max(64),
  }).strict(),
  capabilities: attestationCapabilitySchema,
  diagnostic: z.enum([
    "ok",
    "injected_transport_missing",
    "injected_transport_invalid",
    "health_timeout",
    "health_transport_error",
    "health_status",
    "health_shape_invalid",
    "health_release_mismatch",
    "v2_client_import_error",
    "v2_client_construction_error",
    "client_method_missing",
  ]),
}).strict();

export type OpenCodeRuntimeAttestation = z.infer<typeof openCodeRuntimeAttestationSchema>;

export const sanitizedOpenCodeRuntimeAttestationSchema = openCodeRuntimeAttestationSchema.omit({
  nonce: true,
  serverChallenge: true,
  challengeIssuedAt: true,
  challengeDeadline: true,
});

export type SanitizedOpenCodeRuntimeAttestation = z.infer<typeof sanitizedOpenCodeRuntimeAttestationSchema>;

export const sanitizeOpenCodeRuntimeAttestation = (
  input: OpenCodeRuntimeAttestation,
): SanitizedOpenCodeRuntimeAttestation => {
  const {
    nonce: _nonce,
    serverChallenge: _serverChallenge,
    challengeIssuedAt: _challengeIssuedAt,
    challengeDeadline: _challengeDeadline,
    ...sanitized
  } = input;
  return sanitizedOpenCodeRuntimeAttestationSchema.parse(sanitized);
};

export const isSupportedOpenCodeRuntimeAttestation = (
  input: unknown,
  nowMs = Date.now(),
): input is OpenCodeRuntimeAttestation => {
  const parsed = openCodeRuntimeAttestationSchema.safeParse(input);
  if (!parsed.success) return false;
  const value = parsed.data;
  const capabilities = value.capabilities;
  return value.challengeDeadline > value.challengeIssuedAt
    && value.challengeDeadline - value.challengeIssuedAt <= 10_000
    && value.observedAt >= value.challengeIssuedAt
    && value.observedAt <= value.challengeDeadline
    && value.challengeIssuedAt >= nowMs - 15_000
    && value.challengeIssuedAt <= nowMs + 15_000
    && value.observedAt <= nowMs + 15_000
    && value.challengeDeadline >= nowMs - 1_000
    && value.serverChallenge.deadline > value.serverChallenge.issuedAt
    && value.serverChallenge.deadline - value.serverChallenge.issuedAt <= 30_000
    && value.serverChallenge.issuedAt <= value.challengeIssuedAt
    && value.challengeDeadline <= value.serverChallenge.deadline
    && value.serverChallenge.deadline >= nowMs - 1_000
    && value.contractDigest === OPENCODE_QUESTION_CONTRACT_DIGEST
    && value.compatibilityFingerprint === OPENCODE_QUESTION_COMPATIBILITY_FINGERPRINT
    && value.eventEnvelope === OPENCODE_QUESTION_EVENT_ENVELOPE
    && value.release === SUPPORTED_OPENCODE_SDK_VERSION
    && value.health.called
    && value.health.outcome === "ok"
    && value.health.status === 200
    && value.health.healthy
    && value.health.release === SUPPORTED_OPENCODE_SDK_VERSION
    && value.health.source === OPENCODE_HEALTH_EVIDENCE_SOURCE
    && capabilities.globalHealth
    && capabilities.questionList
    && capabilities.questionReply
    && capabilities.sessionGet
    && value.diagnostic === "ok";
};

export const createOpenCodeRuntimeAttestation = (
  nonce: string,
  serverChallenge: OpenCodeServerChallenge = {
    id: "00000000-0000-4000-8000-000000000000",
    nonce: "S".repeat(43),
    issuedAt: Date.now() - 2,
    deadline: Date.now() + 10_000,
  },
  nowMs = Date.now(),
): OpenCodeRuntimeAttestation => ({
  type: "runtime_attestation",
  handshakeSchema: OPENCODE_RUNTIME_HANDSHAKE_SCHEMA,
  nonce,
  serverChallenge,
  challengeIssuedAt: Math.max(nowMs - 1, serverChallenge.issuedAt),
  challengeDeadline: Math.min(nowMs + 5_000, serverChallenge.deadline),
  observedAt: nowMs,
  contractDigest: OPENCODE_QUESTION_CONTRACT_DIGEST,
  compatibilityFingerprint: OPENCODE_QUESTION_COMPATIBILITY_FINGERPRINT,
  eventEnvelope: OPENCODE_QUESTION_EVENT_ENVELOPE,
  release: SUPPORTED_OPENCODE_SDK_VERSION,
  health: {
    source: OPENCODE_HEALTH_EVIDENCE_SOURCE,
    called: true,
    outcome: "ok",
    status: 200,
    healthy: true,
    release: SUPPORTED_OPENCODE_SDK_VERSION,
  },
  capabilities: { globalHealth: true, questionList: true, questionReply: true, sessionGet: true },
  diagnostic: "ok",
});

const boundedString = (max: number) => z.string().min(1).max(max);
const questionSchema = z.object({
  header: boundedString(120),
  question: boundedString(16_384),
  options: z.array(z.object({
    label: boundedString(1_024),
    description: z.string().max(4_096),
  }).strict()).max(128),
  multiple: z.boolean().optional(),
  custom: z.boolean().optional(),
}).strict();

const askedSchema = z.object({
  id: boundedString(256),
  type: z.literal("question.asked"),
  properties: z.object({
    id: boundedString(256),
    sessionID: boundedString(256),
    questions: z.array(questionSchema).min(1).max(32),
    tool: z.unknown().optional(),
  }).strict(),
}).strict();

// The SDK event includes answers. Capture code must call sanitize before any
// fixture, broker, log, or durable boundary.
const repliedInputSchema = z.object({
  id: boundedString(256),
  type: z.literal("question.replied"),
  properties: z.object({
    requestID: boundedString(256),
    sessionID: boundedString(256),
    answers: z.unknown().optional(),
  }).strict(),
}).strict();

const repliedIdentitySchema = z.object({
  id: boundedString(256),
  type: z.literal("question.replied"),
  properties: z.object({
    requestID: boundedString(256),
    sessionID: boundedString(256),
  }).strict(),
}).strict();

const rejectedSchema = z.object({
  id: boundedString(256),
  type: z.literal("question.rejected"),
  properties: z.object({
    requestID: boundedString(256),
    sessionID: boundedString(256),
  }).strict(),
}).strict();

export type SanitizedOpenCodeQuestionEvent =
  | EventQuestionAsked
  | Omit<EventQuestionReplied, "properties"> & {
      properties: Pick<EventQuestionReplied["properties"], "requestID" | "sessionID">;
    }
  | EventQuestionRejected;

export type OpenCodeQuestionEventParseResult =
  | { kind: "supported"; event: SanitizedOpenCodeQuestionEvent }
  | { kind: "ignored" }
  | { kind: "unsupported"; code: "incompatible_event_shape" };

export const sanitizeOpenCodeQuestionEvent = (input: unknown): OpenCodeQuestionEventParseResult => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { kind: "ignored" };
  const type = (input as { type?: unknown }).type;
  if (type !== "question.asked" && type !== "question.replied" && type !== "question.rejected") {
    return typeof type === "string" && type.startsWith("question.")
      ? { kind: "unsupported", code: "incompatible_event_shape" }
      : { kind: "ignored" };
  }
  if (type === "question.asked") {
    const parsed = askedSchema.safeParse(input);
    if (!parsed.success) return { kind: "unsupported", code: "incompatible_event_shape" };
    return { kind: "supported", event: parsed.data as EventQuestionAsked };
  }
  if (type === "question.replied") {
    const parsed = repliedInputSchema.safeParse(input);
    if (!parsed.success) return { kind: "unsupported", code: "incompatible_event_shape" };
    const identity = repliedIdentitySchema.parse({
      id: parsed.data.id,
      type: parsed.data.type,
      properties: {
        requestID: parsed.data.properties.requestID,
        sessionID: parsed.data.properties.sessionID,
      },
    });
    return { kind: "supported", event: identity as SanitizedOpenCodeQuestionEvent };
  }
  const parsed = rejectedSchema.safeParse(input);
  return parsed.success
    ? { kind: "supported", event: parsed.data as EventQuestionRejected }
    : { kind: "unsupported", code: "incompatible_event_shape" };
};

export const isSupportedOpenCodeQuestionRuntime = isSupportedOpenCodeRuntimeAttestation;

export type OpenCodeReplyOutcome =
  | { outcome: "applied" }
  | { outcome: "already_resolved" }
  | { outcome: "sdk_error"; code: string; retryable: boolean }
  | { outcome: "unsupported"; code: "incompatible_reply_result" };

export const classifyOpenCodeQuestionReplyResult = (result: unknown): OpenCodeReplyOutcome => {
  if (!result || typeof result !== "object") {
    return { outcome: "unsupported", code: "incompatible_reply_result" };
  }
  const fields = result as { data?: unknown; error?: unknown; response?: { status?: unknown } };
  const status = fields.response?.status;
  if (status === 200 && fields.data === true && fields.error === undefined) return { outcome: "applied" };
  if (status === 404 && isTaggedError(fields.error, "QuestionNotFoundError")) return { outcome: "already_resolved" };
  if (status === 400 && fields.error !== undefined) {
    if (isTaggedError(fields.error, "InvalidRequestError")) {
      return { outcome: "sdk_error", code: "InvalidRequest", retryable: false };
    }
    if (isTaggedError(fields.error, "BadRequest")) {
      return { outcome: "sdk_error", code: "BadRequest", retryable: false };
    }
    return { outcome: "unsupported", code: "incompatible_reply_result" };
  }
  if (typeof status === "number" && (status === 408 || status === 429 || status >= 500)) {
    return { outcome: "sdk_error", code: `http_${status}`, retryable: true };
  }
  return { outcome: "unsupported", code: "incompatible_reply_result" };
};

const isTaggedError = (input: unknown, tag: string): boolean => Boolean(
  input && typeof input === "object" && (input as { _tag?: unknown })._tag === tag,
);
