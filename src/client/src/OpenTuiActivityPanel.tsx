import { useEffect, useMemo, useRef } from "react";
import {
  createGrid,
  createGridPainter,
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

export interface OpenTuiActivityRow {
  id: string;
  kind: string;
  title: string;
  summary: string;
  meta: string;
  status: "running" | "waiting" | "completed" | "failed" | "updated";
}

interface OpenTuiActivityPanelProps {
  rows: OpenTuiActivityRow[];
  onClose: () => void;
}

const colors = {
  black: "#050505",
  panel: "#090907",
  active: "#17130a",
  gold: "#f4d35e",
  text: "#e4ded0",
  muted: "#8d826f",
  faint: "#5f584b",
  line: "#2f2a1d",
  green: "#47d37c",
  blue: "#5097ff",
  red: "#d94a3d",
};

const rgba = Object.fromEntries(
  Object.entries(colors).map(([key, value]) => [key, hexToRgba(value)]),
) as Record<keyof typeof colors, RGBA>;

interface HitZone {
  row: number;
  col: number;
  width: number;
  title: string;
}

export function OpenTuiActivityPanel({ rows, onClose }: OpenTuiActivityPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hitsRef = useRef<HitZone[]>([]);
  const metricsRef = useRef<CellMetrics>({ width: 8, height: 16, cols: 1, rows: 1 });
  const renderRows = useMemo(() => rows.slice(0, 100), [rows]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const painter = createGridPainter(canvas, {
      fontSize: 12,
      fontFamily: WMUX_MONO_FONT_FAMILY,
      cellVAlign: "middle",
      clearColor: colors.black,
    });

    const paint = (entry?: ResizeObserverEntry) => {
      const metrics = syncPainterViewport(painter, canvas, entry);
      metricsRef.current = metrics;
      painter.paint(drawActivity(metrics, renderRows, hitsRef.current));
    };

    paint();
    const observer = observeCanvasViewport(canvas, paint);
    return () => {
      observer.disconnect();
      painter.dispose();
    };
  }, [renderRows]);

  const onClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const row = Math.floor((event.clientY - rect.top) / metricsRef.current.height);
    const col = Math.floor((event.clientX - rect.left) / metricsRef.current.width);
    const hit = hitsRef.current.find((candidate) => row === candidate.row && col >= candidate.col && col < candidate.col + candidate.width);
    if (hit) onClose();
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const row = Math.floor((event.clientY - rect.top) / metricsRef.current.height);
    const col = Math.floor((event.clientX - rect.left) / metricsRef.current.width);
    const hit = hitsRef.current.find((candidate) => row === candidate.row && col >= candidate.col && col < candidate.col + candidate.width);
    canvas.style.cursor = hit ? "pointer" : "default";
    canvas.title = hit?.title ?? "";
  };

  return (
    <aside className="activity-panel open-tui-activity-panel" aria-label="Activity">
      <canvas ref={canvasRef} className="open-tui-canvas" onClick={onClick} onPointerMove={onPointerMove} />
    </aside>
  );
}

const drawActivity = (
  metrics: CellMetrics,
  rows: OpenTuiActivityRow[],
  hits: HitZone[],
): CellGrid => {
  hits.length = 0;
  const { cols, rows: gridRows } = metrics;
  const grid = createGrid(cols, gridRows, rgba.black, rgba.text);

  const write = (row: number, col: number, text: string, color: RGBA, weight: 400 | 600 | 700 = 600) => {
    writeText(grid, row, col, fitText(text, Math.max(0, cols - col - 1)), color, weight >= 700 ? 1 : 0);
  };
  const fillRow = (row: number, color: RGBA) => fillCells(grid, row, 0, cols, color);

  write(1, 2, "ACTIVITY", rgba.gold, 700);
  const closeCol = Math.max(1, cols - 8);
  write(1, closeCol, "close", rgba.faint, 700);
  hits.push({ row: 1, col: closeCol - 1, width: 8, title: "Close activity" });
  fillRow(3, rgba.line);

  if (!rows.length) {
    write(5, 2, "NO ACTIVITY YET", rgba.faint, 700);
    return grid;
  }

  const rowHeight = 4;
  const startRow = 5;
  const maxRows = Math.max(0, Math.floor((gridRows - startRow) / rowHeight));
  for (let index = 0; index < Math.min(rows.length, maxRows); index += 1) {
    const item = rows[index];
    const itemRow = startRow + index * rowHeight;
    for (let offset = 0; offset < rowHeight - 1; offset += 1) {
      fillRow(itemRow + offset, index % 2 === 0 ? rgba.black : rgba.panel);
    }
    const statusColor = statusColorFor(item.status);
    write(itemRow, 2, item.kind.toUpperCase(), statusColor, 700);
    write(itemRow, 14, item.title, rgba.text, 700);
    write(itemRow + 1, 14, item.summary, rgba.muted, 400);
    write(itemRow + 2, 14, item.meta, rgba.faint, 400);
  }
  return grid;
};

const statusColorFor = (status: OpenTuiActivityRow["status"]): RGBA => {
  if (status === "running") return rgba.blue;
  if (status === "waiting") return rgba.gold;
  if (status === "completed") return rgba.green;
  if (status === "failed") return rgba.red;
  return rgba.gold;
};
