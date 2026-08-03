import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import type { AgentInputSourcePrincipal, AgentInputSourceRecord } from "./agent-input-credential-store.js";
import { AgentInputCredentialStore } from "./agent-input-credential-store.js";
import {
  AgentInputRequestStore,
  AgentInputRequestStoreError,
  type AgentInputAnswerOutcome,
  type AgentInputNativeSnapshotMember,
} from "./agent-input-request-store.js";

export const MAX_AGENT_INPUT_DELIVERIES = 64;
export const MAX_AGENT_INPUT_TRANSIENT_BYTES = 512 * 1024;
export const MAX_AGENT_INPUT_DELIVERIES_PER_SOURCE = 16;
export const MAX_AGENT_INPUT_TRANSIENT_BYTES_PER_SOURCE = 128 * 1024;
export const MAX_AGENT_INPUT_POLL_LIMIT = 16;
export const MAX_AGENT_INPUT_POLL_WAIT_MS = 30_000;
export const MAX_AGENT_INPUT_POLLS = 64;
export const MAX_AGENT_INPUT_WAITERS_PER_DELIVERY = 32;
export const MAX_AGENT_INPUT_WAITERS = 256;
export const DEFAULT_AGENT_INPUT_DELIVERY_TIMEOUT_MS = 15_000;
export const MIN_AGENT_INPUT_REDELIVERY_MS = 1_000;
export const DEFAULT_AGENT_INPUT_POLL_GRACE_MS = 5_000;

export interface AgentInputDelivery {
  deliveryId: string;
  cursor: number;
  requestId: string;
  expectedGeneration: number;
  openCodeRequestId: string;
  answers: string[][];
}

interface InternalDelivery extends AgentInputDelivery {
  sourceId: string;
  credentialGeneration: number;
  idempotencyKey: string;
  bytes: number;
  waiters: Map<symbol, (outcome: AgentInputAnswerOutcome) => void>;
  timer: ReturnType<typeof setTimeout>;
  observed: boolean;
  observedAt?: number;
  sdkStarted: boolean;
}

interface AckRecord {
  sourceId: string;
  requestId: string;
  generation: number;
    outcome: "applied" | "already_resolved" | "sdk_error";
    code?: string;
    retryable?: boolean;
}

export type AgentInputSubmitResult =
  | AgentInputAnswerOutcome
  | { outcome: "conflict"; code: string }
  | { outcome: "invalid_answers" };

export interface AgentInputRelayOptions {
  enabled?: boolean;
  deliveryTimeoutMs?: number;
  pollGraceMs?: number;
  isPaneLive: (source: AgentInputSourceRecord) => boolean;
}

export class AgentInputRelay {
  private enabled: boolean;
  private readonly deliveryTimeoutMs: number;
  private readonly pollGraceMs: number;
  private readonly deliveries = new Map<string, InternalDelivery>();
  private readonly acknowledgements = new Map<string, AckRecord>();
  private readonly polls = new Map<string, { leaseId: symbol; cancel: () => void }>();
  private readonly recentPolls = new Map<string, { credentialGeneration: number; authenticatedAt: number }>();
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly events = new EventEmitter();
  private readonly epoch: string = crypto.randomUUID();
  private cursor = 0;
  private transientBytes = 0;
  private waiterCount = 0;
  private disposed = false;

  constructor(
    private readonly requests: AgentInputRequestStore,
    private readonly credentials: AgentInputCredentialStore,
    private readonly options: AgentInputRelayOptions,
  ) {
    this.enabled = options.enabled ?? true;
    this.deliveryTimeoutMs = options.deliveryTimeoutMs ?? DEFAULT_AGENT_INPUT_DELIVERY_TIMEOUT_MS;
    this.pollGraceMs = options.pollGraceMs ?? DEFAULT_AGENT_INPUT_POLL_GRACE_MS;
    credentials.on("revoked", this.onSourceRevoked);
    credentials.on("rotated", this.onSourceRotated);
    credentials.on("attestation-required", this.onSourceAttestationRequired);
    credentials.on("issued", this.onSourceIssued);
    for (const source of credentials.snapshot().sources) {
      if (source.revokedAt !== undefined || source.expiresAt <= Date.now()) requests.retireSource(source.id);
      else this.scheduleExpiry(source.id);
    }
    if (!this.enabled) {
      for (const source of credentials.snapshot().sources) requests.retireSource(source.id);
      credentials.invalidateCapabilities();
      credentials.revokeAll();
    }
  }

  async submit(
    requestId: string,
    expectedGeneration: number,
    idempotencyKey: string,
    answers: string[][],
    signal?: AbortSignal,
  ): Promise<AgentInputSubmitResult> {
    if (this.disposed || !this.enabled) return { outcome: "source_unavailable" };
    const request = this.requests.find(requestId);
    if (!request) return { outcome: "conflict", code: "not_found" };

    let reservation;
    try {
      reservation = this.requests.reserve(requestId, expectedGeneration, idempotencyKey, answers);
    } catch (error) {
      if (error instanceof AgentInputRequestStoreError && error.code === "invalid_answer_shape") {
        return { outcome: "invalid_answers" };
      }
      throw error;
    }
    if (reservation.outcome === "conflict") return { outcome: "conflict", code: reservation.code };
    if (reservation.outcome === "converged") return reservation.result;
    if (reservation.outcome === "resumed") {
      const existing = [...this.deliveries.values()].find((delivery) =>
        delivery.requestId === requestId && delivery.idempotencyKey === idempotencyKey);
      if (existing) return this.waitForExisting(existing, signal);
      if (this.requests.submissionState(requestId)?.status === "exposed") {
        return this.requests.release(requestId, expectedGeneration, idempotencyKey, "source_unavailable");
      }
    }
    // A newly reserved delivery must have room for its first waiter before it
    // becomes observable to the broker. Otherwise the caller could receive a
    // failure while its answer remains eligible for execution.
    if (this.waiterCount >= MAX_AGENT_INPUT_WAITERS) {
      return this.requests.release(requestId, expectedGeneration, idempotencyKey, "source_unavailable");
    }
    const source = this.credentials.source(request.sourceId);
    if (!source || !this.sourceAvailable(source) || !this.hasAcceptingPoll(source)) {
      return this.requests.release(requestId, expectedGeneration, idempotencyKey, "source_unavailable");
    }
    const bytes = Buffer.byteLength(JSON.stringify(answers), "utf8");
    const sourceDeliveries = [...this.deliveries.values()].filter((delivery) => delivery.sourceId === source.id);
    if (this.deliveries.size >= MAX_AGENT_INPUT_DELIVERIES
      || this.transientBytes + bytes > MAX_AGENT_INPUT_TRANSIENT_BYTES
      || sourceDeliveries.length >= MAX_AGENT_INPUT_DELIVERIES_PER_SOURCE
      || sourceDeliveries.reduce((total, delivery) => total + delivery.bytes, 0) + bytes
        > MAX_AGENT_INPUT_TRANSIENT_BYTES_PER_SOURCE) {
      return this.requests.release(requestId, expectedGeneration, idempotencyKey, "source_unavailable");
    }

    const deliveryId = `delivery_${crypto.randomUUID()}`;
    this.requests.bindDelivery(requestId, expectedGeneration, idempotencyKey, deliveryId);
    const delivery: InternalDelivery = {
      deliveryId,
      cursor: ++this.cursor,
      requestId,
      expectedGeneration,
      openCodeRequestId: reservation.request.openCodeRequestId,
      answers: structuredClone(answers),
      sourceId: source.id,
      credentialGeneration: source.credentialGeneration,
      idempotencyKey,
      bytes,
      waiters: new Map(),
      timer: setTimeout(() => this.expireDelivery(deliveryId), this.deliveryTimeoutMs),
      observed: false,
      sdkStarted: false,
    };
    this.deliveries.set(deliveryId, delivery);
    this.transientBytes += bytes;
    this.events.emit(source.id);
    return this.waitForExisting(delivery, signal);
  }

  async poll(
    principal: AgentInputSourcePrincipal,
    after: number,
    limit: number,
    waitMs: number,
    signal?: AbortSignal,
    clientEpoch = this.epoch,
  ): Promise<{ epoch: string; cursor: number; deliveries: AgentInputDelivery[] }> {
    this.assertSourcePrincipal(principal);
    if (!Number.isSafeInteger(after) || after < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_AGENT_INPUT_POLL_LIMIT
      || !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_AGENT_INPUT_POLL_WAIT_MS) {
      throw new AgentInputRequestStoreError("invalid_poll_query");
    }
    const prior = this.polls.get(principal.sourceId);
    prior?.cancel();
    if (this.polls.get(principal.sourceId)?.leaseId === prior?.leaseId) this.polls.delete(principal.sourceId);
    if (this.polls.size >= MAX_AGENT_INPUT_POLLS) throw new AgentInputRequestStoreError("poll_limit");
    const leaseId = Symbol(principal.sourceId);
    let cancelled = false;
    let cancelWait: (() => void) | undefined;
    this.polls.set(principal.sourceId, {
      leaseId,
      cancel: () => {
        cancelled = true;
        cancelWait?.();
      },
    });
    let completed = false;
    try {
      const effectiveAfter = clientEpoch === this.epoch ? after : 0;
      const select = (): AgentInputDelivery[] => {
        const now = Date.now();
        const internal = [...this.deliveries.values()]
          .filter((delivery) => delivery.sourceId === principal.sourceId
            && delivery.credentialGeneration === principal.credentialGeneration
            && ((!delivery.observed && delivery.cursor > effectiveAfter)
              || (delivery.observed && !delivery.sdkStarted
                && (delivery.observedAt ?? 0) + MIN_AGENT_INPUT_REDELIVERY_MS <= now)))
          .sort((left, right) => left.cursor - right.cursor)
          .slice(0, limit);
        for (const delivery of internal) {
          if (!delivery.observed) {
            // This persistence boundary is deliberately before any raw answer is
            // copied into a response. A restart can therefore distinguish a
            // never-exposed reservation from a delivery requiring native proof.
            this.requests.observe(
              delivery.requestId,
              delivery.expectedGeneration,
              delivery.idempotencyKey,
              now,
            );
            delivery.observed = true;
          }
          delivery.observedAt = now;
        }
        return internal.map(publicDelivery);
      };
      let selected = select();
      if (selected.length === 0 && waitMs > 0 && !cancelled) {
        const now = Date.now();
        const nextRedeliveryAt = [...this.deliveries.values()]
        .filter((delivery) => delivery.sourceId === principal.sourceId
          && delivery.credentialGeneration === principal.credentialGeneration
          && delivery.observed && !delivery.sdkStarted)
        .reduce((earliest, delivery) => Math.min(
          earliest,
          (delivery.observedAt ?? now) + MIN_AGENT_INPUT_REDELIVERY_MS,
        ), Number.POSITIVE_INFINITY);
        const wakeMs = Math.min(waitMs, Number.isFinite(nextRedeliveryAt)
          ? Math.max(0, nextRedeliveryAt - now)
          : waitMs);
        await new Promise<void>((resolve) => {
          const event = () => done();
          let timer: ReturnType<typeof setTimeout>;
          const done = () => {
            clearTimeout(timer);
            this.events.off(principal.sourceId, event);
            signal?.removeEventListener("abort", abort);
            resolve();
          };
          const abort = () => {
            cancelled = true;
            done();
          };
          timer = setTimeout(done, wakeMs);
          cancelWait = done;
          this.events.once(principal.sourceId, event);
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
        if (!cancelled) selected = select();
      }
      completed = true;
      return {
        epoch: this.epoch,
        cursor: selected.length
          ? Math.max(effectiveAfter, ...selected.map((delivery) => delivery.cursor))
          : effectiveAfter,
        deliveries: selected,
      };
    } finally {
      const active = this.polls.get(principal.sourceId);
      if (active?.leaseId === leaseId) {
        this.polls.delete(principal.sourceId);
        if (completed && !cancelled && !signal?.aborted) {
          this.assertSourcePrincipal(principal);
          this.recentPolls.set(principal.sourceId, {
            credentialGeneration: principal.credentialGeneration,
            authenticatedAt: Date.now(),
          });
        } else {
          this.recentPolls.delete(principal.sourceId);
        }
      }
    }
  }

  acknowledge(
    principal: AgentInputSourcePrincipal,
    deliveryId: string,
    input: {
      requestId: string;
      generation: number;
      outcome: "applied" | "already_resolved" | "sdk_error";
      code?: string;
      retryable?: boolean;
    },
  ): AgentInputAnswerOutcome {
    this.assertSourcePrincipal(principal);
    const prior = this.acknowledgements.get(deliveryId);
    if (prior) {
      if (JSON.stringify(prior) !== JSON.stringify({ sourceId: principal.sourceId, ...input })) {
        throw new AgentInputRequestStoreError("ack_conflict");
      }
      return prior.outcome === "applied" ? { outcome: "delivered" }
        : prior.outcome === "already_resolved" ? { outcome: "already_resolved" }
          : { outcome: "sdk_error", code: prior.code ?? "sdk_error", retryable: prior.retryable === true };
    }
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery) {
      const request = this.requests.find(input.requestId);
      if (!request || request.sourceId !== principal.sourceId || request.paneId !== principal.paneId) {
        throw new AgentInputRequestStoreError("ack_conflict");
      }
      return this.requests.completeDelivery(
        deliveryId,
        input.requestId,
        input.generation,
        input.outcome === "applied" ? "delivered" : input.outcome,
        input.code,
        undefined,
        input.retryable === true,
      );
    }
    if (delivery.sourceId !== principal.sourceId
      || delivery.credentialGeneration !== principal.credentialGeneration
      || delivery.requestId !== input.requestId
      || delivery.expectedGeneration !== input.generation) {
      throw new AgentInputRequestStoreError("ack_conflict");
    }
    const outcome = this.requests.complete(
      input.requestId,
      input.generation,
      delivery.idempotencyKey,
      input.outcome === "applied" ? "delivered" : input.outcome,
      input.code,
      undefined,
      input.retryable === true,
    );
    const record: AckRecord = { sourceId: principal.sourceId, ...input };
    this.acknowledgements.set(deliveryId, record);
    while (this.acknowledgements.size > 1_024) {
      this.acknowledgements.delete(this.acknowledgements.keys().next().value!);
    }
    this.removeDelivery(delivery);
    this.settleDelivery(delivery, outcome);
    return outcome;
  }

  startDelivery(
    principal: AgentInputSourcePrincipal,
    deliveryId: string,
    requestId: string,
    generation: number,
  ): { outcome: "started" | "already_started" } {
    this.assertSourcePrincipal(principal);
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery || delivery.sourceId !== principal.sourceId
      || delivery.credentialGeneration !== principal.credentialGeneration
      || delivery.requestId !== requestId || delivery.expectedGeneration !== generation
      || !delivery.observed) {
      throw new AgentInputRequestStoreError("delivery_conflict");
    }
    if (delivery.sdkStarted) return { outcome: "already_started" };
    this.requests.markSdkStarted(requestId, generation, delivery.idempotencyKey);
    delivery.sdkStarted = true;
    clearTimeout(delivery.timer);
    delivery.timer = setTimeout(() => this.expireDelivery(deliveryId), this.deliveryTimeoutMs);
    return { outcome: "started" };
  }

  reconcileNativePending(
    principal: AgentInputSourcePrincipal,
    requestId: string,
    generation: number,
    occurrenceId: string,
  ): { outcome: "quarantined" | "pending" | "already_resolved" | "retired" } {
    this.assertSourcePrincipal(principal);
    if (!this.requests.belongsToSource(requestId, generation, principal.sourceId)) {
      return { outcome: "retired" };
    }
    return this.requests.reconcileNativePending(requestId, generation, occurrenceId);
  }

  reconcileNativeList(
    principal: AgentInputSourcePrincipal,
    members: readonly AgentInputNativeSnapshotMember[],
    occurrenceKeys?: readonly string[],
  ): { outcome: "reconciled"; closed: number } {
    this.assertSourcePrincipal(principal);
    if (members.length > 256) {
      throw new AgentInputRequestStoreError("invalid_reconciliation");
    }
    const closed = this.requests.resolveNativeAbsent(principal.sourceId, members, occurrenceKeys);
    this.settleClosed(closed);
    return { outcome: "reconciled", closed: closed.length };
  }

  resolveNative(
    principal: AgentInputSourcePrincipal,
    requestId: string,
    generation: number,
    occurrenceId: string,
    result: "replied" | "rejected",
  ): { outcome: "resolved" | "already_resolved" | "retired" } {
    this.assertSourcePrincipal(principal);
    if (!this.requests.belongsToSource(requestId, generation, principal.sourceId)) {
      return { outcome: "retired" };
    }
    const outcome = this.requests.resolveNative(requestId, generation, occurrenceId, result);
    if (outcome.outcome === "resolved") {
      for (const delivery of [...this.deliveries.values()]) {
        if (delivery.requestId !== requestId || delivery.expectedGeneration !== generation) continue;
        this.removeDelivery(delivery);
        this.settleDelivery(delivery, { outcome: "already_resolved" });
      }
    }
    return { outcome: outcome.outcome };
  }

  settleClosed(closed: readonly { id: string; generation: number }[]): void {
    if (closed.length === 0) return;
    const identities = new Set(closed.map((item) => `${item.id}:${item.generation}`));
    for (const delivery of [...this.deliveries.values()]) {
      if (!identities.has(`${delivery.requestId}:${delivery.expectedGeneration}`)) continue;
      this.removeDelivery(delivery);
      this.settleDelivery(delivery, { outcome: "already_resolved" });
    }
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      for (const source of new Set([...this.deliveries.values()].map((delivery) => delivery.sourceId))) {
        this.disconnectSource(source);
        this.requests.retireSource(source);
      }
      this.credentials.revokeAll();
      this.credentials.invalidateCapabilities();
    }
  }

  disconnectSource(sourceId: string): void {
    this.polls.get(sourceId)?.cancel();
    this.polls.delete(sourceId);
    this.recentPolls.delete(sourceId);
    for (const delivery of [...this.deliveries.values()]) {
      if (delivery.sourceId !== sourceId) continue;
      this.removeDelivery(delivery);
      const outcome = this.requests.release(
        delivery.requestId,
        delivery.expectedGeneration,
        delivery.idempotencyKey,
        "source_unavailable",
        undefined,
        delivery.sdkStarted,
      );
      this.settleDelivery(delivery, outcome);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const source of new Set([...this.deliveries.values()].map((delivery) => delivery.sourceId))) {
      this.disconnectSource(source);
    }
    for (const poll of this.polls.values()) poll.cancel();
    this.polls.clear();
    this.recentPolls.clear();
    this.credentials.off("revoked", this.onSourceRevoked);
    this.credentials.off("rotated", this.onSourceRotated);
    this.credentials.off("attestation-required", this.onSourceAttestationRequired);
    this.credentials.off("issued", this.onSourceIssued);
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
  }

  private readonly onSourceRotated = (sourceId: string): void => {
    this.disconnectSource(sourceId);
    this.scheduleExpiry(sourceId);
  };

  private readonly onSourceAttestationRequired = (sourceId: string): void => {
    this.disconnectSource(sourceId);
  };

  private readonly onSourceRevoked = (sourceId: string): void => {
    this.disconnectSource(sourceId);
    this.requests.retireSource(sourceId);
    const timer = this.expiryTimers.get(sourceId);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(sourceId);
  };

  private readonly onSourceIssued = (sourceId: string): void => this.scheduleExpiry(sourceId);

  private sourceAvailable(source: AgentInputSourceRecord): boolean {
    return this.enabled && source.runtimeReady && source.supported && source.revokedAt === undefined
      && source.expiresAt > Date.now() && this.options.isPaneLive(source);
  }

  private hasAcceptingPoll(source: AgentInputSourceRecord): boolean {
    if (this.polls.has(source.id)) return true;
    const recent = this.recentPolls.get(source.id);
    return Boolean(recent
      && recent.credentialGeneration === source.credentialGeneration
      && recent.authenticatedAt + this.pollGraceMs >= Date.now());
  }

  private assertSourcePrincipal(principal: AgentInputSourcePrincipal): void {
    const source = this.credentials.source(principal.sourceId);
    if (!source || !this.sourceAvailable(source)
      || source.context.paneId !== principal.paneId
      || source.credentialId !== principal.credentialId
      || source.credentialGeneration !== principal.credentialGeneration) {
      throw new AgentInputRequestStoreError("unauthorized_source");
    }
  }

  private waitForExisting(delivery: InternalDelivery, signal?: AbortSignal): Promise<AgentInputAnswerOutcome> {
    if (delivery.waiters.size >= MAX_AGENT_INPUT_WAITERS_PER_DELIVERY
      || this.waiterCount >= MAX_AGENT_INPUT_WAITERS) {
      return Promise.resolve({ outcome: "source_unavailable" });
    }
    return new Promise((resolve) => {
      const waiterId = Symbol(delivery.deliveryId);
      let active = true;
      const finish = (outcome: AgentInputAnswerOutcome) => {
        if (!active) return;
        active = false;
        this.waiterCount -= 1;
        signal?.removeEventListener("abort", abort);
        resolve(outcome);
      };
      const abort = () => this.abandonWaiter(delivery, waiterId);
      delivery.waiters.set(waiterId, finish);
      this.waiterCount += 1;
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private abandonWaiter(delivery: InternalDelivery, waiterId: symbol): void {
    const settle = delivery.waiters.get(waiterId);
    if (!settle) return;
    delivery.waiters.delete(waiterId);
    settle({ outcome: "source_unavailable" });
    if (delivery.waiters.size > 0 || delivery.sdkStarted) return;
    this.removeDelivery(delivery);
    this.requests.release(delivery.requestId, delivery.expectedGeneration, delivery.idempotencyKey, "source_unavailable");
  }

  private expireDelivery(deliveryId: string): void {
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery) return;
    this.removeDelivery(delivery);
    const outcome = this.requests.release(
      delivery.requestId,
      delivery.expectedGeneration,
      delivery.idempotencyKey,
      "delivery_timeout",
      undefined,
      delivery.sdkStarted,
    );
    this.settleDelivery(delivery, outcome);
  }

  private settleDelivery(delivery: InternalDelivery, outcome: AgentInputAnswerOutcome): void {
    for (const settle of delivery.waiters.values()) settle(outcome);
    delivery.waiters.clear();
  }

  private removeDelivery(delivery: InternalDelivery): void {
    if (!this.deliveries.delete(delivery.deliveryId)) return;
    clearTimeout(delivery.timer);
    this.transientBytes -= delivery.bytes;
    for (const answer of delivery.answers) answer.fill("");
    delivery.answers.length = 0;
  }

  private scheduleExpiry(sourceId: string): void {
    const prior = this.expiryTimers.get(sourceId);
    if (prior) clearTimeout(prior);
    const source = this.credentials.source(sourceId);
    if (!source || source.revokedAt !== undefined) return;
    const delay = Math.max(0, Math.min(2_147_483_647, source.expiresAt - Date.now()));
    const timer = setTimeout(() => {
      this.expiryTimers.delete(sourceId);
      const current = this.credentials.source(sourceId);
      if (!current || current.revokedAt !== undefined) return;
      if (current.expiresAt > Date.now()) {
        this.scheduleExpiry(sourceId);
        return;
      }
      this.disconnectSource(sourceId);
      this.requests.retireSource(sourceId);
    }, delay);
    timer.unref?.();
    this.expiryTimers.set(sourceId, timer);
  }
}

const publicDelivery = (delivery: InternalDelivery): AgentInputDelivery => ({
  deliveryId: delivery.deliveryId,
  cursor: delivery.cursor,
  requestId: delivery.requestId,
  expectedGeneration: delivery.expectedGeneration,
  openCodeRequestId: delivery.openCodeRequestId,
  answers: structuredClone(delivery.answers),
});
