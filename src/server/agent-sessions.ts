import { createId } from "./id.js";
import {
  AgentTimelineStore,
  type AgentTimelineLifecycleInput,
} from "./agent-timeline.js";
import { stripMarkup, type StateStore } from "./state.js";
import type {
  AgentActivity,
  AgentSessionTimeline,
  AgentTimelineSnapshotLink,
  DelegationRecord,
  DelegationState,
  PersistedState,
  SurfaceTab,
  TerminalNotification,
  WorkingTreeSnapshot,
  Workspace,
} from "./types.js";
import type { AgentEventPostBody } from "../shared/agent-contract.js";

const ACTIVE_AGENT_STATUSES = new Set([
  "running",
  "started",
  "working",
  "waiting",
]);

export const TERMINAL_DELEGATION_STATES = new Set<DelegationState>([
  "completed",
  "failed",
  "error",
  "cancelled",
  "stopped",
  "timed_out",
  "interrupted",
]);

export const DELEGATION_TRANSITIONS: Record<
  DelegationState,
  readonly DelegationState[]
> = {
  running: [
    "running",
    "waiting",
    "completed",
    "failed",
    "error",
    "cancelled",
    "stopped",
    "timed_out",
    "interrupted",
  ],
  waiting: [
    "running",
    "waiting",
    "completed",
    "failed",
    "error",
    "cancelled",
    "stopped",
    "timed_out",
    "interrupted",
  ],
  completed: [],
  failed: [],
  error: [],
  cancelled: [],
  stopped: [],
  timed_out: [],
  interrupted: [],
};

const MAX_DELEGATIONS = 1_000;
const DELEGATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

interface PaneContext {
  workspace: Workspace;
  tab: SurfaceTab;
  paneId: string;
}

interface DelegationEventDisposition {
  accepted: boolean;
  terminalTransition: boolean;
}

export interface AgentEventResult {
  workspace: Workspace;
  notification?: TerminalNotification;
  agentEvent: AgentActivity;
}

export class AgentSessionService {
  constructor(
    private readonly state: StateStore,
    readonly timelines = new AgentTimelineStore(),
  ) {
    this.reconcilePersistedState();
    this.reconcilePersistedTimelines();
  }

  recordAgentEvent(input: AgentEventPostBody): AgentEventResult {
    this.recordInitialPrompt(input);
    const timelineInputs: AgentTimelineLifecycleInput[] = [];
    const result = this.state.commitMutation((persisted) => {
      const target = resolveTarget(persisted, input);
      const agent = cleanTitle(input.agent ?? "agent", "agent");
      const status = cleanTitle(input.status ?? "updated", "updated").toLowerCase();
      const title = cleanTitle(input.title ?? "", "");
      const summary = cleanDescriptor(input.summary ?? input.body ?? "", "");
      const delegationMessage = cleanDelegationMessage(input.message ?? "");
      const message = cleanAgentMessage(delegationMessage);
      const suppliedRunId = cleanDelegationRunId(input.runId);
      const latestAgentEvent = persisted.agentEvents.find(
        (candidate) =>
          candidate.paneId === target.paneId
          && candidate.agent === agent,
      );
      const runId = suppliedRunId || (
        latestAgentEvent
        && ACTIVE_AGENT_STATUSES.has(latestAgentEvent.status)
          ? cleanDelegationRunId(latestAgentEvent.runId)
          : ""
      );
      const existingDelegation = runId
        ? persisted.delegations.find((candidate) => candidate.runId === runId)
        : undefined;
      const sessionId = cleanTimelineId(input.sessionId)
        || existingDelegation?.sessionId
        || runId;
      const createdAt = new Date().toISOString();
      if (ACTIVE_AGENT_STATUSES.has(status)) {
        const interruptedEvent = latestAgentEvent
          && latestAgentEvent.runId !== runId
          ? structuredClone(latestAgentEvent)
          : undefined;
        const interruptedDelegation = interruptedEvent?.runId
          ? persisted.delegations.find(
            (candidate) => candidate.runId === interruptedEvent.runId,
          )
          : undefined;
        const interrupted = markLatestAgentInterrupted(
          persisted,
          target.paneId,
          agent,
          createdAt,
          runId,
        );
        if (
          interrupted
          && interruptedEvent?.runId
          && interruptedDelegation?.sessionId
        ) {
          timelineInputs.push({
            sessionId: interruptedDelegation.sessionId,
            turnId: interruptedEvent.runId,
            runId: interruptedEvent.runId,
            runtime: interruptedEvent.agent,
            workspaceId: interruptedEvent.workspaceId,
            tabId: interruptedEvent.tabId,
            paneId: interruptedEvent.paneId,
            state: "interrupted",
            text: `${interruptedEvent.agent} interrupted`,
            createdAt,
          });
        }
      }
      const agentEvent: AgentActivity = {
        id: createId("agent"),
        ...(runId ? { runId } : {}),
        workspaceId: target.workspace.id,
        tabId: target.tab.id,
        paneId: target.paneId,
        agent,
        status,
        title,
        summary,
        ...(message ? { message } : {}),
        createdAt,
      };
      const delegationDisposition = runId
        ? recordDelegationEvent(
          persisted,
          agentEvent,
          delegationMessage,
          sessionId,
        )
        : { accepted: true, terminalTransition: false };
      if (delegationDisposition.accepted) {
        persisted.agentEvents.unshift(agentEvent);
        persisted.agentEvents = persisted.agentEvents.slice(0, 300);
      }

      let workspaceChanged = false;
      if (
        delegationDisposition.accepted
        && title
        && target.workspace.nameSource !== "user"
      ) {
        target.workspace.name = title;
        target.workspace.nameSource = "auto";
        workspaceChanged = true;
      }

      const descriptor = summary || `${agent} ${status}`;
      if (
        delegationDisposition.accepted
        && descriptor
        && target.workspace.descriptorSource !== "user"
      ) {
        target.workspace.descriptor = descriptor;
        target.workspace.descriptorSource = "auto";
        workspaceChanged = true;
      }

      let notification: TerminalNotification | undefined;
      const terminalNotificationStatus = [
        "completed",
        "failed",
        "error",
        "cancelled",
        "stopped",
      ].includes(status);
      if (
        terminalNotificationStatus
        && (!runId || delegationDisposition.terminalTransition)
      ) {
        notification = {
          id: createId("note"),
          workspaceId: target.workspace.id,
          tabId: target.tab.id,
          paneId: target.paneId,
          title: agent,
          subtitle: status,
          body: summary || title || `${agent} ${status}`,
          createdAt,
          read: false,
        };
        persisted.notifications.unshift(notification);
        persisted.notifications = persisted.notifications.slice(0, 200);
        workspaceChanged = true;
      }

      if (workspaceChanged) target.workspace.updatedAt = createdAt;
      if (
        sessionId
        && (delegationDisposition.accepted || status === "observer_error")
      ) {
        timelineInputs.push({
          sessionId,
          turnId: runId || createId("turn"),
          ...(runId ? { runId } : {}),
          runtime: agent,
          workspaceId: target.workspace.id,
          tabId: target.tab.id,
          paneId: target.paneId,
          ...(input.prompt ? { prompt: cleanTimelinePrompt(input.prompt) } : {}),
          ...(delegationStateForStatus(status)
            ? { state: delegationStateForStatus(status) ?? undefined }
            : {}),
          text: delegationMessage || summary || title || `${agent} ${status}`,
          createdAt,
          ...(status === "observer_error" ? { observerError: true } : {}),
        });
      }
      return {
        result: {
          workspace: target.workspace,
          ...(notification ? { notification } : {}),
          agentEvent,
        },
        changed: true,
        notifications: notification ? [notification] : [],
      };
    });
    for (const timelineInput of timelineInputs) {
      this.timelines.recordLifecycle(timelineInput);
    }
    return result;
  }

  delegationForRun(runId: string): DelegationRecord | undefined {
    return this.state.snapshot().delegations.find(
      (candidate) => candidate.runId === runId,
    );
  }

  timelineSnapshot(): AgentSessionTimeline[] {
    return this.timelines.snapshot();
  }

  timelineForSession(sessionId: string): AgentSessionTimeline | undefined {
    return this.timelines.snapshot().find(
      (candidate) => candidate.id === sessionId,
    );
  }

  recordUserPrompt(paneId: string, text: string): AgentSessionTimeline {
    const snapshot = this.state.snapshot();
    const target = resolveTarget(snapshot, { paneId });
    const latestAgent = snapshot.agentEvents.find(
      (candidate) => candidate.paneId === paneId,
    );
    return this.timelines.recordPrompt({
      paneId,
      runtime: latestAgent?.agent ?? "agent",
      text,
      workspaceId: target.workspace.id,
      tabId: target.tab.id,
    });
  }

  archiveRepositorySnapshot(
    paneId: string,
    snapshot: WorkingTreeSnapshot,
  ): AgentTimelineSnapshotLink | undefined {
    return this.timelines.archiveWorkingTreeSnapshot(paneId, snapshot);
  }

  repositorySnapshot(id: string): WorkingTreeSnapshot | undefined {
    return this.timelines.readWorkingTreeSnapshot(id);
  }

  private recordInitialPrompt(input: AgentEventPostBody): void {
    if (!input.prompt) return;
    const runId = cleanDelegationRunId(input.runId);
    if (!runId) return;
    const snapshot = this.state.snapshot();
    const existing = snapshot.delegations.find(
      (candidate) => candidate.runId === runId,
    );
    if (existing && TERMINAL_DELEGATION_STATES.has(existing.state)) return;
    const target = resolveTarget(snapshot, input);
    const runtime = cleanTitle(input.agent ?? "agent", "agent");
    this.timelines.recordLifecycle({
      sessionId: cleanTimelineId(input.sessionId)
        || existing?.sessionId
        || runId,
      turnId: runId,
      runId,
      runtime,
      workspaceId: target.workspace.id,
      tabId: target.tab.id,
      paneId: target.paneId,
      prompt: cleanTimelinePrompt(input.prompt),
      text: "",
      createdAt: new Date().toISOString(),
    });
  }

  interruptAgentForPane(paneId: string): boolean {
    const snapshot = this.state.snapshot();
    const latest = snapshot.agentEvents.find(
      (candidate) => candidate.paneId === paneId,
    );
    if (!latest || !ACTIVE_AGENT_STATUSES.has(latest.status)) return false;

    const delegation = latest.runId
      ? snapshot.delegations.find(
        (candidate) => candidate.runId === latest.runId,
      )
      : undefined;
    const interruptedAt = new Date().toISOString();
    const changed = this.state.commitMutation((persisted) => {
      const changed = markLatestAgentInterrupted(
        persisted,
        paneId,
        undefined,
        interruptedAt,
      );
      return { result: changed, changed };
    });
    if (changed && latest.runId && delegation?.sessionId) {
      this.timelines.recordLifecycle({
        sessionId: delegation.sessionId,
        turnId: latest.runId,
        runId: latest.runId,
        runtime: latest.agent,
        workspaceId: latest.workspaceId,
        tabId: latest.tabId,
        paneId: latest.paneId,
        state: "interrupted",
        text: `${latest.agent} interrupted`,
        createdAt: interruptedAt,
      });
    }
    return changed;
  }

  private reconcilePersistedState(): void {
    const snapshot = this.state.snapshot();
    const needsMessageNormalization = snapshot.agentEvents.some(
      (event) => (event.message ?? "") !== cleanAgentMessage(event.message ?? ""),
    );
    const backfillRunIds = new Set(
      snapshot.agentEvents
        .map((event) => event.runId)
        .filter((runId): runId is string => Boolean(runId))
        .filter((runId) =>
          !snapshot.delegations.some(
            (delegation) => delegation.runId === runId,
          )),
    );
    const retainedDelegations = retainedDelegationCount(snapshot);
    if (
      !needsMessageNormalization
      && backfillRunIds.size === 0
      && retainedDelegations === snapshot.delegations.length
    ) {
      return;
    }

    this.state.commitMutation((persisted) => {
      for (const event of persisted.agentEvents) {
        const message = cleanAgentMessage(event.message ?? "");
        if (message) event.message = message;
        else delete event.message;
      }
      for (const event of [...persisted.agentEvents].reverse()) {
        if (!event.runId || !backfillRunIds.has(event.runId)) continue;
        recordDelegationEvent(
          persisted,
          event,
          cleanDelegationMessage(event.message ?? ""),
          event.runId,
        );
      }
      pruneDelegations(persisted);
      return { result: undefined, changed: true };
    });
  }

  private reconcilePersistedTimelines(): void {
    const snapshot = this.state.snapshot();
    const existingStates = new Set(
      this.timelines.snapshot().flatMap((timeline) =>
        timeline.entries
          .filter((entry) => entry.runId && entry.state)
          .map(
            (entry) =>
              `${timeline.id}\u0000${entry.runId}\u0000${entry.state}`,
          )),
    );
    for (const delegation of [...snapshot.delegations].reverse()) {
      const stateKey =
        `${delegation.sessionId}\u0000${delegation.runId}\u0000${delegation.state}`;
      if (existingStates.has(stateKey)) continue;
      const events = snapshot.agentEvents
        .filter((event) => event.runId === delegation.runId)
        .sort(
          (first, second) =>
            Date.parse(first.createdAt) - Date.parse(second.createdAt),
        );
      if (events.length === 0) {
        this.timelines.recordLifecycle({
          sessionId: delegation.sessionId,
          turnId: delegation.runId,
          runId: delegation.runId,
          runtime: delegation.runtime,
          workspaceId: delegation.workspaceId,
          tabId: delegation.tabId,
          paneId: delegation.paneId,
          state: delegation.state,
          text: delegation.result
            || delegation.error
            || delegation.summary
            || delegation.title,
          createdAt: delegation.updatedAt,
        });
      } else {
        for (const event of events) {
          this.timelines.recordLifecycle({
            sessionId: delegation.sessionId,
            turnId: delegation.runId,
            runId: delegation.runId,
            runtime: event.agent,
            workspaceId: event.workspaceId,
            tabId: event.tabId,
            paneId: event.paneId,
            ...(delegationStateForStatus(event.status)
              ? { state: delegationStateForStatus(event.status) ?? undefined }
              : {}),
            text: cleanDelegationMessage(event.message ?? "")
              || event.summary
              || event.title,
            createdAt: event.createdAt,
          });
        }
      }
      existingStates.add(stateKey);
    }
  }
}

const resolveTarget = (
  state: PersistedState,
  input: AgentEventPostBody,
): PaneContext => {
  if (input.paneId) {
    for (const workspace of state.workspaces) {
      for (const tab of workspace.tabs) {
        if (tab.panes.some((pane) => pane.id === input.paneId)) {
          return { workspace, tab, paneId: input.paneId };
        }
      }
    }
    throw new Error("pane not found");
  }

  const workspaceId = input.workspaceId ?? state.activeWorkspaceId;
  const workspace = state.workspaces.find(
    (candidate) => candidate.id === workspaceId,
  );
  if (!workspace) throw new Error("workspace not found");
  const tab = input.tabId
    ? workspace.tabs.find((candidate) => candidate.id === input.tabId)
    : workspace.tabs.find(
      (candidate) => candidate.id === workspace.activeTabId,
    );
  if (!tab) throw new Error("tab not found");
  const pane = tab.panes.find(
    (candidate) => candidate.id === tab.activePaneId,
  ) ?? tab.panes[0];
  if (!pane) throw new Error("pane not found");
  return { workspace, tab, paneId: pane.id };
};

const markLatestAgentInterrupted = (
  state: PersistedState,
  paneId: string,
  agent: string | undefined,
  interruptedAt: string,
  nextRunId = "",
): boolean => {
  const latest = state.agentEvents.find(
    (candidate) =>
      candidate.paneId === paneId
      && (!agent || candidate.agent === agent),
  );
  if (!latest || !ACTIVE_AGENT_STATUSES.has(latest.status)) return false;
  if (nextRunId && latest.runId === nextRunId) return false;

  latest.status = "interrupted";
  latest.summary = `${latest.agent} interrupted`;
  if (latest.runId) {
    const delegation = state.delegations.find(
      (candidate) => candidate.runId === latest.runId,
    );
    if (
      delegation
      && DELEGATION_TRANSITIONS[delegation.state].includes("interrupted")
    ) {
      delegation.state = "interrupted";
      delegation.summary = latest.summary;
      delegation.error = latest.summary;
      delegation.updatedAt = interruptedAt;
      moveDelegationToFront(state, delegation.runId);
      pruneDelegations(state);
    }
  }
  const workspace = state.workspaces.find(
    (candidate) => candidate.id === latest.workspaceId,
  );
  if (workspace && workspace.descriptorSource !== "user") {
    workspace.descriptor = latest.summary;
    workspace.descriptorSource = "auto";
    workspace.updatedAt = interruptedAt;
  }
  return true;
};

const recordDelegationEvent = (
  state: PersistedState,
  event: AgentActivity,
  message: string,
  sessionId: string,
): DelegationEventDisposition => {
  if (!event.runId) return { accepted: true, terminalTransition: false };
  const existing = state.delegations.find(
    (candidate) => candidate.runId === event.runId,
  );
  if (event.status === "observer_error") {
    const terminalExisting = Boolean(
      existing && TERMINAL_DELEGATION_STATES.has(existing.state),
    );
    const observerError = message || event.summary;
    if (existing) {
      existing.observerError = observerError;
      existing.updatedAt = event.createdAt;
      moveDelegationToFront(state, existing.runId);
    } else {
      state.delegations.unshift({
        runId: event.runId,
        sessionId,
        state: "running",
        runtime: event.agent,
        title: event.title,
        summary: event.summary,
        result: "",
        error: "",
        observerError,
        workspaceId: event.workspaceId,
        tabId: event.tabId,
        paneId: event.paneId,
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
      });
    }
    pruneDelegations(state);
    return { accepted: !terminalExisting, terminalTransition: false };
  }

  const reportedState = delegationStateForStatus(event.status);
  if (
    existing
    && reportedState
    && !DELEGATION_TRANSITIONS[existing.state].includes(reportedState)
  ) {
    pruneDelegations(state);
    return { accepted: false, terminalTransition: false };
  }
  if (existing && TERMINAL_DELEGATION_STATES.has(existing.state)) {
    pruneDelegations(state);
    return { accepted: false, terminalTransition: false };
  }
  const nextState = reportedState ?? existing?.state ?? "running";
  const successful = nextState === "completed";
  const terminal = TERMINAL_DELEGATION_STATES.has(nextState);
  const detail = message || event.summary;
  const delegation: DelegationRecord = existing ?? {
    runId: event.runId,
    sessionId,
    state: nextState,
    runtime: event.agent,
    title: event.title,
    summary: event.summary,
    result: "",
    error: "",
    workspaceId: event.workspaceId,
    tabId: event.tabId,
    paneId: event.paneId,
    createdAt: event.createdAt,
    updatedAt: event.createdAt,
  };
  delegation.state = nextState;
  delegation.sessionId = sessionId || delegation.sessionId;
  delegation.runtime = event.agent;
  delegation.title = event.title;
  delegation.summary = event.summary;
  delegation.workspaceId = event.workspaceId;
  delegation.tabId = event.tabId;
  delegation.paneId = event.paneId;
  delegation.updatedAt = event.createdAt;
  if (terminal) {
    delegation.result = successful ? detail : "";
    delegation.error = successful ? "" : detail;
  }
  if (!existing) state.delegations.unshift(delegation);
  else moveDelegationToFront(state, delegation.runId);
  pruneDelegations(state);
  return { accepted: true, terminalTransition: terminal };
};

const moveDelegationToFront = (
  state: PersistedState,
  runId: string,
): void => {
  const index = state.delegations.findIndex(
    (candidate) => candidate.runId === runId,
  );
  if (index <= 0) return;
  const [delegation] = state.delegations.splice(index, 1);
  state.delegations.unshift(delegation);
};

const retainedDelegationCount = (
  state: PersistedState,
  referenceTime = Date.now(),
): number => {
  const cutoff = referenceTime - DELEGATION_RETENTION_MS;
  return state.delegations.filter(
    (delegation) =>
      !TERMINAL_DELEGATION_STATES.has(delegation.state)
      || Date.parse(delegation.updatedAt) >= cutoff,
  ).slice(0, MAX_DELEGATIONS).length;
};

const pruneDelegations = (
  state: PersistedState,
  referenceTime = Date.now(),
): void => {
  const cutoff = referenceTime - DELEGATION_RETENTION_MS;
  state.delegations = state.delegations
    .filter(
      (delegation) =>
        !TERMINAL_DELEGATION_STATES.has(delegation.state)
        || Date.parse(delegation.updatedAt) >= cutoff,
    )
    .slice(0, MAX_DELEGATIONS);
};

const cleanTitle = (value: string, fallback: string): string => {
  const cleaned = stripMarkup(value)
    .replace(/\s+/g, " ")
    .replace(/[.!?。]+$/u, "")
    .trim();
  return (cleaned || fallback).slice(0, 50);
};

const cleanDescriptor = (value: string, fallback: string): string => {
  const cleaned = stripMarkup(value).replace(/\s+/g, " ").trim();
  return (cleaned || fallback).slice(0, 120);
};

const cleanAgentMessage = (value: string): string =>
  cleanDelegationMessage(value).slice(0, 12_000);

const cleanDelegationMessage = (value: string): string =>
  stripMarkup(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, 64_000);

const cleanTimelinePrompt = (value: string): string =>
  stripMarkup(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .trim()
    .slice(0, 128 * 1_024);

const cleanDelegationRunId = (value?: string): string => {
  const candidate = value ?? "";
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(candidate)
    ? candidate
    : "";
};

const cleanTimelineId = (value?: string): string => {
  const candidate = value ?? "";
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(candidate)
    ? candidate
    : "";
};

const delegationStateForStatus = (
  status: string,
): DelegationState | null => {
  if (status === "waiting") return "waiting";
  if (status === "completed") return "completed";
  if (
    [
      "failed",
      "error",
      "cancelled",
      "stopped",
      "timed_out",
      "interrupted",
    ].includes(status)
  ) {
    return status as DelegationState;
  }
  if (ACTIVE_AGENT_STATUSES.has(status)) return "running";
  return null;
};
