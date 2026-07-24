import type { MachineConfig } from "../types.js";
import {
  type ApiRoute,
  policyForRoute,
} from "./route.js";

const machineExists = (
  machines: MachineConfig[],
  machineId: string,
): boolean => machines.some((machine) => machine.id === machineId);

const cryptoRandomId = (): string =>
  `stream-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export const streamRoutes: readonly ApiRoute[] = [
  {
    id: "streams",
    method: "GET",
    pattern: "/api/streams",
    policy: policyForRoute("streams"),
    handler: async ({ deps, sendJson }) => {
      await deps.refreshStreamStatuses(false, true);
      sendJson(200, { streams: deps.getStreamStatuses() });
    },
  },
  {
    id: "stream-request-status",
    method: "GET",
    pattern: /^\/api\/streams\/([^/]+)\/request$/,
    policy: policyForRoute("stream-request-status"),
    handler: async ({ deps, machines, match, sendJson }) => {
      if (!match) throw new Error("stream status route matched without captures");
      const machineId = decodeURIComponent(match[1]);
      if (!machineExists(machines, machineId)) {
        sendJson(404, { error: "unknown_machine" });
        return;
      }
      sendJson(200, deps.streamRequests.snapshot(machineId));
    },
  },
  {
    id: "stream-request",
    method: "POST",
    pattern: /^\/api\/streams\/([^/]+)\/request$/,
    policy: policyForRoute("stream-request"),
    handler: async ({ deps, machines, match, readJsonBody, sendJson }) => {
      if (!match) throw new Error("stream request route matched without captures");
      const machineId = decodeURIComponent(match[1]);
      if (!machineExists(machines, machineId)) {
        sendJson(404, { error: "unknown_machine" });
        return;
      }
      const body = (await readJsonBody()) as {
        requestId?: string;
        ttlMs?: number;
      };
      const requestId = body.requestId?.trim() || cryptoRandomId();
      const requestStatus = deps.streamRequests.touch(
        machineId,
        requestId,
        body.ttlMs,
      );
      deps.markStreamMutation();
      await deps.refreshStreamStatuses(true, true);
      sendJson(200, {
        requestId,
        ...requestStatus,
        streams: deps.getStreamStatuses(),
      });
    },
  },
  {
    id: "stream-release",
    method: "DELETE",
    pattern: /^\/api\/streams\/([^/]+)\/request\/([^/]+)$/,
    policy: policyForRoute("stream-release"),
    handler: async ({ deps, machines, match, sendJson }) => {
      if (!match) throw new Error("stream release route matched without captures");
      const machineId = decodeURIComponent(match[1]);
      if (!machineExists(machines, machineId)) {
        sendJson(404, { error: "unknown_machine" });
        return;
      }
      const requestStatus = deps.streamRequests.release(
        machineId,
        decodeURIComponent(match[2]),
      );
      deps.markStreamMutation();
      await deps.refreshStreamStatuses(true, true);
      sendJson(200, {
        ...requestStatus,
        streams: deps.getStreamStatuses(),
      });
    },
  },
];
