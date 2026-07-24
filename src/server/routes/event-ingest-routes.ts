import type {
  AgentEventPostBody,
  RunEventPostBody,
} from "../../shared/agent-contract.js";
import {
  type ApiRoute,
  routePolicy,
} from "./route.js";

export const eventIngestRoutes: readonly ApiRoute[] = [
  {
    id: "notification-create",
    method: "POST",
    pattern: "/api/notifications",
    policy: routePolicy(
      "notification-create",
      "POST",
      "/api/notifications",
      "normal",
      ["helper"],
    ),
    handler: async ({ deps, readJsonBody, sendJson }) => {
      const body = (await readJsonBody()) as {
        workspaceId?: string;
        tabId?: string;
        paneId?: string;
        title?: string;
        subtitle?: string;
        body?: string;
      };
      const notification = deps.state.createNotification({
        workspaceId: body.workspaceId,
        tabId: body.tabId,
        paneId: body.paneId,
        title: body.title ?? "wmux",
        subtitle: body.subtitle,
        body: body.body,
      });
      sendJson(201, {
        notification,
        state: deps.currentPayload(),
      });
    },
  },
  {
    id: "agent-event",
    method: "POST",
    pattern: "/api/agent-events",
    policy: routePolicy(
      "agent-event",
      "POST",
      "/api/agent-events",
      "normal",
      ["automation", "helper"],
    ),
    handler: async ({ deps, readJsonBody, sendJson }) => {
      const body = (await readJsonBody()) as AgentEventPostBody;
      const result = deps.agentSessions.recordAgentEvent({
        runId: body.runId,
        workspaceId: body.workspaceId,
        tabId: body.tabId,
        paneId: body.paneId,
        agent: body.agent,
        status: body.status,
        title: body.title,
        summary: body.summary,
        message: body.message,
        body: body.body,
      });
      sendJson(201, { ...result, state: deps.currentPayload() });
    },
  },
  {
    id: "delegation-status",
    method: "GET",
    pattern: /^\/api\/delegations\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/,
    policy: routePolicy(
      "delegation-status",
      "GET",
      /^\/api\/delegations\/[^/]+$/,
      "normal",
      ["automation"],
    ),
    handler: async ({ deps, match, sendJson }) => {
      if (!match) throw new Error("delegation status route matched without captures");
      const delegation = deps.agentSessions.delegationForRun(match[1]);
      if (!delegation) {
        sendJson(404, { error: "delegation_not_found" });
        return;
      }
      sendJson(200, { delegation });
    },
  },
  {
    id: "run-event",
    method: "POST",
    pattern: "/api/run-events",
    policy: routePolicy(
      "run-event",
      "POST",
      "/api/run-events",
      "normal",
      ["helper"],
    ),
    handler: async ({ deps, readJsonBody, sendJson }) => {
      const body = (await readJsonBody()) as RunEventPostBody;
      if (
        body.status
        && !["started", "completed", "failed"].includes(body.status)
      ) {
        sendJson(400, { error: "invalid_run_status" });
        return;
      }
      const run = deps.state.recordRunEvent({
        workspaceId: body.workspaceId,
        tabId: body.tabId,
        paneId: body.paneId,
        runId: body.runId,
        command: body.command,
        status: body.status,
        exitCode: body.exitCode,
        startedAt: body.startedAt,
        completedAt: body.completedAt,
      });
      sendJson(201, { run, state: deps.currentPayload() });
    },
  },
  {
    id: "notification-read",
    method: "POST",
    pattern: /^\/api\/notifications\/([^/]+)\/read$/,
    policy: routePolicy(
      "notification-read",
      "POST",
      /^\/api\/notifications\/[^/]+\/read$/,
    ),
    handler: async ({ deps, match, sendJson }) => {
      if (!match) throw new Error("notification read route matched without captures");
      deps.state.markNotificationRead(match[1]);
      sendJson(200, deps.currentPayload());
    },
  },
];
