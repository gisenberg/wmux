import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type {
  AgentInputQuestion,
  AgentInputRequest,
  AgentInputRequestState,
} from "../shared/protocol.js";

export const CURRENT_AGENT_INPUT_REQUEST_SCHEMA_VERSION = 7;
export const MAX_AGENT_INPUT_REQUESTS = 2_000;
export const MAX_AGENT_INPUT_TOMBSTONES = MAX_AGENT_INPUT_REQUESTS * 4;
export const MAX_AGENT_INPUT_GENERATION_ANCHORS = MAX_AGENT_INPUT_REQUESTS * 2;
export const MAX_AGENT_INPUT_PENDING_PER_SOURCE = 128;
export const MAX_AGENT_INPUT_REQUESTS_PER_SOURCE = 256;
export const MAX_AGENT_INPUT_ANCHORS_PER_SOURCE = 512;
export const MAX_AGENT_INPUT_SERIALIZED_BYTES_PER_SOURCE = 1 * 1024 * 1024;
export const MAX_AGENT_INPUT_SERIALIZED_BYTES = 8 * 1024 * 1024;
export const MAX_AGENT_INPUT_QUESTIONS = 32;
export const MAX_AGENT_INPUT_OPTIONS = 128;
export const MAX_AGENT_INPUT_ANSWER_BYTES = 16_384;
export const DEFAULT_AGENT_INPUT_RESOLVED_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const DEFAULT_AGENT_INPUT_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const DEFAULT_AGENT_INPUT_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;

const defaultPath = (): string =>
  process.env.WMUX_AGENT_INPUT_REQUEST_PATH
  ?? path.join(os.homedir(), ".wmux", "agent-input-requests.json");

const text = (max: number) => z.string().min(1).max(max);
const questionSchema = z.object({
  header: text(120),
  question: text(16_384),
  options: z.array(z.object({
    label: text(1_024),
    description: z.string().max(4_096),
  }).strict()).max(MAX_AGENT_INPUT_OPTIONS),
  multiple: z.boolean(),
  custom: z.boolean(),
}).strict();

const legacyRequestSchema = z.object({
  id: text(256),
  sourceId: text(256),
  workspaceId: text(256),
  tabId: text(256),
  paneId: text(256),
  machineId: text(256).optional(),
  openCodeSessionId: text(256),
  openCodeRequestId: text(256),
  generation: z.number().int().positive(),
  questions: z.array(questionSchema).min(1).max(MAX_AGENT_INPUT_QUESTIONS),
  state: z.enum(["pending", "answered", "rejected", "cancelled", "closed"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  resolvedAt: z.string().datetime().optional(),
  resolution: z.enum(["user", "terminal", "plugin", "pane-closed", "source-revoked", "migration-unbound"]).optional(),
}).strict();

const occurrenceBindingSchema = z.object({
  occurrenceId: text(256),
  occurrenceKey: z.string().regex(/^[a-f0-9]{64}$/),
  ordinal: z.number().int().positive().safe(),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const requestSchema = legacyRequestSchema.extend({
  occurrence: occurrenceBindingSchema.optional(),
}).strict();

const submissionSchema = z.object({
  requestId: text(256),
  generation: z.number().int().positive(),
  idempotencyKey: text(256),
  answerDigest: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["reserved", "exposed", "ambiguous", "delivered", "already_resolved", "sdk_error"]),
  outcome: z.enum(["delivered", "already_resolved", "sdk_error", "source_unavailable", "delivery_timeout"]).optional(),
  code: z.string().max(120).optional(),
  deliveryId: text(256).optional(),
  sdkStartedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime(),
}).strict();
const legacySubmissionSchema = submissionSchema.extend({
  status: z.enum(["reserved", "delivered", "already_resolved", "sdk_error", "retryable", "in_doubt"]),
});

const legacyTombstoneSchema = z.object({
  id: text(256),
  sourceId: text(256),
  openCodeRequestId: text(256),
  generation: z.number().int().positive(),
  state: z.enum(["answered", "rejected", "cancelled", "closed"]),
  expiresAt: z.string().datetime(),
}).strict();
const tombstoneSchema = legacyTombstoneSchema.extend({
  occurrence: occurrenceBindingSchema.optional(),
}).strict();

const generationAnchorSchema = z.object({
  sourceId: text(256),
  occurrenceKey: z.string().regex(/^[a-f0-9]{64}$/),
  highOrdinal: z.number().int().nonnegative(),
  highGeneration: z.number().int().nonnegative(),
  legacyRequestId: text(256).optional(),
  latestOccurrenceId: text(256).optional(),
  latestPayloadDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().refine((anchor) => anchor.highOrdinal === 0
  ? anchor.latestOccurrenceId === undefined && anchor.latestPayloadDigest === undefined
  : anchor.latestOccurrenceId !== undefined && anchor.latestPayloadDigest !== undefined);

const attentionSchema = z.object({
  requestId: text(256),
  generation: z.number().int().positive(),
  notificationId: text(120),
  createdAt: z.string().datetime(),
}).strict();

const retiredSourceSchema = z.object({
  sourceId: text(256),
  retiredAt: z.string().datetime(),
}).strict();

const envelopeSchema = z.object({
  schemaVersion: z.literal(CURRENT_AGENT_INPUT_REQUEST_SCHEMA_VERSION),
  requests: z.array(requestSchema).max(MAX_AGENT_INPUT_REQUESTS),
  submissions: z.array(submissionSchema).max(MAX_AGENT_INPUT_REQUESTS),
  tombstones: z.array(tombstoneSchema).max(MAX_AGENT_INPUT_TOMBSTONES),
  attention: z.array(attentionSchema).max(MAX_AGENT_INPUT_REQUESTS),
  generationAnchors: z.array(generationAnchorSchema).max(MAX_AGENT_INPUT_GENERATION_ANCHORS),
  retiredSources: z.array(retiredSourceSchema).max(MAX_AGENT_INPUT_GENERATION_ANCHORS),
}).strict();

const envelopeV6Schema = envelopeSchema.omit({ schemaVersion: true, retiredSources: true }).extend({
  schemaVersion: z.literal(6),
}).strict();

const envelopeV5Schema = z.object({
  schemaVersion: z.literal(5),
  requests: z.array(legacyRequestSchema.extend({
    captureOperations: z.array(z.object({ id: text(256), payloadDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(256),
  }).strict()).max(MAX_AGENT_INPUT_REQUESTS),
  submissions: z.array(submissionSchema).max(MAX_AGENT_INPUT_REQUESTS),
  tombstones: z.array(legacyTombstoneSchema.extend({
    captureOperations: z.array(z.object({ id: text(256), payloadDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(256),
  }).strict()).max(MAX_AGENT_INPUT_TOMBSTONES),
  attention: z.array(attentionSchema).max(MAX_AGENT_INPUT_REQUESTS),
}).strict();

const envelopeV4Schema = z.object({
  schemaVersion: z.literal(4),
  requests: z.array(legacyRequestSchema).max(MAX_AGENT_INPUT_REQUESTS),
  submissions: z.array(submissionSchema).max(MAX_AGENT_INPUT_REQUESTS),
  tombstones: z.array(legacyTombstoneSchema).max(MAX_AGENT_INPUT_TOMBSTONES),
  attention: z.array(attentionSchema).max(MAX_AGENT_INPUT_REQUESTS),
}).strict();

const envelopeV2Schema = z.object({
  schemaVersion: z.literal(2),
  requests: z.array(legacyRequestSchema).max(MAX_AGENT_INPUT_REQUESTS),
  submissions: z.array(legacySubmissionSchema).max(MAX_AGENT_INPUT_REQUESTS),
  tombstones: z.array(legacyTombstoneSchema).max(MAX_AGENT_INPUT_TOMBSTONES),
  attention: z.array(attentionSchema).max(MAX_AGENT_INPUT_REQUESTS),
}).strict();

const envelopeV1Schema = z.object({
  schemaVersion: z.literal(1),
  requests: z.array(legacyRequestSchema).max(MAX_AGENT_INPUT_REQUESTS),
  submissions: z.array(legacySubmissionSchema).max(MAX_AGENT_INPUT_REQUESTS),
  tombstones: z.array(legacyTombstoneSchema).max(MAX_AGENT_INPUT_TOMBSTONES),
}).strict();

const envelopeV0Schema = z.object({
  schemaVersion: z.literal(0),
  requests: z.array(legacyRequestSchema).max(MAX_AGENT_INPUT_REQUESTS),
  tombstones: z.array(legacyTombstoneSchema).max(MAX_AGENT_INPUT_TOMBSTONES),
}).strict();

type Envelope = z.infer<typeof envelopeSchema>;
type StoredRequest = Envelope["requests"][number];
type Submission = z.infer<typeof submissionSchema>;

export class UnsupportedAgentInputRequestVersionError extends Error {
  constructor(readonly version: number) {
    super(`agent input request schema ${version} is newer than this wmux build supports (${CURRENT_AGENT_INPUT_REQUEST_SCHEMA_VERSION})`);
    this.name = "UnsupportedAgentInputRequestVersionError";
  }
}

export class AgentInputRequestStoreError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AgentInputRequestStoreError";
  }
}

export type AgentInputRequestQuotaCode = "source_byte_limit" | "global_byte_limit";

export class AgentInputRequestQuotaError extends AgentInputRequestStoreError {
  declare readonly code: AgentInputRequestQuotaCode;

  constructor(
    code: AgentInputRequestQuotaCode,
    readonly limit: number,
    readonly beforeBytes: number,
    readonly afterBytes: number,
    readonly sourceId?: string,
  ) {
    super(code);
    this.name = "AgentInputRequestQuotaError";
  }
}

export interface AgentInputRequestStoreOptions {
  answerDigestKey: string;
  resolvedRetentionMs?: number;
  tombstoneRetentionMs?: number;
  beforeRename?: () => void;
  directoryFsync?: (directory: string, target: "backup" | "primary" | "quarantine") => void;
  pruneIntervalMs?: number;
  maxSerializedBytesPerSource?: number;
  maxSerializedBytes?: number;
}

export type CaptureAgentInputResult =
  | { outcome: "created"; request: AgentInputRequest; superseded: Array<{ id: string; generation: number }> }
  | { outcome: "duplicate"; request: AgentInputRequest | Pick<AgentInputRequest, "id" | "generation" | "state"> }
  | { outcome: "retired"; generation: number }
  | { outcome: "conflict"; code: "conflicting_duplicate" };

export type ReserveAgentInputResult =
  | { outcome: "reserved" | "resumed"; request: AgentInputRequest; digest: string }
  | { outcome: "converged"; result: AgentInputAnswerOutcome }
  | { outcome: "conflict"; code: "not_found" | "stale_generation" | "not_pending" | "idempotency_conflict" };

export type AgentInputAnswerOutcome =
  | { outcome: "delivered" }
  | { outcome: "already_resolved" }
  | { outcome: "sdk_error"; code: string; retryable: boolean }
  | { outcome: "source_unavailable" }
  | { outcome: "delivery_timeout" };

export interface CaptureAgentInputRequest {
  occurrenceId: string;
  occurrenceKey: string;
  occurrenceOrdinal: number;
  payloadDigest: string;
  sourceId: string;
  workspaceId: string;
  tabId: string;
  paneId: string;
  machineId?: string;
  openCodeSessionId: string;
  openCodeRequestId: string;
  questions: AgentInputQuestion[];
}

export interface AgentInputNativeSnapshotMember {
  occurrenceId: string;
  occurrenceKey: string;
  ordinal: number;
  payloadDigest: string;
  sessionID: string;
  requestID: string;
  questions: AgentInputQuestion[];
}

export interface AgentInputAttentionRecord {
  request: AgentInputRequest;
  notificationId: string;
  createdAt: string;
}

export class AgentInputRequestStore extends EventEmitter {
  private data: Envelope;
  private readonly resolvedRetentionMs: number;
  private readonly tombstoneRetentionMs: number;
  private readonly maxSerializedBytesPerSource: number;
  private readonly maxSerializedBytes: number;
  private readonly pruneTimer?: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(
    readonly filePath = defaultPath(),
    private readonly options: AgentInputRequestStoreOptions,
  ) {
    super();
    if (!options.answerDigestKey) throw new Error("agent input answer digest key is required");
    this.resolvedRetentionMs = options.resolvedRetentionMs ?? DEFAULT_AGENT_INPUT_RESOLVED_RETENTION_MS;
    this.tombstoneRetentionMs = options.tombstoneRetentionMs ?? DEFAULT_AGENT_INPUT_TOMBSTONE_RETENTION_MS;
    this.maxSerializedBytesPerSource = boundedQuota(
      options.maxSerializedBytesPerSource,
      MAX_AGENT_INPUT_SERIALIZED_BYTES_PER_SOURCE,
    );
    this.maxSerializedBytes = boundedQuota(options.maxSerializedBytes, MAX_AGENT_INPUT_SERIALIZED_BYTES);
    this.ensureSecureParent();
    const loaded = this.load();
    const recovered = loaded.recovered ? recoverBackupEnvelope(loaded.data) : { data: loaded.data, changed: false };
    const startup = recoverInterruptedSubmissions(recovered.data);
    this.data = startup.data;
    if (loaded.recovered || loaded.migrated || !fs.existsSync(this.filePath)) {
      this.persist(this.data, false);
    } else if (startup.changed) {
      this.persist(this.data, true);
    }
    const pruneIntervalMs = options.pruneIntervalMs ?? DEFAULT_AGENT_INPUT_PRUNE_INTERVAL_MS;
    if (pruneIntervalMs > 0) {
      this.pruneTimer = setInterval(() => this.prune(), pruneIntervalMs);
      this.pruneTimer.unref?.();
    }
  }

  snapshot(): AgentInputRequest[] {
    return this.data.requests.map(toPublicRequest).sort(compareAgentInputRequests);
  }

  attentionSnapshot(): AgentInputAttentionRecord[] {
    return this.data.attention.flatMap((attention) => {
      const request = this.data.requests.find((candidate) => candidate.id === attention.requestId
        && candidate.generation === attention.generation);
      return request ? [{
        request: toPublicRequest(request),
        notificationId: attention.notificationId,
        createdAt: attention.createdAt,
      }] : [];
    });
  }

  find(id: string): AgentInputRequest | undefined {
    const request = this.data.requests.find((candidate) => candidate.id === id);
    return request ? toPublicRequest(request) : undefined;
  }

  capture(input: CaptureAgentInputRequest, nowMs = Date.now()): CaptureAgentInputResult {
    this.prune(nowMs);
    validateCaptureInput(input);
    return this.commit<CaptureAgentInputResult>((draft) => {
      const payloadDigest = capturePayloadDigest(input);
      if (input.occurrenceKey !== nativeOccurrenceKey(input.openCodeSessionId, input.openCodeRequestId)
        || input.payloadDigest !== payloadDigest) {
        return { changed: false, result: { outcome: "conflict" as const, code: "conflicting_duplicate" as const } };
      }
      if (draft.retiredSources.some((source) => source.sourceId === input.sourceId)) {
        throw new AgentInputRequestStoreError("source_retired");
      }
      const priorOccurrence = [...draft.requests, ...draft.tombstones].find((record) =>
        record.sourceId === input.sourceId && record.occurrence?.occurrenceId === input.occurrenceId);
      if (priorOccurrence) {
        const occurrence = priorOccurrence.occurrence!;
        return {
          changed: false,
          result: occurrence.occurrenceKey === input.occurrenceKey
             && occurrence.ordinal === input.occurrenceOrdinal
             && occurrence.payloadDigest === payloadDigest
             && priorOccurrence.openCodeRequestId === input.openCodeRequestId
            ? { outcome: "duplicate" as const, request: "questions" in priorOccurrence
              ? toPublicRequest(priorOccurrence)
              : { id: priorOccurrence.id, generation: priorOccurrence.generation, state: priorOccurrence.state } }
            : { outcome: "conflict" as const, code: "conflicting_duplicate" as const },
        };
      }
      let anchor = draft.generationAnchors.find((candidate) => candidate.sourceId === input.sourceId
        && (candidate.occurrenceKey === input.occurrenceKey
          || (candidate.highOrdinal === 0 && candidate.legacyRequestId === input.openCodeRequestId)));
      if (anchor) {
        if (input.occurrenceOrdinal < anchor.highOrdinal) {
          return { changed: false, result: { outcome: "retired" as const, generation: anchor.highGeneration } };
        }
        if (input.occurrenceOrdinal === anchor.highOrdinal) {
          return { changed: false, result: anchor.latestOccurrenceId === input.occurrenceId
            && anchor.latestPayloadDigest === payloadDigest
            ? { outcome: "retired" as const, generation: anchor.highGeneration }
            : { outcome: "conflict" as const, code: "conflicting_duplicate" as const } };
        }
        if (input.occurrenceOrdinal !== anchor.highOrdinal + 1) {
          return { changed: false, result: { outcome: "conflict" as const, code: "conflicting_duplicate" as const } };
        }
        const latestOccurrenceId = anchor.latestOccurrenceId;
        const current = draft.requests.find((candidate) => candidate.sourceId === input.sourceId
          && candidate.occurrence?.occurrenceId === latestOccurrenceId);
        if (current?.state === "pending") {
          return { changed: false, result: current.occurrence?.payloadDigest === payloadDigest
            ? { outcome: "duplicate" as const, request: toPublicRequest(current) }
            : { outcome: "conflict" as const, code: "conflicting_duplicate" as const } };
        }
      } else if (input.occurrenceOrdinal !== 1) {
        return { changed: false, result: { outcome: "conflict" as const, code: "conflicting_duplicate" as const } };
      }
      if (draft.requests.length >= MAX_AGENT_INPUT_REQUESTS) {
        throw new AgentInputRequestStoreError("request_limit");
      }
      if (draft.requests.filter((request) => request.sourceId === input.sourceId).length >= MAX_AGENT_INPUT_REQUESTS_PER_SOURCE) {
        throw new AgentInputRequestStoreError("source_request_limit");
      }
      if (draft.requests.filter((request) => request.sourceId === input.sourceId && request.state === "pending").length
        >= MAX_AGENT_INPUT_PENDING_PER_SOURCE) {
        throw new AgentInputRequestStoreError("source_pending_limit");
      }
      if (!anchor && draft.generationAnchors.filter((candidate) => candidate.sourceId === input.sourceId).length
        >= MAX_AGENT_INPUT_ANCHORS_PER_SOURCE) {
        throw new AgentInputRequestStoreError("source_anchor_limit");
      }
      if (!anchor && draft.generationAnchors.length >= MAX_AGENT_INPUT_GENERATION_ANCHORS) {
        throw new AgentInputRequestStoreError("global_anchor_limit");
      }
      const generation = (anchor?.highGeneration ?? 0) + 1;
      const timestamp = new Date(nowMs).toISOString();
      const superseded: Array<{ id: string; generation: number }> = [];
      for (const pending of draft.requests) {
        if (pending.sourceId !== input.sourceId || pending.state !== "pending"
          || pending.occurrence?.occurrenceKey !== input.occurrenceKey) continue;
        pending.state = "closed";
        pending.resolution = "plugin";
        pending.resolvedAt = timestamp;
        pending.updatedAt = timestamp;
        settleSubmission(draft.submissions, pending.id, timestamp);
        superseded.push({ id: pending.id, generation: pending.generation });
      }
      const request: AgentInputRequest = {
        id: `input_${crypto.randomUUID()}`,
        sourceId: input.sourceId,
        workspaceId: input.workspaceId,
        tabId: input.tabId,
        paneId: input.paneId,
        ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
        openCodeSessionId: input.openCodeSessionId,
        openCodeRequestId: input.openCodeRequestId,
        questions: structuredClone(input.questions),
        generation,
        state: "pending",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const stored: StoredRequest = {
        ...request,
        occurrence: {
          occurrenceId: input.occurrenceId,
          occurrenceKey: input.occurrenceKey,
          ordinal: input.occurrenceOrdinal,
          payloadDigest,
        },
      };
      draft.requests.push(stored);
      draft.attention.push(attentionForRequest(stored));
      if (!anchor) {
        anchor = { sourceId: input.sourceId, occurrenceKey: input.occurrenceKey, highOrdinal: 0, highGeneration: 0 };
        draft.generationAnchors.push(anchor);
      }
      anchor.highOrdinal = input.occurrenceOrdinal;
      anchor.highGeneration = generation;
      anchor.occurrenceKey = input.occurrenceKey;
      delete anchor.legacyRequestId;
      anchor.latestOccurrenceId = input.occurrenceId;
      anchor.latestPayloadDigest = payloadDigest;
      return { changed: true, result: { outcome: "created" as const, request: toPublicRequest(stored), superseded } };
    });
  }

  reserve(
    id: string,
    expectedGeneration: number,
    idempotencyKey: string,
    answers: string[][],
    nowMs = Date.now(),
  ): ReserveAgentInputResult {
    if (!idempotencyKey || Buffer.byteLength(idempotencyKey) > 256) {
      throw new AgentInputRequestStoreError("invalid_idempotency_key");
    }
    const digest = this.answerDigest(answers);
    return this.commit<ReserveAgentInputResult>((draft) => {
      const request = draft.requests.find((candidate) => candidate.id === id);
      if (!request) {
        const tombstone = draft.tombstones.find((candidate) => candidate.id === id);
        return { changed: false, result: {
          outcome: "conflict" as const,
          code: tombstone && tombstone.generation !== expectedGeneration ? "stale_generation" as const : "not_found" as const,
        } };
      }
      if (request.generation !== expectedGeneration) {
        return { changed: false, result: { outcome: "conflict" as const, code: "stale_generation" as const } };
      }
      validateAgentInputAnswers(request.questions, answers);
      const submission = draft.submissions.find((candidate) => candidate.requestId === id);
      if (submission) {
        if (submission.idempotencyKey !== idempotencyKey || submission.answerDigest !== digest) {
          return { changed: false, result: { outcome: "conflict" as const, code: "idempotency_conflict" as const } };
        }
        if (submission.status === "delivered") return { changed: false, result: { outcome: "converged" as const, result: { outcome: "delivered" as const } } };
        if (submission.status === "already_resolved") return { changed: false, result: { outcome: "converged" as const, result: { outcome: "already_resolved" as const } } };
        if (submission.status === "sdk_error" || submission.status === "ambiguous") return { changed: false, result: { outcome: "converged" as const, result: { outcome: "sdk_error" as const, code: submission.code ?? "delivery_ambiguous", retryable: false } } };
        if (submission.status === "reserved" || submission.status === "exposed") {
          return { changed: false, result: { outcome: "resumed" as const, request: toPublicRequest(request), digest } };
        }
        throw new AgentInputRequestStoreError("submission_conflict");
      }
      if (request.state !== "pending") {
        return { changed: false, result: { outcome: "conflict" as const, code: "not_pending" as const } };
      }
      draft.submissions.push({
        requestId: id,
        generation: expectedGeneration,
        idempotencyKey,
        answerDigest: digest,
        status: "reserved",
        updatedAt: new Date(nowMs).toISOString(),
      });
      return { changed: true, result: { outcome: "reserved" as const, request: toPublicRequest(request), digest } };
    });
  }

  complete(
    id: string,
    generation: number,
    idempotencyKey: string,
    outcome: "delivered" | "already_resolved" | "sdk_error",
    code?: string,
    nowMs = Date.now(),
    retryable = false,
  ): AgentInputAnswerOutcome {
    return this.commit<AgentInputAnswerOutcome>((draft) => {
      const request = draft.requests.find((candidate) => candidate.id === id);
      const submission = draft.submissions.find((candidate) => candidate.requestId === id);
      if (!request || !submission || request.generation !== generation || submission.generation !== generation
        || submission.idempotencyKey !== idempotencyKey) {
        throw new AgentInputRequestStoreError("submission_conflict");
      }
      if (submission.status === "already_resolved") {
        return { changed: false, result: { outcome: "already_resolved" as const } };
      }
      if (submission.status !== "exposed" && submission.status !== "ambiguous") {
        if (submission.outcome === outcome) {
          return { changed: false, result: submissionOutcome(submission) };
        }
        throw new AgentInputRequestStoreError("submission_conflict");
      }
      const timestamp = new Date(nowMs).toISOString();
      submission.status = outcome === "sdk_error" && retryable ? "ambiguous" : outcome;
      submission.outcome = outcome;
      submission.updatedAt = timestamp;
      if (outcome === "sdk_error") {
        submission.code = sanitizeCode(code);
        if (retryable) submission.code = sanitizeCode(code) === "sdk_error" ? "delivery_ambiguous" : sanitizeCode(code);
      }
      else {
        request.state = "answered";
        request.resolution = outcome === "delivered" ? "user" : "plugin";
        request.resolvedAt = timestamp;
        request.updatedAt = timestamp;
      }
      return { changed: true, result: submissionOutcome(submission) };
    });
  }

  bindDelivery(
    id: string,
    generation: number,
    idempotencyKey: string,
    deliveryId: string,
    nowMs = Date.now(),
  ): void {
    if (!/^delivery_[A-Za-z0-9-]{16,}$/.test(deliveryId)) {
      throw new AgentInputRequestStoreError("invalid_delivery_id");
    }
    this.commit((draft) => {
      const submission = draft.submissions.find((candidate) => candidate.requestId === id);
      if (!submission || submission.generation !== generation || submission.idempotencyKey !== idempotencyKey
        || submission.status !== "reserved" || submission.deliveryId) {
        throw new AgentInputRequestStoreError("submission_conflict");
      }
      submission.deliveryId = deliveryId;
      submission.updatedAt = new Date(nowMs).toISOString();
      return { changed: true, result: undefined };
    });
  }

  completeDelivery(
    deliveryId: string,
    id: string,
    generation: number,
    outcome: "delivered" | "already_resolved" | "sdk_error",
    code?: string,
    nowMs = Date.now(),
    retryable = false,
  ): AgentInputAnswerOutcome {
    const submission = this.data.submissions.find((candidate) => candidate.deliveryId === deliveryId);
    if (!submission || submission.requestId !== id || submission.generation !== generation) {
      throw new AgentInputRequestStoreError("submission_conflict");
    }
    return this.complete(id, generation, submission.idempotencyKey, outcome, code, nowMs, retryable);
  }

  observe(
    id: string,
    generation: number,
    idempotencyKey: string,
    nowMs = Date.now(),
  ): void {
    this.commit((draft) => {
      const submission = draft.submissions.find((candidate) => candidate.requestId === id);
       if (!submission || submission.generation !== generation || submission.idempotencyKey !== idempotencyKey
         || submission.status !== "reserved" || !submission.deliveryId) {
        throw new AgentInputRequestStoreError("submission_conflict");
      }
       submission.status = "exposed";
      submission.updatedAt = new Date(nowMs).toISOString();
      return { changed: true, result: undefined };
    });
  }

  markSdkStarted(
    id: string,
    generation: number,
    idempotencyKey: string,
    nowMs = Date.now(),
  ): void {
    this.commit((draft) => {
      const submission = draft.submissions.find((candidate) => candidate.requestId === id);
      if (!submission || submission.generation !== generation || submission.idempotencyKey !== idempotencyKey
         || submission.status !== "exposed") {
        throw new AgentInputRequestStoreError("submission_conflict");
      }
      if (submission.sdkStartedAt) return { changed: false, result: undefined };
      submission.sdkStartedAt = new Date(nowMs).toISOString();
      submission.updatedAt = submission.sdkStartedAt;
      return { changed: true, result: undefined };
    });
  }

  reconcileNativePending(id: string, generation: number, nowMs?: number): {
    outcome: "quarantined" | "pending" | "already_resolved" | "retired";
  };
  reconcileNativePending(id: string, generation: number, occurrenceId: string, nowMs?: number): {
    outcome: "quarantined" | "pending" | "already_resolved" | "retired";
  };
  reconcileNativePending(id: string, generation: number, occurrenceOrNow?: string | number, maybeNow = Date.now()): {
    outcome: "quarantined" | "pending" | "already_resolved" | "retired";
  } {
    const occurrenceId = typeof occurrenceOrNow === "string" ? occurrenceOrNow : undefined;
    const nowMs = typeof occurrenceOrNow === "number" ? occurrenceOrNow : maybeNow;
    return this.commit<{ outcome: "quarantined" | "pending" | "already_resolved" | "retired" }>((draft) => {
      const request = draft.requests.find((candidate) => candidate.id === id);
      if (!request || request.generation !== generation || !request.occurrence
        || (occurrenceId !== undefined && request.occurrence.occurrenceId !== occurrenceId)) {
        const tombstone = draft.tombstones.find((candidate) => candidate.id === id
          && candidate.generation === generation && candidate.occurrence
          && (occurrenceId === undefined || candidate.occurrence.occurrenceId === occurrenceId));
        if (tombstone) return { changed: false, result: { outcome: "already_resolved" as const } };
        return { changed: false, result: { outcome: "retired" as const } };
      }
      if (request.state !== "pending") return { changed: false, result: { outcome: "already_resolved" as const } };
      const submission = draft.submissions.find((candidate) => candidate.requestId === id);
      if (!submission || (submission.status !== "exposed" && submission.status !== "ambiguous")) {
        return { changed: false, result: { outcome: "pending" as const } };
      }
      if (submission.status === "exposed") {
        submission.status = "ambiguous";
        submission.outcome = "sdk_error";
        submission.code = "delivery_ambiguous";
        submission.updatedAt = new Date(nowMs).toISOString();
        return { changed: true, result: { outcome: "quarantined" as const } };
      }
      return { changed: false, result: { outcome: "quarantined" as const } };
    });
  }

  release(
    id: string,
    generation: number,
    idempotencyKey: string,
    outcome: "source_unavailable" | "delivery_timeout",
    nowMs = Date.now(),
    inDoubt = false,
  ): AgentInputAnswerOutcome {
    return this.commit<AgentInputAnswerOutcome>((draft) => {
      const submission = draft.submissions.find((candidate) => candidate.requestId === id);
      if (!submission || submission.generation !== generation || submission.idempotencyKey !== idempotencyKey) {
        throw new AgentInputRequestStoreError("submission_conflict");
      }
      if (submission.status !== "reserved" && submission.status !== "exposed") {
        return { changed: false, result: submissionOutcome(submission) };
      }
       submission.status = inDoubt || submission.sdkStartedAt !== undefined || submission.status === "exposed"
         ? "ambiguous" : "reserved";
      submission.outcome = submission.status === "ambiguous" ? "sdk_error" : outcome;
      submission.code = submission.status === "ambiguous" ? "delivery_ambiguous" : undefined;
      submission.updatedAt = new Date(nowMs).toISOString();
      if (submission.status === "reserved") delete submission.sdkStartedAt;
      if (submission.status === "reserved") delete submission.deliveryId;
      return { changed: true, result: submission.status === "ambiguous"
        ? { outcome: "sdk_error" as const, code: "delivery_ambiguous", retryable: false }
        : { outcome } };
    });
  }

  resolveNative(
    id: string,
    generation: number,
    occurrenceId: string,
    result: "replied" | "rejected",
    nowMs?: number,
  ): { outcome: "resolved" | "already_resolved" | "retired"; request?: AgentInputRequest };
  resolveNative(
    id: string,
    generation: number,
    result: "replied" | "rejected",
    nowMs?: number,
  ): { outcome: "resolved" | "already_resolved" | "retired"; request?: AgentInputRequest };
  resolveNative(
    id: string,
    generation: number,
    occurrenceOrResult: string,
    resultOrNow?: "replied" | "rejected" | number,
    maybeNow = Date.now(),
  ): { outcome: "resolved" | "already_resolved" | "retired"; request?: AgentInputRequest } {
    const legacyCall = occurrenceOrResult === "replied" || occurrenceOrResult === "rejected";
    const occurrenceId = legacyCall ? undefined : occurrenceOrResult;
    const result = (legacyCall ? occurrenceOrResult : resultOrNow) as "replied" | "rejected";
    const nowMs = typeof resultOrNow === "number" ? resultOrNow : maybeNow;
    return this.commit<{ outcome: "resolved" | "already_resolved" | "retired"; request?: AgentInputRequest }>((draft) => {
      const request = draft.requests.find((candidate) => candidate.id === id);
      if (!request || request.generation !== generation || !request.occurrence
        || (occurrenceId !== undefined && request.occurrence.occurrenceId !== occurrenceId)) {
        const tombstone = draft.tombstones.find((candidate) => candidate.id === id
          && candidate.generation === generation && candidate.occurrence
          && (occurrenceId === undefined || candidate.occurrence.occurrenceId === occurrenceId));
        if (tombstone) return { changed: false, result: { outcome: "already_resolved" as const } };
        return { changed: false, result: { outcome: "retired" as const } };
      }
      if (request.state !== "pending") return { changed: false, result: { outcome: "already_resolved" as const, request: toPublicRequest(request) } };
      const timestamp = new Date(nowMs).toISOString();
      request.state = result === "replied" ? "answered" : "rejected";
      request.resolution = "terminal";
      request.updatedAt = timestamp;
      request.resolvedAt = timestamp;
      const submission = draft.submissions.find((candidate) => candidate.requestId === id);
       if (submission && !["delivered", "already_resolved"].includes(submission.status)) {
         submission.status = "already_resolved";
         submission.outcome = "already_resolved";
         delete submission.code;
         submission.updatedAt = timestamp;
      }
      return { changed: true, result: { outcome: "resolved" as const, request: toPublicRequest(request) } };
    });
  }

  resolveNativeAbsent(
    sourceId: string,
    members: readonly AgentInputNativeSnapshotMember[],
    occurrenceKeys?: readonly string[],
    nowMs = Date.now(),
  ): Array<{ id: string; generation: number }> {
    return this.commit((draft) => {
      const present = new Set<string>();
      const presentKeys = new Set<string>();
      const scope = occurrenceKeys === undefined ? undefined : new Set(occurrenceKeys);
      if (scope && (scope.size !== occurrenceKeys!.length || [...scope].some((key) => !/^[a-f0-9]{64}$/.test(key)))) {
        throw new AgentInputRequestStoreError("invalid_reconciliation");
      }
      for (const member of members) {
        if (member.occurrenceKey !== nativeOccurrenceKey(member.sessionID, member.requestID)
          || member.payloadDigest !== capturePayloadDigest({
            openCodeSessionId: member.sessionID,
            openCodeRequestId: member.requestID,
            questions: member.questions,
          }) || present.has(member.occurrenceId) || presentKeys.has(member.occurrenceKey)
          || (scope !== undefined && !scope.has(member.occurrenceKey))) {
          throw new AgentInputRequestStoreError("invalid_reconciliation");
        }
        const anchor = draft.generationAnchors.find((candidate) => candidate.sourceId === sourceId
          && candidate.occurrenceKey === member.occurrenceKey);
        if (!anchor || anchor.latestOccurrenceId !== member.occurrenceId || anchor.highOrdinal !== member.ordinal) {
          throw new AgentInputRequestStoreError("invalid_reconciliation");
        }
        const record = draft.requests.find((candidate) =>
          candidate.sourceId === sourceId
          && candidate.occurrence?.occurrenceId === member.occurrenceId
          && candidate.occurrence.occurrenceKey === member.occurrenceKey
          && candidate.occurrence.ordinal === member.ordinal
          && candidate.occurrence.payloadDigest === member.payloadDigest
          && candidate.openCodeSessionId === member.sessionID
          && candidate.openCodeRequestId === member.requestID);
        if (!record) throw new AgentInputRequestStoreError("invalid_reconciliation");
        present.add(member.occurrenceId);
        presentKeys.add(member.occurrenceKey);
      }
      const closed: Array<{ id: string; generation: number }> = [];
      const timestamp = new Date(nowMs).toISOString();
      for (const request of draft.requests) {
        if (request.sourceId !== sourceId || request.state !== "pending"
          || (request.occurrence && present.has(request.occurrence.occurrenceId))
          || (scope !== undefined && (!request.occurrence || !scope.has(request.occurrence.occurrenceKey)))) continue;
        request.state = "closed";
        request.resolution = "plugin";
        request.resolvedAt = timestamp;
        request.updatedAt = timestamp;
        settleSubmission(draft.submissions, request.id, timestamp);
        closed.push({ id: request.id, generation: request.generation });
      }
      return { changed: closed.length > 0, result: closed };
    });
  }

  submissionState(id: string): { status: Submission["status"]; deliveryId?: string; sdkStarted: boolean } | undefined {
    const submission = this.data.submissions.find((candidate) => candidate.requestId === id);
    return submission ? {
      status: submission.status,
      deliveryId: submission.deliveryId,
      sdkStarted: submission.sdkStartedAt !== undefined,
    } : undefined;
  }

  resolvePane(paneId: string, nowMs = Date.now()): number {
    return this.resolveMatching((request) => request.paneId === paneId, "closed", "pane-closed", nowMs);
  }

  resolveSource(sourceId: string, nowMs = Date.now()): number {
    return this.resolveMatching((request) => request.sourceId === sourceId, "cancelled", "source-revoked", nowMs);
  }

  retireSource(sourceId: string, nowMs = Date.now()): number {
    this.prune(nowMs);
    return this.commit((draft) => {
      const timestamp = new Date(nowMs).toISOString();
      let count = 0;
      for (const request of draft.requests) {
        if (request.sourceId !== sourceId || request.state !== "pending") continue;
        request.state = "cancelled";
        request.resolution = "source-revoked";
        request.resolvedAt = timestamp;
        request.updatedAt = timestamp;
        settleSubmission(draft.submissions, request.id, timestamp);
        count += 1;
      }
      const retired = draft.retiredSources.find((source) => source.sourceId === sourceId);
      if (!retired) draft.retiredSources.push({ sourceId, retiredAt: timestamp });
      return { changed: count > 0 || !retired, result: count };
    });
  }

  prune(nowMs = Date.now()): { removedIds: string[] } {
    return this.commit((draft) => {
      const priorTombstoneCount = draft.tombstones.length;
      const removed: StoredRequest[] = [];
      draft.requests = draft.requests.filter((request) => {
        if (request.state === "pending" || !request.resolvedAt
          || Date.parse(request.resolvedAt) + this.resolvedRetentionMs > nowMs) return true;
        removed.push(request);
        return false;
      });
      for (const request of removed) {
        const existing = draft.tombstones.find((candidate) => candidate.id === request.id);
        if (!existing) draft.tombstones.push({
          id: request.id,
          sourceId: request.sourceId,
           openCodeRequestId: request.openCodeRequestId,
           generation: request.generation,
           state: request.state as Exclude<AgentInputRequestState, "pending">,
           ...(request.occurrence ? { occurrence: structuredClone(request.occurrence) } : {}),
           expiresAt: new Date(nowMs + this.tombstoneRetentionMs).toISOString(),
        });
      }
      const liveIds = new Set(draft.requests.map((request) => request.id));
      draft.submissions = draft.submissions.filter((submission) => liveIds.has(submission.requestId));
      draft.attention = draft.attention.filter((attention) => liveIds.has(attention.requestId));
      draft.tombstones = draft.tombstones.filter((tombstone) => Date.parse(tombstone.expiresAt) > nowMs);
      if (draft.tombstones.length > MAX_AGENT_INPUT_TOMBSTONES) {
        draft.tombstones.sort((left, right) =>
          left.expiresAt.localeCompare(right.expiresAt) || left.id.localeCompare(right.id));
        draft.tombstones.splice(0, draft.tombstones.length - MAX_AGENT_INPUT_TOMBSTONES);
      }
      const retainedSources = new Set([
        ...draft.requests.map((request) => request.sourceId),
        ...draft.tombstones.map((tombstone) => tombstone.sourceId),
      ]);
      const compactedSources = new Set(draft.retiredSources
        .filter((source) => !retainedSources.has(source.sourceId))
        .map((source) => source.sourceId));
      const priorAnchorCount = draft.generationAnchors.length;
      const priorRetiredCount = draft.retiredSources.length;
      draft.generationAnchors = draft.generationAnchors.filter((anchor) => !compactedSources.has(anchor.sourceId));
      draft.retiredSources = draft.retiredSources.filter((source) => !compactedSources.has(source.sourceId));
      return {
        changed: removed.length > 0 || draft.tombstones.length !== priorTombstoneCount
          || draft.generationAnchors.length !== priorAnchorCount || draft.retiredSources.length !== priorRetiredCount,
        result: { removedIds: removed.map((request) => request.id).sort() },
      };
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
  }

  private resolveMatching(
    predicate: (request: AgentInputRequest) => boolean,
    state: "cancelled" | "closed",
    resolution: "pane-closed" | "source-revoked",
    nowMs: number,
  ): number {
    return this.commit((draft) => {
      let count = 0;
      const timestamp = new Date(nowMs).toISOString();
      for (const request of draft.requests) {
        if (request.state !== "pending" || !predicate(request)) continue;
        request.state = state;
        request.resolution = resolution;
        request.resolvedAt = timestamp;
        request.updatedAt = timestamp;
        count += 1;
      }
      return { changed: count > 0, result: count };
    });
  }

  private answerDigest(answers: string[][]): string {
    return crypto.createHmac("sha256", this.options.answerDigestKey)
      .update(JSON.stringify(answers))
      .digest("hex");
  }

  private commit<T>(mutate: (draft: Envelope) => { changed: boolean; publish?: boolean; result: T }): T {
    const draft = structuredClone(this.data);
    const { changed, publish, result } = mutate(draft);
    if (!changed) return structuredClone(result);
    envelopeSchema.parse(draft);
    enforceSerializedQuotaGrowth(this.data, draft, {
      perSource: this.maxSerializedBytesPerSource,
      global: this.maxSerializedBytes,
    });
    this.persist(draft, true);
    this.data = draft;
    if (publish !== false) this.emit("change", this.snapshot());
    return structuredClone(result);
  }

  private load(): { data: Envelope; recovered: boolean; migrated: boolean } {
    if (!fs.existsSync(this.filePath)) return { data: emptyEnvelope(), recovered: false, migrated: false };
    const primary = this.readEnvelope(this.filePath);
    if (primary) return { data: primary.data, recovered: false, migrated: primary.migrated };
    const backup = this.readEnvelope(`${this.filePath}.bak`);
    if (!backup) throw new Error(`wmux agent input request store is invalid: ${this.filePath}`);
    const quarantine = `${this.filePath}.corrupt-${Date.now()}`;
    fs.renameSync(this.filePath, quarantine);
    this.fsyncContainingDirectory("quarantine");
    return { data: backup.data, recovered: true, migrated: backup.migrated };
  }

  private readEnvelope(filePath: string): { data: Envelope; migrated: boolean } | undefined {
    if (!fs.existsSync(filePath)) return undefined;
    this.assertSecureFile(filePath);
    try {
      const input = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      const version = input && typeof input === "object" ? (input as { schemaVersion?: unknown }).schemaVersion : undefined;
      if (typeof version === "number" && Number.isInteger(version) && version > CURRENT_AGENT_INPUT_REQUEST_SCHEMA_VERSION) {
        throw new UnsupportedAgentInputRequestVersionError(version);
      }
      if (version === 0) {
        const old = envelopeV0Schema.parse(input);
        return {
          data: {
             schemaVersion: 7,
             ...migrateLegacyRecords(old.requests, old.tombstones, []),
             submissions: [],
             attention: [], retiredSources: [],
          },
          migrated: true,
        };
      }
      if (version === 1) {
        const old = envelopeV1Schema.parse(input);
        return {
          data: {
             schemaVersion: 7,
             ...migrateLegacyRecords(old.requests, old.tombstones, migrateLegacySubmissions(old.submissions)),
             attention: [], retiredSources: [],
          },
          migrated: true,
        };
      }
      if (version === 2) {
        const old = envelopeV2Schema.parse(input);
         return { data: migrateLegacyEnvelope(old.requests, old.tombstones, migrateLegacySubmissions(old.submissions), old.attention), migrated: true };
       }
      if (version === 3) {
        const old = envelopeV2Schema.extend({ schemaVersion: z.literal(3) }).parse(input);
         return { data: migrateLegacyEnvelope(old.requests, old.tombstones, migrateLegacySubmissions(old.submissions), old.attention), migrated: true };
       }
       if (version === 4) {
         const old = envelopeV4Schema.parse(input);
         return { data: migrateLegacyEnvelope(old.requests, old.tombstones, old.submissions, old.attention), migrated: true };
      }
      if (version === 5) {
        const old = envelopeV5Schema.parse(input);
        return { data: migrateLegacyEnvelope(old.requests, old.tombstones, old.submissions, old.attention), migrated: true };
      }
      if (version === 6) {
        const old = envelopeV6Schema.parse(input);
        return { data: { ...old, schemaVersion: 7, retiredSources: [] }, migrated: true };
      }
      const parsed = envelopeSchema.safeParse(input);
      return parsed.success ? { data: parsed.data, migrated: false } : undefined;
    } catch (error) {
      if (error instanceof UnsupportedAgentInputRequestVersionError) throw error;
      return undefined;
    }
  }

  private persist(data: Envelope, rotateBackup: boolean): void {
    this.ensureSecureParent();
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    try {
      const handle = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(handle, `${JSON.stringify(data, null, 2)}\n`);
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      if (rotateBackup && fs.existsSync(this.filePath) && this.readEnvelope(this.filePath)) {
        const backupPath = `${this.filePath}.bak`;
        if (fs.existsSync(backupPath)) this.assertSecureFile(backupPath);
        const backupTemporary = `${backupPath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
        const backupHandle = fs.openSync(backupTemporary, "wx", 0o600);
        try {
          fs.writeFileSync(backupHandle, fs.readFileSync(this.filePath));
          fs.fsyncSync(backupHandle);
        } finally {
          fs.closeSync(backupHandle);
        }
        fs.renameSync(backupTemporary, backupPath);
        this.fsyncContainingDirectory("backup");
      }
      this.options.beforeRename?.();
      fs.renameSync(temporary, this.filePath);
      this.fsyncContainingDirectory("primary");
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  }

  private ensureSecureParent(): void {
    const parentPath = path.dirname(path.resolve(this.filePath));
    if (!fs.existsSync(parentPath)) fs.mkdirSync(parentPath, { recursive: true, mode: 0o700 });
    const parent = fs.lstatSync(parentPath);
    if (!parent.isDirectory() || parent.isSymbolicLink() || fs.realpathSync(parentPath) !== parentPath) {
      throw new Error("agent input request parent directory must not use symlinks");
    }
    if (typeof process.getuid === "function" && parent.uid !== process.getuid()) {
      throw new Error("agent input request parent directory must be owned by the wmux user");
    }
    if ((parent.mode & 0o077) !== 0) throw new Error("agent input request parent directory must be owner-only");
  }

  private assertSecureFile(filePath: string): void {
    const file = fs.lstatSync(filePath);
    if (!file.isFile() || file.isSymbolicLink() || fs.realpathSync(filePath) !== path.resolve(filePath)) {
      throw new Error("agent input request store must be a regular non-symlink file");
    }
    if (typeof process.getuid === "function" && file.uid !== process.getuid()) {
      throw new Error("agent input request store must be owned by the wmux user");
    }
    if ((file.mode & 0o777) !== 0o600) throw new Error("agent input request store permissions must be 0600");
  }

  private fsyncContainingDirectory(target: "backup" | "primary" | "quarantine"): void {
    const directory = path.dirname(path.resolve(this.filePath));
    if (this.options.directoryFsync) {
      this.options.directoryFsync(directory, target);
      return;
    }
    const handle = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  }
}

const emptyEnvelope = (): Envelope => ({
  schemaVersion: 7, requests: [], submissions: [], tombstones: [], attention: [], generationAnchors: [], retiredSources: [],
});

const recoverBackupEnvelope = (input: Envelope): { data: Envelope; changed: boolean } => {
  const data = structuredClone(input);
  const timestamp = new Date().toISOString();
  let changed = false;
  for (const request of data.requests) {
    if (request.state !== "pending") continue;
    request.state = "closed";
    request.resolution = "plugin";
    request.resolvedAt = timestamp;
    request.updatedAt = timestamp;
    settleSubmission(data.submissions, request.id, timestamp);
    changed = true;
  }
  return { data, changed };
};

const recoverInterruptedSubmissions = (input: Envelope): { data: Envelope; changed: boolean } => {
  const data = structuredClone(input);
  const timestamp = new Date().toISOString();
  let changed = false;
  for (const submission of data.submissions) {
    if (submission.status === "reserved" && submission.deliveryId && !submission.sdkStartedAt) {
      delete submission.deliveryId;
      submission.updatedAt = timestamp;
      changed = true;
      continue;
    }
    if (submission.status === "exposed" || (submission.status === "reserved" && submission.sdkStartedAt)) {
      submission.status = "ambiguous";
      submission.outcome = "sdk_error";
      submission.code = "delivery_ambiguous";
      submission.updatedAt = timestamp;
      changed = true;
    }
  }
  return { data, changed };
};

const toPublicRequest = (request: StoredRequest): AgentInputRequest => {
  const { occurrence: _occurrence, ...publicRequest } = request;
  return structuredClone(publicRequest);
};

export const capturePayloadDigest = (input: Pick<CaptureAgentInputRequest, "openCodeSessionId" | "openCodeRequestId" | "questions">): string =>
  crypto.createHash("sha256").update(JSON.stringify({
    openCodeSessionId: input.openCodeSessionId,
    openCodeRequestId: input.openCodeRequestId,
    questions: input.questions,
  })).digest("hex");

export const nativeOccurrenceKey = (sessionID: string, requestID: string): string =>
  crypto.createHash("sha256").update(JSON.stringify([sessionID, requestID])).digest("hex");

const migrateLegacyRecords = (
  requests: Array<z.infer<typeof legacyRequestSchema> & { captureOperations?: unknown }>,
  tombstones: Array<z.infer<typeof legacyTombstoneSchema> & { captureOperations?: unknown }>,
  submissions: Submission[],
): Pick<Envelope, "requests" | "tombstones" | "generationAnchors" | "submissions"> => {
  const generationAnchors: Envelope["generationAnchors"] = [];
  const timestamp = new Date().toISOString();
  for (const record of [...requests, ...tombstones]) {
    const request = requests.find((candidate) => candidate.sourceId === record.sourceId
      && candidate.openCodeRequestId === record.openCodeRequestId);
    const occurrenceKey = nativeOccurrenceKey(request?.openCodeSessionId ?? "legacy-unbound", record.openCodeRequestId);
    const anchor = generationAnchors.find((candidate) => candidate.sourceId === record.sourceId
      && candidate.legacyRequestId === record.openCodeRequestId);
    if (anchor) anchor.highGeneration = Math.max(anchor.highGeneration, record.generation);
    else generationAnchors.push({
      sourceId: record.sourceId, occurrenceKey, highOrdinal: 0, highGeneration: record.generation,
      legacyRequestId: record.openCodeRequestId,
    });
  }
  const migratedRequests: StoredRequest[] = requests.map((input) => {
    const { captureOperations: _discarded, ...request } = input;
    if (request.state !== "pending") return request;
    return {
      ...request,
      state: "closed",
      resolution: "migration-unbound",
      resolvedAt: timestamp,
      updatedAt: timestamp,
    };
  });
  const migratedSubmissions = submissions.map((submission) => {
    const request = migratedRequests.find((candidate) => candidate.id === submission.requestId);
    if (request?.resolution !== "migration-unbound") return submission;
    return { ...submission, status: "already_resolved" as const, outcome: "already_resolved" as const, code: undefined, updatedAt: timestamp };
  });
  return {
    requests: migratedRequests,
    tombstones: tombstones.map((input) => {
      const { captureOperations: _discarded, ...tombstone } = input;
      return tombstone;
    }),
    generationAnchors,
    submissions: migratedSubmissions,
  };
};

const migrateLegacyEnvelope = (
  requests: Array<z.infer<typeof legacyRequestSchema> & { captureOperations?: unknown }>,
  tombstones: Array<z.infer<typeof legacyTombstoneSchema> & { captureOperations?: unknown }>,
  submissions: Submission[],
  attention: Envelope["attention"],
): Envelope => {
  const migrated = migrateLegacyRecords(requests, tombstones, submissions);
  const pendingIds = new Set(migrated.requests.filter((request) => request.state === "pending").map((request) => request.id));
  return {
    schemaVersion: 7,
    ...migrated,
    attention: attention.filter((item) => pendingIds.has(item.requestId)),
    retiredSources: [],
  };
};

const serializedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

const boundedQuota = (configured: number | undefined, hardMaximum: number): number => {
  if (configured === undefined) return hardMaximum;
  if (!Number.isSafeInteger(configured) || configured <= 0 || configured > hardMaximum) {
    throw new Error("agent input serialized byte quota must be a positive safe integer within the hard maximum");
  }
  return configured;
};

const sourceIds = (data: Envelope): Set<string> => new Set([
  ...data.requests.map((request) => request.sourceId),
  ...data.tombstones.map((tombstone) => tombstone.sourceId),
  ...data.generationAnchors.map((anchor) => anchor.sourceId),
  ...data.retiredSources.map((source) => source.sourceId),
]);

const sourceOwnsReference = (
  data: Envelope,
  sourceId: string,
  requestId: string,
  generation: number,
): boolean => data.requests.some((request) => request.sourceId === sourceId
  && request.id === requestId && request.generation === generation)
  || data.tombstones.some((tombstone) => tombstone.sourceId === sourceId
    && tombstone.id === requestId && tombstone.generation === generation);

const serializedSourceBytes = (data: Envelope, sourceId: string): number => serializedBytes({
  requests: data.requests.filter((request) => request.sourceId === sourceId),
  submissions: data.submissions.filter((submission) => sourceOwnsReference(
    data, sourceId, submission.requestId, submission.generation,
  )),
  tombstones: data.tombstones.filter((tombstone) => tombstone.sourceId === sourceId),
  attention: data.attention.filter((attention) => sourceOwnsReference(
    data, sourceId, attention.requestId, attention.generation,
  )),
  generationAnchors: data.generationAnchors.filter((anchor) => anchor.sourceId === sourceId),
  retiredSources: data.retiredSources.filter((source) => source.sourceId === sourceId),
});

const enforceSerializedQuotaGrowth = (
  before: Envelope,
  after: Envelope,
  limits: { perSource: number; global: number },
): void => {
  for (const sourceId of new Set([...sourceIds(before), ...sourceIds(after)])) {
    const beforeBytes = serializedSourceBytes(before, sourceId);
    const afterBytes = serializedSourceBytes(after, sourceId);
    if (afterBytes > limits.perSource && afterBytes > beforeBytes) {
      throw new AgentInputRequestQuotaError(
        "source_byte_limit", limits.perSource, beforeBytes, afterBytes, sourceId,
      );
    }
  }
  const beforeBytes = serializedBytes(before);
  const afterBytes = serializedBytes(after);
  if (afterBytes > limits.global && afterBytes > beforeBytes) {
    throw new AgentInputRequestQuotaError("global_byte_limit", limits.global, beforeBytes, afterBytes);
  }
};

const attentionForRequest = (request: AgentInputRequest) => ({
  requestId: request.id,
  generation: request.generation,
  notificationId: `agent-input-${request.id}`.slice(0, 120),
  createdAt: request.createdAt,
});

export const compareAgentInputRequests = (left: AgentInputRequest, right: AgentInputRequest): number =>
  Number(right.state === "pending") - Number(left.state === "pending")
  || left.createdAt.localeCompare(right.createdAt)
  || left.id.localeCompare(right.id);

const validateCaptureInput = (input: CaptureAgentInputRequest): void => {
  legacyRequestSchema.omit({
    id: true, generation: true, state: true, createdAt: true, updatedAt: true, resolvedAt: true, resolution: true,
  }).extend({
    occurrenceId: text(256),
    occurrenceKey: z.string().regex(/^[a-f0-9]{64}$/),
    occurrenceOrdinal: z.number().int().positive().safe(),
    payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).parse(input);
  const bounded: Array<[string | undefined, number]> = [
    [input.occurrenceId, 256], [input.sourceId, 256], [input.workspaceId, 256], [input.tabId, 256], [input.paneId, 256],
    [input.machineId, 256], [input.openCodeSessionId, 256], [input.openCodeRequestId, 256],
    ...input.questions.flatMap((question): Array<[string, number]> => [
      [question.header, 120], [question.question, 16_384],
      ...question.options.flatMap((option): Array<[string, number]> => [
        [option.label, 1_024], [option.description, 4_096],
      ]),
    ]),
  ];
  if (bounded.some(([value, maximum]) => value !== undefined && Buffer.byteLength(value, "utf8") > maximum)) {
    throw new AgentInputRequestStoreError("field_too_large");
  }
};

const settleSubmission = (submissions: Submission[], requestId: string, timestamp: string): void => {
  const submission = submissions.find((candidate) => candidate.requestId === requestId);
  if (!submission || submission.status === "delivered" || submission.status === "already_resolved") return;
  submission.status = "already_resolved";
  submission.outcome = "already_resolved";
  delete submission.code;
  submission.updatedAt = timestamp;
};

export const validateAgentInputAnswers = (questions: AgentInputQuestion[], answers: string[][]): void => {
  if (!Array.isArray(answers) || answers.length !== questions.length) {
    throw new AgentInputRequestStoreError("invalid_answer_shape");
  }
  let bytes = 0;
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    const answer = answers[index];
    if (!Array.isArray(answer) || answer.length === 0 || (!question.multiple && answer.length !== 1)) {
      throw new AgentInputRequestStoreError("invalid_answer_shape");
    }
    if (new Set(answer).size !== answer.length) throw new AgentInputRequestStoreError("invalid_answer_shape");
    const labels = new Set(question.options.map((option) => option.label));
    const custom = answer.filter((value) => !labels.has(value));
    if ((!question.custom && custom.length > 0) || custom.length > 1) {
      throw new AgentInputRequestStoreError("invalid_answer_shape");
    }
    for (const value of answer) {
      if (typeof value !== "string" || value.length === 0) throw new AgentInputRequestStoreError("invalid_answer_shape");
      bytes += Buffer.byteLength(value, "utf8");
      if (Buffer.byteLength(value, "utf8") > 4_096) throw new AgentInputRequestStoreError("invalid_answer_shape");
    }
  }
  if (bytes > MAX_AGENT_INPUT_ANSWER_BYTES) throw new AgentInputRequestStoreError("invalid_answer_shape");
};

const sanitizeCode = (code: string | undefined): string =>
  code && /^[A-Za-z0-9_.-]{1,120}$/.test(code) ? code : "sdk_error";

const submissionOutcome = (submission: Submission): AgentInputAnswerOutcome => {
  if (submission.status === "ambiguous") {
    return { outcome: "sdk_error", code: submission.code ?? "delivery_ambiguous", retryable: false };
  }
  switch (submission.outcome) {
    case "delivered": return { outcome: "delivered" };
    case "already_resolved": return { outcome: "already_resolved" };
    case "sdk_error": return { outcome: "sdk_error", code: submission.code ?? "sdk_error", retryable: false };
    case "source_unavailable": return { outcome: "source_unavailable" };
    case "delivery_timeout": return { outcome: "delivery_timeout" };
    default: throw new AgentInputRequestStoreError("submission_incomplete");
  }
};

const migrateLegacySubmissions = (
  submissions: Array<z.infer<typeof legacySubmissionSchema>>,
): Submission[] => submissions.map((submission) => {
  const unsafeToRetry = submission.status === "retryable" || submission.status === "in_doubt"
    || submission.sdkStartedAt !== undefined;
  if (!unsafeToRetry) return { ...submission, status: submission.status as Submission["status"] };
  return {
    ...submission,
    status: "ambiguous",
    outcome: "sdk_error",
    code: "delivery_ambiguous",
  };
});
