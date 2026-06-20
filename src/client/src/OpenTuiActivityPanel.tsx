import { useEffect, useMemo, useRef } from "react";

export interface OpenTuiActivityRow {
  id: string;
  kind: string;
  title: string;
  summary: string;
  meta: string;
  status: "running" | "completed" | "failed" | "updated";
}

interface OpenTuiActivityPanelProps {
  rows: OpenTuiActivityRow[];
  onClose: () => void;
}

const fontFamily = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
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

export function OpenTuiActivityPanel({ rows, onClose }: OpenTuiActivityPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderRows = useMemo(() => rows.slice(0, 100), [rows]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { alpha: false });
    const parent = canvas?.parentElement;
    if (!canvas || !ctx || !parent) return;

    const paint = () => {
      const rect = parent.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      const nextWidth = Math.ceil(width * dpr);
      const nextHeight = Math.ceil(height * dpr);
      if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
        canvas.width = nextWidth;
        canvas.height = nextHeight;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawActivity(ctx, width, height, renderRows);
    };

    paint();
    const observer = new ResizeObserver(paint);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [renderRows]);

  const onClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x >= rect.width - 54 && y <= 36) onClose();
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    canvas.style.cursor = x >= rect.width - 54 && y <= 36 ? "pointer" : "default";
  };

  return (
    <aside className="activity-panel open-tui-activity-panel" aria-label="Activity">
      <canvas ref={canvasRef} className="open-tui-canvas" onClick={onClick} onPointerMove={onPointerMove} />
    </aside>
  );
}

const drawActivity = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  rows: OpenTuiActivityRow[],
) => {
  ctx.fillStyle = colors.black;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = colors.line;
  ctx.beginPath();
  ctx.moveTo(0.5, 0);
  ctx.lineTo(0.5, height);
  ctx.stroke();

  const write = (text: string, x: number, y: number, color: string, weight: 400 | 600 | 700 = 600) => {
    ctx.font = `${weight} 12px ${fontFamily}`;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  };

  write("ACTIVITY", 14, 14, colors.gold, 700);
  write("close", width - 50, 14, colors.faint, 700);
  ctx.strokeStyle = colors.line;
  ctx.beginPath();
  ctx.moveTo(0, 42.5);
  ctx.lineTo(width, 42.5);
  ctx.stroke();

  if (!rows.length) {
    write("NO ACTIVITY YET", 20, 68, colors.faint, 700);
    return;
  }

  const rowHeight = 58;
  const maxRows = Math.max(0, Math.floor((height - 52) / rowHeight));
  for (let index = 0; index < Math.min(rows.length, maxRows); index += 1) {
    const row = rows[index];
    const y = 52 + index * rowHeight;
    ctx.fillStyle = index % 2 === 0 ? colors.black : colors.panel;
    ctx.fillRect(8, y, width - 16, rowHeight - 6);
    const statusColor = statusColorFor(row.status);
    write(fitText(row.kind.toUpperCase(), 10), 18, y + 8, statusColor, 700);
    write(fitText(row.title, Math.max(12, Math.floor((width - 112) / 7))), 98, y + 8, colors.text, 700);
    write(fitText(row.summary, Math.max(12, Math.floor((width - 112) / 7))), 98, y + 26, colors.muted, 400);
    write(fitText(row.meta, Math.max(12, Math.floor((width - 112) / 7))), 98, y + 42, colors.faint, 400);
  }
};

const statusColorFor = (status: OpenTuiActivityRow["status"]): string => {
  if (status === "running") return colors.blue;
  if (status === "completed") return colors.green;
  if (status === "failed") return colors.red;
  return colors.gold;
};

const fitText = (text: string, maxCells: number): string => {
  if (maxCells <= 0) return "";
  if (text.length <= maxCells) return text;
  if (maxCells <= 3) return text.slice(0, maxCells);
  return `${text.slice(0, maxCells - 3)}...`;
};
