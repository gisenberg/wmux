import { EventEmitter } from "node:events";
import type { MachineConfig, StreamProvider, StreamStatus } from "./types.js";

export interface StreamRequestStatus {
  machineId: string;
  requested: boolean;
  requestCount: number;
  requestedUntil?: string;
}

interface MediaMtxPath {
  name?: string;
  online?: boolean;
  ready?: boolean;
  onlineTime?: string;
  readyTime?: string;
  readers?: unknown[];
}

interface MediaMtxPathList {
  items?: MediaMtxPath[];
}

interface MoonlightGatewayHealth {
  ok?: boolean;
  startedAt?: string;
  viewerCount?: number;
  upstream?: {
    ok?: boolean;
    status?: number;
    reason?: string;
  };
}

const DEFAULT_REQUEST_TTL_MS = 20_000;
const MIN_REQUEST_TTL_MS = 5_000;
const MAX_REQUEST_TTL_MS = 60_000;
const GATEWAY_HEALTH_TIMEOUT_MS = 1_500;

export class StreamRequestStore extends EventEmitter {
  private requests = new Map<string, Map<string, number>>();

  touch(machineId: string, requestId: string, ttlMs = DEFAULT_REQUEST_TTL_MS): StreamRequestStatus {
    const cleanRequestId = requestId.trim();
    if (!cleanRequestId) throw new Error("missing_request_id");
    const previous = this.snapshot(machineId);
    const machineRequests = this.requests.get(machineId) ?? new Map<string, number>();
    const requestedTtl = Number.isFinite(ttlMs) ? ttlMs : DEFAULT_REQUEST_TTL_MS;
    const ttl = Math.min(MAX_REQUEST_TTL_MS, Math.max(MIN_REQUEST_TTL_MS, Math.floor(requestedTtl)));
    machineRequests.set(cleanRequestId, Date.now() + ttl);
    this.requests.set(machineId, machineRequests);
    const next = this.snapshot(machineId);
    if (previous.requested !== next.requested || previous.requestCount !== next.requestCount) this.emit("change", next);
    return next;
  }

  release(machineId: string, requestId: string): StreamRequestStatus {
    const previous = this.snapshot(machineId);
    const machineRequests = this.requests.get(machineId);
    if (machineRequests) {
      machineRequests.delete(requestId);
      if (machineRequests.size === 0) this.requests.delete(machineId);
    }
    const next = this.snapshot(machineId);
    if (previous.requested !== next.requested || previous.requestCount !== next.requestCount) this.emit("change", next);
    return next;
  }

  snapshot(machineId: string): StreamRequestStatus {
    const machineRequests = this.prune(machineId);
    const expirations = [...machineRequests.values()];
    const requestedUntil = expirations.length > 0 ? new Date(Math.max(...expirations)).toISOString() : undefined;
    return {
      machineId,
      requested: expirations.length > 0,
      requestCount: expirations.length,
      requestedUntil,
    };
  }

  snapshotMany(machineIds: string[]): Map<string, StreamRequestStatus> {
    return new Map(machineIds.map((machineId) => [machineId, this.snapshot(machineId)]));
  }

  private prune(machineId: string): Map<string, number> {
    const machineRequests = this.requests.get(machineId) ?? new Map<string, number>();
    const now = Date.now();
    let changed = false;
    for (const [requestId, expiresAt] of machineRequests.entries()) {
      if (expiresAt <= now) {
        machineRequests.delete(requestId);
        changed = true;
      }
    }
    if (machineRequests.size === 0) {
      this.requests.delete(machineId);
    } else {
      this.requests.set(machineId, machineRequests);
    }
    if (changed) {
      this.emit("change", this.snapshot(machineId));
    }
    return machineRequests;
  }
}

export const streamPathForMachine = (machineId: string): string =>
  `wmux-${machineId.replace(/[^A-Za-z0-9_-]/g, "-")}`;

export const resolveStreamStatuses = async (
  machines: MachineConfig[],
  host: string,
  requests?: StreamRequestStore,
): Promise<StreamStatus[]> => {
  const requestStatuses = requests?.snapshotMany(machines.map((machine) => machine.id)) ?? new Map<string, StreamRequestStatus>();
  const mediaBase = mediaMtxBase(host);
  const hasMediaMtxStreams = machines.some((machine) => streamProviderForMachine(machine) === "mediamtx");
  const paths = hasMediaMtxStreams
    ? await readMediaMtxPaths(mediaBase.apiUrl).catch((error: unknown) => ({
        error: error instanceof Error ? error.message : "MediaMTX status unavailable",
        items: [] as MediaMtxPath[],
      }))
    : { items: [] as MediaMtxPath[] };
  const pathItems = "items" in paths ? paths.items ?? [] : [];
  const mediaErrorReason = "error" in paths && typeof paths.error === "string" ? paths.error : undefined;
  const mediaByName = new Map(pathItems.map((path) => [path.name, path]));

  return Promise.all(
    machines.map(async (machine) => {
      const requestStatus = requestStatuses.get(machine.id) ?? {
        machineId: machine.id,
        requested: false,
        requestCount: 0,
      };
      return streamProviderForMachine(machine) === "moonlight-gateway"
        ? resolveMoonlightGatewayStatus(machine, host, requestStatus)
        : resolveMediaMtxStatus(machine, mediaBase, mediaByName, requestStatus, mediaErrorReason);
    }),
  );
};

const resolveMediaMtxStatus = (
  machine: MachineConfig,
  base: { host: string; apiUrl: string; webRtcOrigin: string },
  paths: Map<string | undefined, MediaMtxPath>,
  requestStatus: StreamRequestStatus,
  errorReason?: string,
): StreamStatus => {
  const path = streamPathForMachine(machine.id);
  const status = paths.get(path);
  const live = Boolean(status?.online ?? status?.ready);
  const webRtcUrl = `${base.webRtcOrigin}/${path}`;
  return {
    machineId: machine.id,
    provider: "mediamtx",
    path,
    live,
    requested: requestStatus.requested,
    requestCount: requestStatus.requestCount,
    requestedUntil: requestStatus.requestedUntil,
    viewerCount: status?.readers?.length ?? 0,
    startedAt: status?.onlineTime ?? status?.readyTime,
    webRtcUrl,
    openUrl: webRtcUrl,
    publishRtspUrl: `rtsp://${base.host}:8554/${path}`,
    publishWhipUrl: `${base.webRtcOrigin}/${path}/whip`,
    inputEnabled: false,
    reason: live ? undefined : errorReason,
  };
};

const resolveMoonlightGatewayStatus = async (
  machine: MachineConfig,
  host: string,
  requestStatus: StreamRequestStatus,
): Promise<StreamStatus> => {
  const gatewayUrl = moonlightGatewayUrl(machine, host);
  const openUrl = normalizeUrl(machine.stream?.gatewayOpenUrl ?? gatewayUrl);
  const healthUrl = joinUrl(gatewayUrl, "/api/wmux/health");
  const health = await readMoonlightGatewayHealth(healthUrl).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : "Moonlight gateway status unavailable",
  }));
  const path = streamPathForMachine(machine.id);
  const live = "ok" in health ? Boolean(health.ok) && health.upstream?.ok !== false : false;
  const upstreamReason =
    "ok" in health && health.upstream && health.upstream.ok === false
      ? health.upstream.reason ?? `Moonlight Web upstream returned ${health.upstream.status ?? "an error"}`
      : undefined;
  const errorReason = "error" in health ? health.error : undefined;
  return {
    machineId: machine.id,
    provider: "moonlight-gateway",
    path,
    live,
    requested: requestStatus.requested,
    requestCount: requestStatus.requestCount,
    requestedUntil: requestStatus.requestedUntil,
    viewerCount: "ok" in health && typeof health.viewerCount === "number" ? health.viewerCount : requestStatus.requestCount,
    startedAt: "ok" in health ? health.startedAt : undefined,
    webRtcUrl: openUrl,
    openUrl,
    gatewayUrl,
    inputEnabled: true,
    reason: live ? upstreamReason : errorReason,
  };
};

const streamProviderForMachine = (machine: MachineConfig): StreamProvider =>
  machine.stream?.provider ?? "mediamtx";

const readMoonlightGatewayHealth = async (url: string): Promise<MoonlightGatewayHealth> =>
  fetchJsonWithTimeout<MoonlightGatewayHealth>(url, GATEWAY_HEALTH_TIMEOUT_MS);

const fetchJsonWithTimeout = async <T>(url: string, timeoutMs: number): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
};

const moonlightGatewayUrl = (machine: MachineConfig, host: string): string => {
  if (machine.stream?.gatewayUrl) return normalizeUrl(machine.stream.gatewayUrl);
  const gatewayHost = process.env.WMUX_MOONLIGHT_GATEWAY_HOST || machine.host || host;
  const gatewayPort = process.env.WMUX_MOONLIGHT_GATEWAY_PORT || "3490";
  return `http://${gatewayHost}:${gatewayPort}`;
};

const normalizeUrl = (value: string): string => value.replace(/\/+$/, "");

const joinUrl = (base: string, pathname: string): string => {
  const url = new URL(normalizeUrl(base));
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${pathname.replace(/^\/+/, "")}`;
  return url.toString();
};

const readMediaMtxPaths = async (apiUrl: string): Promise<MediaMtxPathList> => {
  const response = await fetch(`${apiUrl}/v3/paths/list`);
  if (!response.ok) throw new Error(`MediaMTX API returned ${response.status}`);
  return (await response.json()) as MediaMtxPathList;
};

const mediaMtxBase = (host: string): { host: string; apiUrl: string; webRtcOrigin: string } => {
  const mediaHost = process.env.WMUX_STREAM_HOST || host;
  const apiUrl = process.env.WMUX_MEDIAMTX_API_URL || "http://127.0.0.1:9997";
  const webRtcOrigin = process.env.WMUX_MEDIAMTX_WEBRTC_ORIGIN || `http://${mediaHost}:8889`;
  return { host: mediaHost, apiUrl, webRtcOrigin };
};
