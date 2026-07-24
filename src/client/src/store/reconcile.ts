// Structural sharing for refetched server state: returns `next` reshaped to
// reuse object identities from `prev` wherever the content is deep-equal.
// Bootstrap resyncs rebuild the whole payload, so without this every pane/tab
// object changes identity on every event and React.memo can never hit.
export const reconcile = <T>(prev: unknown, next: T): T => {
  if (prev === next) return next;
  if (Array.isArray(prev) && Array.isArray(next)) {
    let identical = prev.length === next.length;
    const merged = next.map((item, index) => {
      const reconciled = reconcile(prev[index], item);
      if (reconciled !== prev[index]) identical = false;
      return reconciled;
    });
    return (identical ? prev : merged) as T;
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const prevKeys = Object.keys(prev);
    const nextKeys = Object.keys(next);
    let identical = prevKeys.length === nextKeys.length;
    const merged: Record<string, unknown> = {};
    for (const key of nextKeys) {
      const reconciled = reconcile(prev[key], (next as Record<string, unknown>)[key]);
      if (reconciled !== prev[key]) identical = false;
      merged[key] = reconciled;
    }
    return (identical ? prev : merged) as T;
  }
  return next;
};

export const isIncomingRevisionStale = (
  current: { revision: number; healthEpoch: number } | null | undefined,
  incoming: { revision: number; healthEpoch: number },
): boolean => Boolean(current && (
  incoming.revision < current.revision ||
  (incoming.revision === current.revision && incoming.healthEpoch < current.healthEpoch)
));

export const isIncomingRevisionNewer = (
  current: { revision: number; healthEpoch: number },
  incoming: { revision: number; healthEpoch: number },
): boolean => incoming.revision > current.revision || (
  incoming.revision === current.revision && incoming.healthEpoch > current.healthEpoch
);

export const healthDeltaRequiresResync = (
  current: { revision: number } | null | undefined,
  delta: { revision: number },
): boolean => !current || delta.revision > current.revision;

export const bootstrapSatisfiesHealthDelta = (
  required: { revision: number; healthEpoch: number } | null | undefined,
  incoming: { revision: number; healthEpoch: number },
): boolean => !required || !isIncomingRevisionStale(required, incoming);

export const applyHealthDelta = <T extends { revision: number; healthEpoch: number; machines: unknown[]; streams: unknown[] }>(
  current: T | null | undefined,
  delta: { revision: number; healthEpoch: number; machines?: unknown[]; streams?: unknown[] },
): T | null | undefined => {
  if (!current || delta.revision !== current.revision || delta.healthEpoch <= current.healthEpoch) return current;
  return reconcile(current, {
    ...current,
    healthEpoch: delta.healthEpoch,
    ...(delta.machines ? { machines: delta.machines } : {}),
    ...(delta.streams ? { streams: delta.streams } : {}),
  });
};

export const reconcileIncomingRevision = <T extends { revision: number; healthEpoch: number }>(
  current: T | null | undefined,
  incoming: T,
): T => current && isIncomingRevisionStale(current, incoming) ? current : reconcile(current, incoming);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
