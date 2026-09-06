// Read-only, polling-oriented Codex App Server lifecycle adapter.
//
// This intentionally knows nothing about a transport.  The caller supplies a
// request(method, params) function and is responsible for its connection,
// cadence, and stale deadline.  It never resumes, subscribes, queues, starts,
// interrupts, or answers a thread.

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_TURNS = 8;
const MAX_PAGES = 4;
const ACTIVE_FLAGS = new Set(["waitingOnApproval", "waitingOnUserInput"]);
const TURN_STATUSES = new Set(["completed", "interrupted", "failed", "inProgress"]);

function validId(value) { return typeof value === "string" && ID.test(value); }
function sameStatus(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function unknown(threadId, sessionId, turnId, reason) {
  return { threadId, sessionId, turnId, state: "unknown", attention: null, reason };
}

function validStatus(status) {
  if (!status || typeof status !== "object") return false;
  if (["notLoaded", "idle", "systemError"].includes(status.type)) return Object.keys(status).length === 1;
  return status.type === "active" && Array.isArray(status.activeFlags) &&
    status.activeFlags.length <= 16 && status.activeFlags.every(flag => typeof flag === "string" && flag.length <= 128);
}

function validThread(thread, threadId, sessionId) {
  return thread && typeof thread === "object" && thread.id === threadId && thread.sessionId === sessionId &&
    thread.parentThreadId === null && validStatus(thread.status);
}

function validTurn(turn) {
  return turn && typeof turn === "object" && validId(turn.id) && TURN_STATUSES.has(turn.status) &&
    (turn.startedAt === null || Number.isFinite(turn.startedAt)) &&
    (turn.completedAt === null || Number.isFinite(turn.completedAt)) &&
    (turn.durationMs === null || Number.isFinite(turn.durationMs));
}

function validCursor(value) {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= 4096);
}

function attention(flags) {
  const unknownFlags = flags.filter(flag => !ACTIVE_FLAGS.has(flag));
  if (unknownFlags.length) return { state: "unknown", attention: null, reason: "unknown_active_flag" };
  const approval = flags.includes("waitingOnApproval"), input = flags.includes("waitingOnUserInput");
  if (approval || input) return { state: "attention", attention: approval && input ? "approval_and_input" : approval ? "approval" : "input", reason: null };
  return { state: "active", attention: null, reason: null };
}

/**
 * Snapshot one explicitly bound root turn.
 *
 * A terminal state is emitted only when the same root thread/status appears in
 * two reads bracketing the paged turn lookup and that exact turn has a durable
 * terminal status.  Idle by itself is deliberately unknown: it may describe a
 * turn the observer never saw, or no turn at all.  The App Server has no
 * read-only pending-request snapshot, so attention is generic and never
 * carries a request/item id or answerable question.
 */
export async function observeCodexLifecycle({ request, threadId, sessionId, turnId }) {
  if (typeof request !== "function") throw new Error("A Codex lifecycle request function is required.");
  if (!validId(threadId) || !validId(sessionId) || !validId(turnId)) throw new Error("Explicit valid Codex thread, session, and turn ids are required.");

  let first, turn, second;
  try {
    first = await request("thread/read", { threadId, includeTurns: false });
    const firstThread = first?.thread;
    if (!validThread(firstThread, threadId, sessionId)) return unknown(threadId, sessionId, turnId, firstThread?.parentThreadId ? "child_thread" : "identity_mismatch");

    let cursor = null;
    const cursors = new Set(), ids = new Set();
    for (let page = 0; page < MAX_PAGES; page++) {
      const turns = await request("thread/turns/list", {
        threadId, cursor, limit: MAX_TURNS, sortDirection: "desc", itemsView: "notLoaded",
      });
      if (!Array.isArray(turns?.data) || turns.data.length > MAX_TURNS ||
        !turns.data.every(validTurn) || !validCursor(turns.nextCursor) || !validCursor(turns.backwardsCursor)) {
        return unknown(threadId, sessionId, turnId, "invalid_turn_page");
      }
      // A shifting/repeated page cannot establish one consistent exact-turn
      // snapshot. Retry from the newest page next poll, never chase a cycle.
      for (const candidate of turns.data) {
        if (ids.has(candidate.id)) return unknown(threadId, sessionId, turnId, "inconsistent_turn_pages");
        ids.add(candidate.id);
      }
      turn = turns.data.find(candidate => candidate.id === turnId);
      if (turn || turns.nextCursor === null) break;
      if (cursors.has(turns.nextCursor)) return unknown(threadId, sessionId, turnId, "inconsistent_turn_pages");
      if (page === MAX_PAGES - 1) return unknown(threadId, sessionId, turnId, "turn_lookup_limit");
      cursors.add(turns.nextCursor);
      cursor = turns.nextCursor;
    }

    second = await request("thread/read", { threadId, includeTurns: false });
  } catch {
    return unknown(threadId, sessionId, turnId, "transport_error");
  }

  const before = first.thread, after = second?.thread;
  if (!validThread(after, threadId, sessionId)) return unknown(threadId, sessionId, turnId, after?.parentThreadId ? "child_thread" : "identity_mismatch");
  if (!sameStatus(before.status, after.status)) return unknown(threadId, sessionId, turnId, "cross_read_race");

  if (after.status.type === "notLoaded") return { threadId, sessionId, turnId, state: "notLoaded", attention: null, reason: null };
  if (after.status.type === "systemError") return unknown(threadId, sessionId, turnId, "system_error");
  if (after.status.type === "active") {
    if (!turn || turn.status !== "inProgress") return unknown(threadId, sessionId, turnId, turn ? "turn_status_conflict" : "turn_not_in_snapshot");
    return { threadId, sessionId, turnId, ...attention(after.status.activeFlags) };
  }
  // `idle` has no implication about which turn ended.  Only a matching,
  // persisted terminal turn makes a terminal outcome authoritative.
  if (!turn || !["completed", "interrupted", "failed"].includes(turn.status)) return unknown(threadId, sessionId, turnId, turn ? "turn_status_conflict" : "idle_without_terminal" );
  return { threadId, sessionId, turnId, state: turn.status, attention: null, reason: null,
    completedAt: turn.completedAt, durationMs: turn.durationMs };
}

export const CODEX_LIFECYCLE_TURN_PAGE_LIMIT = MAX_TURNS;
export const CODEX_LIFECYCLE_MAX_TURN_PAGES = MAX_PAGES;
