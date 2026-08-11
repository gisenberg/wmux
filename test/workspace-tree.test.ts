import assert from "node:assert/strict";
import test from "node:test";
import type { Workspace } from "../src/shared/protocol.ts";
import {
  deriveWorkspaceTree,
  expandWorkspaceAncestors,
  orderWorkspaceRowsForDisplay,
  pruneCollapsedWorkspaceIds,
  pruneFavoriteWorkspaceIds,
  rebaseCollapsedWorkspaceIds,
  rebaseFavoriteWorkspaceIds,
  remainingWorkspaceRowCount,
  sortFavoriteWorkspaceRows,
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

test("heartbeat activity surfaces above ordinary running work but below attention", () => {
  const heartbeat = deriveWorkspaceTree({
    workspaces,
    activityByWorkspaceId: new Map([
      ["root", { unreadCount: 0, bell: false, agentStatus: "running" as const }],
      ["child", { unreadCount: 0, bell: false, agentStatus: "heartbeat" as const }],
      ["grandchild", { unreadCount: 0, bell: false, agentStatus: "running" as const }],
    ]),
  });
  assert.equal(heartbeat.byId.get("root")?.subtreeActivity.agentStatus, "heartbeat");

  const attention = deriveWorkspaceTree({
    workspaces,
    activityByWorkspaceId: new Map([
      ["child", { unreadCount: 0, bell: false, agentStatus: "heartbeat" as const }],
      ["grandchild", { unreadCount: 0, bell: false, agentStatus: "waiting" as const }],
    ]),
  });
  assert.equal(attention.byId.get("root")?.subtreeActivity.agentStatus, "waiting");
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

test("pending collapse intent rebases stale incoming settings", () => {
  const state = { revision: 4, settings: { collapsedWorkspaceIds: ["old"] } };
  const rebased = rebaseCollapsedWorkspaceIds(state, ["root", "child"]);
  assert.deepEqual(rebased.settings.collapsedWorkspaceIds, ["root", "child"]);
  assert.notEqual(rebased, state);
  assert.equal(rebaseCollapsedWorkspaceIds(rebased, null), rebased);
  assert.equal(rebaseCollapsedWorkspaceIds(rebased, ["root", "child"]), rebased);
});

test("favorite rows sort sibling subtrees without separating children from parents", () => {
  const rows = [
    { id: "root-a", favorite: false },
    { id: "child-a", parentId: "root-a", favorite: false },
    { id: "child-b", parentId: "root-a", favorite: true },
    { id: "grandchild", parentId: "child-b", favorite: false },
    { id: "root-b", favorite: true },
  ];
  assert.deepEqual(
    sortFavoriteWorkspaceRows(rows).map((row) => row.id),
    ["root-b", "root-a", "child-b", "grandchild", "child-a"],
  );
});

test("display order groups by machine in machine-list order with favorites first", () => {
  const rows = [
    { id: "b-plain", machineId: "b", favorite: false },
    { id: "a-plain", machineId: "a", favorite: false },
    { id: "orphan", machineId: "gone", favorite: false },
    { id: "a-favorite", machineId: "a", favorite: true },
    { id: "b-child", machineId: "b", parentId: "b-plain", favorite: false },
  ];
  assert.deepEqual(
    orderWorkspaceRowsForDisplay(rows, ["a", "b", "empty"]).map((row) => row.id),
    ["a-favorite", "a-plain", "b-plain", "b-child", "orphan"],
  );
  assert.deepEqual(
    orderWorkspaceRowsForDisplay(rows, ["a", "b", "empty"], false).map((row) => row.id),
    ["a-favorite", "b-plain", "b-child", "a-plain", "orphan"],
  );
  assert.deepEqual(orderWorkspaceRowsForDisplay([], ["a"]), []);
});

test("favorite workspace ids prune and rebase independently from collapse state", () => {
  assert.deepEqual(
    pruneFavoriteWorkspaceIds(workspaces, ["grandchild", "missing", "grandchild", "root"]),
    ["grandchild", "root"],
  );
  const state = {
    revision: 5,
    settings: {
      collapsedWorkspaceIds: ["root"],
      favoriteWorkspaceIds: ["old"],
    },
  };
  const rebased = rebaseFavoriteWorkspaceIds(state, ["child"]);
  assert.deepEqual(rebased.settings, {
    collapsedWorkspaceIds: ["root"],
    favoriteWorkspaceIds: ["child"],
  });
  assert.equal(rebased.revision, 5);
  const legacyState = { revision: 4, settings: { collapsedWorkspaceIds: ["root"] } };
  assert.deepEqual(
    rebaseFavoriteWorkspaceIds(legacyState, ["child"]).settings.favoriteWorkspaceIds,
    ["child"],
  );
});
