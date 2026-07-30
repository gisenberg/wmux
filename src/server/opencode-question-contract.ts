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
export const OPENCODE_RUNTIME_HANDSHAKE_SCHEMA = 1;
export const OPENCODE_QUESTION_COMPATIBILITY_FINGERPRINT =
  "opencode-question-occurrence-stream-v4-runtime-attestation-1.18.9";
export const OPENCODE_QUESTION_CONTRACT_DIGEST = "1feab28627744cac89922c1aaf5177a26f2f290511d1b0e457d0fd8f1671997f";
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
  custom: question.custom ?? false,
});
const _compileHealth = (client: OpencodeClient) => client.global.health();
void _compileReplyInput;
void _compileQuestion;
void _compileHealth;

const attestationCapabilitySchema = z.object({
  globalHealth: z.boolean(),
  questionList: z.boolean(),
  questionReply: z.boolean(),
  sessionGet: z.boolean(),
}).strict();

export const openCodeRuntimeAttestationSchema = z.object({
  type: z.literal("runtime_attestation"),
  handshakeSchema: z.literal(OPENCODE_RUNTIME_HANDSHAKE_SCHEMA),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  challengeIssuedAt: z.number().int().nonnegative(),
  challengeDeadline: z.number().int().positive(),
  observedAt: z.number().int().nonnegative(),
  contractDigest: z.string().regex(/^[a-f0-9]{64}$/),
  compatibilityFingerprint: z.string().min(1).max(256),
  eventEnvelope: z.string().min(1).max(64),
  release: z.string().max(64),
  health: z.object({
    called: z.boolean(),
    outcome: z.enum(["ok", "missing", "timeout", "error", "malformed", "release_mismatch"]),
    status: z.number().int().min(0).max(999),
    healthy: z.boolean(),
    release: z.string().max(64),
  }).strict(),
  capabilities: attestationCapabilitySchema,
  diagnostic: z.enum([
    "ok",
    "health_method_missing",
    "health_timeout",
    "health_error",
    "health_malformed",
    "health_release_mismatch",
    "client_method_missing",
  ]),
}).strict();

export type OpenCodeRuntimeAttestation = z.infer<typeof openCodeRuntimeAttestationSchema>;

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
    && value.contractDigest === OPENCODE_QUESTION_CONTRACT_DIGEST
    && value.compatibilityFingerprint === OPENCODE_QUESTION_COMPATIBILITY_FINGERPRINT
    && value.eventEnvelope === OPENCODE_QUESTION_EVENT_ENVELOPE
    && value.release === SUPPORTED_OPENCODE_SDK_VERSION
    && value.health.called
    && value.health.outcome === "ok"
    && value.health.status === 200
    && value.health.healthy
    && value.health.release === SUPPORTED_OPENCODE_SDK_VERSION
    && capabilities.globalHealth
    && capabilities.questionList
    && capabilities.questionReply
    && capabilities.sessionGet
    && value.diagnostic === "ok";
};

export const createOpenCodeRuntimeAttestation = (
  nonce: string,
  nowMs = Date.now(),
): OpenCodeRuntimeAttestation => ({
  type: "runtime_attestation",
  handshakeSchema: OPENCODE_RUNTIME_HANDSHAKE_SCHEMA,
  nonce,
  challengeIssuedAt: nowMs - 1,
  challengeDeadline: nowMs + 5_000,
  observedAt: nowMs,
  contractDigest: OPENCODE_QUESTION_CONTRACT_DIGEST,
  compatibilityFingerprint: OPENCODE_QUESTION_COMPATIBILITY_FINGERPRINT,
  eventEnvelope: OPENCODE_QUESTION_EVENT_ENVELOPE,
  release: SUPPORTED_OPENCODE_SDK_VERSION,
  health: { called: true, outcome: "ok", status: 200, healthy: true, release: SUPPORTED_OPENCODE_SDK_VERSION },
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
