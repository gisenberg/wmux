import { useEffect, useMemo, useRef } from "react";
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

export interface OpenTuiTabItem {
  id: string;
  title: string;
  active: boolean;
  unreadCount: number;
}

interface OpenTuiTopbarProps {
  tabs: OpenTuiTabItem[];
  serviceConnection: "connecting" | "online" | "offline";
  targetLabel: string;
  canCreate: boolean;
  canCopyLink: boolean;
  canCopyClipboard: boolean;
  clipboardAttention: boolean;
  canOpenStream: boolean;
  streamLive: boolean;
  streamViewerCount: number;
  unreadNotifications: number;
  canMarkRead: boolean;
  canEnableNotifications: boolean;
  activityOpen: boolean;
  onActivateTab: (tabId: string) => void;
  onCreate: () => void;
  onOpenCommandPalette: () => void;
  onOpenSettings: () => void;
  onToggleActivity: () => void;
  onOpenStream: () => void;
  onCopyLink: () => void;
  onCopyClipboard: () => void;
  onEnableNotifications: () => void;
  onMarkRead: () => void;
}

type HitAction =
  | { type: "tab"; tabId: string }
  | { type: "create" }
  | { type: "palette" }
  | { type: "settings" }
  | { type: "activity" }
  | { type: "stream" }
  | { type: "copy-link" }
  | { type: "copy-clipboard" }
  | { type: "notifications" }
  | { type: "mark-read" };

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
  line: "#2f2a1d",
  gold: "#f4d35e",
  text: "#e4ded0",
  muted: "#8d826f",
  faint: "#5f584b",
  green: "#47d37c",
  red: "#d94a3d",
};

const rgba = Object.fromEntries(
  Object.entries(colors).map(([key, value]) => [key, hexToRgba(value)]),
) as Record<keyof typeof colors, RGBA>;

export function OpenTuiTopbar(props: OpenTuiTopbarProps) {
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
      clearColor: colors.black,
    });

    const paint = (entry?: ResizeObserverEntry) => {
      const metrics = syncPainterViewport(painter, canvas, entry);
      metricsRef.current = metrics;
      painter.paint(drawTopbar(metrics, renderModel, hitsRef.current));
    };

    paint();
    const observer = observeCanvasViewport(canvas, paint);
    return () => {
      observer.disconnect();
      painter.dispose();
    };
  }, [renderModel]);

  const runAction = (action: HitAction) => {
    if (action.type === "tab") props.onActivateTab(action.tabId);
    if (action.type === "create") props.onCreate();
    if (action.type === "palette") props.onOpenCommandPalette();
    if (action.type === "settings") props.onOpenSettings();
    if (action.type === "activity") props.onToggleActivity();
    if (action.type === "stream") props.onOpenStream();
    if (action.type === "copy-link") props.onCopyLink();
    if (action.type === "copy-clipboard") props.onCopyClipboard();
    if (action.type === "notifications") props.onEnableNotifications();
    if (action.type === "mark-read") props.onMarkRead();
  };

  const onClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const row = Math.floor((event.clientY - rect.top) / metricsRef.current.height);
    const col = Math.floor((event.clientX - rect.left) / metricsRef.current.width);
    const hit = hitsRef.current.find(
      (candidate) =>
        !candidate.disabled &&
        row === candidate.row &&
        col >= candidate.col &&
        col < candidate.col + candidate.width,
    );
    if (hit) runAction(hit.action);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const row = Math.floor((event.clientY - rect.top) / metricsRef.current.height);
    const col = Math.floor((event.clientX - rect.left) / metricsRef.current.width);
    const hit = hitsRef.current.find(
      (candidate) =>
        !candidate.disabled &&
        row === candidate.row &&
        col >= candidate.col &&
        col < candidate.col + candidate.width,
    );
    canvas.style.cursor = hit ? "pointer" : "default";
    canvas.title = hit?.title ?? "";
  };

  return (
    <header className="topbar open-tui-topbar" aria-label="OpenTUI session toolbar">
      <canvas ref={canvasRef} className="open-tui-canvas" onClick={onClick} onPointerMove={onPointerMove} />
    </header>
  );
}

const drawTopbar = (
  metrics: CellMetrics,
  props: OpenTuiTopbarProps,
  hits: HitZone[],
): CellGrid => {
  hits.length = 0;
  const { cols, rows } = metrics;
  const grid = createGrid(cols, rows, rgba.black, rgba.text);

  const write = (row: number, col: number, text: string, color: RGBA, weight: 400 | 600 | 700 = 600) => {
    writeText(grid, row, col, fitText(text, Math.max(0, cols - col - 1)), color, weight >= 700 ? 1 : 0);
  };
  const fill = (row: number, col: number, width: number, color: RGBA) => {
    fillCells(grid, row, col, width, color);
  };
  const hit = (row: number, col: number, width: number, title: string, action: HitAction, disabled = false) => {
    if (row >= 0 && row < rows && width > 0) hits.push({ row, col, width, title, action, disabled });
  };

  const row = rows > 2 ? 1 : 0;
  let col = 1;
  for (const tab of props.tabs) {
    const label = `${tab.active ? ">" : " "} ${tab.title}${tab.unreadCount > 0 ? ` (${tab.unreadCount})` : ""}`;
    const width = Math.min(Math.max(12, label.length + 2), 24);
    fill(row, col, width, tab.active ? rgba.active : rgba.panel);
    write(row, col + 1, label, tab.active ? rgba.gold : rgba.text, tab.active ? 700 : 600);
    hit(row, col, width, `Activate ${tab.title}`, { type: "tab", tabId: tab.id });
    col += width + 1;
    if (col > cols - 46) break;
  }

  fill(row, col, 4, props.canCreate ? rgba.panel : rgba.black);
  write(row, col + 1, "+", props.canCreate ? rgba.gold : rgba.faint, 700);
  hit(row, col, 4, `New on ${props.targetLabel}`, { type: "create" }, !props.canCreate);

  const serviceLabel = `wmux ${props.serviceConnection}`;
  const serviceWidth = Math.max(13, serviceLabel.length + 4);
  let right = cols - 1;
  const buttons: Array<[string, string, HitAction, boolean, boolean]> = [
    ["ok", "Mark workspace notifications read", { type: "mark-read" }, !props.canMarkRead, props.canMarkRead],
    [props.unreadNotifications > 0 ? `bell${props.unreadNotifications}` : "bell", "Enable browser notifications", { type: "notifications" }, !props.canEnableNotifications, props.unreadNotifications > 0],
    [props.clipboardAttention ? "clip!" : "clip", "Copy wmux clipboard buffer", { type: "copy-clipboard" }, !props.canCopyClipboard, props.canCopyClipboard],
    [props.streamLive ? `str${Math.min(99, props.streamViewerCount)}` : "str", "Machine screen stream", { type: "stream" }, !props.canOpenStream, props.streamLive],
    ["link", "Copy active session link", { type: "copy-link" }, !props.canCopyLink, false],
    [props.activityOpen ? "act*" : "act", "Activity", { type: "activity" }, false, props.activityOpen],
    ["set", "Settings", { type: "settings" }, false, false],
    ["cmd", "Command palette", { type: "palette" }, false, false],
  ];

  for (const [label, title, action, disabled, active] of buttons) {
    const width = Math.max(5, label.length + 2);
    right -= width;
    fill(row, right, width, active ? rgba.active : rgba.panel);
    write(row, right + 1, label, disabled ? rgba.faint : active ? rgba.gold : rgba.text, active ? 700 : 600);
    hit(row, right, width, title, action, disabled);
    right -= 1;
  }

  right -= serviceWidth;
  fill(row, right, serviceWidth, rgba.panel);
  const serviceColor = props.serviceConnection === "online" ? rgba.green : props.serviceConnection === "offline" ? rgba.red : rgba.gold;
  write(row, right + 1, serviceLabel, serviceColor, 700);
  if (rows > 1) {
    write(0, 1, "tabs", rgba.faint, 700);
    write(0, Math.max(1, cols - props.targetLabel.length - 10), `target ${props.targetLabel}`, rgba.faint, 700);
  }
  return grid;
};
