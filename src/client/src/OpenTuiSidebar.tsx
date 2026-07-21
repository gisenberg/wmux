import { useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import {
  createGrid,
  createGridPainter,
  fillCells,
  fitText,
  observeCanvasViewport,
  syncPainterViewport,
  writeText,
  type CellGrid,
  type CellMetrics,
  type RGBA,
} from "./opentui-grid";
import { WMUX_MONO_FONT_FAMILY } from "./fonts";
import { loadMachineTargetPickerExpanded, persistMachineTargetPickerExpanded } from "./machine-target";
import { compactMiddlePath } from "./path-display";
import { workspaceTabPath } from "./route-state";
import { formatSessionReference } from "./session-reference";
import type { MachineVersionStatus, Workspace, WorkspaceReorderPosition } from "./types";
import { useOpenTuiTheme, type OpenTuiTheme } from "./color-scheme-context";
import { WorkspaceMoveDialog } from "./WorkspaceMoveDialog";
import { remainingWorkspaceRowCount, workspacePointerMovePosition, type WorkspaceAgentStatus, type WorkspaceMoveIntent } from "./workspace-tree";

export interface OpenTuiSidebarWorkspace {
  id: string;
  tabId: string;
  title: string;
  descriptor: string;
  host: string;
  cwd?: string;
  reachable: boolean;
  active: boolean;
  unreadCount: number;
  agentCreated?: boolean;
  agentName?: string;
  agentStatus?: "running" | "waiting" | "completed" | "failed" | "updated";
  sessionId?: string;
  versionStatus?: MachineVersionStatus;
  versionLabel?: string;
  versionDetail?: string;
  bell?: boolean;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  hiddenUnreadCount: number;
  hiddenBell: boolean;
  hiddenAgentStatus?: WorkspaceAgentStatus;
  canOutdent: boolean;
}

export interface OpenTuiSidebarMachine {
  id: string;
  name: string;
  version?: string;
  reachable: boolean;
  detail: string;
}

interface OpenTuiSidebarProps {
  targetMachineId: string;
  targetMachineName: string;
  targetMachineReachable: boolean;
  workspaces: OpenTuiSidebarWorkspace[];
  machines: OpenTuiSidebarMachine[];
  onTargetMachineChange: (machineId: string) => void;
  onCreateWorkspace: () => void;
  onActivateWorkspace: (workspaceId: string, tabId: string) => void;
  onReorderWorkspace: (
    workspaceId: string,
    targetWorkspaceId: string | undefined,
    position: WorkspaceReorderPosition,
  ) => void | Promise<void>;
  onToggleWorkspace: (workspaceId: string) => void | Promise<void>;
  movesDisabled: boolean;
  allWorkspaces: Workspace[];
  hostFilter: string;
  onHostFilterChange: (machineId: string) => void;
}

type HitAction =
  | { type: "create-workspace" }
  | { type: "toggle-host-picker" }
  | { type: "target-machine"; machineId: string }
  | { type: "workspace"; workspaceId: string; tabId: string }
  | { type: "toggle-workspace"; workspaceId: string }
  | { type: "outdent-workspace"; workspaceId: string }
  | { type: "cycle-host-filter" };

interface HitZone {
  row: number;
  col: number;
  width: number;
  action: HitAction;
  title: string;
}

const runningFrames = ["|", "/", "-", "\\"];
const statusBullet = "•";

interface SidebarRenderModel {
  targetMachineId: string;
  targetMachineName: string;
  targetMachineReachable: boolean;
  hostPickerOpen: boolean;
  animationTick: number;
  workspaces: OpenTuiSidebarWorkspace[];
  machines: OpenTuiSidebarMachine[];
  workspaceDropPreview: WorkspaceDropPreview | null;
  workspaceScrollOffset: number;
  hostFilter: string;
  movesDisabled: boolean;
}

interface WorkspaceDropPreview {
  workspaceId: string;
  targetWorkspaceId: string;
  position: WorkspaceReorderPosition;
}

interface WorkspacePointerDrag {
  pointerId: number;
  workspaceId: string;
  startX: number;
  startY: number;
  dragging: boolean;
  targetWorkspaceId?: string;
  position?: WorkspaceReorderPosition;
}

interface SemanticWorkspaceRow {
  workspace: OpenTuiSidebarWorkspace;
  row: number;
  rowCount: number;
}

export function OpenTuiSidebar({
  targetMachineId,
  targetMachineName,
  targetMachineReachable,
  workspaces,
  machines,
  onTargetMachineChange,
  onCreateWorkspace,
  onActivateWorkspace,
  onReorderWorkspace,
  onToggleWorkspace,
  movesDisabled,
  allWorkspaces,
  hostFilter,
  onHostFilterChange,
}: OpenTuiSidebarProps) {
  const theme = useOpenTuiTheme();
  const [hostPickerOpen, setHostPickerOpen] = useState(() => loadMachineTargetPickerExpanded(window.localStorage));
  const [animationTick, setAnimationTick] = useState(0);
  const [workspaceDropPreview, setWorkspaceDropPreview] = useState<WorkspaceDropPreview | null>(null);
  const [workspaceScrollOffset, setWorkspaceScrollOffset] = useState(0);
  const [moveWorkspace, setMoveWorkspace] = useState<{ workspaceId: string; returnFocus: HTMLElement | null } | null>(null);
  const [semanticRows, setSemanticRows] = useState<SemanticWorkspaceRow[]>([]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hitsRef = useRef<HitZone[]>([]);
  const metricsRef = useRef<CellMetrics>({ width: 8, height: 16, cols: 1, rows: 1 });
  const paintRef = useRef<(() => void) | null>(null);
  const workspaceDragRef = useRef<WorkspacePointerDrag | null>(null);
  const suppressClickRef = useRef(false);
  const hasRunningWorkspace = workspaces.some((workspace) => workspace.agentStatus === "running");

  useEffect(() => {
    setWorkspaceScrollOffset((value) => Math.min(value, Math.max(0, workspaces.length - 1)));
  }, [workspaces.length]);

  useEffect(() => {
    persistMachineTargetPickerExpanded(window.localStorage, hostPickerOpen);
  }, [hostPickerOpen]);

  useEffect(() => {
    if (!hasRunningWorkspace) return;
    const timer = window.setInterval(() => setAnimationTick((value) => (value + 1) % runningFrames.length), 280);
    return () => window.clearInterval(timer);
  }, [hasRunningWorkspace]);

  const renderModel = useMemo<SidebarRenderModel>(
    () => ({
      targetMachineId,
      targetMachineName,
      targetMachineReachable,
      hostPickerOpen,
      animationTick,
      workspaces,
      machines,
      workspaceDropPreview,
      workspaceScrollOffset,
      hostFilter,
      movesDisabled,
    }),
    [animationTick, hostFilter, hostPickerOpen, machines, movesDisabled, targetMachineId, targetMachineName, targetMachineReachable, workspaceDropPreview, workspaceScrollOffset, workspaces],
  );
  const renderModelRef = useRef(renderModel);

  useEffect(() => {
    renderModelRef.current = renderModel;
    paintRef.current?.();
  }, [renderModel]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const painter = createGridPainter(canvas, {
      fontSize: 12,
      fontFamily: WMUX_MONO_FONT_FAMILY,
      cellVAlign: "middle",
      clearColor: theme.colors.black,
    });

    const paint = (entry?: ResizeObserverEntry) => {
      const metrics = syncPainterViewport(painter, canvas, entry);
      metricsRef.current = metrics;
      const result = drawSidebarGrid(metricsRef.current, renderModelRef.current, hitsRef, theme);
      painter.paint(result.grid);
      setSemanticRows((current) => sameSemanticRows(current, result.semanticRows) ? current : result.semanticRows);
    };

    paintRef.current = () => paint();
    paint();
    const observer = observeCanvasViewport(canvas, paint);
    return () => {
      paintRef.current = null;
      observer.disconnect();
      painter.dispose();
    };
  }, [theme]);

  const hitAt = (clientX: number, clientY: number): HitZone | undefined => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const rect = canvas.getBoundingClientRect();
    const row = Math.floor((clientY - rect.top) / metricsRef.current.height);
    const col = Math.floor((clientX - rect.left) / metricsRef.current.width);
    return hitsRef.current.find((candidate) => candidate.row === row && col >= candidate.col && col < candidate.col + candidate.width);
  };

  const onClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const hit = hitAt(event.clientX, event.clientY);
    if (!hit) return;
    if (hit.action.type === "create-workspace") onCreateWorkspace();
    if (hit.action.type === "toggle-host-picker") setHostPickerOpen((value) => !value);
    if (hit.action.type === "target-machine") {
      onTargetMachineChange(hit.action.machineId);
      setHostPickerOpen(false);
    }
    if (hit.action.type === "workspace") onActivateWorkspace(hit.action.workspaceId, hit.action.tabId);
    if (hit.action.type === "toggle-workspace") void onToggleWorkspace(hit.action.workspaceId);
    if (hit.action.type === "outdent-workspace" && !movesDisabled) void onReorderWorkspace(hit.action.workspaceId, undefined, "out-of");
    if (hit.action.type === "cycle-host-filter") {
      const choices = ["all", ...machines.map((machine) => machine.id)];
      onHostFilterChange(choices[(choices.indexOf(hostFilter) + 1) % choices.length]);
      setWorkspaceScrollOffset(0);
    }
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || movesDisabled) return;
    const hit = hitAt(event.clientX, event.clientY);
    if (hit?.action.type !== "workspace") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    workspaceDragRef.current = {
      pointerId: event.pointerId,
      workspaceId: hit.action.workspaceId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const drag = workspaceDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      if (!drag.dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 5) {
        drag.dragging = true;
        suppressClickRef.current = true;
      }
      if (drag.dragging) {
        event.preventDefault();
        const hit = hitAt(event.clientX, event.clientY);
        if (hit?.action.type === "workspace" && hit.action.workspaceId !== drag.workspaceId) {
          const targetWorkspaceId = hit.action.workspaceId;
          const targetRows = hitsRef.current
            .filter((candidate) => candidate.action.type === "workspace" && candidate.action.workspaceId === targetWorkspaceId)
            .map((candidate) => candidate.row);
          const firstRow = Math.min(...targetRows);
          const lastRow = Math.max(...targetRows);
          const relativeRow = (hit.row - firstRow + 0.5) / Math.max(1, lastRow - firstRow + 1);
          const position = workspacePointerMovePosition(relativeRow);
          drag.targetWorkspaceId = targetWorkspaceId;
          drag.position = position;
          const nextPreview = {
            workspaceId: drag.workspaceId,
            targetWorkspaceId,
            position,
          };
          setWorkspaceDropPreview((current) =>
            current?.workspaceId === nextPreview.workspaceId &&
            current.targetWorkspaceId === nextPreview.targetWorkspaceId &&
            current.position === nextPreview.position
              ? current
              : nextPreview,
          );
        } else {
          drag.targetWorkspaceId = undefined;
          drag.position = undefined;
          setWorkspaceDropPreview(null);
        }
        canvas.style.cursor = "grabbing";
        canvas.title = "Reorder workspace";
        return;
      }
    }
    const hit = hitAt(event.clientX, event.clientY);
    canvas.style.cursor = hit ? "pointer" : "default";
    canvas.title = hit?.action.type === "workspace" ? `${hit.title} / drag to reorder` : hit?.title ?? "";
  };

  const finishWorkspaceDrag = (event: React.PointerEvent<HTMLCanvasElement>, cancelled = false) => {
    const drag = workspaceDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    workspaceDragRef.current = null;
    setWorkspaceDropPreview(null);
    event.currentTarget.style.cursor = "default";
    event.currentTarget.title = "";
    if (drag.dragging) window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
    if (!cancelled && drag.dragging && drag.targetWorkspaceId && drag.position) {
      void onReorderWorkspace(drag.workspaceId, drag.targetWorkspaceId, drag.position);
    }
  };

  return (
    <aside id="wmux-sidebar" className="sidebar open-tui-sidebar" aria-label="Workspace navigation">
      <canvas
        ref={canvasRef}
        className="open-tui-canvas"
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishWorkspaceDrag}
        onPointerCancel={(event) => finishWorkspaceDrag(event, true)}
        onWheel={(event) => {
          if (event.deltaY === 0 || workspaces.length === 0) return;
          event.preventDefault();
          setWorkspaceScrollOffset((value) => Math.max(0, Math.min(workspaces.length - 1, value + (event.deltaY > 0 ? 1 : -1))));
        }}
      />
      <div className="open-tui-sidebar-semantics">
        <button
          type="button"
          className="open-tui-filter-semantic"
          aria-label={`Workspace host filter: ${hostFilter === "all" ? "all hosts" : machines.find((machine) => machine.id === hostFilter)?.name ?? hostFilter}. Activate for next filter.`}
          onClick={() => {
            const choices = ["all", ...machines.map((machine) => machine.id)];
            onHostFilterChange(choices[(choices.indexOf(hostFilter) + 1) % choices.length]);
            setWorkspaceScrollOffset(0);
          }}
        />
        <div role="tree" aria-label="Workspace tree">
        {semanticRows.map(({ workspace, row, rowCount }) => (
          <div
            key={workspace.id}
            className="open-tui-semantic-row"
            style={{ top: row * metricsRef.current.height, height: rowCount * metricsRef.current.height }}
          >
            <a
              href={workspaceTabPath(workspace.id, workspace.tabId)}
              role="treeitem"
              aria-level={workspace.depth + 1}
              aria-current={workspace.active ? "page" : undefined}
              aria-expanded={workspace.hasChildren ? workspace.expanded : undefined}
              aria-label={`${workspace.title}${workspace.hiddenUnreadCount ? `, ${workspace.hiddenUnreadCount} hidden unread` : ""}${workspace.hiddenAgentStatus ? `, hidden descendant agent status ${workspace.hiddenAgentStatus}` : ""}`}
              onClick={(event) => {
                if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                onActivateWorkspace(workspace.id, workspace.tabId);
              }}
            />
            {workspace.hasChildren ? (
              <button className="semantic-disclosure" type="button" aria-label={`${workspace.expanded ? "Collapse" : "Expand"} ${workspace.title}`} onClick={() => void onToggleWorkspace(workspace.id)} />
            ) : null}
            {!movesDisabled ? <button className="semantic-move" type="button" aria-label={`Move ${workspace.title}`} onClick={(event) => setMoveWorkspace({ workspaceId: workspace.id, returnFocus: event.currentTarget })} /> : null}
          </div>
        ))}
        </div>
      </div>
      {moveWorkspace ? (
        <WorkspaceMoveDialog
          workspaceId={moveWorkspace.workspaceId}
          workspaces={allWorkspaces}
          returnFocus={moveWorkspace.returnFocus}
          onClose={() => setMoveWorkspace(null)}
          onMove={(intent: WorkspaceMoveIntent) => onReorderWorkspace(intent.workspaceId, intent.targetWorkspaceId, intent.position)}
        />
      ) : null}
    </aside>
  );
}

const drawSidebarGrid = (
  metrics: CellMetrics,
  model: SidebarRenderModel,
  hitsRef: MutableRefObject<HitZone[]>,
  theme: OpenTuiTheme,
): { grid: CellGrid; semanticRows: SemanticWorkspaceRow[] } => {
  const { rgba } = theme;
  const agentStatusColors = {
    completed: rgba.green,
    failed: rgba.red,
    running: rgba.blue,
    updated: rgba.gold,
    waiting: rgba.gold,
  };
  const inactiveAgentBackgrounds = {
    completed: rgba.black,
    failed: rgba.failedSoft,
    running: rgba.runningSoft,
    updated: rgba.black,
    waiting: rgba.activeSoft,
  };
  const reachColor = (reachable: boolean): RGBA => reachable ? rgba.green : rgba.red;
  const { cols, rows } = metrics;
  const grid = createGrid(cols, rows, rgba.black, rgba.text);
  const hits: HitZone[] = [];
  const semanticRows: SemanticWorkspaceRow[] = [];
  hitsRef.current = hits;

  const fillRow = (row: number, color: RGBA) => {
    if (row < 0 || row >= rows) return;
    fillCells(grid, row, 0, cols, color);
  };
  const write = (row: number, col: number, text: string, color: RGBA, weight: 400 | 600 | 700 = 600) => {
    if (row < 0 || row >= rows || col >= cols) return;
    writeText(grid, row, col, fitText(text, Math.max(0, cols - col - 1)), color, weight >= 700 ? 1 : 0);
  };
  const writeWithin = (
    row: number,
    col: number,
    text: string,
    maxCells: number,
    color: RGBA,
    weight: 400 | 600 | 700 = 600,
  ) => {
    if (row < 0 || row >= rows || col >= cols || maxCells <= 0) return;
    writeText(grid, row, col, fitText(text, maxCells), color, weight >= 700 ? 1 : 0);
  };
  const writeCompactPath = (row: number, col: number, pathValue: string) => {
    const maxPathCells = Math.max(0, cols - col - 1);
    const compact = compactMiddlePath(pathValue, maxPathCells);
    let cursor = col;
    if (!compact.compacted) {
      write(row, cursor, compact.text, rgba.muted, 700);
      return;
    }
    write(row, cursor, compact.prefix, rgba.muted, 700);
    cursor += compact.prefix.length;
    write(row, cursor, compact.marker, rgba.faint, 600);
    cursor += compact.marker.length;
    write(row, cursor, compact.suffix, rgba.muted, 700);
  };
  const section = (row: number, label: string) => {
    write(row, 1, label.toUpperCase(), rgba.goldDim, 700);
  };
  const actionCells = (row: number, col: number, width: number, title: string, action: HitAction) => {
    if (row >= 0 && row < rows && width > 0) hits.push({ row, col, width, title, action });
  };
  const actionRows = (startRow: number, count: number, title: string, action: HitAction) => {
    for (let offset = 0; offset < count; offset += 1) {
      actionCells(startRow + offset, 0, cols, title, action);
    }
  };

  let row = 1;
  write(row, 1, "WMUX", rgba.gold, 700);
  row += 2;

  section(row, "target host");
  row++;
  fillRow(row, rgba.panel);
  write(row, 1, model.hostPickerOpen ? "^" : "v", rgba.gold, 700);
  write(row, 3, statusBullet, reachColor(model.targetMachineReachable), 700);
  write(row, 5, model.targetMachineName, model.targetMachineReachable ? rgba.text : rgba.muted);
  write(row, cols - 4, "+", model.targetMachineReachable ? rgba.gold : rgba.faint, 700);
  actionCells(row, 0, Math.max(1, cols - 5), "Pick target host", { type: "toggle-host-picker" });
  if (model.targetMachineReachable) {
    actionCells(row, Math.max(0, cols - 5), 5, `New workspace on ${model.targetMachineName}`, { type: "create-workspace" });
  }
  row++;
  if (model.hostPickerOpen) {
    for (const machine of model.machines) {
      if (row >= rows - 4) break;
      const activeTarget = machine.id === model.targetMachineId;
      fillRow(row, activeTarget ? rgba.active : rgba.black);
      write(row, 2, activeTarget ? ">" : " ", activeTarget ? rgba.gold : rgba.faint, 700);
      write(row, 4, statusBullet, reachColor(machine.reachable), 700);
      const versionedName = machine.version ? `${machine.name}@${machine.version}` : machine.name;
      write(row, 6, versionedName, machine.reachable ? rgba.text : rgba.muted, activeTarget ? 700 : 600);
      actionCells(row, 0, cols, `Target ${machine.name}`, { type: "target-machine", machineId: machine.id });
      row++;
      write(row, 6, machine.detail, machine.reachable ? rgba.faint : rgba.red);
      actionCells(row, 0, cols, `Target ${machine.name}`, { type: "target-machine", machineId: machine.id });
      row++;
    }
  }
  row++;

  section(row, "workspaces");
  row++;
  const filterName = model.hostFilter === "all"
    ? "all hosts"
    : model.machines.find((machine) => machine.id === model.hostFilter)?.name ?? model.hostFilter;
  write(row, 3, `filter: ${filterName}`, model.hostFilter === "all" ? rgba.faint : rgba.goldDim, 700);
  actionCells(row, 0, cols, `Workspace filter: ${filterName}; click for next`, { type: "cycle-host-filter" });
  row += 2;
  const workspaceEndRow = rows - 1;
  let visibleWorkspaceCount = 0;
  if (model.workspaces.length === 0) {
    write(row, 3, "NO WORKSPACES", rgba.faint, 700);
    row += 2;
  } else {
    for (const workspace of model.workspaces.slice(model.workspaceScrollOffset)) {
      const meta = workspace.descriptor;
      const hostContext = workspace.agentName ? `${workspace.host} / ${workspace.agentName}` : workspace.host;
      const descriptionLines = wrapText(meta, Math.max(8, cols - 7), 3);
      const cwd = workspace.cwd?.trim() ?? "";
      const itemRows = 1 + descriptionLines.length + 1 + (cwd ? 1 : 0);
      if (row + itemRows >= workspaceEndRow) break;
      const itemStart = row;
      const statusColor = workspace.agentStatus
        ? agentStatusColors[workspace.agentStatus]
        : reachColor(workspace.reachable);
      const statusMarker = workspace.agentStatus === "running"
        ? runningFrames[model.animationTick]
        : workspace.agentStatus === "waiting"
          ? "?"
          : statusBullet;
      const inactiveBackground = workspace.agentStatus
        ? inactiveAgentBackgrounds[workspace.agentStatus]
        : rgba.black;
      for (let offset = 0; offset < itemRows; offset += 1) {
        fillRow(row + offset, workspace.active ? (offset === 0 ? rgba.active : rgba.activeSoft) : inactiveBackground);
      }
      fillRow(row, workspace.active ? rgba.active : inactiveBackground);
      const indent = Math.min(workspace.depth, 3) * 2;
      write(row, 1, workspace.active ? ">" : " ", workspace.active ? rgba.gold : rgba.faint, 700);
      if (workspace.hasChildren) {
        write(row, 3 + indent, workspace.expanded ? "v" : ">", rgba.goldDim, 700);
        actionCells(row, 3 + indent, 1, workspace.expanded ? `Collapse ${workspace.title}` : `Expand ${workspace.title}`, { type: "toggle-workspace", workspaceId: workspace.id });
      }
      write(row, 5 + indent, statusMarker, statusColor, 700);
      const titleCol = workspace.agentCreated ? 10 + indent : 7 + indent;
      if (workspace.agentCreated) write(row, 7 + indent, "AI", rgba.agent, 700);
      const aggregateUnread = workspace.unreadCount + workspace.hiddenUnreadCount;
      const unreadText = aggregateUnread > 0 ? `(${aggregateUnread}${workspace.hiddenUnreadCount ? "*" : ""})` : "";
      const versionText = workspace.versionStatus === "outdated" && workspace.versionLabel
        ? `[${workspace.versionLabel}]`
        : "";
      const hiddenStatusText = workspace.hiddenAgentStatus ? `↳${agentStatusAbbreviation[workspace.hiddenAgentStatus]}` : "";
      let suffixCol = cols - 1;
      if (unreadText) {
        suffixCol -= unreadText.length;
        write(row, suffixCol, unreadText, rgba.gold, 700);
      }
      if (versionText) {
        if (unreadText) suffixCol--;
        suffixCol -= versionText.length;
        const versionColor = workspace.versionStatus === "current"
          ? rgba.green
          : workspace.versionStatus === "outdated"
            ? rgba.gold
            : rgba.muted;
        write(row, suffixCol, versionText, versionColor, 700);
      }
      if (hiddenStatusText) {
        if (unreadText || versionText) suffixCol--;
        suffixCol -= hiddenStatusText.length;
        write(row, suffixCol, hiddenStatusText, agentStatusColors[workspace.hiddenAgentStatus!], 700);
      }
      writeWithin(
        row,
        titleCol,
        workspace.title,
        Math.max(0, suffixCol - titleCol - 1),
        workspace.reachable ? rgba.text : rgba.muted,
        700,
      );
      if (workspace.canOutdent && !model.movesDisabled) {
        write(row, Math.max(titleCol, suffixCol - 2), "<", rgba.goldDim, 700);
        actionCells(row, Math.max(titleCol, suffixCol - 2), 1, `Move ${workspace.title} out one level`, { type: "outdent-workspace", workspaceId: workspace.id });
      }
      row++;
      for (const line of descriptionLines) {
        if ((workspace.bell || workspace.hiddenBell) && row === itemStart + 1) write(row, 5 + indent, workspace.hiddenBell ? "!*" : "!", rgba.gold, 700);
        write(row, 7 + indent, line, rgba.muted);
        row++;
      }
      write(row, 7 + indent, `host ${hostContext}`, rgba.faint);
      row++;
      if (cwd) {
        writeCompactPath(row, 7 + indent, cwd);
        row++;
      }
      actionRows(
        itemStart,
        itemRows,
        [
          workspace.agentCreated ? `${workspace.title} (agent-created)` : workspace.title,
          workspace.versionDetail,
          formatSessionReference(workspace.sessionId),
        ].filter(Boolean).join(" / "),
        { type: "workspace", workspaceId: workspace.id, tabId: workspace.tabId },
      );
      semanticRows.push({ workspace, row: itemStart, rowCount: itemRows });
      if (model.workspaceDropPreview?.targetWorkspaceId === workspace.id) {
        const previewPosition = model.workspaceDropPreview.position;
        const indicatorRow = previewPosition === "before" ? itemStart : previewPosition === "into" ? itemStart + Math.floor(itemRows / 2) : row - 1;
        write(indicatorRow, Math.max(0, cols - 4), previewPosition === "before" ? "^^" : previewPosition === "into" ? "[+]" : "vv", rgba.gold, 700);
      }
      visibleWorkspaceCount++;
    }
  }

  const remainingWorkspaceCount = remainingWorkspaceRowCount(model.workspaces.length, model.workspaceScrollOffset, visibleWorkspaceCount);
  if (remainingWorkspaceCount > 0) {
    write(row, 3, `+${remainingWorkspaceCount} more`, rgba.faint);
    row += 2;
  }

  return { grid, semanticRows };
};

const agentStatusAbbreviation: Record<WorkspaceAgentStatus, string> = {
  running: "R",
  waiting: "W",
  completed: "C",
  failed: "F",
  updated: "U",
};

const sameSemanticRows = (left: SemanticWorkspaceRow[], right: SemanticWorkspaceRow[]): boolean =>
  left.length === right.length && left.every((row, index) => {
    const candidate = right[index];
    return candidate && row.workspace === candidate.workspace && row.row === candidate.row && row.rowCount === candidate.rowCount;
  });

const wrapText = (text: string, maxCells: number, maxLines: number): string[] => {
  if (maxCells <= 0 || maxLines <= 0) return [];
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const safeWord = word.length > maxCells ? word.slice(0, maxCells) : word;
    const next = current ? `${current} ${safeWord}` : safeWord;
    if (next.length <= maxCells) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    current = safeWord;
    if (lines.length === maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines.slice(0, maxLines).map((line) => fitText(line, maxCells));
};
