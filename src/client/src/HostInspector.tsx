import type { MachineStatus } from "./types";
import type { SessionRow } from "./session-inventory";
import { useConsoleDialog } from "./useConsoleDialog";

export function HostInspector({ machine, sessions, onClose, onManage, onCreate }: {
  machine: MachineStatus; sessions: SessionRow[]; onClose: () => void; onManage: () => void; onCreate: () => void;
}) {
  const ref = useConsoleDialog<HTMLElement>(onClose);
  const rows = sessions.filter((row) => row.available && row.machineId === machine.id);
  return <div className="agent-fleet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={ref} role="dialog" aria-modal="true" aria-label={`Host ${machine.name}`} className="agent-fleet console-host-inspector" tabIndex={-1}>
      <header className="agent-fleet-header"><strong>HOST // {machine.name}</strong><button onClick={onClose}>[ESC] CLOSE</button></header>
      <dl>
        <dt>IDENTITY</dt><dd>{machine.id}</dd>
        <dt>NETWORK</dt><dd>{machine.host ?? "local"}{machine.port ? `:${machine.port}` : ""}</dd>
        <dt>REACHABILITY</dt><dd>[{machine.reachable ? "ONLINE" : "OFFLINE"}] {machine.reason}</dd>
        <dt>BACKEND</dt><dd>{machine.kind} / {machine.sessionBackend ?? "auto"}</dd>
        <dt>RELEASE</dt><dd>{machine.releaseVersion ?? "unknown"}</dd>
        <dt>RUNTIME</dt><dd>{machine.runtimeVersion ?? "unknown"} / expected {machine.expectedRuntimeVersion ?? "unknown"}</dd>
        <dt>HELPERS</dt><dd>{machine.helperBundleVersion ?? "unknown"} / expected {machine.expectedHelperBundleVersion ?? "unknown"}</dd>
        <dt>SESSIONS</dt><dd>{rows.length} panes / {rows.filter((row) => row.state === "running").length} running / {rows.filter((row) => row.attentionReason || row.state === "waiting").length} waiting</dd>
      </dl>
      <p>Host reachability is separate from browser attachment and agent activity.</p>
      <div className="console-empty-actions"><button disabled={!machine.reachable} onClick={onCreate}>[+] NEW WORKSPACE</button><button onClick={onManage}>[CONFIGURE HOSTS]</button></div>
    </section>
  </div>;
}
