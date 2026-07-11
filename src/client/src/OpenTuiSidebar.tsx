import { useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import {
  createGrid,
  createOpenTuiPainter,
  fillCells,
  fitText,
  hexToRgba,
  observeCanvasViewport,
  syncPainterViewport,
  writeText,
  type CellGrid,
  type CellMetrics,
  type RGBA,
} from "./opentui-grid";
import { WMUX_MONO_FONT_FAMILY } from "./fonts";
import { compactMiddlePath } from "./path-display";

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
  agentStatus?: "running" | "completed" | "failed" | "updated";
  bell?: boolean;
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
}

type HitAction =
  | { type: "create-workspace" }
  | { type: "toggle-host-picker" }
  | { type: "target-machine"; machineId: string }
  | { type: "workspace"; workspaceId: string; tabId: string };

interface HitZone {
  row: number;
  col: number;
  width: number;
  action: HitAction;
  title: string;
}

const colors = {
  black: "#050505",
  panel: "#090909",
  active: "#17130a",
  activeSoft: "#100e08",
  gold: "#f4d35e",
  goldDim: "#a9944f",
  text: "#e4ded0",
  muted: "#8d826f",
  faint: "#5f584b",
  red: "#d94a3d",
  green: "#47d37c",
  blue: "#5aa9ff",
  agent: "#c792ea",
  runningSoft: "#061019",
  failedSoft: "#150806",
};

const rgba = Object.fromEntries(
  Object.entries(colors).map(([key, value]) => [key, hexToRgba(value)]),
) as Record<keyof typeof colors, RGBA>;

const runningFrames = ["|", "/", "-", "\\"];
const statusBullet = "•";
const reachColor = (reachable: boolean): RGBA => reachable ? rgba.green : rgba.red;

interface SidebarRenderModel {
  targetMachineId: string;
  targetMachineName: string;
  targetMachineReachable: boolean;
  hostPickerOpen: boolean;
  animationTick: number;
  workspaces: OpenTuiSidebarWorkspace[];
  machines: OpenTuiSidebarMachine[];
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
}: OpenTuiSidebarProps) {
  const [hostPickerOpen, setHostPickerOpen] = useState(false);
  const [animationTick, setAnimationTick] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hitsRef = useRef<HitZone[]>([]);
  const metricsRef = useRef<CellMetrics>({ width: 8, height: 16, cols: 1, rows: 1 });
  const paintRef = useRef<(() => void) | null>(null);
  const hasRunningWorkspace = workspaces.some((workspace) => workspace.agentStatus === "running");

  useEffect(() => {
    if (!hasRunningWorkspace) return;
    const timer = window.setInterval(() => setAnimationTick((value) => (value + 1) % runningFrames.length), 140);
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
    }),
    [animationTick, hostPickerOpen, machines, targetMachineId, targetMachineName, targetMachineReachable, workspaces],
  );
  const renderModelRef = useRef(renderModel);

  useEffect(() => {
    renderModelRef.current = renderModel;
    paintRef.current?.();
  }, [renderModel]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const painter = createOpenTuiPainter(canvas, {
      fontSize: 12,
      fontFamily: WMUX_MONO_FONT_FAMILY,
      cellVAlign: "middle",
      clearColor: colors.black,
    });

    const paint = (entry?: ResizeObserverEntry) => {
      const metrics = syncPainterViewport(painter, canvas, entry);
      metricsRef.current = metrics;
      painter.paint(drawSidebarGrid(metricsRef.current, renderModelRef.current, hitsRef));
    };

    paintRef.current = () => paint();
    paint();
    const observer = observeCanvasViewport(canvas, paint);
    return () => {
      paintRef.current = null;
      observer.disconnect();
      painter.dispose();
    };
  }, []);

  const onClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const row = Math.floor((event.clientY - rect.top) / metricsRef.current.height);
    const col = Math.floor((event.clientX - rect.left) / metricsRef.current.width);
    const hit = hitsRef.current.find((candidate) => candidate.row === row && col >= candidate.col && col < candidate.col + candidate.width);
    if (!hit) return;
    if (hit.action.type === "create-workspace") onCreateWorkspace();
    if (hit.action.type === "toggle-host-picker") setHostPickerOpen((value) => !value);
    if (hit.action.type === "target-machine") {
      onTargetMachineChange(hit.action.machineId);
      setHostPickerOpen(false);
    }
    if (hit.action.type === "workspace") onActivateWorkspace(hit.action.workspaceId, hit.action.tabId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const row = Math.floor((event.clientY - rect.top) / metricsRef.current.height);
    const col = Math.floor((event.clientX - rect.left) / metricsRef.current.width);
    const hit = hitsRef.current.find((candidate) => candidate.row === row && col >= candidate.col && col < candidate.col + candidate.width);
    canvas.style.cursor = hit ? "pointer" : "default";
    canvas.title = hit?.title ?? "";
  };

  return (
    <aside id="wmux-sidebar" className="sidebar open-tui-sidebar" aria-label="OpenTUI workspace navigation">
      <canvas ref={canvasRef} className="open-tui-canvas" onClick={onClick} onPointerMove={onPointerMove} />
    </aside>
  );
}

const drawSidebarGrid = (
  metrics: CellMetrics,
  model: SidebarRenderModel,
  hitsRef: MutableRefObject<HitZone[]>,
): CellGrid => {
  const { cols, rows } = metrics;
  const grid = createGrid(cols, rows, rgba.black, rgba.text);
  const hits: HitZone[] = [];
  hitsRef.current = hits;

  const fillRow = (row: number, color: RGBA) => {
    if (row < 0 || row >= rows) return;
    fillCells(grid, row, 0, cols, color);
  };
  const write = (row: number, col: number, text: string, color: RGBA, weight: 400 | 600 | 700 = 600) => {
    if (row < 0 || row >= rows || col >= cols) return;
    writeText(grid, row, col, fitText(text, Math.max(0, cols - col - 1)), color, weight >= 700 ? 1 : 0);
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
  const workspaceEndRow = rows - 1;
  let visibleWorkspaceCount = 0;
  if (model.workspaces.length === 0) {
    write(row, 3, "NO WORKSPACES", rgba.faint, 700);
    row += 2;
  } else {
    for (const workspace of model.workspaces) {
      const meta = workspace.descriptor;
      const hostContext = workspace.agentName ? `${workspace.host} / ${workspace.agentName}` : workspace.host;
      const descriptionLines = wrapText(meta, Math.max(8, cols - 7), 3);
      const cwd = workspace.cwd?.trim() ?? "";
      const itemRows = 1 + descriptionLines.length + 1 + (cwd ? 1 : 0);
      if (row + itemRows >= workspaceEndRow) break;
      const itemStart = row;
      const statusColor = workspace.agentStatus === "completed"
        ? rgba.green
        : workspace.agentStatus === "failed"
          ? rgba.red
          : workspace.agentStatus === "running"
            ? rgba.blue
            : reachColor(workspace.reachable);
      const statusMarker = workspace.agentStatus === "running" ? runningFrames[model.animationTick] : statusBullet;
      const inactiveBackground = workspace.agentStatus === "completed"
        ? rgba.black
        : workspace.agentStatus === "failed"
          ? rgba.failedSoft
          : workspace.agentStatus === "running"
            ? rgba.runningSoft
            : rgba.black;
      for (let offset = 0; offset < itemRows; offset += 1) {
        fillRow(row + offset, workspace.active ? (offset === 0 ? rgba.active : rgba.activeSoft) : inactiveBackground);
      }
      fillRow(row, workspace.active ? rgba.active : inactiveBackground);
      write(row, 1, workspace.active ? ">" : " ", workspace.active ? rgba.gold : rgba.faint, 700);
      write(row, 3, statusMarker, statusColor, 700);
      const titleCol = workspace.agentCreated ? 8 : 5;
      if (workspace.agentCreated) write(row, 5, "AI", rgba.agent, 700);
      write(row, titleCol, workspace.title, workspace.reachable ? rgba.text : rgba.muted, 700);
      if (workspace.unreadCount > 0) write(row, cols - 6, `(${workspace.unreadCount})`, rgba.gold, 700);
      row++;
      for (const line of descriptionLines) {
        if (workspace.bell && row === itemStart + 1) write(row, 3, "!", rgba.gold, 700);
        write(row, 5, line, rgba.muted);
        row++;
      }
      write(row, 5, `host ${hostContext}`, rgba.faint);
      row++;
      if (cwd) {
        writeCompactPath(row, 5, cwd);
        row++;
      }
      actionRows(
        itemStart,
        itemRows,
        workspace.agentCreated ? `${workspace.title} (agent-created)` : workspace.title,
        { type: "workspace", workspaceId: workspace.id, tabId: workspace.tabId },
      );
      visibleWorkspaceCount++;
    }
  }

  if (model.workspaces.length > visibleWorkspaceCount) {
    write(row, 3, `+${model.workspaces.length - visibleWorkspaceCount} more`, rgba.faint);
    row += 2;
  }

  return grid;
};

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
