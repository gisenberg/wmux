import { useEffect, useMemo, useRef, useState } from "react";
import {
  createGrid,
  createOpenTuiPainter,
  fillCells,
  fitText,
  hexToRgba,
  observeCanvasViewport,
  syncPainterViewport,
  writeText,
  type CellMetrics,
  type RGBA,
} from "./opentui-grid";
import { WMUX_MONO_FONT_FAMILY } from "./fonts";

type MobileSurfaceMode = "agent" | "terminal";
type MobileStatus = "running" | "completed" | "failed" | "updated";

interface OpenTuiMobileChromeProps {
  workspaceName: string;
  subtitle: string;
  status: MobileStatus;
  statusLabel: string;
  serviceConnection: "connecting" | "online" | "offline";
  surfaceMode: MobileSurfaceMode;
  navigationOpen: boolean;
  onToggleNavigation: () => void;
  onSurfaceModeChange: (mode: MobileSurfaceMode) => void;
  onOpenActions: () => void;
}

type MobileChromeRenderModel = Pick<
  OpenTuiMobileChromeProps,
  "workspaceName" | "subtitle" | "status" | "statusLabel" | "serviceConnection" | "surfaceMode" | "navigationOpen"
> & { animationTick: number };

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
  blue: "#5aa9ff",
};

const rgba = Object.fromEntries(
  Object.entries(colors).map(([key, value]) => [key, hexToRgba(value)]),
) as Record<keyof typeof colors, RGBA>;

const runningFrames = ["|", "/", "-", "\\"];

export function OpenTuiMobileChrome(props: OpenTuiMobileChromeProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const paintRef = useRef<(() => void) | null>(null);
  const [animationTick, setAnimationTick] = useState(0);
  const reducedMotion = useMemo(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches, []);

  useEffect(() => {
    if (reducedMotion || (props.status !== "running" && props.serviceConnection !== "connecting")) return;
    const timer = window.setInterval(() => setAnimationTick((tick) => (tick + 1) % runningFrames.length), 140);
    return () => window.clearInterval(timer);
  }, [props.serviceConnection, props.status, reducedMotion]);

  const model = useMemo<MobileChromeRenderModel>(() => ({
    workspaceName: props.workspaceName,
    subtitle: props.subtitle,
    status: props.status,
    statusLabel: props.statusLabel,
    serviceConnection: props.serviceConnection,
    surfaceMode: props.surfaceMode,
    navigationOpen: props.navigationOpen,
    animationTick,
  }), [
    animationTick,
    props.navigationOpen,
    props.serviceConnection,
    props.status,
    props.statusLabel,
    props.subtitle,
    props.surfaceMode,
    props.workspaceName,
  ]);
  const modelRef = useRef(model);

  useEffect(() => {
    modelRef.current = model;
    paintRef.current?.();
  }, [model]);

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
      painter.paint(drawMobileChrome(metrics, modelRef.current));
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

  return (
    <header className="open-tui-mobile-chrome" aria-label="Mobile session controls">
      <canvas ref={canvasRef} className="open-tui-mobile-chrome-canvas" aria-hidden="true" />
      <div className="open-tui-mobile-chrome-status visually-hidden" aria-live="polite">
        {props.workspaceName}, {props.statusLabel}, {props.subtitle}
      </div>
      <div className="open-tui-mobile-chrome-actions">
        <button
          type="button"
          aria-label={props.navigationOpen ? "Hide workspaces and hosts" : "Open workspaces and hosts"}
          aria-expanded={props.navigationOpen}
          aria-controls="wmux-sidebar"
          onClick={props.onToggleNavigation}
        >
          Workspaces
        </button>
        <button
          type="button"
          aria-label="Open chat"
          aria-pressed={props.surfaceMode === "agent"}
          onClick={() => props.onSurfaceModeChange("agent")}
        >
          Chat
        </button>
        <button
          type="button"
          aria-label="Open terminal"
          aria-pressed={props.surfaceMode === "terminal"}
          onClick={() => props.onSurfaceModeChange("terminal")}
        >
          Terminal
        </button>
        <button type="button" aria-label="Open actions" onClick={props.onOpenActions}>
          Actions
        </button>
      </div>
    </header>
  );
}

const drawMobileChrome = (
  metrics: CellMetrics,
  model: MobileChromeRenderModel,
) => {
  const { cols, rows } = metrics;
  const grid = createGrid(cols, rows, rgba.black, rgba.text);
  const write = (row: number, col: number, text: string, color: RGBA, bold = false) => {
    if (row < 0 || row >= rows) return;
    writeText(grid, row, col, fitText(text, Math.max(0, cols - col)), color, bold ? 1 : 0);
  };
  const fillRows = (start: number, count: number, col: number, width: number, color: RGBA) => {
    for (let row = start; row < Math.min(rows, start + count); row += 1) fillCells(grid, row, col, width, color);
  };

  const connectionColor =
    model.serviceConnection === "online" ? rgba.green : model.serviceConnection === "offline" ? rgba.red : rgba.gold;
  write(0, 1, "WMUX // MOBILE", rgba.faint, true);
  const connection = model.serviceConnection === "connecting"
    ? `${runningFrames[model.animationTick]} CONNECTING`
    : `● ${model.serviceConnection.toUpperCase()}`;
  write(0, Math.max(1, cols - connection.length - 1), connection, connectionColor, true);

  const statusColor =
    model.status === "running" ? rgba.blue : model.status === "completed" ? rgba.green : model.status === "failed" ? rgba.red : rgba.muted;
  const statusMark = model.status === "running" ? runningFrames[model.animationTick] : "●";
  const actionRowCount = rows >= 5 ? 3 : 2;
  const actionRow = Math.max(0, rows - actionRowCount);
  if (actionRow >= 4) {
    write(1, 1, `> ${model.workspaceName}`, rgba.gold, true);
    write(2, 1, `${statusMark} ${model.statusLabel}`, statusColor, true);
    if (model.subtitle) write(3, 1, model.subtitle, rgba.muted);
  } else if (actionRow >= 2) {
    const context = [model.workspaceName, `${statusMark} ${model.statusLabel}`, model.subtitle].filter(Boolean).join(" / ");
    write(1, 1, `> ${context}`, model.status === "running" ? statusColor : rgba.gold, true);
  }

  const gap = 1;
  const available = Math.max(4, cols - gap * 5);
  const widths = [0, 1, 2, 3].map((index) => Math.floor((available + index) / 4));
  const labels = [
    model.navigationOpen ? "NAV*" : "NAV",
    model.surfaceMode === "agent" ? "CHAT*" : "CHAT",
    model.surfaceMode === "terminal" ? "TERM*" : "TERM",
    "CMD",
  ];
  let col = gap;
  labels.forEach((label, index) => {
    const active = label.endsWith("*");
    const width = widths[index];
    fillRows(actionRow, actionRowCount, col, width, active ? rgba.active : rgba.panel);
    const labelRow = Math.min(rows - 1, actionRow + Math.floor(actionRowCount / 2));
    write(labelRow, col + Math.max(1, Math.floor((width - label.length) / 2)), label, active ? rgba.gold : rgba.text, active);
    col += width + gap;
  });
  return grid;
};
