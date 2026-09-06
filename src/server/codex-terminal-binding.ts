import crypto from "node:crypto";

const MAX_BINDINGS = 512;
const ISSUED_TTL_MS = 60_000;
const RESOLVED_TTL_MS = 24 * 60 * 60 * 1000;
const MARKER_PREFIX = "[[WMUX:";
const MARKER_LENGTH = MARKER_PREFIX.length + 22 + 2;
const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const receiptPattern = /^[A-Za-z0-9_-]{43}$/;
const markerPattern = /^\[\[WMUX:([A-Za-z0-9_-]{22})\]\]$/;

export interface CodexBindingTuple {
  workspaceId: string;
  tabId: string;
  paneId: string;
  sessionId: string;
  turnId?: string;
  expiresAt: string;
}

interface Binding extends CodexBindingTuple {
  marker: string;
  receiptHash: string;
  issuedAt: number;
  issuedAtMs: number;
  expiresAtMs: number;
  observedPaneId?: string;
  invalid: boolean;
  lastLifecycleSequence?: number;
}

export class CodexMarkerParser {
  private candidate = "";

  push(data: string, onMarker: (marker: string) => void): void {
    for (const char of data) {
      if (!this.candidate) {
        if (char === "[") this.candidate = char;
        continue;
      }
      const index = this.candidate.length;
      const isTokenCharacter = index >= MARKER_PREFIX.length && index < MARKER_PREFIX.length + 22
        && /^[A-Za-z0-9_-]$/.test(char);
      const expectedChar = index < MARKER_PREFIX.length
        ? MARKER_PREFIX[index]
        : index >= MARKER_PREFIX.length + 22
          ? "]]"[index - MARKER_PREFIX.length - 22]
          : undefined;
      if (!isTokenCharacter && char !== expectedChar) {
        this.candidate = char === "[" ? "[" : "";
        continue;
      }
      this.candidate += char;
      if (this.candidate.length !== MARKER_LENGTH) continue;
      const marker = this.candidate;
      this.candidate = "";
      if (markerPattern.test(marker)) onMarker(marker);
    }
  }
}

export class CodexTerminalBindingRegistry {
  private readonly byMarker = new Map<string, Binding>();
  private readonly byReceipt = new Map<string, Binding>();
  private issueSequence = 0;

  constructor(
    private readonly findTuple: (paneId: string) => Omit<CodexBindingTuple, "sessionId" | "expiresAt"> | undefined,
    private readonly isPaneLive: (paneId: string) => boolean,
  ) {}

  issue(sessionId: unknown, turnId?: unknown): { receipt: string; marker: string; expiresAt: string } {
    if (typeof sessionId !== "string" || !sessionIdPattern.test(sessionId)) throw new CodexBindingError(400, "invalid_session_id");
    if (turnId !== undefined && (typeof turnId !== "string" || !sessionIdPattern.test(turnId))) throw new CodexBindingError(400, "invalid_turn_id");
    this.prune();
    const now = Date.now();
    const marker = `${MARKER_PREFIX}${randomBase64Url(16)}]]`;
    const receipt = randomBase64Url(32);
    const binding: Binding = {
      workspaceId: "",
      tabId: "",
      paneId: "",
      sessionId,
      ...(turnId === undefined ? {} : { turnId }),
      marker,
      receiptHash: receiptDigest(receipt),
      issuedAt: ++this.issueSequence,
      issuedAtMs: now,
      expiresAtMs: now + ISSUED_TTL_MS,
      expiresAt: new Date(now + ISSUED_TTL_MS).toISOString(),
      invalid: false,
    };
    this.byMarker.set(marker, binding);
    this.byReceipt.set(binding.receiptHash, binding);
    this.trim();
    return { receipt, marker, expiresAt: binding.expiresAt };
  }

  observe(paneId: string, marker: string): void {
    this.prune();
    const binding = this.byMarker.get(marker);
    if (!binding || binding.invalid || binding.expiresAtMs <= Date.now()) return;
    if (binding.observedPaneId && binding.observedPaneId !== paneId) {
      binding.invalid = true;
      return;
    }
    if (binding.observedPaneId === paneId) return;
    // Separate receipts do not make concurrent views of one saved Codex
    // conversation independent. Reject known cross-pane ambiguity in both
    // directions instead of letting arrival order choose a workspace.
    let ambiguous = false;
    for (const candidate of this.byMarker.values()) {
      if (candidate === binding || candidate.invalid || !candidate.observedPaneId
        || candidate.sessionId !== binding.sessionId || candidate.observedPaneId === paneId) continue;
      candidate.invalid = true;
      ambiguous = true;
    }
    if (ambiguous) {
      binding.invalid = true;
      return;
    }
    // A newer challenge wins within one pane. An old marker replayed after it
    // must never regain authority.
    for (const candidate of this.byMarker.values()) {
      if (candidate === binding || candidate.invalid || candidate.observedPaneId !== paneId) continue;
      if (candidate.issuedAt > binding.issuedAt) {
        binding.invalid = true;
        return;
      }
      candidate.invalid = true;
    }
    const tuple = this.findTuple(paneId);
    if (!tuple || !this.isPaneLive(paneId)) {
      binding.invalid = true;
      return;
    }
    binding.workspaceId = tuple.workspaceId;
    binding.tabId = tuple.tabId;
    binding.paneId = paneId;
    binding.observedPaneId = paneId;
    // Establish the lease when the marker is observed, not when the model's
    // tool is approved. A normal human approval can take longer than a minute.
    binding.expiresAtMs = binding.issuedAtMs + RESOLVED_TTL_MS;
    binding.expiresAt = new Date(binding.expiresAtMs).toISOString();
  }

  /** A pane id can be reused by a replacement backend process. */
  invalidatePane(paneId: string): void {
    this.prune();
    for (const binding of this.byMarker.values()) {
      if (binding.observedPaneId === paneId) binding.invalid = true;
    }
  }

  resolve(sessionId: unknown, receipt: unknown): CodexBindingTuple {
    this.prune();
    if (typeof sessionId !== "string" || !sessionIdPattern.test(sessionId)) throw new CodexBindingError(400, "invalid_session_id");
    if (typeof receipt !== "string" || !receiptPattern.test(receipt)) throw new CodexBindingError(400, "invalid_receipt");
    const binding = this.byReceipt.get(receiptDigest(receipt));
    if (!binding || binding.sessionId !== sessionId || binding.invalid) {
      throw new CodexBindingError(404, "binding_not_found");
    }
    if (!binding.observedPaneId) throw new CodexBindingError(409, "binding_pending");
    if (!this.isPaneLive(binding.paneId)) throw new CodexBindingError(409, "pane_unavailable");
    const tuple = this.findTuple(binding.paneId);
    if (!tuple || tuple.workspaceId !== binding.workspaceId || tuple.tabId !== binding.tabId) {
      throw new CodexBindingError(409, "binding_target_changed");
    }
    return {
      workspaceId: binding.workspaceId,
      tabId: binding.tabId,
      paneId: binding.paneId,
      sessionId: binding.sessionId,
      ...(binding.turnId ? { turnId: binding.turnId } : {}),
      expiresAt: binding.expiresAt,
    };
  }

  acceptLifecycle(sessionId: unknown, receipt: unknown, turnId: unknown, sequence: unknown): CodexBindingTuple | undefined {
    const tuple = this.resolve(sessionId, receipt);
    if (!tuple.turnId || tuple.turnId !== turnId) throw new CodexBindingError(409, "binding_turn_mismatch");
    if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence <= 0) throw new CodexBindingError(400, "invalid_lifecycle_sequence");
    const lifecycleSequence = sequence;
    const binding = this.byReceipt.get(receiptDigest(receipt as string));
    if (!binding) throw new CodexBindingError(404, "binding_not_found");
    if ((binding.lastLifecycleSequence ?? 0) >= lifecycleSequence) return undefined;
    binding.lastLifecycleSequence = lifecycleSequence;
    return tuple;
  }

  private prune(now = Date.now()): void {
    for (const [marker, binding] of this.byMarker) {
      if (binding.expiresAtMs > now) continue;
      this.byMarker.delete(marker);
      if (this.byReceipt.get(binding.receiptHash) === binding) this.byReceipt.delete(binding.receiptHash);
    }
  }

  private trim(): void {
    while (this.byMarker.size > MAX_BINDINGS) {
      const oldest = this.byMarker.values().next().value as Binding | undefined;
      if (!oldest) return;
      this.byMarker.delete(oldest.marker);
      if (this.byReceipt.get(oldest.receiptHash) === oldest) this.byReceipt.delete(oldest.receiptHash);
    }
  }
}

export class CodexBindingError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

const randomBase64Url = (bytes: number): string => crypto.randomBytes(bytes).toString("base64url");
const receiptDigest = (receipt: string): string => crypto.createHash("sha256").update(receipt).digest("base64url");
