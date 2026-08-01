import assert from "node:assert/strict";
import test from "node:test";
import type { BootstrapPayload, Workspace } from "../src/shared/protocol.ts";
import { hidePendingWorkspaceCloses } from "../src/client/src/workspace-close.ts";

const workspace = (id: string, parentWorkspaceId?: string): Workspace => ({
  id,
  name: id,
  machineId: "local",
  ...(parentWorkspaceId ? { parentWorkspaceId } : {}),
  activeTabId: `tab-${id}`,
  tabs: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const payload = (workspaces: Workspace[], activeWorkspaceId: string): BootstrapPayload => ({
  workspaces,
  activeWorkspaceId,
  settings: {
    collapsedWorkspaceIds: ["root"],
    favoriteWorkspaceIds: ["root"],
  },
} as BootstrapPayload);

test("pending close hides the workspace without mutating authoritative state or settings", () => {
  const authoritative = payload([
    workspace("before"),
    workspace("root"),
    workspace("child", "root"),
    workspace("after"),
  ], "root");

  const visible = hidePendingWorkspaceCloses(authoritative, new Set(["root"]));
  assert.deepEqual(visible?.workspaces.map((candidate) => candidate.id), ["before", "child", "after"]);
  assert.equal(visible?.workspaces[1]?.parentWorkspaceId, undefined);
  assert.equal(visible?.activeWorkspaceId, "child");
  assert.deepEqual(visible?.settings.collapsedWorkspaceIds, ["root"]);
  assert.deepEqual(visible?.settings.favoriteWorkspaceIds, ["root"]);
  assert.equal(authoritative.workspaces[2]?.parentWorkspaceId, "root");
});

test("pending closes choose the nearest visible fallback and support overlapping ancestors", () => {
  const authoritative = payload([
    workspace("before"),
    workspace("root"),
    workspace("child", "root"),
    workspace("grandchild", "child"),
    workspace("after"),
  ], "root");

  const visible = hidePendingWorkspaceCloses(
    authoritative,
    new Set(["root", "child"]),
  );
  assert.deepEqual(visible?.workspaces.map((candidate) => candidate.id), [
    "before",
    "grandchild",
    "after",
  ]);
  assert.equal(visible?.workspaces[1]?.parentWorkspaceId, undefined);
  assert.equal(visible?.activeWorkspaceId, "grandchild");
});
