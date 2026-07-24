import { z } from "zod";
import { machineSchema } from "./config.js";
import type { DelegationRecord, LayoutNode, PersistedState } from "./types.js";

export const CURRENT_STATE_SCHEMA_VERSION = 4;

export class UnsupportedStateVersionError extends Error {
  constructor(readonly version: number) {
    super(`state schema ${version} is newer than this wmux build supports (${CURRENT_STATE_SCHEMA_VERSION})`);
    this.name = "UnsupportedStateVersionError";
  }
}

const titleSourceSchema = z.enum(["default", "auto", "user"]);
const idSchema = z.string().min(1).max(120);
const delegationRunIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const timestampSchema = z.string().min(1).max(80);

const paneSchema = z.object({
  id: idSchema,
  machineId: idSchema,
  agentPort: z.number().int().min(1).max(65535).optional(),
  title: z.string().max(500),
  cwd: z.string().max(8192).optional(),
  status: z.enum(["idle", "running", "exited"]),
  exitCode: z.number().int().nullable().optional(),
  createdAt: timestampSchema,
}).strict();

const layoutSchema: z.ZodType<LayoutNode> = z.lazy(() => z.discriminatedUnion("type", [
  z.object({ type: z.literal("pane"), paneId: idSchema }).strict(),
  z.object({
    type: z.literal("split"),
    direction: z.enum(["horizontal", "vertical"]),
    first: layoutSchema,
    second: layoutSchema,
    ratio: z.number().finite().min(0.15).max(0.85),
  }).strict(),
]));

const tabSchema = z.object({
  id: idSchema,
  title: z.string().max(500),
  titleSource: titleSourceSchema.optional(),
  activePaneId: idSchema,
  layout: layoutSchema,
  panes: z.array(paneSchema).min(1),
  createdAt: timestampSchema,
}).strict();

const workspaceSchema = z.object({
  id: idSchema,
  name: z.string().max(500),
  createdBy: z.enum(["user", "agent"]).optional(),
  parentWorkspaceId: idSchema.optional(),
  nameSource: titleSourceSchema.optional(),
  descriptor: z.string().max(2000).optional(),
  descriptorSource: titleSourceSchema.optional(),
  machineId: idSchema,
  activeTabId: idSchema,
  tabs: z.array(tabSchema).min(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

const notificationSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  tabId: idSchema,
  paneId: idSchema,
  title: z.string().max(500),
  subtitle: z.string().max(500),
  body: z.string().max(2000),
  createdAt: timestampSchema,
  read: z.boolean(),
}).strict();

const agentEventSchema = z.object({
  id: idSchema,
  runId: delegationRunIdSchema.optional(),
  workspaceId: idSchema,
  tabId: idSchema,
  paneId: idSchema,
  agent: z.string().max(500),
  status: z.string().max(500),
  title: z.string().max(500),
  summary: z.string().max(2000),
  message: z.string().max(12_000).optional(),
  createdAt: timestampSchema,
}).strict();

const delegationStateSchema = z.enum([
  "running",
  "waiting",
  "completed",
  "failed",
  "error",
  "cancelled",
  "stopped",
  "timed_out",
  "interrupted",
]);

const delegationSchema: z.ZodType<DelegationRecord> = z.object({
  runId: delegationRunIdSchema,
  sessionId: delegationRunIdSchema,
  state: delegationStateSchema,
  runtime: z.string().max(500),
  title: z.string().max(500),
  summary: z.string().max(2000),
  result: z.string().max(64_000),
  error: z.string().max(64_000),
  observerError: z.string().max(64_000).optional(),
  workspaceId: idSchema,
  tabId: idSchema,
  paneId: idSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

const runSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  tabId: idSchema,
  paneId: idSchema,
  command: z.string().max(500),
  status: z.enum(["started", "completed", "failed"]),
  exitCode: z.number().int().nullable().optional(),
  startedAt: timestampSchema,
  completedAt: timestampSchema.optional(),
}).strict();

const persistedStateSchema = z.object({
  schemaVersion: z.literal(CURRENT_STATE_SCHEMA_VERSION),
  revision: z.number().int().nonnegative().default(0),
  workspaceTreeRevision: z.number().int().nonnegative().default(0),
  machines: z.array(machineSchema).default([]),
  workspaces: z.array(workspaceSchema),
  activeWorkspaceId: z.string().max(120),
  notifications: z.array(notificationSchema).default([]),
  agentEvents: z.array(agentEventSchema).default([]),
  delegations: z.array(delegationSchema).default([]),
  runs: z.array(runSchema).default([]),
}).strict().superRefine((state, context) => {
  const workspaceIds = new Set<string>();
  const tabIdsGlobal = new Set<string>();
  const paneIdsGlobal = new Set<string>();
  for (const [workspaceIndex, workspace] of state.workspaces.entries()) {
    if (workspaceIds.has(workspace.id)) {
      context.addIssue({ code: "custom", path: ["workspaces", workspaceIndex, "id"], message: "duplicate workspace id" });
    }
    workspaceIds.add(workspace.id);
    if (workspace.parentWorkspaceId === workspace.id) context.addIssue({ code: "custom", path: ["workspaces", workspaceIndex, "parentWorkspaceId"], message: "workspace cannot parent itself" });
    const tabIds = new Set<string>();
    for (const [tabIndex, tab] of workspace.tabs.entries()) {
      if (tabIds.has(tab.id)) {
        context.addIssue({ code: "custom", path: ["workspaces", workspaceIndex, "tabs", tabIndex, "id"], message: "duplicate tab id" });
      }
      tabIds.add(tab.id);
      if (tabIdsGlobal.has(tab.id)) context.addIssue({ code: "custom", path: ["workspaces", workspaceIndex, "tabs", tabIndex, "id"], message: "duplicate global tab id" });
      tabIdsGlobal.add(tab.id);
      const paneIds = new Set(tab.panes.map((pane) => pane.id));
      if (paneIds.size !== tab.panes.length) {
        context.addIssue({ code: "custom", path: ["workspaces", workspaceIndex, "tabs", tabIndex, "panes"], message: "duplicate pane id" });
      }
      for (const pane of tab.panes) { if (paneIdsGlobal.has(pane.id)) context.addIssue({ code: "custom", path: ["workspaces", workspaceIndex, "tabs", tabIndex, "panes"], message: "duplicate global pane id" }); paneIdsGlobal.add(pane.id); }
      if (!paneIds.has(tab.activePaneId)) {
        context.addIssue({ code: "custom", path: ["workspaces", workspaceIndex, "tabs", tabIndex, "activePaneId"], message: "active pane is missing" });
      }
      const layoutPaneIds = collectLayoutPaneIds(tab.layout);
      if (layoutPaneIds.length !== paneIds.size || layoutPaneIds.some((paneId) => !paneIds.has(paneId))) {
        context.addIssue({ code: "custom", path: ["workspaces", workspaceIndex, "tabs", tabIndex, "layout"], message: "layout does not match tab panes" });
      }
    }
    if (!tabIds.has(workspace.activeTabId)) {
      context.addIssue({ code: "custom", path: ["workspaces", workspaceIndex, "activeTabId"], message: "active tab is missing" });
    }
  }
  const stack: string[] = [];
  for (const [index, workspace] of state.workspaces.entries()) {
    while (stack.length && stack.at(-1) !== workspace.parentWorkspaceId) stack.pop();
    if (workspace.parentWorkspaceId && !workspaceIds.has(workspace.parentWorkspaceId)) context.addIssue({ code: "custom", path: ["workspaces", index, "parentWorkspaceId"], message: "workspace parent is missing or subtree is not contiguous" });
    if (workspace.parentWorkspaceId && stack.at(-1) !== workspace.parentWorkspaceId) context.addIssue({ code: "custom", path: ["workspaces", index, "parentWorkspaceId"], message: "workspace subtree is not contiguous" });
    if (stack.length >= 4) context.addIssue({ code: "custom", path: ["workspaces", index, "parentWorkspaceId"], message: "workspace tree exceeds maximum depth" });
    stack.push(workspace.id);
  }
  if (state.workspaces.length > 0 && !workspaceIds.has(state.activeWorkspaceId)) {
    context.addIssue({ code: "custom", path: ["activeWorkspaceId"], message: "active workspace is missing" });
  }
  if (state.workspaces.length === 0 && state.activeWorkspaceId) {
    context.addIssue({ code: "custom", path: ["activeWorkspaceId"], message: "active workspace must be empty" });
  }
  const delegationRunIds = new Set<string>();
  for (const [delegationIndex, delegation] of state.delegations.entries()) {
    if (delegationRunIds.has(delegation.runId)) {
      context.addIssue({
        code: "custom",
        path: ["delegations", delegationIndex, "runId"],
        message: "duplicate delegation run id",
      });
    }
    delegationRunIds.add(delegation.runId);
  }
});

export interface ParsedPersistedState {
  state: PersistedState;
  migrated: boolean;
}

const migratePreV2State = (record: Record<string, unknown>): Record<string, unknown> => ({
  ...record,
  schemaVersion: 2,
  workspaces: Array.isArray(record.workspaces)
    ? record.workspaces.map((workspace) => {
      if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return workspace;
      const workspaceRecord = workspace as Record<string, unknown>;
      return {
        ...workspaceRecord,
        tabs: Array.isArray(workspaceRecord.tabs)
          ? workspaceRecord.tabs.map((tab) => {
            if (!tab || typeof tab !== "object" || Array.isArray(tab)) return tab;
            const tabRecord = tab as Record<string, unknown>;
            return {
              ...tabRecord,
              panes: Array.isArray(tabRecord.panes)
                ? tabRecord.panes.map((pane) => {
                  if (!pane || typeof pane !== "object" || Array.isArray(pane)) return pane;
                  const paneRecord = pane as Record<string, unknown>;
                  if (paneRecord.kind !== "terminal") return pane;
                  const { kind: _legacyKind, ...migratedPane } = paneRecord;
                  return migratedPane;
                })
                : tabRecord.panes,
            };
          })
          : workspaceRecord.tabs,
      };
    })
    : record.workspaces,
});

/** v2 workspaces were a newest-first root array; preserve that exact order as the v3 forest. */
export const migrateV2ToV3State = (record: Record<string, unknown>): Record<string, unknown> => ({
  ...record,
  schemaVersion: 3,
  workspaceTreeRevision: 0,
  workspaces: Array.isArray(record.workspaces)
    ? record.workspaces.map((workspace) => {
      if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return workspace;
      const { parentWorkspaceId: _parentWorkspaceId, ...root } = workspace as Record<string, unknown>;
      return root;
    })
    : record.workspaces,
});

/** v3 delegation runs each become the first turn in a durable agent session. */
export const migrateV3ToV4State = (record: Record<string, unknown>): Record<string, unknown> => ({
  ...record,
  schemaVersion: 4,
  delegations: Array.isArray(record.delegations)
    ? record.delegations.map((delegation) => {
      if (!delegation || typeof delegation !== "object" || Array.isArray(delegation)) {
        return delegation;
      }
      const delegationRecord = delegation as Record<string, unknown>;
      return {
        ...delegationRecord,
        sessionId: delegationRecord.sessionId ?? delegationRecord.runId,
      };
    })
    : record.delegations,
});

export const parsePersistedState = (input: unknown): ParsedPersistedState => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("state must be a JSON object");
  }
  const record = input as Record<string, unknown>;
  const rawVersion = record.schemaVersion;
  if (typeof rawVersion === "number" && Number.isInteger(rawVersion) && rawVersion > CURRENT_STATE_SCHEMA_VERSION) {
    throw new UnsupportedStateVersionError(rawVersion);
  }
  if (rawVersion !== undefined && rawVersion !== 0 && rawVersion !== 1 && rawVersion !== 2 && rawVersion !== 3 && rawVersion !== CURRENT_STATE_SCHEMA_VERSION) {
    throw new Error("state schemaVersion must be a supported integer");
  }
  const migrated = rawVersion !== CURRENT_STATE_SCHEMA_VERSION;
  const v2Candidate = rawVersion === 2 ? record : migratePreV2State(record);
  const v3Candidate = rawVersion === 3
    ? record
    : rawVersion === CURRENT_STATE_SCHEMA_VERSION
      ? record
      : migrateV2ToV3State(v2Candidate);
  const candidate = rawVersion === CURRENT_STATE_SCHEMA_VERSION
    ? record
    : migrateV3ToV4State(v3Candidate);
  return { state: persistedStateSchema.parse(candidate), migrated };
};

const collectLayoutPaneIds = (node: LayoutNode): string[] =>
  node.type === "pane"
    ? [node.paneId]
    : [...collectLayoutPaneIds(node.first), ...collectLayoutPaneIds(node.second)];
