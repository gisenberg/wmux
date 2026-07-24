import type {
  BootstrapPayload,
  EventCollectionDelta,
  EventStateDelta,
} from "../types";

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
  current: { revision: number; healthEpoch: number; eventRevision?: number } | null | undefined,
  incoming: { revision: number; healthEpoch: number; eventRevision?: number },
): boolean => Boolean(current && (
  incoming.revision < current.revision ||
  (
    incoming.revision === current.revision
    && (
      incoming.healthEpoch < current.healthEpoch
      || (
        incoming.healthEpoch === current.healthEpoch
        && incoming.eventRevision !== undefined
        && current.eventRevision !== undefined
        && incoming.eventRevision < current.eventRevision
      )
    )
  )
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

const applyCollectionDelta = <T>(
  current: T[],
  delta: EventCollectionDelta<T> | undefined,
  idOf: (item: T) => string,
): T[] => {
  if (!delta) return current;
  const removed = new Set(delta.removedIds);
  const byId = new Map(
    current
      .filter((item) => !removed.has(idOf(item)))
      .map((item) => [idOf(item), item]),
  );
  for (const item of delta.upserted) byId.set(idOf(item), item);
  if (!delta.order) return [...byId.values()];
  return delta.order.flatMap((id) => {
    const item = byId.get(id);
    return item === undefined ? [] : [item];
  });
};

export const eventDeltaRequiresResync = (
  current: Pick<BootstrapPayload, "eventRevision"> | null | undefined,
  delta: EventStateDelta,
): boolean => Boolean(
  !current
  || (
    delta.eventRevision > current.eventRevision
    && delta.baseEventRevision !== current.eventRevision
  ),
);

export const bootstrapSatisfiesEventDelta = (
  required: Pick<EventStateDelta, "eventRevision" | "healthEpoch"> | null | undefined,
  incoming: Pick<BootstrapPayload, "eventRevision" | "healthEpoch">,
): boolean => !required
  || incoming.healthEpoch > required.healthEpoch
  || (
    incoming.healthEpoch === required.healthEpoch
    && incoming.eventRevision >= required.eventRevision
  );

export const applyEventDelta = (
  current: BootstrapPayload | null | undefined,
  delta: EventStateDelta,
): BootstrapPayload | null | undefined => {
  if (!current || delta.eventRevision <= current.eventRevision) return current;
  if (delta.baseEventRevision !== current.eventRevision) return current;
  const workspaceDelta = delta.workspaces;
  const agentDelta = delta.agents;
  return reconcile(current, {
    ...current,
    eventRevision: delta.eventRevision,
    revision: delta.revision,
    ...(workspaceDelta
      ? {
          workspaces: applyCollectionDelta(
            current.workspaces,
            workspaceDelta.items,
            (workspace) => workspace.id,
          ),
          activeWorkspaceId:
            workspaceDelta.activeWorkspaceId ?? current.activeWorkspaceId,
          workspaceTreeRevision:
            workspaceDelta.workspaceTreeRevision ?? current.workspaceTreeRevision,
        }
      : {}),
    ...(delta.notifications
      ? {
          notifications: applyCollectionDelta(
            current.notifications,
            delta.notifications,
            (notification) => notification.id,
          ),
        }
      : {}),
    ...(agentDelta
      ? {
          agentEvents: applyCollectionDelta(
            current.agentEvents,
            agentDelta.events,
            (event) => event.id,
          ),
          delegations: applyCollectionDelta(
            current.delegations,
            agentDelta.delegations,
            (delegation) => delegation.runId,
          ),
          agentTimelines: applyCollectionDelta(
            current.agentTimelines,
            agentDelta.timelines,
            (timeline) => timeline.id,
          ),
        }
      : {}),
    ...(delta.runs
      ? {
          runs: applyCollectionDelta(
            current.runs,
            delta.runs,
            (run) => run.id,
          ),
        }
      : {}),
    ...(delta.settings ? { settings: delta.settings } : {}),
  });
};

export const reconcileIncomingRevision = <T extends { revision: number; healthEpoch: number; eventRevision?: number }>(
  current: T | null | undefined,
  incoming: T,
): T => current && isIncomingRevisionStale(current, incoming) ? current : reconcile(current, incoming);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
