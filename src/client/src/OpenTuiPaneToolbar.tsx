import { useEffect, useMemo, useRef } from "react";
import type { SplitDirection, TerminalRun } from "./types";
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

interface PaneToolbarRun {
  status: TerminalRun["status"];
  label: string;
  title: string;
}

interface OpenTuiPaneToolbarProps {
  title: string;
  machineLabel: string;
  connected: boolean;
  unreadCount: number;
  run?: PaneToolbarRun;
  canCopyLastCommand: boolean;
  canRerunLastCommand: boolean;
  canSplit: boolean;
  canClose: boolean;
  onSplit: (direction: SplitDirection) => void;
  onActivate: () => void;
  onClose: () => void;
  onCopyLastCommand: () => void;
  onRerunLastCommand: () => void;
}

type HitAction =
  | { type: "copy-last-command" }
  | { type: "rerun-last-command" }
  | { type: "split"; direction: SplitDirection }
  | { type: "focus" }
  | { type: "close" };

interface HitZone {
  row: number;
  col: number;
  width: number;
  title: string;
  disabled?: boolean;
  action: HitAction;
}

const fontFamily = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const colors = {
  black: "#050505",
  panel: "#0a0907",
  active: "#17130a",
  gold: "#f4d35e",
  text: "#e4ded0",
  muted: "#8d826f",
  faint: "#5f584b",
  green: "#47d37c",
  blue: "#5097ff",
  red: "#d94a3d",
};

const rgba = Object.fromEntries(
  Object.entries(colors).map(([key, value]) => [key, hexToRgba(value)]),
) as Record<keyof typeof colors, RGBA>;

export function OpenTuiPaneToolbar(props: OpenTuiPaneToolbarProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hitsRef = useRef<HitZone[]>([]);
  const metricsRef = useRef<CellMetrics>({ width: 8, height: 16, cols: 1, rows: 1 });
  const renderModel = useMemo(() => props, [props]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const painter = createOpenTuiPainter(canvas, {
      fontSize: 12,
      fontFamily,
      cellVAlign: "middle",
      clearColor: colors.panel,
    });

    const paint = (entry?: ResizeObserverEntry) => {
      const metrics = syncPainterViewport(painter, canvas, entry);
      metricsRef.current = metrics;
      painter.paint(drawPaneToolbar(metrics, renderModel, hitsRef.current));
    };

    paint();
    const observer = observeCanvasViewport(canvas, paint);
    return () => {
      observer.disconnect();
      painter.dispose();
    };
  }, [renderModel]);

  const runAction = (action: HitAction) => {
    if (action.type === "copy-last-command") props.onCopyLastCommand();
    if (action.type === "rerun-last-command") props.onRerunLastCommand();
    if (action.type === "split") props.onSplit(action.direction);
    if (action.type === "focus") props.onActivate();
    if (action.type === "close") props.onClose();
  };

  const hitAt = (event: React.MouseEvent<HTMLCanvasElement> | React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const rect = canvas.getBoundingClientRect();
    const row = Math.floor((event.clientY - rect.top) / metricsRef.current.height);
    const col = Math.floor((event.clientX - rect.left) / metricsRef.current.width);
    return hitsRef.current.find(
      (candidate) =>
        row === candidate.row &&
        col >= candidate.col &&
        col < candidate.col + candidate.width,
    );
  };

  const onClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const hit = hitAt(event);
    if (!hit || hit.disabled) return;
    event.stopPropagation();
    runAction(hit.action);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const hit = hitAt(event);
    canvas.style.cursor = hit && !hit.disabled ? "pointer" : "default";
    canvas.title = hit?.title ?? "";
  };

  return (
    <div className="pane-toolbar open-tui-pane-toolbar">
      <canvas ref={canvasRef} className="open-tui-canvas" onClick={onClick} onPointerMove={onPointerMove} />
    </div>
  );
}

const drawPaneToolbar = (
  metrics: CellMetrics,
  props: OpenTuiPaneToolbarProps,
  hits: HitZone[],
): CellGrid => {
  hits.length = 0;
  const { cols, rows } = metrics;
  const grid = createGrid(cols, rows, rgba.panel, rgba.text);
  for (let row = 0; row < rows; row += 1) fillCells(grid, row, 0, cols, rgba.panel);

  const row = rows > 1 ? Math.floor(rows / 2) : 0;
  const write = (col: number, text: string, color: RGBA, weight: 400 | 600 | 700 = 600) => {
    writeText(grid, row, col, fitText(text, Math.max(0, cols - col - 1)), color, weight >= 700 ? 1 : 0);
  };
  const button = (
    right: number,
    label: string,
    title: string,
    action: HitAction,
    disabled = false,
    active = false,
  ): number => {
    const width = Math.max(4, label.length + 2);
    const col = Math.max(0, right - width);
    fillCells(grid, row, col, width, active ? rgba.active : rgba.black);
    writeText(grid, row, col + 1, fitText(label, width - 2), disabled ? rgba.faint : active ? rgba.gold : rgba.text, 1);
    hits.push({ row, col, width, title, action, disabled });
    return col - 1;
  };

  let right = cols - 1;
  right = button(right, "x", "Close pane", { type: "close" }, !props.canClose);
  right = button(right, "max", "Focus pane", { type: "focus" });
  right = button(right, "down", `Split down on ${props.machineLabel}`, { type: "split", direction: "horizontal" }, !props.canSplit);
  right = button(right, "right", `Split right on ${props.machineLabel}`, { type: "split", direction: "vertical" }, !props.canSplit);

  if (props.run) {
    right = button(right, "rerun", "Rerun last command", { type: "rerun-last-command" }, !props.canRerunLastCommand);
    right = button(right, "copy", "Copy last command", { type: "copy-last-command" }, !props.canCopyLastCommand);
    const runLabel = fitText(props.run.label, Math.min(14, Math.max(6, right - 8)));
    const runWidth = Math.max(6, runLabel.length + 2);
    const runCol = Math.max(0, right - runWidth);
    fillCells(grid, row, runCol, runWidth, rgba.black);
    writeText(grid, row, runCol + 1, runLabel, runColor(props.run.status), 1);
    hits.push({ row, col: runCol, width: runWidth, title: props.run.title, action: { type: "focus" }, disabled: true });
    right = runCol - 1;
  }

  const status = props.connected ? "[on]" : "[--]";
  write(1, status, props.connected ? rgba.green : rgba.faint, 700);
  const unread = props.unreadCount > 0 ? ` (${Math.min(99, props.unreadCount)})` : "";
  const label = `${props.title}  ${props.machineLabel}${unread}`;
  const titleStart = 7;
  write(titleStart, fitText(label, Math.max(0, right - titleStart)), props.unreadCount > 0 ? rgba.gold : rgba.text, 700);

  return grid;
};

const runColor = (status: TerminalRun["status"]): RGBA => {
  if (status === "started") return rgba.blue;
  if (status === "failed") return rgba.red;
  return rgba.green;
};
