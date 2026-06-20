import { useEffect, useMemo, useRef } from "react";

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
  unreadNotifications: number;
  canMarkRead: boolean;
  canEnableNotifications: boolean;
  activityOpen: boolean;
  onActivateTab: (tabId: string) => void;
  onCreate: () => void;
  onOpenCommandPalette: () => void;
  onOpenSettings: () => void;
  onToggleActivity: () => void;
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
  | { type: "copy-link" }
  | { type: "copy-clipboard" }
  | { type: "notifications" }
  | { type: "mark-read" };

interface HitZone {
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  disabled?: boolean;
  action: HitAction;
}

interface CellMetrics {
  width: number;
  height: number;
  cols: number;
  rows: number;
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

export function OpenTuiTopbar(props: OpenTuiTopbarProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hitsRef = useRef<HitZone[]>([]);
  const metricsRef = useRef<CellMetrics>({ width: 8, height: 16, cols: 1, rows: 1 });
  const renderModel = useMemo(() => props, [props]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { alpha: false });
    const parent = canvas?.parentElement;
    if (!canvas || !ctx || !parent) return;

    const paint = () => {
      const rect = parent.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const fontSize = 12;
      ctx.font = `600 ${fontSize}px ${fontFamily}`;
      ctx.textBaseline = "top";
      const cellWidth = Math.max(7, Math.round(ctx.measureText("M").width));
      const cellHeight = 17;
      const cols = Math.max(1, Math.floor(rect.width / cellWidth));
      const rows = Math.max(1, Math.floor(rect.height / cellHeight));
      metricsRef.current = { width: cellWidth, height: cellHeight, cols, rows };

      const cssWidth = Math.max(1, Math.floor(rect.width));
      const cssHeight = Math.max(1, Math.floor(rect.height));
      const nextWidth = Math.ceil(cssWidth * dpr);
      const nextHeight = Math.ceil(cssHeight * dpr);
      if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
        canvas.width = nextWidth;
        canvas.height = nextHeight;
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawTopbar(ctx, metricsRef.current, renderModel, hitsRef.current);
    };

    paint();
    const observer = new ResizeObserver(paint);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [renderModel]);

  const runAction = (action: HitAction) => {
    if (action.type === "tab") props.onActivateTab(action.tabId);
    if (action.type === "create") props.onCreate();
    if (action.type === "palette") props.onOpenCommandPalette();
    if (action.type === "settings") props.onOpenSettings();
    if (action.type === "activity") props.onToggleActivity();
    if (action.type === "copy-link") props.onCopyLink();
    if (action.type === "copy-clipboard") props.onCopyClipboard();
    if (action.type === "notifications") props.onEnableNotifications();
    if (action.type === "mark-read") props.onMarkRead();
  };

  const onClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const hit = hitsRef.current.find(
      (candidate) =>
        !candidate.disabled &&
        x >= candidate.x &&
        x <= candidate.x + candidate.width &&
        y >= candidate.y &&
        y <= candidate.y + candidate.height,
    );
    if (hit) runAction(hit.action);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const hit = hitsRef.current.find(
      (candidate) =>
        !candidate.disabled &&
        x >= candidate.x &&
        x <= candidate.x + candidate.width &&
        y >= candidate.y &&
        y <= candidate.y + candidate.height,
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
  ctx: CanvasRenderingContext2D,
  metrics: CellMetrics,
  props: OpenTuiTopbarProps,
  hits: HitZone[],
) => {
  hits.length = 0;
  const { width: cellWidth, height: cellHeight, cols, rows } = metrics;
  const canvasWidth = cols * cellWidth;
  const canvasHeight = rows * cellHeight;
  ctx.fillStyle = colors.black;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  const write = (row: number, col: number, text: string, color: string, weight: 400 | 600 | 700 = 600) => {
    ctx.font = `${weight} 12px ${fontFamily}`;
    ctx.fillStyle = color;
    ctx.fillText(fitText(text, Math.max(0, cols - col - 1)), col * cellWidth, row * cellHeight + 2);
  };
  const fillCells = (row: number, col: number, width: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(col * cellWidth, row * cellHeight, width * cellWidth, cellHeight);
  };
  const hit = (row: number, col: number, width: number, title: string, action: HitAction, disabled = false) => {
    hits.push({
      x: col * cellWidth,
      y: row * cellHeight,
      width: width * cellWidth,
      height: cellHeight,
      title,
      action,
      disabled,
    });
  };

  const row = 1;
  let col = 1;
  for (const tab of props.tabs) {
    const label = `${tab.active ? ">" : " "} ${tab.title}${tab.unreadCount > 0 ? ` (${tab.unreadCount})` : ""}`;
    const width = Math.min(Math.max(12, label.length + 2), 24);
    fillCells(row, col, width, tab.active ? colors.active : colors.panel);
    write(row, col + 1, label, tab.active ? colors.gold : colors.text, tab.active ? 700 : 600);
    hit(row, col, width, `Activate ${tab.title}`, { type: "tab", tabId: tab.id });
    col += width + 1;
    if (col > cols - 46) break;
  }

  fillCells(row, col, 4, props.canCreate ? colors.panel : colors.black);
  write(row, col + 1, "+", props.canCreate ? colors.gold : colors.faint, 700);
  hit(row, col, 4, `New on ${props.targetLabel}`, { type: "create" }, !props.canCreate);

  const serviceLabel = `wmux ${props.serviceConnection}`;
  const serviceWidth = Math.max(13, serviceLabel.length + 4);
  let right = cols - 1;
  const buttons: Array<[string, string, HitAction, boolean, boolean]> = [
    ["ok", "Mark workspace notifications read", { type: "mark-read" }, !props.canMarkRead, props.canMarkRead],
    [props.unreadNotifications > 0 ? `bell${props.unreadNotifications}` : "bell", "Enable browser notifications", { type: "notifications" }, !props.canEnableNotifications, props.unreadNotifications > 0],
    [props.clipboardAttention ? "clip!" : "clip", "Copy wmux clipboard buffer", { type: "copy-clipboard" }, !props.canCopyClipboard, props.canCopyClipboard],
    ["link", "Copy active session link", { type: "copy-link" }, !props.canCopyLink, false],
    [props.activityOpen ? "act*" : "act", "Activity", { type: "activity" }, false, props.activityOpen],
    ["set", "Settings", { type: "settings" }, false, false],
    ["cmd", "Command palette", { type: "palette" }, false, false],
  ];

  for (const [label, title, action, disabled, active] of buttons) {
    const width = Math.max(5, label.length + 2);
    right -= width;
    fillCells(row, right, width, active ? colors.active : colors.panel);
    write(row, right + 1, label, disabled ? colors.faint : active ? colors.gold : colors.text, active ? 700 : 600);
    hit(row, right, width, title, action, disabled);
    right -= 1;
  }

  right -= serviceWidth;
  fillCells(row, right, serviceWidth, colors.panel);
  const serviceColor = props.serviceConnection === "online" ? colors.green : props.serviceConnection === "offline" ? colors.red : colors.gold;
  write(row, right + 1, serviceLabel, serviceColor, 700);
  write(0, 1, "tabs", colors.faint, 700);
  write(0, Math.max(1, cols - props.targetLabel.length - 10), `target ${props.targetLabel}`, colors.faint, 700);
  ctx.strokeStyle = colors.line;
  ctx.beginPath();
  ctx.moveTo(0, canvasHeight - 0.5);
  ctx.lineTo(canvasWidth, canvasHeight - 0.5);
  ctx.stroke();
};

const fitText = (text: string, maxCells: number): string => {
  if (maxCells <= 0) return "";
  if (text.length <= maxCells) return text;
  if (maxCells <= 3) return text.slice(0, maxCells);
  return `${text.slice(0, maxCells - 3)}...`;
};
