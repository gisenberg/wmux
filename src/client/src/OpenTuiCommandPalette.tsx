import { useEffect, useMemo, useRef, useState } from "react";
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
import { useOpenTuiTheme, type OpenTuiTheme } from "./color-scheme-context";

export interface OpenTuiCommand {
  id: string;
  title: string;
  subtitle?: string;
  section: string;
  shortcut?: string;
  keywords?: string[];
  disabled?: boolean;
  run: () => void | Promise<void>;
}

interface OpenTuiCommandPaletteProps {
  commands: OpenTuiCommand[];
  query: string;
  onQueryChange: (query: string) => void;
  onClose: () => void;
}

interface HitZone {
  index: number;
  row: number;
  col: number;
  width: number;
  height: number;
}

export function OpenTuiCommandPalette({ commands, query, onQueryChange, onClose }: OpenTuiCommandPaletteProps) {
  const theme = useOpenTuiTheme();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const hitsRef = useRef<HitZone[]>([]);
  const metricsRef = useRef<CellMetrics>({ width: 8, height: 16, cols: 1, rows: 1 });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const filteredCommands = useMemo(() => filterCommands(commands, query).slice(0, 40), [commands, query]);
  const selectableCommands = filteredCommands.filter((command) => !command.disabled);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const firstEnabled = filteredCommands.findIndex((command) => !command.disabled);
    setSelectedIndex(firstEnabled === -1 ? 0 : firstEnabled);
  }, [filteredCommands]);

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
      painter.paint(drawPalette(metrics, filteredCommands, selectedIndex, hitsRef.current, theme));
    };

    paint();
    const observer = observeCanvasViewport(canvas, paint);
    return () => {
      observer.disconnect();
      painter.dispose();
    };
  }, [filteredCommands, selectedIndex, theme]);

  const runCommand = async (command: OpenTuiCommand | undefined) => {
    if (!command || command.disabled) return;
    onClose();
    await command.run();
  };

  const moveSelection = (delta: number) => {
    if (!filteredCommands.length) return;
    let next = selectedIndex;
    for (let step = 0; step < filteredCommands.length; step += 1) {
      next = modulo(next + delta, filteredCommands.length);
      if (!filteredCommands[next].disabled) {
        setSelectedIndex(next);
        return;
      }
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void runCommand(filteredCommands[selectedIndex] ?? selectableCommands[0]);
    }
  };

  const onCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const row = Math.floor((event.clientY - rect.top) / metricsRef.current.height);
    const col = Math.floor((event.clientX - rect.left) / metricsRef.current.width);
    const hit = hitsRef.current.find(
      (candidate) =>
        row >= candidate.row &&
        row < candidate.row + candidate.height &&
        col >= candidate.col &&
        col < candidate.col + candidate.width,
    );
    if (hit) void runCommand(filteredCommands[hit.index]);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const row = Math.floor((event.clientY - rect.top) / metricsRef.current.height);
    const col = Math.floor((event.clientX - rect.left) / metricsRef.current.width);
    const hit = hitsRef.current.find(
      (candidate) =>
        row >= candidate.row &&
        row < candidate.row + candidate.height &&
        col >= candidate.col &&
        col < candidate.col + candidate.width,
    );
    canvas.style.cursor = hit ? "pointer" : "default";
    if (hit) setSelectedIndex(hit.index);
  };

  return (
    <div className="command-backdrop open-tui-command-backdrop" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
      <div className="open-tui-command-panel" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}>
        <div className="open-tui-command-input-row">
          <span>cmd</span>
          <input
            ref={inputRef}
            value={query}
            placeholder="Search commands, workspaces, tabs, hosts"
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
        <canvas ref={canvasRef} className="open-tui-command-canvas" onClick={onCanvasClick} onPointerMove={onPointerMove} />
      </div>
    </div>
  );
}

const drawPalette = (
  metrics: CellMetrics,
  commands: OpenTuiCommand[],
  selectedIndex: number,
  hits: HitZone[],
  theme: OpenTuiTheme,
): CellGrid => {
  const { rgba } = theme;
  hits.length = 0;
  const { cols, rows } = metrics;
  const grid = createGrid(cols, rows, rgba.black, rgba.text);

  const write = (row: number, col: number, text: string, color: RGBA, weight: 400 | 600 | 700 = 600) => {
    writeText(grid, row, col, fitText(text, Math.max(0, cols - col - 1)), color, weight >= 700 ? 1 : 0);
  };
  const fillRow = (row: number, col: number, width: number, color: RGBA) => fillCells(grid, row, col, width, color);

  if (!commands.length) {
    write(1, 2, "NO COMMANDS", rgba.faint, 700);
    return grid;
  }

  const rowHeight = 3;
  const rowTop = 1;
  const rowWidth = Math.max(1, cols - 2);
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    const row = rowTop + index * rowHeight;
    if (row + rowHeight > rows) break;
    const selected = index === selectedIndex;
    for (let offset = 0; offset < rowHeight; offset += 1) {
      fillRow(row + offset, 1, rowWidth, selected ? rgba.active : index % 2 === 0 ? rgba.black : rgba.panel);
    }
    const shortcut = command.shortcut ?? "";
    const shortcutCol = Math.max(18, cols - 16);
    write(row, 2, command.section.toUpperCase(), command.disabled ? rgba.faint : rgba.gold, 700);
    write(row, 16, command.title, command.disabled ? rgba.faint : selected ? rgba.gold : rgba.text, selected ? 700 : 600);
    if (command.subtitle) write(row + 1, 16, command.subtitle, rgba.muted, 400);
    if (shortcut) write(row, shortcutCol, shortcut, command.disabled ? rgba.faint : rgba.muted, 700);
    if (!command.disabled) hits.push({ index, row, col: 1, width: rowWidth, height: rowHeight });
  }
  return grid;
};

const filterCommands = (commands: OpenTuiCommand[], query: string): OpenTuiCommand[] => {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return commands;
  return commands.filter((command) => {
    const haystack = [command.title, command.subtitle, command.section, command.shortcut, ...(command.keywords ?? [])]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
};

const modulo = (value: number, divisor: number): number => ((value % divisor) + divisor) % divisor;
