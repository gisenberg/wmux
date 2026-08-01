import type { BootstrapPayload, Workspace } from "./types";

/**
 * Builds the browser-local view used while destructive workspace closes are
 * still undoable. The authoritative store remains untouched so an undo can
 * reveal the original workspace and every later server update immediately.
 */
export const hidePendingWorkspaceCloses = (
  state: BootstrapPayload | null,
  pendingWorkspaceIds: ReadonlySet<string>,
): BootstrapPayload | null => {
  if (!state || pendingWorkspaceIds.size === 0) return state;
  const hiddenIds = new Set(
    state.workspaces
      .map((workspace) => workspace.id)
      .filter((workspaceId) => pendingWorkspaceIds.has(workspaceId)),
  );
  if (hiddenIds.size === 0) return state;

  const workspacesById = new Map(state.workspaces.map((workspace) => [workspace.id, workspace]));
  const workspaces = state.workspaces
    .filter((workspace) => !hiddenIds.has(workspace.id))
    .map((workspace) => promotePastHiddenAncestors(workspace, hiddenIds, workspacesById));
  const activeWorkspaceId = hiddenIds.has(state.activeWorkspaceId)
    ? fallbackWorkspaceId(state.workspaces, workspaces, state.activeWorkspaceId)
    : state.activeWorkspaceId;

  return {
    ...state,
    workspaces,
    activeWorkspaceId,
  };
};

const promotePastHiddenAncestors = (
  workspace: Workspace,
  hiddenIds: ReadonlySet<string>,
  workspacesById: ReadonlyMap<string, Workspace>,
): Workspace => {
  let parentWorkspaceId = workspace.parentWorkspaceId;
  while (parentWorkspaceId && hiddenIds.has(parentWorkspaceId)) {
    parentWorkspaceId = workspacesById.get(parentWorkspaceId)?.parentWorkspaceId;
  }
  if (parentWorkspaceId === workspace.parentWorkspaceId) return workspace;
  if (parentWorkspaceId) return { ...workspace, parentWorkspaceId };
  const promoted = { ...workspace };
  delete promoted.parentWorkspaceId;
  return promoted;
};

const fallbackWorkspaceId = (
  authoritativeWorkspaces: readonly Workspace[],
  visibleWorkspaces: readonly Workspace[],
  hiddenActiveWorkspaceId: string,
): string => {
  if (visibleWorkspaces.length === 0) return "";
  const visibleIds = new Set(visibleWorkspaces.map((workspace) => workspace.id));
  const hiddenIndex = authoritativeWorkspaces.findIndex(
    (workspace) => workspace.id === hiddenActiveWorkspaceId,
  );
  for (let index = Math.max(0, hiddenIndex); index < authoritativeWorkspaces.length; index += 1) {
    const candidate = authoritativeWorkspaces[index];
    if (candidate && visibleIds.has(candidate.id)) return candidate.id;
  }
  for (let index = hiddenIndex - 1; index >= 0; index -= 1) {
    const candidate = authoritativeWorkspaces[index];
    if (candidate && visibleIds.has(candidate.id)) return candidate.id;
  }
  return visibleWorkspaces[0]?.id ?? "";
};
