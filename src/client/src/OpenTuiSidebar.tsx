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

export interface OpenTuiSidebarWorkspace {
  id: string;
  tabId: string;
  title: string;
  descriptor: string;
  host: string;
  reachable: boolean;
  active: boolean;
  unreadCount: number;
  agentLabel?: string;
}

export interface OpenTuiSidebarMachine {
  id: string;
  name: string;
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
};

const rgba = Object.fromEntries(
  Object.entries(colors).map(([key, value]) => [key, hexToRgba(value)]),
) as Record<keyof typeof colors, RGBA>;

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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hitsRef = useRef<HitZone[]>([]);
  const metricsRef = useRef<CellMetrics>({ width: 8, height: 16, cols: 1, rows: 1 });

  const renderModel = useMemo(
    () => ({
      targetMachineId,
      targetMachineName,
      targetMachineReachable,
      hostPickerOpen,
      workspaces,
      machines,
    }),
    [hostPickerOpen, machines, targetMachineId, targetMachineName, targetMachineReachable, workspaces],
  );

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
      painter.paint(drawSidebarGrid(metricsRef.current, renderModel, hitsRef));
    };

    paint();
    const observer = observeCanvasViewport(canvas, paint);
    return () => {
      observer.disconnect();
      painter.dispose();
    };
  }, [renderModel]);

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
    <aside className="sidebar open-tui-sidebar" aria-label="OpenTUI workspace navigation">
      <canvas ref={canvasRef} className="open-tui-canvas" onClick={onClick} onPointerMove={onPointerMove} />
    </aside>
  );
}

const drawSidebarGrid = (
  metrics: CellMetrics,
  model: {
    targetMachineId: string;
    targetMachineName: string;
    targetMachineReachable: boolean;
    hostPickerOpen: boolean;
    workspaces: OpenTuiSidebarWorkspace[];
    machines: OpenTuiSidebarMachine[];
  },
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
  write(row, 1, `${model.hostPickerOpen ? "[^]" : "[v]"} ${model.targetMachineReachable ? "[on] " : "[--] "}${model.targetMachineName}`, model.targetMachineReachable ? rgba.text : rgba.muted);
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
      write(row, 2, `${activeTarget ? ">" : " "} ${machine.reachable ? "[on]" : "[--]"} ${machine.name}`, machine.reachable ? rgba.text : rgba.muted, activeTarget ? 700 : 600);
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
  const workspaceEndRow = rows - Math.min(rows, model.machines.length * 2 + 4);
  let visibleWorkspaceCount = 0;
  if (model.workspaces.length === 0) {
    write(row, 3, "NO WORKSPACES", rgba.faint, 700);
    row += 2;
  } else {
    for (const workspace of model.workspaces) {
      const meta = workspace.agentLabel ? `${workspace.agentLabel}  ${workspace.descriptor}` : workspace.descriptor;
      const descriptionLines = wrapText(meta || "No description", Math.max(8, cols - 7), 3);
      const itemRows = 1 + descriptionLines.length + 1;
      if (row + itemRows >= workspaceEndRow) break;
      const itemStart = row;
      for (let offset = 0; offset < itemRows; offset += 1) {
        fillRow(row + offset, workspace.active ? (offset === 0 ? rgba.active : rgba.activeSoft) : rgba.black);
      }
      fillRow(row, workspace.active ? rgba.active : rgba.black);
      write(row, 1, workspace.active ? ">" : " ", workspace.active ? rgba.gold : rgba.faint, 700);
      write(row, 3, `${workspace.reachable ? "[on]" : "[--]"} ${workspace.title}`, workspace.reachable ? rgba.text : rgba.muted, 700);
      if (workspace.unreadCount > 0) write(row, cols - 6, `(${workspace.unreadCount})`, rgba.gold, 700);
      row++;
      for (const line of descriptionLines) {
        write(row, 5, line, rgba.muted);
        row++;
      }
      write(row, 5, `host ${workspace.host}`, rgba.faint);
      row++;
      actionRows(itemStart, itemRows, workspace.title, { type: "workspace", workspaceId: workspace.id, tabId: workspace.tabId });
      visibleWorkspaceCount++;
    }
  }

  if (model.workspaces.length > visibleWorkspaceCount) {
    write(row, 3, `+${model.workspaces.length - visibleWorkspaceCount} more`, rgba.faint);
    row += 2;
  }

  row = Math.max(row + 1, rows - Math.min(rows, model.machines.length * 2 + 3));
  section(row, "host status");
  row++;
  for (const machine of model.machines) {
    if (row >= rows - 1) break;
    const activeTarget = machine.id === model.targetMachineId;
    fillRow(row, activeTarget ? rgba.active : rgba.black);
    write(row, 1, activeTarget ? ">" : " ", activeTarget ? rgba.gold : rgba.faint, 700);
    write(row, 3, `${machine.reachable ? "[on]" : "[--]"} ${machine.name}`, machine.reachable ? rgba.text : rgba.muted, 700);
    actionCells(row, 0, cols, `Target ${machine.name}`, { type: "target-machine", machineId: machine.id });
    row++;
    write(row, 5, machine.detail, machine.reachable ? rgba.faint : rgba.red);
    row++;
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
