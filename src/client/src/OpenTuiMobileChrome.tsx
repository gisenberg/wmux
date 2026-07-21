import { useEffect, useMemo, useRef, useState } from "react";
import {
  createGrid,
  createGridPainter,
  fillCells,
  fitText,
  observeCanvasViewport,
  syncPainterViewport,
  writeText,
  type CellMetrics,
  type RGBA,
} from "./opentui-grid";
import { WMUX_MONO_FONT_FAMILY } from "./fonts";
import type { MachineVersionStatus } from "./types";
import { useOpenTuiTheme, type OpenTuiTheme } from "./color-scheme-context";

type MobileSurfaceMode = "agent" | "terminal";
type MobileStatus = "running" | "waiting" | "completed" | "failed" | "updated";

interface OpenTuiMobileChromeProps {
  workspaceName: string;
  subtitle: string;
  status: MobileStatus;
  statusLabel: string;
  versionStatus?: MachineVersionStatus;
  versionLabel?: string;
  versionDetail?: string;
  serviceConnection: "connecting" | "online" | "offline";
  surfaceMode: MobileSurfaceMode;
  navigationOpen: boolean;
  onToggleNavigation: () => void;
  onSurfaceModeChange: (mode: MobileSurfaceMode) => void;
  onOpenActions: () => void;
}

type MobileChromeRenderModel = Pick<
  OpenTuiMobileChromeProps,
  "workspaceName" | "subtitle" | "status" | "statusLabel" | "versionStatus" | "versionLabel" | "versionDetail" | "serviceConnection" | "surfaceMode" | "navigationOpen"
> & { animationTick: number };

const runningFrames = ["|", "/", "-", "\\"];
const mobileActionHeight = 44;

export function OpenTuiMobileChrome(props: OpenTuiMobileChromeProps) {
  const theme = useOpenTuiTheme();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const paintRef = useRef<(() => void) | null>(null);
  const [animationTick, setAnimationTick] = useState(0);
  const reducedMotion = useMemo(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches, []);

  useEffect(() => {
    if (reducedMotion || (props.status !== "running" && props.serviceConnection !== "connecting")) return;
    const timer = window.setInterval(() => setAnimationTick((tick) => (tick + 1) % runningFrames.length), 280);
    return () => window.clearInterval(timer);
  }, [props.serviceConnection, props.status, reducedMotion]);

  const model = useMemo<MobileChromeRenderModel>(() => ({
    workspaceName: props.workspaceName,
    subtitle: props.subtitle,
    status: props.status,
    statusLabel: props.statusLabel,
    versionStatus: props.versionStatus,
    versionLabel: props.versionLabel,
    versionDetail: props.versionDetail,
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
    props.versionDetail,
    props.versionLabel,
    props.versionStatus,
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
    const painter = createGridPainter(canvas, {
      fontSize: 12,
      fontFamily: WMUX_MONO_FONT_FAMILY,
      cellVAlign: "middle",
      clearColor: theme.colors.black,
    });
    const paint = (entry?: ResizeObserverEntry) => {
      const metrics = syncPainterViewport(painter, canvas, entry);
      painter.paint(drawMobileChrome(metrics, modelRef.current, theme));
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

  return (
    <header className="open-tui-mobile-chrome" role="banner" aria-label="Mobile session controls">
      <canvas ref={canvasRef} className="open-tui-mobile-chrome-canvas" aria-hidden="true" />
      <div className="open-tui-mobile-chrome-status visually-hidden" aria-live="polite">
        {props.workspaceName}, {props.statusLabel}, {props.versionDetail ? `${props.versionDetail}, ` : ""}{props.subtitle}
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
  theme: OpenTuiTheme,
) => {
  const { rgba } = theme;
  const statusColors = {
    completed: rgba.green,
    failed: rgba.red,
    running: rgba.blue,
    updated: rgba.muted,
    waiting: rgba.gold,
  };
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

  const statusColor = statusColors[model.status];
  const statusMark = model.status === "running" ? runningFrames[model.animationTick] : model.status === "waiting" ? "?" : "●";
  const versionColor = model.versionStatus === "current"
    ? rgba.green
    : model.versionStatus === "outdated"
      ? rgba.gold
      : rgba.muted;
  const versionText = model.versionStatus === "outdated" && model.versionLabel ? `[${model.versionLabel}]` : "";
  const viewportHeight = metrics.viewportHeight ?? rows * metrics.height;
  const actionBoundary = Math.max(0, viewportHeight - mobileActionHeight);
  const actionRow = Math.min(rows - 1, Math.max(0, Math.ceil(actionBoundary / metrics.height)));
  const actionRowCount = rows - actionRow;
  if (actionRow >= 3) {
    write(1, 1, `> ${model.workspaceName}`, rgba.gold, true);
    if (versionText) write(1, Math.max(1, cols - versionText.length - 1), versionText, versionColor, true);
    const detail = [model.statusLabel, model.subtitle].filter(Boolean).join(" / ");
    write(2, 1, `${statusMark} ${detail}`, statusColor, true);
  } else if (actionRow >= 2) {
    const context = [model.workspaceName, versionText, `${statusMark} ${model.statusLabel}`, model.subtitle].filter(Boolean).join(" / ");
    write(1, 1, `> ${context}`, ["running", "waiting"].includes(model.status) ? statusColor : rgba.gold, true);
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
