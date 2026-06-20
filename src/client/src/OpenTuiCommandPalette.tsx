import { useEffect, useMemo, useRef, useState } from "react";

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
  x: number;
  y: number;
  width: number;
  height: number;
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
  red: "#d94a3d",
};

export function OpenTuiCommandPalette({ commands, query, onQueryChange, onClose }: OpenTuiCommandPaletteProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const hitsRef = useRef<HitZone[]>([]);
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
      drawPalette(ctx, width, height, filteredCommands, selectedIndex, hitsRef.current);
    };

    paint();
    const observer = new ResizeObserver(paint);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [filteredCommands, selectedIndex]);

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
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const hit = hitsRef.current.find(
      (candidate) =>
        x >= candidate.x &&
        x <= candidate.x + candidate.width &&
        y >= candidate.y &&
        y <= candidate.y + candidate.height,
    );
    if (hit) void runCommand(filteredCommands[hit.index]);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const hit = hitsRef.current.find(
      (candidate) =>
        x >= candidate.x &&
        x <= candidate.x + candidate.width &&
        y >= candidate.y &&
        y <= candidate.y + candidate.height,
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
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  commands: OpenTuiCommand[],
  selectedIndex: number,
  hits: HitZone[],
) => {
  hits.length = 0;
  ctx.fillStyle = colors.black;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = colors.line;
  ctx.strokeRect(0.5, 0.5, width - 1, height - 1);

  const cellHeight = 32;
  const rowTop = 10;
  const rowWidth = Math.max(1, width - 20);
  const write = (text: string, x: number, y: number, color: string, weight: 400 | 600 | 700 = 600) => {
    ctx.font = `${weight} 12px ${fontFamily}`;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  };

  if (!commands.length) {
    write("NO COMMANDS", 14, rowTop + 4, colors.faint, 700);
    return;
  }

  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    const y = rowTop + index * cellHeight;
    if (y > height - cellHeight - 6) break;
    const selected = index === selectedIndex;
    ctx.fillStyle = selected ? colors.active : index % 2 === 0 ? colors.black : colors.panel;
    ctx.fillRect(10, y, rowWidth, cellHeight);
    const section = fitText(command.section.toUpperCase(), 12);
    const title = fitText(command.title, Math.max(12, Math.floor((rowWidth - 240) / 7)));
    const shortcut = command.shortcut ? fitText(command.shortcut, 14) : "";
    write(section, 18, y + 3, command.disabled ? colors.faint : colors.gold, 700);
    write(title, 120, y + 3, command.disabled ? colors.faint : selected ? colors.gold : colors.text, selected ? 700 : 600);
    if (command.subtitle) write(fitText(command.subtitle, 42), 120, y + 21, colors.muted, 400);
    if (shortcut) write(shortcut, width - 118, y + 3, command.disabled ? colors.faint : colors.muted, 700);
    if (!command.disabled) hits.push({ index, x: 10, y, width: rowWidth, height: cellHeight });
  }
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

const fitText = (text: string, maxCells: number): string => {
  if (maxCells <= 0) return "";
  if (text.length <= maxCells) return text;
  if (maxCells <= 3) return text.slice(0, maxCells);
  return `${text.slice(0, maxCells - 3)}...`;
};

const modulo = (value: number, divisor: number): number => ((value % divisor) + divisor) % divisor;
