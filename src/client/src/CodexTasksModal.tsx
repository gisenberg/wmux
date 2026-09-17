import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConsoleDialog } from "./useConsoleDialog";
import { CodexTasksApiError, codexTasksApi } from "./codex-tasks-api";
import type {
  CodexTask,
  CodexTaskAssociation,
  CodexTaskDetail,
  CodexTaskEndpoint,
  CodexTaskLaunch,
  CodexTaskTarget,
} from "../../shared/codex-tasks";
import type { Workspace } from "./types";
import "./CodexTasksModal.css";

type TargetOption = CodexTaskTarget & { label: string; selectLabel: string };
type LaunchRecord = CodexTaskLaunch & { acknowledgedAt?: string };
const truncateGraphemes = (value: string, maximum: number) => {
  const graphemes = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value),
    ({ segment }) => segment,
  );
  return graphemes.length > maximum
    ? `${graphemes.slice(0, maximum).join("")}…`
    : value;
};
const compactTargetLabel = (workspace: Workspace, tab: Workspace["tabs"][number], pane: Workspace["tabs"][number]["panes"][number]) =>
  `${truncateGraphemes(workspace.name || "Workspace", 6)} / ${truncateGraphemes(tab.title || "Tab", 6)} [${pane.id.slice(-8)}]`;
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed";
const taskKey = (task: Pick<CodexTask, "endpointIdentity" | "threadId">) =>
  `${task.endpointIdentity}\u0000${task.threadId}`;
const identity = (task: CodexTask) =>
  `${task.endpointIdentity} · ${task.threadId}`;
const sampleAge = (sampledAt: string, now: number) => {
  const timestamp = Date.parse(sampledAt);
  if (!Number.isFinite(timestamp))
    return { label: "sample time unavailable", stale: true };
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  return { label: `sampled ${seconds}s ago`, stale: seconds > 30 };
};
const uuid = () => globalThis.crypto?.randomUUID?.() ?? null;
const launchIdsKey = "wmux.codex-launch-attempt-ids";
type RememberedLaunch = {
  requestId: string;
  endpointId: string;
  operation?: "attach";
  endpointIdentity?: string;
  threadId?: string;
  generation?: string;
  acknowledgedAt?: string;
};
const rememberedLaunches = (): RememberedLaunch[] => {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(launchIdsKey) ?? "[]",
    ) as unknown[];
    return value.filter(
      (item): item is RememberedLaunch =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof (item as RememberedLaunch).requestId === "string" &&
        typeof (item as RememberedLaunch).endpointId === "string" &&
        ((item as RememberedLaunch).operation !== "attach" ||
          (typeof (item as RememberedLaunch).endpointIdentity === "string" &&
            typeof (item as RememberedLaunch).threadId === "string" &&
            typeof (item as RememberedLaunch).generation === "string")),
    );
  } catch {
    return [];
  }
};
const rememberLaunch = (attempt: RememberedLaunch) => {
  try {
    const current = rememberedLaunches();
    sessionStorage.setItem(
      launchIdsKey,
      JSON.stringify(
        [
          ...current.filter((item) => item.requestId !== attempt.requestId),
          attempt,
        ].slice(-40),
      ),
    );
  } catch {
    /* persisted server attempts remain available */
  }
};

export function CodexTasksModal({
  workspaces,
  onClose,
  onOpenTarget,
}: {
  workspaces: Workspace[];
  onClose: () => void;
  onOpenTarget: (target: CodexTaskTarget) => void;
}) {
  const dialogRef = useConsoleDialog<HTMLElement>(onClose);
  const versions = useRef({ catalog: 0, page: 0, detail: 0 });
  const selectedKey = useRef<string | null>(null);
  const launchBusy = useRef(false);
  const [endpoints, setEndpoints] = useState<CodexTaskEndpoint[]>([]);
  const [endpointId, setEndpointId] = useState("");
  const [tasks, setTasks] = useState<CodexTask[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [archived, setArchived] = useState(false);
  const [selected, setSelected] = useState<CodexTask | null>(null);
  const [detail, setDetail] = useState<CodexTaskDetail | null>(null);
  const [associations, setAssociations] = useState<CodexTaskAssociation[]>([]);
  const [launches, setLaunches] = useState<LaunchRecord[]>([]);
  const [targetId, setTargetId] = useState("");
  const [cwd, setCwd] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const targets = useMemo<TargetOption[]>(
    () =>
      workspaces.flatMap((workspace) =>
        workspace.tabs.flatMap((tab) =>
          tab.panes.map((pane) => ({
            workspaceId: workspace.id,
            tabId: tab.id,
            paneId: pane.id,
            label: `${workspace.name} / ${tab.title} / ${pane.title} [${pane.id}]`,
            selectLabel: compactTargetLabel(workspace, tab, pane),
          })),
        ),
      ),
    [workspaces],
  );
  const endpoint = endpoints.find((item) => item.id === endpointId);
  const unsettledLaunch = launches.some(
    (item) =>
      item.endpointId === endpointId &&
      (item.status === "opening" ||
        (item.status === "unknown" && !item.acknowledgedAt)),
  );
  const unsettledExistingAttempts = selected
    ? launches.filter(
        (item) =>
          item.operation === "attach" &&
          item.endpointId === selected.endpointId &&
          item.endpointIdentity === selected.endpointIdentity &&
          item.threadId === selected.threadId &&
          (item.status === "opening" ||
            (item.status === "unknown" && !item.acknowledgedAt)),
      )
    : [];
  const unsettledExistingOpen = unsettledExistingAttempts.length > 0;
  const previousTerminal = unsettledExistingAttempts.find(item => item.target && targets.some(target =>
    target.workspaceId === item.target!.workspaceId && target.tabId === item.target!.tabId && target.paneId === item.target!.paneId))?.target;
  const removedTerminals = unsettledExistingOpen && unsettledExistingAttempts.every(item => item.target && !targets.some(target =>
    target.workspaceId === item.target!.workspaceId && target.tabId === item.target!.tabId && target.paneId === item.target!.paneId));
  const matchingAssociations = selected
    ? associations.filter(
        (item) =>
          item.endpointId === selected.endpointId &&
          item.endpointIdentity === selected.endpointIdentity &&
          item.threadId === selected.threadId,
      )
    : [];
  const selectedFreshness = selected
    ? sampleAge(selected.sampledAt, now)
    : null;

  const loadCatalog = useCallback(async () => {
    const version = ++versions.current.catalog;
    try {
      const [catalog, associationResponse, launchResponse] = await Promise.all([
        codexTasksApi.endpoints(),
        codexTasksApi.associations(),
        codexTasksApi.launches(),
      ]);
      if (version !== versions.current.catalog) return;
      setEndpoints(catalog.endpoints);
      setAssociations(associationResponse.associations);
      const remembered = new Map(
        rememberedLaunches().map((item) => [item.requestId, item]),
      );
      const serverLaunches = launchResponse.launches.map((item) =>
        item.status === "unknown" &&
        remembered.get(item.requestId)?.acknowledgedAt
          ? {
              ...item,
              acknowledgedAt: remembered.get(item.requestId)!.acknowledgedAt,
            }
          : item,
      );
      const known = new Set(
        launchResponse.launches.map((item) => item.requestId),
      );
      const missing = [...remembered.values()]
        .filter((item) => !known.has(item.requestId))
        .map((item) => ({
          requestId: item.requestId,
          endpointId: item.endpointId,
          ...(item.operation ? { operation: item.operation, endpointIdentity: item.endpointIdentity,
            threadId: item.threadId, generation: item.generation } : {}),
          status: "unknown" as const,
          target: null,
          reason: "launch outcome not listed; reconcile explicitly",
          createdAt: "unknown",
          ...(item.acknowledgedAt
            ? { acknowledgedAt: item.acknowledgedAt }
            : {}),
        }));
      setLaunches([...serverLaunches, ...missing]);
      setEndpointId((current) =>
        catalog.endpoints.some((item) => item.id === current)
          ? current
          : (catalog.endpoints[0]?.id ?? ""),
      );
    } catch (nextError) {
      if (version === versions.current.catalog) setError(errorText(nextError));
    }
  }, []);

  const loadPage = useCallback(
    async (nextCursor: string | null = null, append = false) => {
      if (!endpointId) return;
      const expected = endpointId;
      const version = ++versions.current.page;
      setLoading(true);
      setError("");
      try {
        const page = await codexTasksApi.list(expected, nextCursor, archived);
        if (version !== versions.current.page || expected !== endpointId)
          return;
        setEndpoints((current) =>
          current.map((item) =>
            item.id === page.endpoint.id ? page.endpoint : item,
          ),
        );
        setTasks((current) => {
          const rows = append ? [...current, ...page.tasks] : page.tasks;
          const unique = new Map<string, CodexTask>();
          rows.forEach((task) => unique.set(taskKey(task), task));
          return [...unique.values()].slice(0, 200);
        });
        setCursor(page.nextCursor);
      } catch (nextError) {
        if (version === versions.current.page) setError(errorText(nextError));
      } finally {
        if (version === versions.current.page) setLoading(false);
      }
    },
    [archived, endpointId],
  );

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);
  useEffect(() => {
    selectedKey.current = null;
    setTasks([]);
    setCursor(null);
    setSelected(null);
    setDetail(null);
    if (endpointId) void loadPage();
  }, [archived, endpointId, loadPage]);
  const refresh = () => {
    versions.current.page += 1;
    versions.current.detail += 1;
    selectedKey.current = null;
    setTasks([]);
    setCursor(null);
    setSelected(null);
    setDetail(null);
    void loadCatalog();
    if (endpointId) void loadPage();
  };
  const changeEndpoint = (value: string) => {
    versions.current.page += 1;
    versions.current.detail += 1;
    selectedKey.current = null;
    setEndpointId(value);
  };
  const changeArchived = (value: boolean) => {
    versions.current.page += 1;
    versions.current.detail += 1;
    selectedKey.current = null;
    setArchived(value);
  };
  const read = async (task: CodexTask, history = false) => {
    const version = ++versions.current.detail;
    const key = taskKey(task);
    selectedKey.current = key;
    setSelected(task);
    setDetail(null);
    setCwd((current) => current || task.cwd || "");
    setError("");
    try {
      const response = await codexTasksApi.read(
        task.endpointId,
        task.threadId,
        history,
      );
      if (version !== versions.current.detail || taskKey(task) !== key) return;
      if (selectedKey.current === key) {
        setSelected(response.task);
        setDetail(response);
      }
    } catch (nextError) {
      if (version === versions.current.detail) setError(errorText(nextError));
    }
  };
  const saveAssociation = async (association?: CodexTaskAssociation) => {
    if (
      !selected ||
      !targetId ||
      selected.stale ||
      sampleAge(selected.sampledAt, now).stale ||
      endpoint?.status !== "available"
    )
      return;
    const option = targets.find((item) => item.paneId === targetId);
    if (!option) return;
    const target = {
      workspaceId: option.workspaceId,
      tabId: option.tabId,
      paneId: option.paneId,
    };
    try {
      await codexTasksApi.associate({
        id: association?.id,
        endpointId: selected.endpointId,
        endpointIdentity: selected.endpointIdentity,
        threadId: selected.threadId,
        target,
      });
      setAssociations((await codexTasksApi.associations()).associations);
    } catch (nextError) {
      setError(errorText(nextError));
    }
  };
  const removeAssociation = async (association: CodexTaskAssociation) => {
    if (
      selected?.stale ||
      (selected && sampleAge(selected.sampledAt, now).stale) ||
      endpoint?.status !== "available"
    )
      return;
    try {
      await codexTasksApi.removeAssociation(association.id);
      setAssociations((current) =>
        current.filter((item) => item.id !== association.id),
      );
    } catch (nextError) {
      setError(errorText(nextError));
    }
  };
  const launch = async () => {
    if (!endpoint?.freshLaunch || !cwd.startsWith("/") || launchBusy.current)
      return;
    const requestId = uuid();
    if (!requestId) {
      setError(
        "New CLI view is unavailable because secure UUID generation is unavailable.",
      );
      return;
    }
    launchBusy.current = true;
    rememberLaunch({ requestId, endpointId: endpoint.id });
    try {
      const response = await codexTasksApi.launch(
        requestId,
        endpoint.id,
        endpoint.identity,
        cwd,
      );
      setLaunches((current) => [
        response.launch,
        ...current.filter((item) => item.requestId !== requestId),
      ]);
      if (response.launch.status === "opened" && response.launch.target)
        onOpenTarget(response.launch.target);
    } catch (nextError) {
      setError(
        `Launch outcome is uncertain for ${requestId}. Reconcile it; it was not submitted again. ${errorText(nextError)}`,
      );
      setLaunches((current) => [
        {
          requestId,
          endpointId: endpoint.id,
          status: "unknown",
          target: null,
          reason: "browser did not receive a launch response",
          createdAt: new Date().toISOString(),
        },
        ...current,
      ]);
    } finally {
      launchBusy.current = false;
    }
  };
  const openExisting = async (attempt?: RememberedLaunch) => {
    if (launchBusy.current) return;
    const candidate = attempt
      ? {
          requestId: attempt.requestId,
          endpointId: attempt.endpointId,
          endpointIdentity: attempt.endpointIdentity,
          threadId: attempt.threadId,
          generation: attempt.generation,
        }
      : detail?.resume.enabled && selected
        ? {
            requestId: uuid(),
            endpointId: selected.endpointId,
            endpointIdentity: selected.endpointIdentity,
            threadId: selected.threadId,
            generation: detail.resume.generation,
          }
        : null;
    if (
      !candidate?.requestId ||
      !candidate.endpointIdentity ||
      !candidate.threadId ||
      !candidate.generation
    )
      return;
    launchBusy.current = true;
    const remembered: RememberedLaunch = { ...candidate, operation: "attach" };
    rememberLaunch(remembered);
    try {
      const response = await codexTasksApi.attach({
        requestId: candidate.requestId,
        endpointId: candidate.endpointId,
        endpointIdentity: candidate.endpointIdentity,
        threadId: candidate.threadId,
        generation: candidate.generation,
      });
      setLaunches((current) => [
        response.launch,
        ...current.filter((item) => item.requestId !== candidate.requestId),
      ]);
      if (response.launch.status === "opened" && response.launch.target)
        onOpenTarget(response.launch.target);
    } catch (nextError) {
      setError(
        `Open outcome is uncertain for ${candidate.requestId}. Retry this same request or reconcile it; it was not submitted as a new attempt. ${errorText(nextError)}`,
      );
      setLaunches((current) => [
        {
          requestId: candidate.requestId!,
          endpointId: candidate.endpointId,
          endpointIdentity: candidate.endpointIdentity,
          operation: "attach",
          threadId: candidate.threadId,
          generation: candidate.generation,
          status: "unknown",
          target: null,
          reason: "browser did not receive an existing-task open response",
          createdAt: new Date().toISOString(),
        },
        ...current.filter((item) => item.requestId !== candidate.requestId),
      ]);
    } finally {
      launchBusy.current = false;
    }
  };
  const reconcile = async (requestId: string) => {
    try {
      const response = await codexTasksApi.reconcileLaunch(requestId);
      setLaunches((current) => [
        response.launch,
        ...current.filter((item) => item.requestId !== requestId),
      ]);
      if (response.launch.status === "opened" && response.launch.target)
        onOpenTarget(response.launch.target);
    } catch (nextError) {
      setError(errorText(nextError));
    }
  };
  const recoverExisting = async () => {
    if (launchBusy.current || !selected) return;
    launchBusy.current = true;
    setRecoveryBusy(true);
    setError("");
    const task = selected;
    try {
      // Recheck every attempt for this exact task. A recovered terminal wins
      // over creating another; a still-opening request cannot be acknowledged.
      const checked: CodexTaskLaunch[] = [];
      for (const attempt of unsettledExistingAttempts) {
        const { launch } = await codexTasksApi.reconcileLaunch(attempt.requestId);
        setLaunches(current => [launch, ...current.filter(item => item.requestId !== launch.requestId)]);
        if (launch.status === "opened" && launch.target) { onOpenTarget(launch.target); return; }
        if (launch.status !== "unknown") throw new Error("The earlier CLI is still opening. Check it again shortly.");
        checked.push(launch);
      }
      const fresh = await codexTasksApi.read(task.endpointId, task.threadId);
      if (!fresh.resume.enabled || !fresh.resume.generation || fresh.task.stale || fresh.task.endpointIdentity !== task.endpointIdentity)
        throw new Error(fresh.resume.reason || "The task is unavailable. Refresh before opening another CLI.");
      if (fresh.resume.target) { onOpenTarget(fresh.resume.target); return; }
      for (const launch of checked) {
        const { launch: acknowledged } = await codexTasksApi.acknowledgeLaunch(launch.requestId);
        rememberLaunch({ requestId: launch.requestId, endpointId: launch.endpointId,
          operation: "attach", endpointIdentity: launch.endpointIdentity, threadId: launch.threadId,
          generation: launch.generation, acknowledgedAt: acknowledged.acknowledgedAt });
      }
      const current = await codexTasksApi.launches();
      setLaunches(current.launches);
      const requestId = uuid();
      if (!requestId) throw new Error("A secure request ID is unavailable.");
      launchBusy.current = false;
      await openExisting({ requestId, endpointId: task.endpointId, endpointIdentity: task.endpointIdentity,
        operation: "attach", threadId: task.threadId, generation: fresh.resume.generation });
    } catch (nextError) { setError(errorText(nextError)); }
    finally { launchBusy.current = false; setRecoveryBusy(false); }
  };
  const acknowledge = async (requestId: string) => {
    try {
      const response = await codexTasksApi.acknowledgeLaunch(requestId);
      setLaunches((current) => [
        response.launch,
        ...current.filter((item) => item.requestId !== requestId),
      ]);
    } catch (nextError) {
      if (nextError instanceof CodexTasksApiError && nextError.status === 404) {
        const launch = launches.find((item) => item.requestId === requestId);
        if (launch) {
          const acknowledgedAt = new Date().toISOString();
          rememberLaunch({
            requestId,
            endpointId: launch.endpointId,
            acknowledgedAt,
          });
          setLaunches((current) =>
            current.map((item) =>
              item.requestId === requestId ? { ...item, acknowledgedAt } : item,
            ),
          );
          setError(
            "No recorded server attempt was found. This acknowledgement does not cancel delayed work or retry it.",
          );
          return;
        }
      }
      setError(errorText(nextError));
    }
  };
  return (
    <div
      className="codex-tasks-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        ref={dialogRef}
        className="codex-tasks-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Codex tasks"
      >
        <header>
          <div>
            <span>TASK CATALOG</span>
            <h2>CODEX TASKS</h2>
          </div>
          <button type="button" onClick={onClose}>
            [ESC] CLOSE
          </button>
        </header>
        <div className="codex-tasks-toolbar">
          <label>
            Execution host{" "}
            <select
              aria-label="Codex endpoint"
              value={endpointId}
              onChange={(event) => changeEndpoint(event.target.value)}
            >
              {endpoints.map((item) => (
                <option key={`${item.id}:${item.identity}`} value={item.id}>
                  {item.label} — {item.id}
                </option>
              ))}
            </select>
            <small className="codex-endpoint-identity">
              {endpoints.find((item) => item.id === endpointId)?.identity}
            </small>
          </label>
          <label>
            <input
              type="checkbox"
              checked={archived}
              onChange={(event) => changeArchived(event.target.checked)}
            />{" "}
            Archived
          </label>
          <button type="button" onClick={refresh} disabled={loading}>
            REFRESH
          </button>
        </div>
        {error ? (
          <p className="codex-tasks-error" role="alert">
            [ERR] {error}
          </p>
        ) : null}
        <div className="codex-tasks-grid">
          <div className="codex-task-list" aria-label="Codex task results">
            {tasks.length ? (
              tasks.map((task) => (
                <button
                  type="button"
                  className={
                    selected && taskKey(selected) === taskKey(task)
                      ? "selected"
                      : ""
                  }
                  key={taskKey(task)}
                  onClick={() => void read(task)}
                >
                  <strong title={task.name || "Untitled task"}>{task.name || "Untitled task"}</strong>
                  <small>{identity(task)}</small>
                  <span>
                    {task.status}
                    {task.stale || sampleAge(task.sampledAt, now).stale
                      ? " · stale"
                      : ""}{" "}
                    · {sampleAge(task.sampledAt, now).label} ·{" "}
                    {task.updatedAt
                      ? new Date(task.updatedAt).toLocaleString()
                      : "no update time"}
                  </span>
                  <em>{task.preview || "No preview"}</em>
                </button>
              ))
            ) : (
              <p>{loading ? "Loading catalog…" : "No tasks returned."}</p>
            )}
            {cursor ? (
              <button
                type="button"
                className="codex-load-more"
                onClick={() => void loadPage(cursor, true)}
                disabled={loading || tasks.length >= 200}
              >
                LOAD MORE
              </button>
            ) : null}
          </div>
          <aside className="codex-task-detail">
            {selected ? (
              <>
                <h3>{selected.name || "Untitled task"}</h3>
                <p className="codex-identity">{identity(selected)}</p>
                <dl>
                  <dt>Freshness</dt>
                  <dd>
                    {selected.stale || selectedFreshness?.stale
                      ? "stale"
                      : "current"}
                    ; {selectedFreshness?.label}
                  </dd>
                  <dt>Source/status</dt>
                  <dd>
                    {selected.source} / {selected.status}
                  </dd>
                  <dt>Working directory</dt>
                  <dd>{selected.cwd || "not reported"}</dd>
                  <dt>Model provider</dt>
                  <dd>{selected.modelProvider || "not reported"}</dd>
                  <dt>Parent thread</dt>
                  <dd>{selected.parentThreadId || "none"}</dd>
                  <dt>Latest native outcome</dt>
                  <dd>
                    {selected.latestTurn
                      ? `${selected.latestTurn.status} (${selected.latestTurn.id})`
                      : "not reported"}
                  </dd>
                </dl>
                {detail ? (
                  <>
                    {detail.resume.enabled || unsettledExistingOpen ? (
                      <section className="codex-existing-open">
                        <button
                          type="button"
                          disabled={unsettledExistingOpen || recoveryBusy || !detail.resume.enabled}
                          onClick={() => void openExisting()}
                        >
                          {detail.resume.target
                            ? "OPEN TERMINAL"
                            : "OPEN IN CLI"}
                        </button>
                        <small>
                          {detail.resume.target
                            ? "The verified terminal is rechecked before it is focused."
                            : "Opens this exact loaded task in a managed CLI view."}
                        </small>
                        {unsettledExistingOpen ? (
                          <div className="codex-open-recovery" role="group" aria-label="Recover CLI opening">
                            <p>{removedTerminals
                              ? "The previous wmux terminal was removed. Open a new CLI to continue viewing this task."
                              : "The earlier CLI could not be verified. Check it or view its terminal before opening another. Another CLI may still be running."}</p>
                            <button type="button" disabled={recoveryBusy}
                              onClick={() => void reconcile(unsettledExistingAttempts.at(-1)!.requestId)}>CHECK EXISTING CLI</button>
                            {previousTerminal ? <button type="button" disabled={recoveryBusy}
                              onClick={() => onOpenTarget(previousTerminal)}>VIEW PREVIOUS TERMINAL</button> : null}
                            <button type="button" disabled={recoveryBusy || !detail.resume.enabled || unsettledExistingAttempts.some(item => item.status === "opening")}
                              onClick={() => void recoverExisting()}>{recoveryBusy ? "CHECKING CLI…" : removedTerminals ? "OPEN A NEW CLI" : "OPEN ANOTHER CLI"}</button>
                            <small>Checks for an existing CLI first. If none can be verified, this clears the previous open warning and requests a new view. It does not stop another CLI or the task.</small>
                            {!detail.resume.enabled ? <p>Open unavailable: {detail.resume.reason}</p> : null}
                          </div>
                        ) : <p>Active tasks share the original task. Native input in any client affects that same task.</p>}
                      </section>
                    ) : (
                      <p className="codex-resume-disabled">
                        Open unavailable: {detail.resume.reason}
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={() => void read(selected, true)}
                    >
                      LOAD BOUNDED HISTORY
                    </button>
                    {detail.historyReason ? (
                      <p>{detail.historyReason}</p>
                    ) : null}
                    {detail.turns.map((turn) => (
                      <article key={turn.id}>
                        <strong>
                          {turn.status} · {turn.id}
                        </strong>
                        <p>
                          {turn.text}
                          {turn.truncated ? " [truncated]" : ""}
                        </p>
                      </article>
                    ))}
                  </>
                ) : (
                  <button type="button" onClick={() => void read(selected)}>
                    LOAD DETAILS
                  </button>
                )}
                <section className="codex-association">
                  <h3>OPTIONAL ACTIVITY ASSOCIATIONS</h3>
                  {matchingAssociations.map((association) => (
                    <div className="codex-association-row" key={association.id}>
                      <p>
                        {association.resolved
                          ? "Associated activity target"
                          : "Unresolved association"}
                        : {association.target.paneId}{" "}
                        {association.reason ? `— ${association.reason}` : ""}
                      </p>
                      <button
                        type="button"
                        onClick={() => onOpenTarget(association.target)}
                        disabled={!association.resolved}
                      >
                        OPEN DISPLAY TARGET
                      </button>
                      <button
                        type="button"
                        disabled={
                          !targetId ||
                          selected.stale ||
                          selectedFreshness?.stale ||
                          endpoint?.status !== "available"
                        }
                        onClick={() => void saveAssociation(association)}
                      >
                        MOVE
                      </button>
                      <button
                        type="button"
                        disabled={
                          selected.stale ||
                          selectedFreshness?.stale ||
                          endpoint?.status !== "available"
                        }
                        onClick={() => void removeAssociation(association)}
                      >
                        REMOVE
                      </button>
                    </div>
                  ))}
                  <label>
                    Pane target{" "}
                    <select
                      aria-label="Pane target"
                      value={targetId}
                      disabled={
                        selected.stale ||
                        selectedFreshness?.stale ||
                        endpoint?.status !== "available"
                      }
                      onChange={(event) => setTargetId(event.target.value)}
                    >
                      <option value="">Choose an exact pane</option>
                      {targets.map((target) => (
                        <option key={target.paneId} value={target.paneId}>
                          {target.selectLabel}
                        </option>
                      ))}
                    </select>
                    <small className="codex-target-identity">
                      {targets.find((target) => target.paneId === targetId)?.label}
                    </small>
                  </label>
                  <button
                    type="button"
                    disabled={
                      !targetId ||
                      selected.stale ||
                      selectedFreshness?.stale ||
                      endpoint?.status !== "available"
                    }
                    onClick={() => void saveAssociation()}
                  >
                    ASSOCIATE NEW
                  </button>
                  <small>
                    Associations optionally monitor activity and select a
                    display target. They do not establish a terminal binding,
                    title ownership, or input authority.
                  </small>
                </section>
              </>
            ) : (
              <p>
                Select a task to inspect its exact endpoint and thread identity.
                Native identity is unknown until a terminal binding verifies it.
              </p>
            )}
            <section className="codex-launch">
              <h3>START NEW TASK</h3>
              <label>
                Absolute working directory{" "}
                <input
                  aria-label="Absolute working directory"
                  value={cwd}
                  placeholder="/absolute/path"
                  onChange={(event) => setCwd(event.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={
                  !endpoint?.freshLaunch ||
                  !cwd.startsWith("/") ||
                  unsettledLaunch
                }
                onClick={() => void launch()}
              >
                START NEW TASK
              </button>
              <p>
                {unsettledLaunch
                  ? "Unavailable until the existing launch attempt is reconciled or explicitly acknowledged."
                  : endpoint?.freshLaunch
                    ? "Starts a separate CLI task view; it never sends a prompt."
                    : `Unavailable: ${endpoint?.launchReason || "no selected endpoint"}`}
              </p>
              <h3>RECENT LAUNCH ATTEMPTS</h3>
              {launches
                .filter((item) => item.endpointId === endpoint?.id)
                .sort(
                  (first, second) =>
                    (Date.parse(second.createdAt) || 0) -
                    (Date.parse(first.createdAt) || 0),
                )
                .slice(0, 8)
                .map((item) => (
                  <div className="codex-launch-row" key={item.requestId}>
                    <span>
                      {item.status} · {item.requestId}
                    </span>
                    <small>{item.reason || item.createdAt}</small>
                    {item.operation === "attach" ? (
                      <button
                        type="button"
                        onClick={() => void reconcile(item.requestId)}
                      >
                        INSPECT ATTACHMENT
                      </button>
                    ) : item.status === "opening" || item.status === "unknown" ? (
                      <button
                        type="button"
                        onClick={() => void reconcile(item.requestId)}
                      >
                        RECONCILE
                      </button>
                    ) : null}
                    {item.operation === "attach" &&
                    item.status === "unknown" &&
                    !item.acknowledgedAt ? (
                      <button
                        type="button"
                        onClick={() =>
                          void openExisting({
                            requestId: item.requestId,
                            endpointId: item.endpointId,
                            operation: "attach",
                            endpointIdentity: item.endpointIdentity,
                            threadId: item.threadId,
                            generation: item.generation,
                          })
                        }
                      >
                        RETRY SAME OPEN REQUEST
                      </button>
                    ) : null}
                    {item.operation !== "attach" &&
                    (item.status === "opened" || item.status === "unknown") &&
                    item.target ? (
                      <button
                        type="button"
                        onClick={() => onOpenTarget(item.target!)}
                      >
                        OPEN TARGET
                      </button>
                    ) : null}
                    {item.status === "unknown" && !item.acknowledgedAt ? (
                      <button
                        type="button"
                        onClick={() => void acknowledge(item.requestId)}
                      >
                        {item.operation === "attach"
                          ? "I INSPECTED THIS ATTACHMENT / ALLOW ANOTHER OPEN"
                          : "I INSPECTED THIS ATTEMPT / ALLOW ANOTHER CLI VIEW"}
                      </button>
                    ) : null}
                    {item.status === "unknown" && item.acknowledgedAt ? (
                      <small>
                        Unknown {item.operation === "attach" ? "attachment" : "attempt"} acknowledged; this does not cancel an
                        existing view or retry it.
                      </small>
                    ) : null}
                  </div>
                ))}
            </section>
          </aside>
        </div>
      </section>
    </div>
  );
}
