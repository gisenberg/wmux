import crypto from "node:crypto";
import { TERMINAL_DELEGATION_STATES, type AgentSessionService } from "./agent-sessions.js";
import type { CodexBindingTuple, CodexTerminalBindingRegistry } from "./codex-terminal-binding.js";

const STALE_MS = 30_000;
const MAX_LEASES = 512;
const MAX_INITIAL_UNCERTAINTIES = 512;
const states = new Set(["active", "attention", "completed", "failed", "interrupted", "unknown", "notLoaded"]);
const attentions = new Set([null, "approval", "input", "approval_and_input"]);

export interface CodexLifecycleInput { sessionId: unknown; receipt: unknown; turnId: unknown; sequence: unknown; state: unknown; attention: unknown; }
interface Lease {
  tuple: CodexBindingTuple;
  receipt: string;
  runId: string;
  state: string;
  attention: "approval" | "input" | "approval_and_input" | null;
  lastAuthoritativeAt: number;
  stale: boolean;
}
interface InitialUncertainty {
  tuple: CodexBindingTuple;
  receipt: string;
}

export class CodexLifecyclePublisher {
  private leases = new Map<string, Lease>();
  // A first observer sample can be unavailable before there has ever been an
  // authoritative native state. Keep one receipt-bound diagnostic per run so
  // the gap is visible without manufacturing Working or terminal activity.
  private initialUncertainties = new Map<string, InitialUncertainty>();
  private timer: ReturnType<typeof setInterval>;
  constructor(private readonly bindings: CodexTerminalBindingRegistry, private readonly agents: AgentSessionService) {
    // Binding receipts and observer connections are process-local. Do not let a
    // persisted Working glyph outlive the observer that made it authoritative.
    this.agents.markCodexObserversStale();
    this.timer = setInterval(() => this.reconcile(), 5_000);
    this.timer.unref();
  }
  dispose(): void { clearInterval(this.timer); this.leases.clear(); this.initialUncertainties.clear(); }
  publish(input: CodexLifecycleInput): { accepted: boolean } {
    if (typeof input.state !== "string" || !states.has(input.state) || !attentions.has(input.attention as null)
      || (input.state === "attention" ? input.attention === null : input.attention !== null)) throw new Error("invalid_codex_lifecycle");
    const tuple = this.bindings.acceptLifecycle(input.sessionId, input.receipt, input.turnId, input.sequence);
    if (!tuple) return { accepted: false };
    const key = tuple.paneId;
    const runId = codexRunId(tuple);
    const existing = this.agents.delegationForRun(runId);
    if (existing && TERMINAL_DELEGATION_STATES.has(existing.state)) return { accepted: false };
    let lease = this.leases.get(key);
    // A new receipt-bound turn on this pane supersedes only this pane's old
    // confidence. It must not suppress the new turn's first uncertainty, and
    // sampling another pane must never evict a valid diagnostic/lease here.
    if (lease && (lease.tuple.sessionId !== tuple.sessionId || lease.tuple.turnId !== tuple.turnId)) {
      this.leases.delete(key);
      lease = undefined;
    }
    if (input.state === "unknown" || input.state === "notLoaded") {
      const sameDiagnostic = typeof input.receipt === "string"
        && sameInitialUncertainty(this.initialUncertainties.get(runId), tuple, input.receipt);
      if (!lease && !sameDiagnostic && typeof input.receipt === "string") {
        this.rememberInitialUncertainty(runId, tuple, input.receipt);
        this.agents.recordAgentEvent({
          workspaceId: tuple.workspaceId, tabId: tuple.tabId, paneId: tuple.paneId,
          agent: "codex", runId, sessionId: tuple.sessionId, status: "observer_stale",
          summary: "Codex status unknown: initial observation unavailable", message: "observer_stale",
        });
      }
      return { accepted: true };
    }
    if (typeof input.receipt !== "string") return { accepted: false };
    const now = Date.now();
    if (!this.leases.has(key) && !this.reserveLeaseSlot()) return { accepted: false };
    const previous = this.leases.get(key);
    this.initialUncertainties.delete(runId);
    this.leases.set(key, { tuple, receipt: input.receipt, runId, state: input.state, attention: input.attention as Lease["attention"], lastAuthoritativeAt: now, stale: false });
    const status = input.state === "active" ? "running" : input.state === "attention" ? "waiting" : input.state;
    const attentionReason = input.attention === "approval" ? "approval" : input.attention === "input" || input.attention === "approval_and_input" ? "input" : undefined;
    const unchanged = previous?.state === input.state && previous.attention === input.attention && !previous.stale;
    this.agents.recordAgentEvent({ workspaceId: tuple.workspaceId, tabId: tuple.tabId, paneId: tuple.paneId, agent: "codex", runId, sessionId: tuple.sessionId, status, attentionReason, summary: input.state === "attention" ? `codex waiting: ${input.attention}` : `codex ${status}`, coalesce: (status === "running" || status === "waiting") && unchanged });
    if (input.state === "completed" || input.state === "failed" || input.state === "interrupted") this.leases.delete(key);
    return { accepted: true };
  }
  reconcile(now = Date.now()): void {
    for (const [key, lease] of this.leases) {
      if (lease.stale || now - lease.lastAuthoritativeAt <= STALE_MS) continue;
      try {
        // This server-owned withdrawal is conditional on the exact latest run,
        // including when its receipt was revoked. It cannot select replacement
        // activity or create an outcome from an obsolete source callback.
        this.agents.markCodexObserverStale(lease.tuple.paneId, lease.runId);
        const current = this.bindings.resolve(lease.tuple.sessionId, lease.receipt);
        if (!sameBinding(current, lease.tuple)) {
          this.leases.delete(key);
          continue;
        }
        lease.stale = true;
      } catch {
        // A closed or recycled pane invalidates the process-local lease.
        this.leases.delete(key);
      }
    }
  }

  private reserveLeaseSlot(): boolean {
    for (const [key, lease] of this.leases) {
      let valid = false;
      try {
        const current = this.bindings.resolve(lease.tuple.sessionId, lease.receipt);
        valid = sameBinding(current, lease.tuple);
      }
      catch { this.agents.markCodexObserverStale(lease.tuple.paneId, lease.runId); }
      // A valid stale lease is still exact receipt-bound evidence. Retain it
      // so another pane's sample cannot turn a later unknown into a fresh,
      // misleading initial-observation diagnostic.
      if (valid) continue;
      this.leases.delete(key);
    }
    return this.leases.size < MAX_LEASES;
  }

  private rememberInitialUncertainty(runId: string, tuple: CodexBindingTuple, receipt: string): void {
    if (!this.initialUncertainties.has(runId) && this.initialUncertainties.size >= MAX_INITIAL_UNCERTAINTIES) this.pruneInitialUncertainties();
    this.initialUncertainties.set(runId, { tuple, receipt });
    if (this.initialUncertainties.size <= MAX_INITIAL_UNCERTAINTIES) return;
    const oldest = this.initialUncertainties.keys().next().value;
    if (oldest) this.initialUncertainties.delete(oldest);
  }

  private pruneInitialUncertainties(): void {
    for (const [runId, diagnostic] of this.initialUncertainties) {
      try {
        const current = this.bindings.resolve(diagnostic.tuple.sessionId, diagnostic.receipt);
        if (sameBinding(current, diagnostic.tuple)) continue;
      } catch {}
      this.initialUncertainties.delete(runId);
    }
  }
}

const codexRunId = (tuple: CodexBindingTuple): string => `codex_${crypto.createHash("sha256")
  .update(`${tuple.sessionId}\0${tuple.turnId ?? ""}`)
  .digest("base64url")}`;

const sameBinding = (left: CodexBindingTuple, right: CodexBindingTuple): boolean => left.workspaceId === right.workspaceId
  && left.tabId === right.tabId
  && left.paneId === right.paneId
  && left.sessionId === right.sessionId
  && left.turnId === right.turnId;

const sameInitialUncertainty = (value: InitialUncertainty | undefined, tuple: CodexBindingTuple, receipt: string): boolean =>
  Boolean(value && value.receipt === receipt && sameBinding(value.tuple, tuple));
