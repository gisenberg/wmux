import assert from "node:assert/strict";
import test from "node:test";
import type { Workspace } from "../src/shared/protocol.ts";
import {
  deriveWorkspaceTree,
  expandWorkspaceAncestors,
  pruneCollapsedWorkspaceIds,
  remainingWorkspaceRowCount,
  workspaceMoveIntents,
  workspacePointerMovePosition,
} from "../src/client/src/workspace-tree.ts";

const workspace = (id: string, machineId: string, parentWorkspaceId?: string): Workspace => ({
  id,
  name: id,
  machineId,
  ...(parentWorkspaceId ? { parentWorkspaceId } : {}),
  activeTabId: "tab",
  tabs: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const workspaces = [
  workspace("root", "a"),
  workspace("child", "b", "root"),
  workspace("grandchild", "b", "child"),
  workspace("sibling", "a"),
];

test("tree derivation preserves preorder, depth, collapse, and hidden activity", () => {
  const activity = new Map([
    ["root", { unreadCount: 1, bell: true, agentStatus: "completed" as const }],
    ["child", { unreadCount: 2, bell: true, agentStatus: "running" as const }],
    ["grandchild", { unreadCount: 3, bell: false, agentStatus: "failed" as const }],
  ]);
  const model = deriveWorkspaceTree({ workspaces, collapsedWorkspaceIds: ["root"], activityByWorkspaceId: activity });
  assert.deepEqual(model.rows.map((row) => [row.workspace.id, row.depth]), [["root", 0], ["sibling", 0]]);
  const root = model.byId.get("root");
  assert.deepEqual(root?.ownActivity, activity.get("root"));
  assert.deepEqual(root?.subtreeActivity, { unreadCount: 6, bell: true, agentStatus: "failed" });
  assert.deepEqual(root?.hiddenActivity, { unreadCount: 5, bell: true, agentStatus: "failed" });
});

test("host filtering includes matches, ancestors, and the active path while forcing context open", () => {
  const model = deriveWorkspaceTree({
    workspaces,
    activeWorkspaceId: "sibling",
    hostFilter: "b",
    collapsedWorkspaceIds: ["root", "child"],
  });
  assert.equal(model.movesDisabled, true);
  assert.deepEqual(model.rows.map((row) => row.workspace.id), ["root", "child", "grandchild", "sibling"]);
  assert.equal(model.byId.get("root")?.filterMatch, false);
  assert.equal(model.byId.get("root")?.effectiveExpanded, true);
  assert.equal(model.byId.get("sibling")?.activePath, true);
});

test("active descendants are effectively expanded and expansion is persisted globally", () => {
  const model = deriveWorkspaceTree({ workspaces, activeWorkspaceId: "grandchild", collapsedWorkspaceIds: ["root", "child"] });
  assert.deepEqual(model.rows.map((row) => row.workspace.id), ["root", "child", "grandchild", "sibling"]);
  assert.deepEqual(expandWorkspaceAncestors(workspaces, ["root", "child", "sibling"], "grandchild"), ["sibling"]);
  assert.deepEqual(pruneCollapsedWorkspaceIds(workspaces, ["root", "child", "missing", "sibling", "root"]), ["root", "child"]);
});

test("move intents exclude cycles, enforce four levels, and expose outdent", () => {
  const intents = workspaceMoveIntents(workspaces, "child");
  assert.equal(intents.some((intent) => intent.targetWorkspaceId === "grandchild"), false);
  assert.equal(intents.some((intent) => intent.position === "out-of"), true);
  const deep = [...workspaces, workspace("level3", "b", "grandchild")];
  assert.equal(workspaceMoveIntents(deep, "sibling").some((intent) => intent.position === "into" && intent.targetWorkspaceId === "level3"), false);
  assert.equal(workspacePointerMovePosition(0.1), "before");
  assert.equal(workspacePointerMovePosition(0.5), "into");
  assert.equal(workspacePointerMovePosition(0.9), "after");
});

test("canvas remaining-row count excludes rows above its scroll offset", () => {
  assert.equal(remainingWorkspaceRowCount(10, 4, 3), 3);
  assert.equal(remainingWorkspaceRowCount(3, 2, 2), 0);
});
