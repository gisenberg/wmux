import type { Workspace, WorkspaceReorderPosition } from "./types";

export const MAX_WORKSPACE_TREE_DEPTH = 4;

export type WorkspaceAgentStatus = "running" | "waiting" | "completed" | "failed" | "updated";

export interface WorkspaceActivityAggregate {
  unreadCount: number;
  bell: boolean;
  agentStatus?: WorkspaceAgentStatus;
}

export interface WorkspaceTreeRow {
  workspace: Workspace;
  depth: number;
  parentId?: string;
  childIds: string[];
  ancestorIds: string[];
  hasChildren: boolean;
  collapsed: boolean;
  effectiveExpanded: boolean;
  activePath: boolean;
  filterMatch: boolean;
  ownActivity: WorkspaceActivityAggregate;
  subtreeActivity: WorkspaceActivityAggregate;
  hiddenActivity: WorkspaceActivityAggregate;
}

export interface WorkspaceTreeModel {
  rows: WorkspaceTreeRow[];
  byId: Map<string, WorkspaceTreeRow>;
  childrenByParentId: Map<string | undefined, string[]>;
  movesDisabled: boolean;
}

export interface DeriveWorkspaceTreeOptions {
  workspaces: Workspace[];
  activeWorkspaceId?: string;
  hostFilter?: string;
  collapsedWorkspaceIds?: readonly string[];
  activityByWorkspaceId?: ReadonlyMap<string, WorkspaceActivityAggregate>;
}

export interface WorkspaceMoveIntent {
  workspaceId: string;
  targetWorkspaceId?: string;
  position: WorkspaceReorderPosition;
}

const emptyActivity = (): WorkspaceActivityAggregate => ({ unreadCount: 0, bell: false });
const statusPriority: Record<WorkspaceAgentStatus, number> = {
  completed: 1,
  updated: 2,
  running: 3,
  waiting: 4,
  failed: 5,
};

const mergeActivity = (
  left: WorkspaceActivityAggregate,
  right: WorkspaceActivityAggregate,
): WorkspaceActivityAggregate => ({
  unreadCount: left.unreadCount + right.unreadCount,
  bell: left.bell || right.bell,
  agentStatus: strongerStatus(left.agentStatus, right.agentStatus),
});

const strongerStatus = (
  left: WorkspaceAgentStatus | undefined,
  right: WorkspaceAgentStatus | undefined,
): WorkspaceAgentStatus | undefined => {
  if (!left) return right;
  if (!right) return left;
  return statusPriority[right] > statusPriority[left] ? right : left;
};

export const deriveWorkspaceTree = ({
  workspaces,
  activeWorkspaceId,
  hostFilter = "all",
  collapsedWorkspaceIds = [],
  activityByWorkspaceId = new Map(),
}: DeriveWorkspaceTreeOptions): WorkspaceTreeModel => {
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const childrenByParentId = new Map<string | undefined, string[]>();
  const appendChild = (parentId: string | undefined, workspaceId: string) => {
    const children = childrenByParentId.get(parentId) ?? [];
    children.push(workspaceId);
    childrenByParentId.set(parentId, children);
  };
  for (const workspace of workspaces) {
    appendChild(workspace.parentWorkspaceId && workspaceById.has(workspace.parentWorkspaceId)
      ? workspace.parentWorkspaceId
      : undefined, workspace.id);
  }

  const ancestorsById = new Map<string, string[]>();
  const depthById = new Map<string, number>();
  const visitMetadata = (workspaceId: string, ancestors: string[]) => {
    if (ancestorsById.has(workspaceId)) return;
    ancestorsById.set(workspaceId, ancestors);
    depthById.set(workspaceId, ancestors.length);
    for (const childId of childrenByParentId.get(workspaceId) ?? []) visitMetadata(childId, [...ancestors, workspaceId]);
  };
  for (const rootId of childrenByParentId.get(undefined) ?? []) visitMetadata(rootId, []);

  const activePathIds = new Set<string>();
  if (activeWorkspaceId && workspaceById.has(activeWorkspaceId)) {
    activePathIds.add(activeWorkspaceId);
    for (const ancestorId of ancestorsById.get(activeWorkspaceId) ?? []) activePathIds.add(ancestorId);
  }
  const filtering = hostFilter !== "all";
  const filterMatches = new Set<string>();
  const includedIds = new Set<string>();
  if (filtering) {
    for (const workspace of workspaces) {
      if (workspace.machineId !== hostFilter) continue;
      filterMatches.add(workspace.id);
      includedIds.add(workspace.id);
      for (const ancestorId of ancestorsById.get(workspace.id) ?? []) includedIds.add(ancestorId);
    }
    for (const workspaceId of activePathIds) includedIds.add(workspaceId);
  } else {
    for (const workspace of workspaces) includedIds.add(workspace.id);
  }

  const forcedExpandedIds = new Set<string>();
  for (const includedId of filtering ? includedIds : activePathIds) {
    for (const ancestorId of ancestorsById.get(includedId) ?? []) forcedExpandedIds.add(ancestorId);
  }
  const collapsedIds = new Set(collapsedWorkspaceIds);
  const subtreeActivityById = new Map<string, WorkspaceActivityAggregate>();
  const calculateSubtreeActivity = (workspaceId: string): WorkspaceActivityAggregate => {
    let aggregate = activityByWorkspaceId.get(workspaceId) ?? emptyActivity();
    aggregate = { ...aggregate };
    for (const childId of childrenByParentId.get(workspaceId) ?? []) {
      aggregate = mergeActivity(aggregate, calculateSubtreeActivity(childId));
    }
    subtreeActivityById.set(workspaceId, aggregate);
    return aggregate;
  };
  for (const rootId of childrenByParentId.get(undefined) ?? []) calculateSubtreeActivity(rootId);

  const rows: WorkspaceTreeRow[] = [];
  const byId = new Map<string, WorkspaceTreeRow>();
  for (const workspace of workspaces) {
    const workspaceId = workspace.id;
    const childIds = childrenByParentId.get(workspaceId) ?? [];
    const ownActivity = { ...(activityByWorkspaceId.get(workspaceId) ?? emptyActivity()) };
    const subtreeActivity = { ...(subtreeActivityById.get(workspaceId) ?? ownActivity) };
    let descendantActivity = emptyActivity();
    for (const childId of childIds) {
      descendantActivity = mergeActivity(descendantActivity, subtreeActivityById.get(childId) ?? emptyActivity());
    }
    const collapsed = childIds.length > 0 && collapsedIds.has(workspaceId);
    const effectiveExpanded = childIds.length > 0 && (!collapsed || forcedExpandedIds.has(workspaceId));
    byId.set(workspaceId, {
      workspace,
      depth: depthById.get(workspaceId) ?? 0,
      parentId: workspace.parentWorkspaceId,
      childIds,
      ancestorIds: ancestorsById.get(workspaceId) ?? [],
      hasChildren: childIds.length > 0,
      collapsed,
      effectiveExpanded,
      activePath: activePathIds.has(workspaceId),
      filterMatch: !filtering || filterMatches.has(workspaceId),
      ownActivity,
      subtreeActivity,
      hiddenActivity: collapsed && !effectiveExpanded ? descendantActivity : emptyActivity(),
    });
  }
  const visitRows = (workspaceId: string) => {
    const row = byId.get(workspaceId);
    if (!row || !includedIds.has(workspaceId)) return;
    rows.push(row);
    if (row.effectiveExpanded || filtering) {
      for (const childId of row.childIds) visitRows(childId);
    }
  };
  for (const rootId of childrenByParentId.get(undefined) ?? []) visitRows(rootId);
  return { rows, byId, childrenByParentId, movesDisabled: filtering };
};

export const workspaceAncestorIds = (workspaces: readonly Workspace[], workspaceId: string): string[] => {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const ancestors: string[] = [];
  const seen = new Set<string>();
  let parentId = byId.get(workspaceId)?.parentWorkspaceId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    ancestors.unshift(parentId);
    parentId = byId.get(parentId)?.parentWorkspaceId;
  }
  return ancestors;
};

export const expandWorkspaceAncestors = (
  workspaces: readonly Workspace[],
  collapsedWorkspaceIds: readonly string[],
  workspaceId: string,
): string[] => {
  const ancestors = new Set(workspaceAncestorIds(workspaces, workspaceId));
  return collapsedWorkspaceIds.filter((id) => !ancestors.has(id));
};

export const pruneCollapsedWorkspaceIds = (
  workspaces: readonly Workspace[],
  collapsedWorkspaceIds: readonly string[],
): string[] => {
  const validIds = new Set(workspaces.filter((workspace) => workspaces.some((candidate) => candidate.parentWorkspaceId === workspace.id)).map((workspace) => workspace.id));
  return collapsedWorkspaceIds.filter((id, index) => validIds.has(id) && collapsedWorkspaceIds.indexOf(id) === index);
};

export const workspaceMoveIntents = (
  workspaces: readonly Workspace[],
  workspaceId: string,
): WorkspaceMoveIntent[] => {
  const model = deriveWorkspaceTree({ workspaces: [...workspaces] });
  const source = model.byId.get(workspaceId);
  if (!source) return [];
  const sourceDescendants = new Set<string>();
  const collect = (id: string) => {
    for (const childId of model.childrenByParentId.get(id) ?? []) {
      sourceDescendants.add(childId);
      collect(childId);
    }
  };
  collect(workspaceId);
  const sourceHeight = Math.max(0, ...[...sourceDescendants].map((id) => (model.byId.get(id)?.depth ?? source.depth) - source.depth));
  const intents: WorkspaceMoveIntent[] = [];
  for (const target of model.byId.values()) {
    if (target.workspace.id === workspaceId || sourceDescendants.has(target.workspace.id)) continue;
    if (target.depth + sourceHeight < MAX_WORKSPACE_TREE_DEPTH) {
      intents.push({ workspaceId, targetWorkspaceId: target.workspace.id, position: "before" });
      intents.push({ workspaceId, targetWorkspaceId: target.workspace.id, position: "after" });
    }
    if (target.depth + 1 + sourceHeight < MAX_WORKSPACE_TREE_DEPTH) {
      intents.push({ workspaceId, targetWorkspaceId: target.workspace.id, position: "into" });
    }
  }
  if (source.parentId) intents.push({ workspaceId, position: "out-of" });
  return intents;
};

export const workspacePointerMovePosition = (relativeY: number): Exclude<WorkspaceReorderPosition, "out-of"> => {
  if (relativeY < 0.3) return "before";
  if (relativeY > 0.7) return "after";
  return "into";
};

export const sameWorkspaceIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);

export const remainingWorkspaceRowCount = (total: number, scrollOffset: number, visibleCount: number): number =>
  Math.max(0, total - scrollOffset - visibleCount);
