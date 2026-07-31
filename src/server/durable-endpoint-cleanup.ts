import {
  disposeDurableSession,
  listDurableSessionsOnMachine,
  type DurableSessionObservationResult,
} from "./durable-session.js";
import {
  durableEndpointKey,
  type DurableEndpointRecord,
  DurableEndpointStore,
  sameDisposalEndpoint,
} from "./durable-endpoint-store.js";
import {
  deleteWindowsAgentSession,
  listSessionAgentSessions,
  type SessionAgentObservationResult,
} from "./windows-agent.js";

export interface StrandedEndpointCleanupOptions {
  remoteLister?: (
    machine: DurableEndpointRecord["machine"],
  ) => Promise<DurableSessionObservationResult>;
  remoteDisposer?: (
    machine: DurableEndpointRecord["machine"],
    paneId: string,
  ) => Promise<boolean>;
  agentLister?: (
    machine: DurableEndpointRecord["machine"],
  ) => Promise<SessionAgentObservationResult>;
  agentDisposer?: (
    machine: DurableEndpointRecord["machine"],
    paneId: string,
  ) => Promise<boolean>;
}

export interface StrandedEndpointCleanupResult {
  removedRecords: number;
  disposedSessions: number;
  unreachableRecords: number;
  failedRecords: number;
}

const currentStrandedRecord = (
  store: DurableEndpointStore,
  record: DurableEndpointRecord,
  result: StrandedEndpointCleanupResult,
): DurableEndpointRecord | undefined => {
  const current = store.find(record.id);
  if (!current || current.status !== "stranded") return undefined;
  const hasReplacement = store.snapshot().some((candidate) =>
    candidate.status === "active"
    && candidate.paneId === current.paneId
    && candidate.backend === current.backend
    && sameDisposalEndpoint(candidate.machine, current.machine));
  if (!hasReplacement) return current;
  if (store.delete(current.id)) result.removedRecords += 1;
  return undefined;
};

export const cleanupStrandedDurableEndpoints = async (
  store: DurableEndpointStore,
  options: StrandedEndpointCleanupOptions = {},
): Promise<StrandedEndpointCleanupResult> => {
  const result: StrandedEndpointCleanupResult = {
    removedRecords: 0,
    disposedSessions: 0,
    unreachableRecords: 0,
    failedRecords: 0,
  };
  const records = store.snapshot().filter((record) => record.status === "stranded");
  const groups = new Map<string, DurableEndpointRecord[]>();
  for (const record of records) {
    const key = `${record.backend}:${durableEndpointKey(record.machine)}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }

  const cleanupGroup = async (group: DurableEndpointRecord[]): Promise<void> => {
    const representative = group[0];
    if (representative.backend === "windows-agent") {
      let observed: SessionAgentObservationResult;
      try {
        observed = await (options.agentLister ?? listSessionAgentSessions)(representative.machine);
      } catch {
        observed = { reachable: false, sessions: [] };
      }
      if (!observed.reachable) {
        result.unreachableRecords += group.length;
        return;
      }
      const observedPaneIds = new Set(observed.sessions.map((session) => session.paneId));
      for (const candidate of group) {
        const record = currentStrandedRecord(store, candidate, result);
        if (!record) continue;
        if (!observedPaneIds.has(record.paneId)) {
          if (store.delete(record.id)) result.removedRecords += 1;
          continue;
        }
        try {
          const disposed = await (options.agentDisposer ?? deleteWindowsAgentSession)(
            record.machine,
            record.paneId,
          );
          if (!disposed) {
            result.failedRecords += 1;
            continue;
          }
          result.disposedSessions += 1;
          if (store.delete(record.id)) result.removedRecords += 1;
        } catch {
          result.failedRecords += 1;
        }
      }
      return;
    }

    let observed: DurableSessionObservationResult;
    try {
      observed = await (options.remoteLister ?? listDurableSessionsOnMachine)(representative.machine);
    } catch {
      observed = { reachable: false, sessions: [] };
    }
    if (!observed.reachable) {
      result.unreachableRecords += group.length;
      return;
    }
    for (const candidate of group) {
      const record = currentStrandedRecord(store, candidate, result);
      if (!record) continue;
      const sessions = observed.sessions.filter((session) => session.paneId === record.paneId);
      if (sessions.length === 0) {
        if (store.delete(record.id)) result.removedRecords += 1;
        continue;
      }
      try {
        const backends = new Set(sessions.map((session) => session.backend));
        const outcomes = await Promise.all([...backends].map((sessionBackend) =>
          (options.remoteDisposer ?? disposeDurableSession)(
            { ...record.machine, sessionBackend },
            record.paneId,
          )));
        if (outcomes.some((disposed) => !disposed)) {
          result.failedRecords += 1;
          continue;
        }
        result.disposedSessions += sessions.length;
        if (store.delete(record.id)) result.removedRecords += 1;
      } catch {
        result.failedRecords += 1;
      }
    }
  };

  const endpointGroups = [...groups.values()];
  let nextGroup = 0;
  await Promise.all(Array.from(
    { length: Math.min(4, endpointGroups.length) },
    async () => {
      while (nextGroup < endpointGroups.length) {
        const index = nextGroup;
        nextGroup += 1;
        await cleanupGroup(endpointGroups[index]);
      }
    },
  ));
  return result;
};
