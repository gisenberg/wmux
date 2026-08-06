import assert from "node:assert/strict";
import test from "node:test";
import { groupSidebarWorkspaceRows } from "../src/client/src/workspace-tree.js";

interface OpenTuiSidebarWorkspace {
  id: string;
  tabId: string;
  title: string;
  descriptor: string;
  machineId: string;
  host: string;
  reachable: boolean;
  active: boolean;
  unreadCount: number;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  hiddenUnreadCount: number;
  hiddenBell: boolean;
  canOutdent: boolean;
  parentId?: string;
  favorite: boolean;
}

const workspace = (id: string, machineId: string, depth: number, parentId?: string): OpenTuiSidebarWorkspace => ({
  id,
  tabId: `${id}-tab`,
  title: id,
  descriptor: "",
  machineId,
  host: machineId,
  reachable: true,
  active: id === "parent",
  unreadCount: 0,
  depth,
  hasChildren: id === "parent",
  expanded: true,
  hiddenUnreadCount: 0,
  hiddenBell: false,
  canOutdent: Boolean(parentId),
  parentId,
  favorite: false,
});

const machines = [
  { id: "a", name: "A", reachable: true, detail: "", workspaceCount: 2, activeAgentCount: 0 },
  { id: "b", name: "B", reachable: true, detail: "", workspaceCount: 1, activeAgentCount: 0 },
];
const rows = [workspace("parent", "a", 0), workspace("child-a", "a", 1, "parent"), workspace("child-b", "b", 1, "parent")];

test("sidebar host grouping partitions presentation hosts without duplicating cross-host children", () => {
  const groups = groupSidebarWorkspaceRows(rows, machines.map((machine) => machine.id), true);
  assert.deepEqual(groups.map((group) => [group.machineId, group.rows.map((row) => row.id)]), [
    ["a", ["parent", "child-a"]],
    ["b", ["child-b"]],
  ]);
});

test("global sidebar grouping preserves the workspace preorder and tree depths", () => {
  const groups = groupSidebarWorkspaceRows(rows, machines.map((machine) => machine.id), false);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].machineId, undefined);
  assert.deepEqual(groups[0].rows.map((row) => [row.id, row.depth, row.parentId]), [
    ["parent", 0, undefined],
    ["child-a", 1, "parent"],
    ["child-b", 1, "parent"],
  ]);
});
