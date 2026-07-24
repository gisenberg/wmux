import { readAgentProfileBundle } from "../agent-profile.js";
import { buildDoctorReport } from "../doctor.js";
import {
  auditDurableSessions,
  cleanupDurableSession,
} from "../session-audit.js";
import type { WmuxSettings } from "../types.js";
import {
  type ApiRoute,
  policyForRoute,
} from "./route.js";

export const bootstrapRoutes: readonly ApiRoute[] = [
  {
    id: "bootstrap",
    method: "GET",
    pattern: "/api/bootstrap",
    policy: policyForRoute("bootstrap"),
    handler: async ({ deps, sendJson }) => {
      sendJson(200, await deps.bootstrapFresh());
    },
  },
  {
    id: "session-audit",
    method: "GET",
    pattern: "/api/session-audit",
    policy: policyForRoute("session-audit"),
    handler: async ({ sendJson }) => {
      sendJson(200, await auditDurableSessions());
    },
  },
  {
    id: "doctor",
    method: "GET",
    pattern: "/api/doctor",
    policy: policyForRoute("doctor"),
    handler: async ({ deps, sendJson }) => {
      await deps.refreshMachineStatuses(false);
      sendJson(
        200,
        buildDoctorReport(
          deps.state.snapshot(),
          deps.currentMachines(),
          deps.getMachineStatuses(),
          await auditDurableSessions(),
        ),
      );
    },
  },
  {
    id: "agent-profile",
    method: "GET",
    pattern: "/api/agent-profile",
    policy: policyForRoute("agent-profile"),
    handler: async ({ response, sendJson }) => {
      response.setHeader("cache-control", "no-store");
      sendJson(200, readAgentProfileBundle());
    },
  },
  {
    id: "session-cleanup",
    method: "DELETE",
    pattern: /^\/api\/session-audit\/(tmux|screen)\/([^/]+)$/,
    policy: policyForRoute("session-cleanup"),
    handler: async ({ match, sendJson }) => {
      if (!match) throw new Error("session cleanup route matched without captures");
      sendJson(
        200,
        await cleanupDurableSession(
          match[1] as "tmux" | "screen",
          decodeURIComponent(match[2]),
        ),
      );
    },
  },
  {
    id: "settings",
    method: "POST",
    pattern: "/api/settings",
    policy: policyForRoute("settings"),
    handler: async ({ deps, readJsonBody, sendJson }) => {
      const body = (await readJsonBody()) as {
        terminalFontSize?: number;
        terminalScrollbackRows?: number;
        colorScheme?: WmuxSettings["colorScheme"];
        inactiveTabStreaming?: WmuxSettings["inactiveTabStreaming"];
        tuiFrameRate?: WmuxSettings["tuiFrameRate"];
        terminalScrollMode?: WmuxSettings["terminalScrollMode"];
        machineAliases?: Record<string, string>;
        collapsedWorkspaceIds?: string[];
      };
      deps.settings.update({
        terminalFontSize: body.terminalFontSize,
        terminalScrollbackRows: body.terminalScrollbackRows,
        colorScheme: body.colorScheme,
        inactiveTabStreaming: body.inactiveTabStreaming,
        tuiFrameRate: body.tuiFrameRate,
        terminalScrollMode: body.terminalScrollMode,
        machineAliases: body.machineAliases,
        collapsedWorkspaceIds: body.collapsedWorkspaceIds,
      });
      sendJson(200, {
        settings: deps.settings.snapshot(),
        state: deps.currentPayload(),
      });
    },
  },
];
