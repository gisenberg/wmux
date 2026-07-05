import { ExternalLink, ScreenShare, X } from "lucide-react";
import { useEffect, useMemo } from "react";
import type { MachineStatus, StreamStatus } from "./types";

interface ScreenStreamViewerProps {
  machine: MachineStatus | undefined;
  stream: StreamStatus | undefined;
  onRequest: (machineId: string, requestId: string, ttlMs: number) => void;
  onRelease: (machineId: string, requestId: string) => void;
  onClose: () => void;
}

const STREAM_REQUEST_TTL_MS = 20_000;
const STREAM_REQUEST_HEARTBEAT_MS = 5_000;

export function ScreenStreamViewer({ machine, stream, onRequest, onRelease, onClose }: ScreenStreamViewerProps) {
  const machineId = machine?.id ?? stream?.machineId ?? "unknown";
  const machineName = machine?.name ?? machineId;
  const requestId = useMemo(() => createRequestId(), []);
  const isMoonlightGateway = stream?.provider === "moonlight-gateway";
  const streamUrl = stream
    ? isMoonlightGateway
      ? stream.openUrl
      : `${stream.openUrl}?controls=false&muted=true&autoplay=true&playsInline=true`
    : "";
  const streamStateLabel = isMoonlightGateway
    ? stream?.live
      ? "gateway ready"
      : stream?.reason
        ? "upstream offline"
        : "gateway offline"
    : stream?.live
      ? "live"
      : stream?.requested
        ? "starting agent"
        : "requesting stream";

  useEffect(() => {
    if (!machineId || machineId === "unknown") return;
    onRequest(machineId, requestId, STREAM_REQUEST_TTL_MS);
    const interval = window.setInterval(() => {
      onRequest(machineId, requestId, STREAM_REQUEST_TTL_MS);
    }, STREAM_REQUEST_HEARTBEAT_MS);
    return () => {
      window.clearInterval(interval);
      onRelease(machineId, requestId);
    };
  }, [machineId, onRelease, onRequest, requestId]);

  return (
    <div className="stream-backdrop" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
      <section className="stream-panel" role="dialog" aria-modal="true" aria-label={`${machineName} screen stream`}>
        <div className="stream-header">
          <div>
            <h2>{machineName} stream</h2>
            <span className={`stream-status ${stream?.live ? "live" : "waiting"}`}>
              {streamStateLabel}
              {stream ? ` / ${stream.viewerCount} viewer${stream.viewerCount === 1 ? "" : "s"}` : ""}
            </span>
          </div>
          <div className="stream-actions">
            {stream ? (
              <a
                className="stream-link"
                href={stream.openUrl}
                target="_blank"
                rel="noreferrer"
                title={isMoonlightGateway ? "Open Moonlight gateway" : "Open MediaMTX stream"}
              >
                <ExternalLink size={15} />
                <span>open</span>
              </a>
            ) : null}
            <button type="button" title="Close stream" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="stream-video-shell">
          {stream?.live ? (
            <iframe
              className="stream-frame"
              src={streamUrl}
              title={`${machineName} ${isMoonlightGateway ? "Moonlight gateway" : "WebRTC stream"}`}
              allow="autoplay; fullscreen; picture-in-picture; gamepad; clipboard-read; clipboard-write"
            />
          ) : (
            <div className="stream-empty">
              <ScreenShare size={30} />
              <strong>
                {isMoonlightGateway
                  ? stream?.reason
                    ? "Moonlight upstream unavailable"
                    : "Moonlight gateway unavailable"
                  : stream?.requested
                    ? "Starting pixel stream"
                    : "No active pixel stream"}
              </strong>
              <span>
                {isMoonlightGateway
                  ? `Run wmux-moonlight-gateway for ${machineName}; Sunshine and the gateway own the remote-control stream.`
                  : `Keep wmux-stream-agent-service running on ${machineName}; capture starts only while this dialog is open.`}
              </span>
              {stream?.reason ? <span>{stream.reason}</span> : null}
            </div>
          )}
        </div>
        {stream && isMoonlightGateway ? (
          <div className="stream-agent-hint">
            <span>gateway</span>
            <code>{stream.gatewayUrl ?? stream.openUrl}</code>
            <span>control</span>
            <code>{stream.inputEnabled ? "keyboard, pointer, touch, and gamepad flow through the browser gateway" : "view only"}</code>
          </div>
        ) : stream && stream.publishRtspUrl && stream.publishWhipUrl ? (
          <div className="stream-agent-hint">
            <span>RTSP publish</span>
            <code>{stream.publishRtspUrl}</code>
            <span>WHIP publish</span>
            <code>{stream.publishWhipUrl}</code>
          </div>
        ) : null}
      </section>
    </div>
  );
}

const createRequestId = (): string => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `stream-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};
