import {
  WorkspaceDepthError,
  type SplitCreationIds,
  type TabCreationIds,
  type WorkspaceCreationIds,
} from "../state.js";
import type { WorkspaceReorderPosition } from "../types.js";
import {
  HttpError,
  type ApiRoute,
  policyForRoute,
} from "./route.js";

const clientIdPattern = (prefix: string): RegExp =>
  new RegExp(`^${prefix}_[0-9a-f]{16,64}$`);

const parseClientCreationIds = (
  value: unknown,
  fields: Record<string, string>,
): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_client_ids");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = Object.keys(fields);
  if (Object.keys(record).length !== expectedKeys.length) {
    throw new HttpError(400, "invalid_client_ids");
  }
  const result: Record<string, string> = {};
  for (const key of expectedKeys) {
    const id = record[key];
    if (typeof id !== "string" || !clientIdPattern(fields[key]).test(id)) {
      throw new HttpError(400, "invalid_client_ids");
    }
    result[key] = id;
  }
  return result;
};

export const workspaceRoutes: readonly ApiRoute[] = [
  {
    id: "workspace-create",
    method: "POST",
    pattern: "/api/workspaces",
    policy: policyForRoute("workspace-create"),
    handler: async ({ deps, machines, readJsonBody, sendJson }) => {
      const body = (await readJsonBody()) as {
        machineId?: string;
        sourcePaneId?: string;
        parentPaneId?: string;
        createdBy?: "user" | "agent";
        parentWorkspaceId?: unknown;
        clientIds?: unknown;
      };
      if (body.parentWorkspaceId !== undefined) {
        sendJson(400, { error: "parent_workspace_id_not_accepted" });
        return;
      }
      if (body.parentPaneId !== undefined && body.createdBy !== "agent") {
        sendJson(400, { error: "parent_pane_requires_agent" });
        return;
      }
      const parentPane = body.parentPaneId
        ? deps.state.findPane(body.parentPaneId) ?? undefined
        : undefined;
      if (body.parentPaneId && (!parentPane || parentPane.status === "exited")) {
        sendJson(422, { error: "parent_pane_unavailable" });
        return;
      }
      const machineId = deps.resolveMachineId(machines, body.machineId);
      const clientIds = parseClientCreationIds(body.clientIds, {
        workspaceId: "ws",
        tabId: "tab",
        paneId: "pane",
      }) as WorkspaceCreationIds | undefined;
      const sourcePane = body.sourcePaneId
        ? deps.state.findPane(body.sourcePaneId) ?? undefined
        : undefined;
      const cwdPane = sourcePane ?? parentPane;
      let workspace;
      try {
        workspace = deps.state.createWorkspace(
          machineId,
          await deps.cwdForSourcePane(machines, cwdPane, machineId),
          body.createdBy === "agent" ? "agent" : "user",
          parentPane
            ? deps.state.findPaneContext(parentPane.id)?.workspace.id
            : undefined,
          clientIds,
        );
      } catch (error) {
        if (error instanceof WorkspaceDepthError) {
          sendJson(422, { error: error.code });
          return;
        }
        throw error;
      }
      sendJson(201, { workspace, state: deps.currentPayload() });
    },
  },
  {
    id: "workspace-reorder",
    method: "POST",
    pattern: "/api/workspaces/reorder",
    policy: policyForRoute("workspace-reorder"),
    handler: async ({ deps, readJsonBody, sendJson }) => {
      const body = (await readJsonBody()) as {
        workspaceId?: unknown;
        targetWorkspaceId?: unknown;
        position?: unknown;
        workspaceTreeRevision?: unknown;
      };
      if (
        typeof body.workspaceId !== "string"
        || (body.position !== "out-of" && typeof body.targetWorkspaceId !== "string")
        || (
          body.position === "out-of"
          && body.targetWorkspaceId !== undefined
          && typeof body.targetWorkspaceId !== "string"
        )
        || (
          body.position !== "before"
          && body.position !== "after"
          && body.position !== "into"
          && body.position !== "out-of"
        )
        || !Number.isInteger(body.workspaceTreeRevision)
      ) {
        sendJson(400, { error: "invalid_workspace_reorder" });
        return;
      }
      const reordered = deps.state.reorderWorkspaceResult(
        body.workspaceId,
        typeof body.targetWorkspaceId === "string"
          ? body.targetWorkspaceId
          : undefined,
        body.position as WorkspaceReorderPosition,
        body.workspaceTreeRevision as number,
      );
      if (!reordered.ok) {
        const status = reordered.status === "conflict"
          ? 409
          : reordered.status === "not_found"
            ? 404
            : 422;
        sendJson(status, {
          error: `workspace_${reordered.status}`,
          state: deps.currentPayload(),
        });
        return;
      }
      sendJson(200, { state: deps.currentPayload() });
    },
  },
  {
    id: "workspace-notifications-read",
    method: "POST",
    pattern: /^\/api\/workspaces\/([^/]+)\/notifications\/read$/,
    policy: policyForRoute("workspace-notifications-read"),
    handler: async ({ deps, match, sendJson }) => {
      if (!match) throw new Error("workspace notifications route matched without captures");
      deps.state.markWorkspaceNotificationsRead(match[1]);
      sendJson(200, deps.currentPayload());
    },
  },
  {
    id: "workspace-close",
    method: "DELETE",
    pattern: /^\/api\/workspaces\/([^/]+)$/,
    policy: policyForRoute("workspace-close"),
    handler: async ({ deps, match, sendJson }) => {
      if (!match) throw new Error("workspace close route matched without captures");
      const removed = deps.sessions.closeWorkspace(match[1]);
      sendJson(removed ? 200 : 409, {
        removed,
        state: deps.currentPayload(),
      });
    },
  },
  {
    id: "workspace-title",
    method: "POST",
    pattern: /^\/api\/workspaces\/([^/]+)\/title$/,
    policy: policyForRoute("workspace-title"),
    handler: async ({ deps, match, readJsonBody, sendJson }) => {
      if (!match) throw new Error("workspace title route matched without captures");
      const body = (await readJsonBody()) as { title?: string; clear?: boolean };
      const workspace = body.clear
        ? deps.state.clearWorkspaceTitle(match[1])
        : deps.state.setWorkspaceTitle(match[1], body.title ?? "");
      sendJson(200, { workspace, state: deps.currentPayload() });
    },
  },
  {
    id: "workspace-auto-title",
    method: "POST",
    pattern: /^\/api\/workspaces\/([^/]+)\/auto-title$/,
    policy: policyForRoute("workspace-auto-title"),
    handler: async ({ deps, match, readJsonBody, sendJson }) => {
      if (!match) throw new Error("workspace auto-title route matched without captures");
      const body = (await readJsonBody()) as {
        title?: string;
        tabId?: string;
        descriptor?: string;
        tabOnlyIfMultiple?: boolean;
      };
      const result = deps.state.setAutoTitle({
        workspaceId: match[1],
        title: body.title ?? "",
        tabId: body.tabId,
        descriptor: body.descriptor,
        tabOnlyIfMultiple: body.tabOnlyIfMultiple,
      });
      sendJson(200, { ...result, state: deps.currentPayload() });
    },
  },
  {
    id: "tab-create",
    method: "POST",
    pattern: /^\/api\/workspaces\/([^/]+)\/tabs$/,
    policy: policyForRoute("tab-create"),
    handler: async ({ deps, machines, match, readJsonBody, sendJson }) => {
      if (!match) throw new Error("tab create route matched without captures");
      const body = (await readJsonBody()) as {
        machineId?: string;
        sourcePaneId?: string;
        clientIds?: unknown;
      };
      const snapshot = deps.state.snapshot();
      const workspace = snapshot.workspaces.find((candidate) => candidate.id === match[1]);
      const sourcePane = body.sourcePaneId
        ? workspace?.tabs
          .flatMap((tab) => tab.panes)
          .find((pane) => pane.id === body.sourcePaneId)
        : undefined;
      const machineId = deps.resolveMachineId(
        machines,
        body.machineId,
        workspace?.machineId,
      );
      const clientIds = parseClientCreationIds(
        body.clientIds,
        { tabId: "tab", paneId: "pane" },
      ) as TabCreationIds | undefined;
      const tab = deps.state.createTab(
        match[1],
        machineId,
        await deps.cwdForSourcePane(machines, sourcePane, machineId),
        clientIds,
      );
      sendJson(201, { tab, state: deps.currentPayload() });
    },
  },
  {
    id: "tab-close",
    method: "DELETE",
    pattern: /^\/api\/workspaces\/([^/]+)\/tabs\/([^/]+)$/,
    policy: policyForRoute("tab-close"),
    handler: async ({ deps, match, sendJson }) => {
      if (!match) throw new Error("tab close route matched without captures");
      const removed = deps.sessions.closeTab(match[1], match[2]);
      sendJson(removed ? 200 : 409, {
        removed,
        state: deps.currentPayload(),
      });
    },
  },
  {
    id: "tab-title",
    method: "POST",
    pattern: /^\/api\/workspaces\/([^/]+)\/tabs\/([^/]+)\/title$/,
    policy: policyForRoute("tab-title"),
    handler: async ({ deps, match, readJsonBody, sendJson }) => {
      if (!match) throw new Error("tab title route matched without captures");
      const body = (await readJsonBody()) as { title?: string };
      const tab = deps.state.setTabTitle(match[1], match[2], body.title ?? "");
      sendJson(200, { tab, state: deps.currentPayload() });
    },
  },
  {
    id: "pane-split",
    method: "POST",
    pattern: /^\/api\/tabs\/([^/]+)\/split$/,
    policy: policyForRoute("pane-split"),
    handler: async ({ deps, machines, match, readJsonBody, sendJson }) => {
      if (!match) throw new Error("pane split route matched without captures");
      const body = (await readJsonBody()) as {
        paneId?: string;
        direction?: "horizontal" | "vertical";
        machineId?: string;
        clientIds?: unknown;
      };
      if (
        !body.paneId
        || (body.direction !== "horizontal" && body.direction !== "vertical")
      ) {
        sendJson(400, { error: "invalid_split" });
        return;
      }
      const snapshot = deps.state.snapshot();
      const targetTab = snapshot.workspaces
        .flatMap((workspace) => workspace.tabs)
        .find((tab) => tab.id === match[1]);
      if (!targetTab) throw new HttpError(404, "tab_not_found");
      const sourcePane = targetTab.panes.find((pane) => pane.id === body.paneId);
      if (!sourcePane) throw new HttpError(404, "pane_not_found");
      const machineId = deps.resolveMachineId(
        machines,
        body.machineId,
        sourcePane.machineId,
      );
      const clientIds = parseClientCreationIds(
        body.clientIds,
        { paneId: "pane" },
      ) as SplitCreationIds | undefined;
      const tab = deps.state.splitPane(
        match[1],
        body.paneId,
        body.direction,
        machineId,
        await deps.cwdForSourcePane(machines, sourcePane, machineId),
        clientIds,
      );
      sendJson(201, { tab, state: deps.currentPayload() });
    },
  },
  {
    id: "split-ratio",
    method: "POST",
    pattern: /^\/api\/tabs\/([^/]+)\/split-ratio$/,
    policy: policyForRoute("split-ratio"),
    handler: async ({ deps, match, readJsonBody, sendJson }) => {
      if (!match) throw new Error("split ratio route matched without captures");
      const body = (await readJsonBody()) as { path?: string; ratio?: number };
      const ratio = body.ratio;
      if (
        typeof body.path !== "string"
        || typeof ratio !== "number"
        || !Number.isFinite(ratio)
      ) {
        sendJson(400, { error: "invalid_split_ratio" });
        return;
      }
      const tab = deps.state.setSplitRatio(match[1], body.path, ratio);
      sendJson(200, { tab, state: deps.currentPayload() });
    },
  },
  {
    id: "pane-input",
    method: "POST",
    pattern: /^\/api\/panes\/([^/]+)\/input$/,
    policy: policyForRoute("pane-input"),
    handler: async ({ deps, match, readJsonBody, sendJson }) => {
      if (!match) throw new Error("pane input route matched without captures");
      const body = (await readJsonBody()) as {
        data?: unknown;
        cols?: unknown;
        rows?: unknown;
      };
      if (typeof body.data !== "string") {
        sendJson(400, { error: "invalid_input" });
        return;
      }
      if (body.data.length > 256 * 1024) {
        sendJson(413, { error: "input_too_large" });
        return;
      }
      const written = deps.sessions.writePane(
        decodeURIComponent(match[1]),
        body.data,
        typeof body.cols === "number" ? body.cols : undefined,
        typeof body.rows === "number" ? body.rows : undefined,
      );
      if (!written) {
        sendJson(404, { error: "pane_not_found" });
        return;
      }
      sendJson(200, deps.currentPayload());
    },
  },
  {
    id: "pane-notifications-read",
    method: "POST",
    pattern: /^\/api\/panes\/([^/]+)\/notifications\/read$/,
    policy: policyForRoute("pane-notifications-read"),
    handler: async ({ deps, match, sendJson }) => {
      if (!match) throw new Error("pane notifications route matched without captures");
      deps.state.markPaneNotificationsRead(decodeURIComponent(match[1]));
      sendJson(200, deps.currentPayload());
    },
  },
  {
    id: "pane-close",
    method: "DELETE",
    pattern: /^\/api\/tabs\/([^/]+)\/panes\/([^/]+)$/,
    policy: policyForRoute("pane-close"),
    handler: async ({ deps, match, sendJson }) => {
      if (!match) throw new Error("pane close route matched without captures");
      const removed = deps.sessions.closePane(match[2]);
      sendJson(removed ? 200 : 409, {
        removed,
        state: deps.currentPayload(),
      });
    },
  },
];
