import type { MachineStatus } from "./types";

export function EmptyWorkspaceView({ machines, targetId, onTarget, onCreate, onNavigate, onManage }: {
  machines: MachineStatus[];
  targetId: string;
  onTarget: (id: string) => void;
  onCreate: () => void;
  onNavigate: () => void;
  onManage: () => void;
}) {
  const target = machines.find((machine) => machine.id === targetId);
  return (
    <section className="empty-workspace-view console-empty" aria-label="Session launcher">
      <h1>WMUX // SESSION MANAGER</h1>
      <p>[IDLE] No workspace selected.</p>
      <label>NEW SESSION TARGET
        <select aria-label="New session target" value={targetId} onChange={(event) => onTarget(event.target.value)}>
          {machines.map((machine) => (
            <option key={machine.id} value={machine.id}>{machine.name} [{machine.reachable ? "ONLINE" : "OFFLINE"}]</option>
          ))}
        </select>
      </label>
      <div className="console-empty-actions">
        <button disabled={!target?.reachable} onClick={onCreate}>[+] NEW WORKSPACE</button>
        <button onClick={onNavigate}>[FIND SESSION]</button>
        <button onClick={onManage}>[MANAGE HOSTS]</button>
      </div>
      {!target?.reachable && <p role="status">[OFFLINE] Select a reachable host before creating a session.</p>}
      <p>Closing the browser leaves durable sessions running.<br />Explicitly closing a pane terminates its process.</p>
    </section>
  );
}
