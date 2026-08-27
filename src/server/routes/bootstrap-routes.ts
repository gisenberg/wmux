import { buildDoctorReport } from "../doctor.js";
import {
  auditDurableSessions,
  cleanupDurableSession,
} from "../session-audit.js";
import type { WmuxSettings } from "../types.js";
import {
  type ApiRoute,
  routePolicy,
} from "./route.js";

export const bootstrapRoutes: readonly ApiRoute[] = [
  {
    id: "bootstrap",
    method: "GET",
    pattern: "/api/bootstrap",
    policy: routePolicy(
      "bootstrap",
      "GET",
      "/api/bootstrap",
      "normal",
      ["automation"],
    ),
    handler: async ({ deps, sendJson }) => {
      sendJson(200, await deps.bootstrapFresh());
    },
  },
  {
    id: "session-audit",
    method: "GET",
    pattern: "/api/session-audit",
    policy: routePolicy("session-audit", "GET", "/api/session-audit"),
    handler: async ({ sendJson }) => {
      sendJson(200, await auditDurableSessions());
    },
  },
  {
    id: "doctor",
    method: "GET",
    pattern: "/api/doctor",
    policy: routePolicy("doctor", "GET", "/api/doctor", "normal", ["helper"]),
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
    id: "session-cleanup",
    method: "DELETE",
    pattern: /^\/api\/session-audit\/(tmux|screen|agent)\/([^/]+)$/,
    policy: routePolicy(
      "session-cleanup",
      "DELETE",
      /^\/api\/session-audit\/(tmux|screen|agent)\/[^/]+$/,
    ),
    handler: async ({ match, sendJson, url }) => {
      if (!match) throw new Error("session cleanup route matched without captures");
      sendJson(
        200,
        await cleanupDurableSession(
          match[1] as "tmux" | "screen" | "agent",
          decodeURIComponent(match[2]),
          undefined,
          url.searchParams.get("endpoint") ?? undefined,
        ),
      );
    },
  },
  {
    id: "settings",
    method: "POST",
    pattern: "/api/settings",
    policy: routePolicy("settings", "POST", "/api/settings"),
    handler: async ({ deps, readJsonBody, sendJson }) => {
      const body = (await readJsonBody()) as {
        terminalFontSize?: number;
        terminalScrollbackRows?: number;
        colorScheme?: WmuxSettings["colorScheme"];
        inactiveTabStreaming?: WmuxSettings["inactiveTabStreaming"];
        tuiFrameRate?: WmuxSettings["tuiFrameRate"];
        terminalScrollMode?: WmuxSettings["terminalScrollMode"];
        groupSidebarSessionsByHost?: boolean;
        machineAliases?: Record<string, string>;
        collapsedWorkspaceIds?: string[];
        favoriteWorkspaceIds?: string[];
      };
      deps.settings.update({
        terminalFontSize: body.terminalFontSize,
        terminalScrollbackRows: body.terminalScrollbackRows,
        colorScheme: body.colorScheme,
        inactiveTabStreaming: body.inactiveTabStreaming,
        tuiFrameRate: body.tuiFrameRate,
        terminalScrollMode: body.terminalScrollMode,
        groupSidebarSessionsByHost: body.groupSidebarSessionsByHost,
        machineAliases: body.machineAliases,
        collapsedWorkspaceIds: body.collapsedWorkspaceIds,
        favoriteWorkspaceIds: body.favoriteWorkspaceIds,
      });
      sendJson(200, {
        settings: deps.settings.snapshot(),
        state: deps.currentPayload(),
      });
    },
  },
];
