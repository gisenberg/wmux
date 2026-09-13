import type { CodexObservation } from "../shared/protocol.js";
import { CodexBindingError } from "./codex-terminal-binding.js";

const statuses = new Set(["starting", "active", "unknown", "backing_off", "stopped"]);
const reasons = new Set([
  "missing_native_name", "invalid_native_name", "missing_turn_id", "binding_unavailable",
  "binding_not_observed", "binding_expired", "native_root_mismatch", "unsupported_endpoint",
  "socket_unavailable", "delivery_failed", "transport_error", "observer_stopped",
  "terminal_observed", "lock_contended", "sample_budget_exceeded", "none",
]);
const counters = new Set(["attempts", "reconnects", "transportFailures", "requestFailures",
  "lockContention", "staleResponses", "cancelled"]);
const fields = new Set(["sessionId", "receipt", "channel", "status", "sampledAt", "lastSuccessAt", "reason", "counters", "pluginVersion"]);
const invalid = (): never => { throw new CodexBindingError(400, "invalid_codex_observation"); };

export function parseCodexObservation(body: Record<string, unknown>, now = Date.now()): {
  channel: "naming" | "activity"; observation: CodexObservation;
} {
  if (Object.keys(body).some(key => !fields.has(key))
    || (body.channel !== "naming" && body.channel !== "activity")
    || typeof body.status !== "string" || !statuses.has(body.status)
    || (body.reason !== undefined && (typeof body.reason !== "string" || !reasons.has(body.reason)))) invalid();
  for (const key of ["sampledAt", "lastSuccessAt"] as const) {
    const value = body[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > now + 5_000)) invalid();
  }
  if (typeof body.sampledAt === "number" && typeof body.lastSuccessAt === "number" && body.lastSuccessAt > body.sampledAt) invalid();
  if (body.pluginVersion !== undefined && (typeof body.pluginVersion !== "string"
    || !/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[+-][A-Za-z0-9.-]{1,48})?$/.test(body.pluginVersion))) invalid();
  const counts: Record<string, number> = {};
  if (body.counters !== undefined) {
    if (!body.counters || typeof body.counters !== "object" || Array.isArray(body.counters)) invalid();
    for (const [key, value] of Object.entries(body.counters as Record<string, unknown>)) {
      if (!counters.has(key) || typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) invalid();
      counts[key] = value as number;
    }
  }
  return { channel: body.channel as "naming" | "activity", observation: {
    status: body.status as CodexObservation["status"], receivedAt: now, counters: counts, stale: false,
    ...(body.reason === undefined ? {} : { reason: body.reason as string }),
    ...(body.sampledAt === undefined ? {} : { sampledAt: body.sampledAt as number }),
    ...(body.lastSuccessAt === undefined ? {} : { lastSuccessAt: body.lastSuccessAt as number }),
    ...(body.pluginVersion === undefined ? {} : { pluginVersion: body.pluginVersion as string }),
  } };
}
