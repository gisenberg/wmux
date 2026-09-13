import { useEffect, useMemo, useState } from "react";
import type {
  CodexBindingDiagnostic as ProtocolCodexBindingDiagnostic,
  CodexDiagnosticReport as ProtocolCodexDiagnosticReport,
  CodexObservation as ProtocolCodexObservation,
} from "./types";

export type CodexObservationDiagnostic = ProtocolCodexObservation;
export type CodexBindingDiagnostic = ProtocolCodexBindingDiagnostic;
export type CodexDiagnosticsReport = ProtocolCodexDiagnosticReport;
type CodexOwnership = CodexBindingDiagnostic["workspaceOwnership"];

export const observationAge = (timestamp: number | undefined, now = Date.now()): string => {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return "not sampled";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

export const expiryLabel = (expiresAt: string, now = Date.now()): string => {
  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp)) return "expiry unknown";
  const seconds = Math.floor((timestamp - now) / 1_000);
  if (seconds <= 0) return `expired ${observationAge(timestamp, now)}`;
  if (seconds < 60) return `expires in ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `expires in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `expires in ${hours}h`;
  return `expires in ${Math.floor(hours / 24)}d`;
};

export const codexRecoveryInstruction = (binding: CodexBindingDiagnostic): string => {
  if (binding.binding === "expired") {
    return "Binding expired. Open the intended terminal and establish fresh terminal proof before automatic naming can resume.";
  }
  if (binding.binding === "unavailable") {
    return "Terminal proof is unavailable. Reopen the intended terminal and establish fresh proof; socket recovery alone does not restore title authority.";
  }
  if (binding.naming?.stale || binding.activity?.stale) {
    return "Observation is stale. Recover the socket first; if this binding expires, establish fresh terminal proof before automatic naming can resume.";
  }
  return "Live terminal proof is present. A socket recovery may resume sampling without sending a prompt.";
};

const ownership = (value: CodexOwnership): string => ({
  user: "MANUAL PIN",
  auto: "AUTOMATIC",
  default: "AUTOMATIC / AWAITING SYNC",
})[value];

const observationTitle = (observation: CodexObservationDiagnostic | undefined, now: number): string => {
  if (!observation) return "No observation received.";
  return [
    `received ${observationAge(observation.receivedAt, now)}`,
    `sample ${observationAge(observation.sampledAt, now)}`,
    `success ${observationAge(observation.lastSuccessAt, now)}`,
    observation.reason,
  ].filter(Boolean).join("; ");
};

const isStale = (sample: CodexObservationDiagnostic, now: number): boolean => sample.stale
  || (sample.reason !== "terminal_observed" && now - sample.receivedAt > 30_000);

export const codexTransportLabel = (binding: CodexBindingDiagnostic, now = Date.now()): string => {
  const samples = [binding.naming, binding.activity].filter((sample): sample is CodexObservationDiagnostic => Boolean(sample))
    .sort((a, b) => b.receivedAt - a.receivedAt);
  const latest = samples[0];
  if (!latest || isStale(latest, now)) return "UNKNOWN / NO FRESH SAMPLE";
  if (latest.reason === "unsupported_endpoint") return "UNSUPPORTED ENDPOINT";
  if (["socket_unavailable", "transport_error"].includes(latest.reason ?? "")) return "NATIVE SOCKET UNAVAILABLE";
  if (latest.reason === "delivery_failed") return "WMUX DELIVERY FAILED";
  if (latest.lastSuccessAt !== undefined) return "NATIVE METADATA READ";
  return "UNVERIFIED";
};

function Observation({ label, observation, now }: {
  label: "NAMING" | "ACTIVITY";
  observation?: CodexObservationDiagnostic;
  now: number;
}) {
  if (!observation) return <div className="diagnostics-row issue" role="row">
    <span>{label}</span><span>UNAVAILABLE</span><span title="No observation received">not sampled</span><span>-</span><span>[UNKNOWN] no observation</span>
  </div>;
  const counters = Object.entries(observation.counters)
    .map(([name, count]) => `${name} ${count}`)
    .join(" · ") || "no counters";
  const stale = isStale(observation, now);
  return <div className={`diagnostics-row ${stale ? "issue" : ""}`} role="row">
    <span>{label}</span>
    <span>{observation.status.toUpperCase()}{stale ? " / STALE" : ""}</span>
    <span title={observationTitle(observation, now)}>sample {observationAge(observation.sampledAt, now)}</span>
    <span title={observation.pluginVersion}>success {observationAge(observation.lastSuccessAt, now)}</span>
    <span>[{observation.reason && observation.reason !== "none" ? "INFO" : "OK"}] {observation.reason?.toUpperCase()}<br />{counters}</span>
  </div>;
}

export function CodexDiagnostics({ report, paneId, now: suppliedNow }: {
  report: CodexDiagnosticsReport;
  paneId?: string;
  now?: number;
}) {
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (suppliedNow !== undefined) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [suppliedNow]);
  const now = suppliedNow ?? clock;
  const bindings = useMemo(
    () => (paneId ? report.bindings.filter((binding) => binding.paneId === paneId) : report.bindings).map(binding => ({ ...binding,
      binding: Date.parse(binding.expiresAt) <= now ? "expired" as const : binding.binding })),
    [paneId, report.bindings, now],
  );
  const liveCount = bindings.filter((binding) => binding.binding === "live").length;
  return <section aria-label={paneId ? "Codex binding details" : "Codex diagnostics"} className="latency-diagnostics">
    <div className="diagnostics-section-heading">
      <span>CODEX::BINDINGS</span>
      <span>{liveCount} LIVE / {bindings.length} SHOWN</span>
    </div>
    <div className="diagnostics-summary">
      <span className="diagnostics-status-token">[{report.expiredCount ? "WARN" : "OK"}]</span>
      <strong>{report.expiredCount ? "BINDING RECOVERY REQUIRED" : "BINDING STATUS AVAILABLE"}</strong>
      <span>PENDING {report.pendingCount}</span>
      <span>EXPIRED {report.expiredCount}</span>
    </div>
    <div className="diagnostics-row" role="row" title={`CLI ${report.compatibility.cli}; server ${report.compatibility.server}; plugins ${report.compatibility.pluginVersions.join(", ") || "none observed"}`}>
      <span>COMPATIBILITY</span><span>CLI {report.compatibility.cli.toUpperCase()}</span><span>SERVER {report.compatibility.server.toUpperCase()}</span><span>PLUGINS</span><span>{report.compatibility.pluginVersions.join(", ") || "UNVERIFIED"}</span>
    </div>
    {bindings.length === 0 ? <div className="diagnostics-loading"><span>[IDLE]</span> {paneId ? "NO CODEX BINDING FOR THIS PANE" : "NO CODEX BINDINGS OBSERVED"}</div> : bindings.map((binding) => (
      <section key={`${binding.workspaceId}:${binding.tabId}:${binding.paneId}:${binding.sessionId}`} aria-label={`Codex binding for pane ${binding.paneId}`}>
        <div className="diagnostics-section-heading">
          <span title={`workspace ${binding.workspaceId}; tab ${binding.tabId}; pane ${binding.paneId}; session ${binding.sessionId}`}>TARGET {binding.workspaceId} / {binding.tabId} / {binding.paneId}</span>
          <span>{binding.binding.toUpperCase()}</span>
        </div>
        <div className={`diagnostics-row ${binding.binding === "live" ? "" : "issue"}`} role="row">
          <span>BINDING</span><span title={binding.sessionId}>{binding.binding.toUpperCase()}</span><span title={binding.expiresAt}>{expiryLabel(binding.expiresAt, now)}</span><span>TRANSPORT</span><span>{codexTransportLabel(binding, now)}</span>
        </div>
        <div className="diagnostics-row" role="row">
          <span>PINS</span><span>WORKSPACE</span><span title={binding.workspaceOwnership}>{ownership(binding.workspaceOwnership)}</span><span>TAB</span><span title={binding.tabOwnership}>{ownership(binding.tabOwnership)}</span>
        </div>
        <div className="diagnostics-table" role="table" aria-label="Codex naming and activity observation">
          <div className="diagnostics-row diagnostics-columns" role="row"><span>SIGNAL</span><span>STATE</span><span>SAMPLED</span><span>LAST SUCCESS</span><span>REASON / COUNTERS</span></div>
          <Observation label="NAMING" observation={binding.naming} now={now} />
          <Observation label="ACTIVITY" observation={binding.activity} now={now} />
        </div>
        <div className="diagnostics-loading" title={codexRecoveryInstruction(binding)}><span>[RECOVERY]</span> {codexRecoveryInstruction(binding)}</div>
      </section>
    ))}
  </section>;
}
