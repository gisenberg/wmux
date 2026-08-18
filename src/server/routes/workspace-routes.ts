import {
  WorkspaceDepthError,
  type SplitCreationIds,
  type TabCreationIds,
  type WorkspaceCleanupOptions,
  type WorkspaceCreationIds,
} from "../state.js";
import type { WorkspaceReorderPosition } from "../types.js";
import {
  HttpError,
  type ApiRoute,
  routePolicy,
} from "./route.js";

const clientIdPattern = (prefix: string, minLength = 16): RegExp =>
  new RegExp(`^${prefix}_[0-9a-f]{${minLength},64}$`);

const MIN_AGENT_WORKSPACE_CLEANUP_TTL_SECONDS = 60;
const MAX_AGENT_WORKSPACE_CLEANUP_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_AGENT_WORKSPACE_CLEANUP_TTL_SECONDS = 24 * 60 * 60;

const parseWorkspaceCleanup = (
  policy: unknown,
  ttlSeconds: unknown,
): WorkspaceCleanupOptions | undefined => {
  if (policy === undefined && ttlSeconds === undefined) return undefined;
  if (policy !== "on-success") {
    throw new HttpError(400, "invalid_workspace_cleanup_policy");
  }
  if (
    typeof ttlSeconds !== "number"
    || !Number.isInteger(ttlSeconds)
    || ttlSeconds < MIN_AGENT_WORKSPACE_CLEANUP_TTL_SECONDS
    || ttlSeconds > MAX_AGENT_WORKSPACE_CLEANUP_TTL_SECONDS
  ) {
    throw new HttpError(400, "invalid_workspace_cleanup_ttl");
  }
  return {
    policy,
    cleanupAt: new Date(Date.now() + ttlSeconds * 1_000).toISOString(),
  };
};

const parseWorkspaceCreationCleanup = (
  policy: unknown,
  ttlSeconds: unknown,
): WorkspaceCleanupOptions | undefined => {
  if (policy === "retain" && ttlSeconds === undefined) return undefined;
  if (policy === undefined && ttlSeconds === undefined) {
    return parseWorkspaceCleanup(
      "on-success",
      DEFAULT_AGENT_WORKSPACE_CLEANUP_TTL_SECONDS,
    );
  }
  return parseWorkspaceCleanup(policy, ttlSeconds);
};

const parseClientCreationIds = (
  value: unknown,
  fields: Record<string, string>,
  minLength = 16,
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
    if (typeof id !== "string" || !clientIdPattern(fields[key], minLength).test(id)) {
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
    policy: routePolicy(
      "workspace-create",
      "POST",
      "/api/workspaces",
      "normal",
      ["automation"],
    ),
    handler: async ({ deps, machines, readJsonBody, sendJson }) => {
      const body = (await readJsonBody()) as {
        machineId?: string;
        sourcePaneId?: string;
        parentPaneId?: string;
        parentContext?: unknown;
        createdBy?: "user" | "agent";
        cleanupPolicy?: unknown;
        cleanupTtlSeconds?: unknown;
        parentWorkspaceId?: unknown;
        clientIds?: unknown;
      };
      if (body.parentWorkspaceId !== undefined) {
        sendJson(400, { error: "parent_workspace_id_not_accepted" });
        return;
      }
      if (
        (body.parentPaneId !== undefined || body.parentContext !== undefined)
        && body.createdBy !== "agent"
      ) {
        sendJson(400, { error: "parent_pane_requires_agent" });
        return;
      }
      if (body.parentPaneId !== undefined && body.parentContext !== undefined) {
        sendJson(400, { error: "ambiguous_parent_context" });
        return;
      }
      if (
        (body.cleanupPolicy !== undefined || body.cleanupTtlSeconds !== undefined)
        && body.createdBy !== "agent"
      ) {
        sendJson(400, { error: "workspace_cleanup_requires_agent" });
        return;
      }
      const cleanup = body.createdBy === "agent"
        ? parseWorkspaceCreationCleanup(
          body.cleanupPolicy,
          body.cleanupTtlSeconds,
        )
        : undefined;
      const parentContext = body.parentContext === undefined
        ? undefined
        : parseClientCreationIds(body.parentContext, {
          workspaceId: "ws",
          tabId: "tab",
          paneId: "pane",
        }, 8);
      const parentPaneId = parentContext?.paneId ?? body.parentPaneId;
      const parentPane = parentPaneId
        ? deps.state.findPane(parentPaneId) ?? undefined
        : undefined;
      if (parentPaneId && (!parentPane || parentPane.status === "exited")) {
        sendJson(422, { error: "parent_pane_unavailable" });
        return;
      }
      if (parentContext && parentPane) {
        const actual = deps.state.findPaneContext(parentPane.id);
        if (
          !actual
          || actual.workspace.id !== parentContext.workspaceId
          || actual.tab.id !== parentContext.tabId
        ) {
          sendJson(422, { error: "parent_context_mismatch" });
          return;
        }
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
      const cwd = await deps.cwdForSourcePane(machines, cwdPane, machineId);
      let parentWorkspaceId: string | undefined;
      if (parentPaneId) {
        const currentParent = deps.state.findPaneContext(parentPaneId);
        if (!currentParent || currentParent.pane.status === "exited") {
          sendJson(422, { error: "parent_pane_unavailable" });
          return;
        }
        if (
          parentContext
          && (
            currentParent.workspace.id !== parentContext.workspaceId
            || currentParent.tab.id !== parentContext.tabId
          )
        ) {
          sendJson(422, { error: "parent_context_mismatch" });
          return;
        }
        parentWorkspaceId = currentParent.workspace.id;
      }
      let workspace;
      try {
        workspace = deps.state.createWorkspace(
          machineId,
          cwd,
          body.createdBy === "agent" ? "agent" : "user",
          parentWorkspaceId,
          clientIds,
          cleanup,
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
    id: "workspace-cleanup-configure",
    method: "POST",
    pattern: /^\/api\/workspaces\/([^/]+)\/cleanup$/,
    policy: routePolicy(
      "workspace-cleanup-configure",
      "POST",
      /^\/api\/workspaces\/[^/]+\/cleanup$/,
      "normal",
      ["automation"],
      false,
      false,
      true,
    ),
    handler: async ({ deps, match, readJsonBody, sendJson }) => {
      if (!match) throw new Error("workspace cleanup route matched without captures");
      const body = (await readJsonBody()) as {
        cleanupPolicy?: unknown;
        cleanupTtlSeconds?: unknown;
      };
      const existing = deps.state.snapshot().workspaces.find(
        (workspace) => workspace.id === match[1],
      );
      if (!existing) {
        sendJson(404, { error: "workspace_not_found" });
        return;
      }
      if (existing.createdBy !== "agent") {
        sendJson(409, { error: "workspace_cleanup_requires_agent" });
        return;
      }
      if (
        body.cleanupPolicy === "retain"
        && body.cleanupTtlSeconds === undefined
      ) {
        const workspace = deps.state.configureWorkspaceCleanup(match[1]);
        sendJson(200, { workspace, state: deps.currentPayload() });
        return;
      }
      const cleanup = parseWorkspaceCleanup(
        body.cleanupPolicy,
        body.cleanupTtlSeconds,
      );
      if (!cleanup) {
        sendJson(400, { error: "workspace_cleanup_policy_required" });
        return;
      }
      const workspace = deps.state.configureWorkspaceCleanup(match[1], cleanup);
      sendJson(200, { workspace, state: deps.currentPayload() });
    },
  },
  {
    id: "workspace-reorder",
    method: "POST",
    pattern: "/api/workspaces/reorder",
    policy: routePolicy(
      "workspace-reorder",
      "POST",
      "/api/workspaces/reorder",
    ),
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
    policy: routePolicy(
      "workspace-notifications-read",
      "POST",
      /^\/api\/workspaces\/[^/]+\/notifications\/read$/,
    ),
    handler: async ({ deps, match, sendJson }) => {
      if (!match) throw new Error("workspace notifications route matched without captures");
      deps.state.markWorkspaceNotificationsRead(match[1]);
      sendJson(200, deps.currentPayload());
    },
  },
  {
    id: "workspace-close-schedule",
    method: "POST",
    pattern: /^\/api\/workspaces\/([^/]+)\/pending-close$/,
    policy: routePolicy(
      "workspace-close-schedule",
      "POST",
      /^\/api\/workspaces\/[^/]+\/pending-close$/,
    ),
    handler: async ({ deps, match, sendJson }) => {
      if (!match) throw new Error("workspace close schedule route matched without captures");
      const closeAt = deps.sessions.scheduleWorkspaceClose(match[1]);
      sendJson(closeAt ? 202 : 404, closeAt
        ? { scheduled: true, closeAt }
        : { error: "workspace_not_found" });
    },
  },
  {
    id: "workspace-close-cancel",
    method: "DELETE",
    pattern: /^\/api\/workspaces\/([^/]+)\/pending-close$/,
    policy: routePolicy(
      "workspace-close-cancel",
      "DELETE",
      /^\/api\/workspaces\/[^/]+\/pending-close$/,
    ),
    handler: async ({ deps, match, sendJson }) => {
      if (!match) throw new Error("workspace close cancel route matched without captures");
      const cancelled = deps.sessions.cancelWorkspaceClose(match[1]);
      sendJson(200, { cancelled, state: deps.currentPayload() });
    },
  },
  {
    id: "workspace-close",
    method: "DELETE",
    pattern: /^\/api\/workspaces\/([^/]+)$/,
    policy: routePolicy(
      "workspace-close",
      "DELETE",
      /^\/api\/workspaces\/[^/]+$/,
      "normal",
      ["automation"],
    ),
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
    policy: routePolicy(
      "workspace-title",
      "POST",
      /^\/api\/workspaces\/[^/]+\/title$/,
      "normal",
      ["automation", "helper"],
    ),
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
    policy: routePolicy(
      "workspace-auto-title",
      "POST",
      /^\/api\/workspaces\/[^/]+\/auto-title$/,
      "normal",
      ["helper"],
    ),
    handler: async ({ deps, match, readJsonBody, sendJson }) => {
      if (!match) throw new Error("workspace auto-title route matched without captures");
      const body = (await readJsonBody()) as {
        title?: string;
        tabId?: string;
        paneId?: string;
        descriptor?: string;
        tabOnlyIfMultiple?: boolean;
      };
      if (body.paneId !== undefined) {
        if (!body.tabId) throw new HttpError(400, "auto_title_pane_requires_tab");
        const source = deps.state.findPaneContext(body.paneId);
        if (!source) throw new HttpError(404, "pane_not_found");
        if (source.workspace.id !== match[1] || source.tab.id !== body.tabId) {
          throw new HttpError(400, "auto_title_target_mismatch");
        }
      } else {
        const workspace = deps.state.snapshot().workspaces.find(
          (candidate) => candidate.id === match[1],
        );
        if (!workspace) throw new HttpError(404, "workspace_not_found");
        const paneCount = workspace.tabs.reduce(
          (count, tab) => count + tab.panes.length,
          0,
        );
        if (paneCount !== 1) {
          throw new HttpError(400, "ambiguous_auto_title_source");
        }
        if (body.tabId && body.tabId !== workspace.tabs[0]?.id) {
          throw new HttpError(400, "auto_title_target_mismatch");
        }
      }
      const result = deps.state.setAutoTitle({
        workspaceId: match[1],
        title: body.title ?? "",
        tabId: body.tabId,
        sourcePaneId: body.paneId,
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
    policy: routePolicy(
      "tab-create",
      "POST",
      /^\/api\/workspaces\/[^/]+\/tabs$/,
      "normal",
      ["automation"],
    ),
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
    policy: routePolicy(
      "tab-close",
      "DELETE",
      /^\/api\/workspaces\/[^/]+\/tabs\/[^/]+$/,
      "normal",
      ["automation"],
    ),
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
    policy: routePolicy(
      "tab-title",
      "POST",
      /^\/api\/workspaces\/[^/]+\/tabs\/[^/]+\/title$/,
      "normal",
      ["automation"],
    ),
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
    policy: routePolicy(
      "pane-split",
      "POST",
      /^\/api\/tabs\/[^/]+\/split$/,
    ),
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
    policy: routePolicy(
      "split-ratio",
      "POST",
      /^\/api\/tabs\/[^/]+\/split-ratio$/,
    ),
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
    policy: routePolicy(
      "pane-input",
      "POST",
      /^\/api\/panes\/[^/]+\/input$/,
      "normal",
      ["automation"],
    ),
    handler: async ({ deps, match, readJsonBody, sendJson }) => {
      if (!match) throw new Error("pane input route matched without captures");
      const body = (await readJsonBody()) as {
        data?: unknown;
        cols?: unknown;
        rows?: unknown;
        timelinePrompt?: unknown;
      };
      if (typeof body.data !== "string") {
        sendJson(400, { error: "invalid_input" });
        return;
      }
      if (body.data.length > 256 * 1024) {
        sendJson(413, { error: "input_too_large" });
        return;
      }
      if (
        body.timelinePrompt !== undefined
        && (
          typeof body.timelinePrompt !== "string"
          || body.timelinePrompt.length > 128 * 1024
        )
      ) {
        sendJson(400, { error: "invalid_timeline_prompt" });
        return;
      }
      const paneId = decodeURIComponent(match[1]);
      const written = deps.sessions.writePane(
        paneId,
        body.data,
        typeof body.cols === "number" ? body.cols : undefined,
        typeof body.rows === "number" ? body.rows : undefined,
      );
      if (!written) {
        sendJson(404, { error: "pane_not_found" });
        return;
      }
      if (typeof body.timelinePrompt === "string" && body.timelinePrompt.trim()) {
        deps.agentSessions.recordUserPrompt(paneId, body.timelinePrompt);
      }
      sendJson(200, deps.currentPayload());
    },
  },
  {
    id: "pane-notifications-read",
    method: "POST",
    pattern: /^\/api\/panes\/([^/]+)\/notifications\/read$/,
    policy: routePolicy(
      "pane-notifications-read",
      "POST",
      /^\/api\/panes\/[^/]+\/notifications\/read$/,
    ),
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
    policy: routePolicy(
      "pane-close",
      "DELETE",
      /^\/api\/tabs\/[^/]+\/panes\/[^/]+$/,
    ),
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
