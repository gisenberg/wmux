import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  clearTerminalLatency,
  terminalLatency,
  type TerminalLatencyDistribution,
  type TerminalLatencySnapshot,
} from "./terminal-latency";
import type { DoctorReport } from "./types";

interface DiagnosticsModalProps {
  report: DoctorReport | null;
  loading: boolean;
  error: string;
  onRefresh: () => void;
  onClose: () => void;
}

export function DiagnosticsModal({ report, loading, error, onRefresh, onClose }: DiagnosticsModalProps) {
  const latency = useSyncExternalStore(terminalLatency.subscribe, terminalLatency.getSnapshot);
  const copyLatency = useCallback(() => {
    void navigator.clipboard.writeText(JSON.stringify(latency, null, 2)).catch(() => undefined);
  }, [latency]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key.toLowerCase() === "r") {
        event.preventDefault();
        onRefresh();
      } else if (event.key.toLowerCase() === "c") {
        event.preventDefault();
        copyLatency();
      } else if (event.key === "Delete") {
        event.preventDefault();
        clearTerminalLatency();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [copyLatency, onClose, onRefresh]);

  const hasIssues = Boolean(
    report && (report.summary.exitedPaneCount || report.summary.sessionIssueCount || report.panes.some((pane) => pane.issue)),
  );

  return (
    <div className="diagnostics-backdrop" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
      <section className="diagnostics-panel" role="dialog" aria-modal="true" aria-label="wmux diagnostics">
        <header className="diagnostics-header">
          <div>
            <span className="diagnostics-kicker">WMUX::SYSTEM_CONSOLE</span>
            <h2>DIAGNOSTICS</h2>
          </div>
          <div className="diagnostics-actions">
            <button type="button" title="Refresh diagnostics (R)" aria-keyshortcuts="R" onClick={onRefresh} disabled={loading}>
              <span>[R]</span> {loading ? "REFRESHING" : "REFRESH"}
            </button>
            <button type="button" title="Close diagnostics (Escape)" aria-keyshortcuts="Escape" onClick={onClose}>
              <span>[ESC]</span> CLOSE
            </button>
          </div>
        </header>
        <div className="diagnostics-command-line" aria-hidden="true">
          <span>wmux@browser:~$</span>
          <strong>inspect --latency --pane-drivers</strong>
          <i>{loading ? "RUNNING" : "READY"}</i>
        </div>
        <div className="diagnostics-content">
          <LatencyDiagnostics snapshot={latency} onCopy={copyLatency} onClear={clearTerminalLatency} />
          <div className="diagnostics-section-heading">
            <span>SERVER::PANE_DRIVERS</span>
            <span>{report ? `${report.summary.paneCount} PANE${report.summary.paneCount === 1 ? "" : "S"}` : "PROBING"}</span>
          </div>
          {error ? <div className="diagnostics-error"><span>[ERR]</span> {error}</div> : null}
          {report ? (
            <>
              <div className={`diagnostics-summary ${hasIssues ? "warning" : "healthy"}`}>
                <span className="diagnostics-status-token">[{hasIssues ? "WARN" : "OK"}]</span>
                <strong>{hasIssues ? "REVIEW REQUIRED" : "ALL PANE DRIVERS HEALTHY"}</strong>
                <span>DURABLE {report.summary.restartDurablePaneCount}/{report.summary.paneCount}</span>
                <span>ISSUES {report.summary.sessionIssueCount}</span>
              </div>
              <div className="diagnostics-table" role="table" aria-label="Pane diagnostics">
                <div className="diagnostics-row diagnostics-columns" role="row">
                  <span>PANE</span><span>HOST</span><span>DRIVER</span><span>DURABILITY</span><span>STATUS</span>
                </div>
                {report.panes.map((pane) => (
                  <div className={`diagnostics-row ${pane.issue ? "issue" : ""}`} role="row" key={pane.paneId}>
                    <span title={pane.paneId}>{pane.title}</span>
                    <span>{pane.machineName}</span>
                    <span>{pane.transport}</span>
                    <span>{pane.restartDurable ? "RESTART-SAFE" : "PROCESS-LOCAL"}</span>
                    <span title={pane.issue}>[{pane.issue ? "ERR" : "OK"}] {pane.issue ?? pane.status}</span>
                  </div>
                ))}
              </div>
            </>
          ) : loading ? <div className="diagnostics-loading"><span>[....]</span> PROBING PANE DRIVERS</div> : null}
        </div>
        <footer className="diagnostics-footer">
          <span>LOCAL BROWSER SESSION</span>
          <span>ESC CLOSE · R REFRESH · C COPY · DEL CLEAR</span>
        </footer>
      </section>
    </div>
  );
}

const formatLatency = (value: number | null): string => {
  if (value === null) return "—";
  return `${value.toFixed(value < 10 ? 1 : 0)} ms`;
};

const formatChars = (value: number | null): string => value === null ? "—" : `${Math.round(value)} chars`;

function LatencyDiagnostics({
  snapshot,
  onCopy,
  onClear,
}: {
  snapshot: TerminalLatencySnapshot;
  onCopy: () => void;
  onClear: () => void;
}) {
  const rows: Array<{
    group: "INPUT" | "SHELL" | "TUI";
    label: string;
    metric: TerminalLatencyDistribution;
    unit?: "chars";
    title: string;
  }> = [
    {
      group: "INPUT",
      label: "Input dispatch",
      metric: snapshot.metrics.inputDispatch,
      title: "DOM key event to Ghostty terminal input callback",
    },
    {
      group: "INPUT",
      label: "Predicted paint",
      metric: snapshot.metrics.predictedPaint,
      title: "DOM key event to the first animation frame after speculative overlay mutation",
    },
    {
      group: "INPUT",
      label: "Predicted backspace",
      metric: snapshot.metrics.predictedBackspacePaint,
      title: "Backspace key event to the first animation frame after speculative overlay mutation",
    },
    {
      group: "SHELL",
      label: "Shell output",
      metric: snapshot.metrics.normalOutput,
      title: "Normal-screen input to the first sequence-acknowledged WebSocket output",
    },
    {
      group: "SHELL",
      label: "Shell canvas",
      metric: snapshot.metrics.normalRender,
      title: "Normal-screen input to Ghostty's post-canvas-render event",
    },
    {
      group: "SHELL",
      label: "Shell backspace",
      metric: snapshot.metrics.normalBackspaceRender,
      title: "Normal-screen Backspace input to Ghostty's post-canvas-render event",
    },
    {
      group: "SHELL",
      label: "Shell browser work",
      metric: snapshot.metrics.normalOutputToRender,
      title: "Normal-screen WebSocket output arrival to Ghostty's post-canvas-render event",
    },
    {
      group: "SHELL",
      label: "Shell output size",
      metric: snapshot.metrics.normalOutputChars,
      unit: "chars",
      title: "Characters received before the sampled normal-screen render",
    },
    {
      group: "TUI",
      label: "TUI output",
      metric: snapshot.metrics.alternateOutput,
      title: "Alternate-screen input to the first sequence-acknowledged WebSocket output",
    },
    {
      group: "TUI",
      label: "TUI canvas",
      metric: snapshot.metrics.alternateRender,
      title: "Alternate-screen input to Ghostty's post-canvas-render event",
    },
    {
      group: "TUI",
      label: "TUI backspace",
      metric: snapshot.metrics.alternateBackspaceRender,
      title: "Alternate-screen Backspace input to Ghostty's post-canvas-render event",
    },
    {
      group: "TUI",
      label: "TUI browser work",
      metric: snapshot.metrics.alternateOutputToRender,
      title: "Alternate-screen WebSocket output arrival to Ghostty's post-canvas-render event",
    },
    {
      group: "TUI",
      label: "TUI output size",
      metric: snapshot.metrics.alternateOutputChars,
      unit: "chars",
      title: "Characters received before the sampled alternate-screen render",
    },
  ];

  return (
    <section className="latency-diagnostics" aria-label="Browser terminal latency">
      <div className="diagnostics-section-heading">
        <span>CLIENT::TERMINAL_LATENCY</span>
        <span>WINDOW 512 / VOLATILE</span>
      </div>
      <div className="latency-diagnostics-header">
        <p>
          <span>#</span> PRESENTATION PROXY: NEXT BROWSER FRAME + GHOSTTY POST-CANVAS RENDER. INPUT TEXT IS NEVER RETAINED.
        </p>
        <div className="diagnostics-actions">
          <button type="button" title="Copy latency measurements as JSON (C)" aria-keyshortcuts="C" onClick={onCopy}>
            <span>[C]</span> COPY JSON
          </button>
          <button type="button" title="Clear latency measurements (Delete)" aria-keyshortcuts="Delete" onClick={onClear}>
            <span>[DEL]</span> CLEAR
          </button>
        </div>
      </div>
      <div className="latency-summary">
        <span>SAMPLES <strong>{snapshot.sampleCount.toString().padStart(3, "0")}</strong></span>
        <span>PENDING <strong>{snapshot.pendingCount.toString().padStart(3, "0")}</strong></span>
        <span>EXPIRED <strong>{snapshot.droppedCount.toString().padStart(3, "0")}</strong></span>
      </div>
      <div className="latency-table" role="table" aria-label="Terminal latency percentiles">
        <div className="latency-row latency-columns" role="row">
          <span>PIPELINE / STAGE</span><span>N</span><span>P50</span><span>P95</span><span>P99</span>
        </div>
        {rows.map(({ group, label, metric, unit, title }, index) => {
          const format = unit === "chars" ? formatChars : formatLatency;
          return (
            <div
              className={`latency-row${index === 0 || rows[index - 1]?.group !== group ? " group-start" : ""}`}
              role="row"
              key={label}
              title={title}
            >
              <span><i>{group}</i>::{label.toUpperCase().replace(`${group} `, "")}</span>
              <span>{metric.samples}</span>
              <span>{format(metric.p50)}</span>
              <span>{format(metric.p95)}</span>
              <span>{format(metric.p99)}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
