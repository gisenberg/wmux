import { observedClientAddress } from "../proxy-address.js";
import {
  buildWindowsHelperBundle,
  buildWindowsPowerShellBootstrap,
} from "../windows-helpers.js";
import {
  type ApiRoute,
  routePolicy,
} from "./route.js";

const windowsBootstrapEnvKeys = [
  "WMUX_WORKSPACE_ID",
  "WMUX_WORKSPACE_NAME",
  "WMUX_TAB_ID",
  "WMUX_TAB_TITLE",
  "WMUX_PANE_ID",
  "WMUX_COLOR_SCHEME",
  "WMUX_COLOR_MODE",
  "WMUX_TERMINAL_FOREGROUND",
  "WMUX_TERMINAL_BACKGROUND",
  "WMUX_TERMINAL_ANSI_PALETTE",
  "KITTY_WINDOW_ID",
];

export const registryRoutes: readonly ApiRoute[] = [
  {
    id: "registry-list",
    method: "GET",
    pattern: "/api/registry/hosts",
    policy: routePolicy("registry-list", "GET", "/api/registry/hosts"),
    handler: async ({ deps, sendJson }) => {
      sendJson(200, { hosts: deps.hostRegistry?.snapshot() ?? [] });
    },
  },
  {
    id: "registry-register",
    method: "POST",
    pattern: "/api/registry/hosts",
    policy: routePolicy(
      "registry-register",
      "POST",
      "/api/registry/hosts",
      "registration",
    ),
    handler: async ({ deps, request, readJsonBody, sendJson }) => {
      if (!deps.hostRegistry) {
        sendJson(404, { error: "registry_disabled" });
        return;
      }
      const host = deps.hostRegistry.register(
        await readJsonBody(),
        observedClientAddress(request, deps.trustedProxies),
      );
      sendJson(200, {
        host: {
          id: host.id,
          lastSeenAt: host.lastSeenAt,
          expiresAt: host.expiresAt,
        },
      });
    },
  },
  {
    id: "registry-delete",
    method: "DELETE",
    pattern: /^\/api\/registry\/hosts\/([^/]+)$/,
    policy: routePolicy(
      "registry-delete",
      "DELETE",
      /^\/api\/registry\/hosts\/[^/]+$/,
    ),
    handler: async ({ deps, match, sendJson }) => {
      if (!deps.hostRegistry) {
        sendJson(404, { error: "registry_disabled" });
        return;
      }
      if (!match) throw new Error("registry delete route matched without captures");
      const removed = deps.hostRegistry.unregister(decodeURIComponent(match[1]));
      sendJson(removed ? 200 : 404, { removed });
    },
  },
  {
    id: "windows-bootstrap",
    method: "GET",
    pattern: /^\/api\/helpers\/windows\/([^/]+)\/bootstrap$/,
    policy: routePolicy(
      "windows-bootstrap",
      "GET",
      /^\/api\/helpers\/windows\/[^/]+\/bootstrap$/,
      "normal",
      ["helper"],
      false,
      true,
      true,
    ),
    handler: async ({ deps, machines, match, response, sendJson, url }) => {
      if (!match) throw new Error("Windows bootstrap route matched without captures");
      const machineId = decodeURIComponent(match[1]);
      const machine = machines.find((candidate) => candidate.id === machineId);
      if (!machine) {
        sendJson(404, { error: "unknown_machine" });
        return;
      }
      if (machine.kind !== "powershell-ssh") {
        sendJson(400, { error: "not_windows_machine" });
        return;
      }
      const startCwd = url.searchParams.get("WMUX_START_CWD") ?? undefined;
      const extraEnv: Record<string, string> = {};
      for (const key of windowsBootstrapEnvKeys) {
        const value = url.searchParams.get(key);
        if (value) extraEnv[key] = value;
      }
      if (machine.source !== "registered") {
        if (deps.auth.helperToken) extraEnv.WMUX_HELPER_TOKEN = deps.auth.helperToken;
        else if (
          (deps.auth.browserAuthMode ?? "shared-or-login") === "shared-or-login"
          && deps.auth.token
        ) {
          extraEnv.WMUX_TOKEN = deps.auth.token;
        }
        extraEnv.WMUX_BROWSER_AUTH_MODE = deps.auth.browserAuthMode ?? "shared-or-login";
      }
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      const bundleMachine = machine.source === "registered"
        ? { ...machine, agentToken: undefined }
        : machine;
      response.end(
        buildWindowsPowerShellBootstrap(
          machine,
          startCwd,
          extraEnv,
          undefined,
          machine.source === "registered"
            ? buildWindowsHelperBundle(bundleMachine, deps.bindHost)
            : undefined,
        ),
      );
    },
  },
  {
    id: "windows-helpers",
    method: "GET",
    pattern: /^\/api\/helpers\/windows\/([^/]+)$/,
    policy: routePolicy(
      "windows-helpers",
      "GET",
      /^\/api\/helpers\/windows\/[^/]+$/,
      "normal",
      ["helper"],
      false,
      false,
      true,
    ),
    handler: async ({ deps, machines, match, sendJson }) => {
      if (!match) throw new Error("Windows helper route matched without captures");
      const machineId = decodeURIComponent(match[1]);
      const machine = machines.find((candidate) => candidate.id === machineId);
      if (!machine) {
        sendJson(404, { error: "unknown_machine" });
        return;
      }
      if (machine.kind !== "powershell-ssh") {
        sendJson(400, { error: "not_windows_machine" });
        return;
      }
      const bundleMachine = machine.source === "registered"
        ? { ...machine, agentToken: undefined }
        : machine;
      sendJson(200, buildWindowsHelperBundle(bundleMachine, deps.bindHost));
    },
  },
];
