import net from "node:net";
import { isAllowedBindHost } from "./bind.js";

export const normalizeSessionAgentOrigin = (rawUrl: string): string | undefined => {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    if (
      parsed.protocol !== "http:"
      || !parsed.port
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
      || net.isIP(host) !== 4
      || !isAllowedBindHost(host)
    ) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
};

export const sessionAgentOriginForEndpoint = (
  endpoint: {
    kind: string;
    host?: string;
    sessionBackend?: string;
    agentUrl?: string;
    agentPort?: number;
  },
): string | undefined => {
  if (endpoint.sessionBackend !== "agent") return undefined;
  if (endpoint.agentUrl) {
    const origin = normalizeSessionAgentOrigin(endpoint.agentUrl);
    if (!origin) return undefined;
    const originPort = Number(new URL(origin).port);
    if (endpoint.agentPort !== undefined && endpoint.agentPort !== originPort) return undefined;
    return origin;
  }
  if (endpoint.kind === "local") {
    return `http://127.0.0.1:${endpoint.agentPort ?? 3481}`;
  }
  if (!endpoint.host || net.isIP(endpoint.host) !== 4 || !isAllowedBindHost(endpoint.host)) {
    return undefined;
  }
  return `http://${endpoint.host}:${endpoint.agentPort ?? 3481}`;
};

export const sessionAgentOriginAtPort = (rawUrl: string, port: number): string | undefined => {
  const origin = normalizeSessionAgentOrigin(rawUrl);
  if (!origin || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  const parsed = new URL(origin);
  parsed.port = String(port);
  return normalizeSessionAgentOrigin(parsed.origin);
};
