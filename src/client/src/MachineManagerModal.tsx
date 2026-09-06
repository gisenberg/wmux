import { useCallback, useEffect, useState } from "react";
import { useConsoleDialog } from "./useConsoleDialog";
import {
  api,
  type MachineManagementCatalog,
  type ManagedStaticMachine,
} from "./api";
import type {
  BootstrapPayload,
  MachineKind,
  MachinePlatform,
  MachineStreamConfig,
  SessionBackend,
} from "./types";

type EditableMachine = Omit<ManagedStaticMachine, "hasAgentToken" | "hasGatewayToken">;

const blankMachine = (): EditableMachine => ({
  id: "",
  name: "",
  kind: "ssh",
  sessionBackend: "auto",
});

const editableMachine = (machine: ManagedStaticMachine): EditableMachine => {
  const {
    hasAgentToken: _hasAgentToken,
    hasGatewayToken: _hasGatewayToken,
    ...editable
  } = machine;
  return structuredClone(editable);
};

export function MachineManagerModal({
  onClose,
  onState,
}: {
  onClose: () => void;
  onState: (state: BootstrapPayload) => void | Promise<void>;
}) {
  const [catalog, setCatalog] = useState<MachineManagementCatalog | null>(null);
  const [draft, setDraft] = useState<EditableMachine>(blankMachine);
  const [selectedId, setSelectedId] = useState("");
  const [registrationNames, setRegistrationNames] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const close = () => {
    if (busy) return;
    const original = catalog?.staticMachines.find((machine) => machine.id === selectedId);
    const dirty = JSON.stringify(draft) !== JSON.stringify(original ? editableMachine(original) : blankMachine())
      || Boolean(catalog?.registeredHosts.some((host) => registrationNames[host.id] !== host.machine.name));
    if (!dirty || window.confirm("Discard unsaved machine changes?")) onClose();
  };
  const dialogRef = useConsoleDialog<HTMLFormElement>(close);

  const load = useCallback(async () => {
    setError("");
    try {
      const next = await api.managedMachines();
      setCatalog(next);
      setRegistrationNames(Object.fromEntries(
        next.registeredHosts.map((host) => [host.id, host.machine.name]),
      ));
      if (selectedId) {
        const selected = next.staticMachines.find((machine) => machine.id === selectedId);
        if (selected) setDraft(editableMachine(selected));
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Machine catalog failed to load");
    }
  }, [selectedId]);

  useEffect(() => {
    void load();
  }, [load]);

  const select = (machine: ManagedStaticMachine) => {
    setSelectedId(machine.id);
    setDraft(editableMachine(machine));
    setError("");
  };

  const startCreate = () => {
    setSelectedId("");
    setDraft(blankMachine());
    setError("");
  };

  const updateDraft = (update: Partial<EditableMachine>) => {
    setDraft((current) => ({ ...current, ...update }));
  };

  const updateStream = (update: Partial<MachineStreamConfig> | null) => {
    setDraft((current) => ({
      ...current,
      stream: update ? { ...current.stream, ...update } : undefined,
    }));
  };

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const response = selectedId
        ? await api.updateManagedMachine(draft)
        : await api.createManagedMachine(draft);
      await onState(response.state);
      setSelectedId(response.machine.id);
      setDraft(editableMachine(response.machine));
      await load();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Machine save failed");
    } finally {
      setBusy(false);
    }
  };

  const removeStatic = async (machine: ManagedStaticMachine) => {
    if (!window.confirm(`Remove static machine ${machine.name}?`)) return;
    setBusy(true);
    setError("");
    try {
      const response = await api.deleteManagedMachine(machine.id);
      await onState(response.state);
      if (selectedId === machine.id) startCreate();
      await load();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Machine removal failed");
    } finally {
      setBusy(false);
    }
  };

  const updateRegistered = async (
    machineId: string,
    update: { name?: string; disabled?: boolean },
  ) => {
    setBusy(true);
    setError("");
    try {
      const response = await api.updateRegisteredHost(machineId, update);
      await onState(response.state);
      await load();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Registration update failed");
    } finally {
      setBusy(false);
    }
  };

  const removeRegistered = async (machineId: string, name: string) => {
    if (!window.confirm(`Delete dynamic registration ${name}?`)) return;
    setBusy(true);
    setError("");
    try {
      await api.deleteRegisteredHost(machineId);
      await onState(await api.bootstrap());
      await load();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Registration removal failed");
    } finally {
      setBusy(false);
    }
  };

  const existing = selectedId
    ? catalog?.staticMachines.find((machine) => machine.id === selectedId)
    : undefined;

  return (
    <div
      className="settings-backdrop machine-manager-backdrop"
      onMouseDown={(event) => event.currentTarget === event.target && close()}
    >
      <form
        ref={dialogRef}
        tabIndex={-1}
        className="settings-panel machine-manager-panel machine-manager-console"
        role="dialog"
        aria-modal="true"
        aria-labelledby="machine-manager-title"
        data-surface="console"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="settings-header machine-manager-header">
          <div>
            <span className="machine-manager-kicker">WMUX / HOST DIRECTORY</span>
            <h2 id="machine-manager-title">Machine management</h2>
          </div>
          <div className="settings-header-actions">
            <span className="machine-manager-catalog-status">
              {catalog
                ? `[OK] ${catalog.staticMachines.length} STATIC / ${catalog.registeredHosts.length} DYNAMIC`
                : "[WAIT] LOADING CATALOG"}
            </span>
            <button
              type="button"
              onClick={close}
              title="Close machine management"
              aria-label="Close machine management"
            >
              [X] CLOSE
            </button>
          </div>
        </div>
        <div className="settings-body machine-manager-body">
          <section className="settings-section machine-manager-list">
            <div className="settings-command-row">
              <h3>Static machines</h3>
              <button type="button" disabled={!selectedId || busy} onClick={startCreate}>[+] ADD</button>
            </div>
            {catalog?.staticMachines.map((machine) => (
              <div key={machine.id} className={`machine-manager-item ${selectedId === machine.id ? "selected" : ""}`}>
                <button type="button" onClick={() => select(machine)}>
                  <span>{machine.name}</span>
                  <small>{machine.id} / {machine.kind}</small>
                </button>
                <button
                  type="button"
                  title={`Remove ${machine.name}`}
                  aria-label={`Remove ${machine.name}`}
                  disabled={busy}
                  onClick={() => void removeStatic(machine)}
                >
                  [X]
                </button>
              </div>
            ))}
          </section>

          <section className="settings-section machine-manager-editor">
            <h3>{selectedId ? `Edit ${selectedId}` : "Add static machine"}</h3>
            <fieldset className="machine-manager-form" disabled={!catalog || busy}>
            <div className="machine-manager-fields">
              <label><span>ID</span><input required maxLength={64} value={draft.id} disabled={Boolean(selectedId)} onChange={(event) => updateDraft({ id: event.currentTarget.value })} /></label>
              <label><span>Name</span><input required maxLength={80} value={draft.name} onChange={(event) => updateDraft({ name: event.currentTarget.value })} /></label>
              <label>
                <span>Kind</span>
                <select value={draft.kind} onChange={(event) => updateDraft({ kind: event.currentTarget.value as MachineKind })}>
                  <option value="local">local</option>
                  <option value="ssh">ssh</option>
                  <option value="powershell-ssh">powershell-ssh</option>
                  <option value="powershell">powershell</option>
                  <option value="service">service</option>
                </select>
              </label>
              <label>
                <span>Platform</span>
                <select value={draft.platform ?? ""} onChange={(event) => updateDraft({ platform: event.currentTarget.value as MachinePlatform || undefined })}>
                  <option value="">infer</option>
                  <option value="linux">linux</option>
                  <option value="mac">mac</option>
                  <option value="win">win</option>
                </select>
              </label>
              <label><span>Host</span><input value={draft.host ?? ""} onChange={(event) => updateDraft({ host: optional(event.currentTarget.value) })} /></label>
              <label><span>User</span><input value={draft.user ?? ""} onChange={(event) => updateDraft({ user: optional(event.currentTarget.value) })} /></label>
              <label><span>Port</span><input type="number" min={1} max={65535} value={draft.port ?? ""} onChange={(event) => updateDraft({ port: optionalNumber(event.currentTarget.value) })} /></label>
              <label>
                <span>Session</span>
                <select value={draft.sessionBackend ?? ""} onChange={(event) => updateDraft({ sessionBackend: event.currentTarget.value as SessionBackend || undefined })}>
                  <option value="">default</option>
                  <option value="auto">auto</option>
                  <option value="pty">pty</option>
                  <option value="tmux">tmux</option>
                  <option value="screen">screen</option>
                  <option value="agent">agent</option>
                </select>
              </label>
              <label><span>Shell</span><input value={draft.shell ?? ""} onChange={(event) => updateDraft({ shell: optional(event.currentTarget.value) })} /></label>
              <label><span>Working dir</span><input value={draft.cwd ?? ""} onChange={(event) => updateDraft({ cwd: optional(event.currentTarget.value) })} /></label>
              <label><span>Agent URL</span><input type="url" value={draft.agentUrl ?? ""} onChange={(event) => updateDraft({ agentUrl: optional(event.currentTarget.value) })} /></label>
              <label><span>Agent port</span><input type="number" min={1} max={65527} value={draft.agentPort ?? ""} onChange={(event) => updateDraft({ agentPort: optionalNumber(event.currentTarget.value) })} /></label>
              <label className="machine-manager-field-wide">
                <span>Command argv (one argument per line)</span>
                <textarea
                  rows={3}
                  value={draft.command?.join("\n") ?? ""}
                  onChange={(event) => updateDraft({
                    command: event.currentTarget.value
                      ? event.currentTarget.value.split("\n").filter((argument) => argument.length > 0)
                      : undefined,
                  })}
                />
              </label>
              <label>
                <span>Stream provider</span>
                <select
                  value={draft.stream?.provider ?? ""}
                  onChange={(event) => {
                    const provider = event.currentTarget.value as MachineStreamConfig["provider"] | "";
                    updateStream(provider ? { provider } : null);
                  }}
                >
                  <option value="">none</option>
                  <option value="mediamtx">mediamtx</option>
                  <option value="moonlight-gateway">moonlight-gateway</option>
                </select>
              </label>
              <label>
                <span>Gateway URL</span>
                <input
                  type="url"
                  disabled={!draft.stream}
                  value={draft.stream?.gatewayUrl ?? ""}
                  onChange={(event) => updateStream({ gatewayUrl: optional(event.currentTarget.value) })}
                />
              </label>
              <label className="machine-manager-field-wide">
                <span>Gateway open URL</span>
                <input
                  type="url"
                  disabled={!draft.stream}
                  value={draft.stream?.gatewayOpenUrl ?? ""}
                  onChange={(event) => updateStream({ gatewayOpenUrl: optional(event.currentTarget.value) })}
                />
              </label>
            </div>
            <label className="settings-checkbox-row">
              <input
                type="checkbox"
                checked={draft.loadPowerShellProfile === true}
                onChange={(event) => updateDraft({ loadPowerShellProfile: event.currentTarget.checked || undefined })}
              />
              <span>Load PowerShell profile</span>
            </label>
            </fieldset>
            {existing?.hasAgentToken || existing?.hasGatewayToken ? (
              <div className="machine-manager-secret-state">
                Credentials retained: {[existing.hasAgentToken ? "agent" : "", existing.hasGatewayToken ? "gateway" : ""].filter(Boolean).join(", ")}.
                Tokens are never shown or accepted here.
              </div>
            ) : (
              <div className="machine-manager-secret-state">
                Credential provisioning remains manual; this editor never mints or displays tokens.
              </div>
            )}
          </section>

          <section className="settings-section machine-manager-registered">
            <h3>Dynamic registrations</h3>
            {catalog?.registeredHosts.length ? catalog.registeredHosts.map((host) => (
              <div key={host.id} className={`machine-manager-registration ${host.disabled ? "disabled" : ""}`}>
                <div>
                  <input
                    aria-label={`Label for ${host.id}`}
                    maxLength={80}
                    value={registrationNames[host.id] ?? host.machine.name}
                    onChange={(event) => {
                      const name = event.currentTarget.value;
                      setRegistrationNames((current) => ({ ...current, [host.id]: name }));
                    }}
                  />
                  <small>{host.id} / {host.observedAddress} / {host.active ? "[ONLINE]" : host.disabled ? "[DISABLED]" : "[OFFLINE]"}</small>
                </div>
                <button
                  type="button"
                  disabled={busy || !(registrationNames[host.id] ?? "").trim() || registrationNames[host.id] === host.machine.name}
                  onClick={() => void updateRegistered(host.id, { name: registrationNames[host.id]?.trim() })}
                >
                  [S] SAVE
                </button>
                <button type="button" disabled={busy} onClick={() => void updateRegistered(host.id, { disabled: !host.disabled })}>
                  {host.disabled ? "[A] ENABLE" : "[D] DISABLE"}
                </button>
                <button
                  type="button"
                  title={`Remove ${host.machine.name}`}
                  aria-label={`Remove ${host.machine.name}`}
                  disabled={busy}
                  onClick={() => void removeRegistered(host.id, host.machine.name)}
                >
                  [X]
                </button>
              </div>
            )) : <div className="machine-manager-secret-state">No dynamic registrations.</div>}
          </section>
        </div>
        {error ? <div className="settings-error machine-manager-error">{error}</div> : null}
        <div className="settings-actions">
          <button type="button" aria-label="Close" onClick={close}>[ESC] CLOSE</button>
          <button
            type="submit"
            aria-label={selectedId ? "Save machine" : "Add machine"}
            disabled={!catalog || busy || !draft.id || !draft.name}
          >
            {busy ? "[WAIT] SAVING" : selectedId ? "[S] SAVE MACHINE" : "[+] ADD MACHINE"}
          </button>
        </div>
      </form>
    </div>
  );
}

const optional = (value: string): string | undefined => value.trim() || undefined;
const optionalNumber = (value: string): number | undefined => value ? Number(value) : undefined;
