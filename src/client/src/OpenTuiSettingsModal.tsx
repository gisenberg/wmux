import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  createGrid,
  createGridPainter,
  fillCells,
  fitText,
  hexToRgba,
  observeCanvasViewport,
  setCellBackground,
  syncPainterViewport,
  writeText,
  type CellGrid,
  type CellMetrics,
  type RGBA,
} from "./opentui-grid";
import { WMUX_MONO_FONT_FAMILY } from "./fonts";
import type { DurableSessionAudit, MachineStatus, WmuxSettings } from "./types";

interface OpenTuiSettingsModalProps {
  machines: MachineStatus[];
  draft: WmuxSettings;
  defaultSettings: WmuxSettings;
  sessionAudit: DurableSessionAudit | null;
  sessionAuditError: string;
  sessionAuditLoading: boolean;
  saving: boolean;
  onApplyDraft: (settings: WmuxSettings) => void;
  onSave: (settings: WmuxSettings) => void | Promise<void>;
  onCancel: () => void;
  onUseDomFallback?: () => void;
  onRunSessionAudit: () => void | Promise<void>;
  onCleanupSession: (backend: "tmux" | "screen", name: string) => void | Promise<void>;
}

type FieldId = "font" | "scrollback" | `alias:${string}`;
type FocusId = FieldId | "dom" | "close" | "audit" | "reset" | "cancel" | "save" | `cleanup:${string}:${string}`;

interface EditState {
  id: FieldId;
  value: string;
}

interface LayoutSection {
  kind: "section";
  title: string;
  start: number;
  height: number;
}

interface LayoutNumber {
  kind: "number";
  id: "font" | "scrollback";
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  start: number;
  height: number;
}

interface LayoutAlias {
  kind: "alias";
  id: `alias:${string}`;
  machineId: string;
  label: string;
  value: string;
  placeholder: string;
  start: number;
  height: number;
}

interface LayoutAudit {
  kind: "audit";
  id: "audit";
  summary: string;
  start: number;
  height: number;
}

interface LayoutMessage {
  kind: "message";
  text: string;
  tone: "muted" | "error";
  start: number;
  height: number;
}

interface LayoutAuditRow {
  kind: "audit-row";
  id?: FocusId;
  backend?: "tmux" | "screen";
  name?: string;
  status: string;
  meta: string;
  detail: string;
  start: number;
  height: number;
}

type LayoutItem = LayoutSection | LayoutNumber | LayoutAlias | LayoutAudit | LayoutMessage | LayoutAuditRow;
type LayoutItemInput =
  | Omit<LayoutSection, "start">
  | Omit<LayoutNumber, "start">
  | Omit<LayoutAlias, "start">
  | Omit<LayoutAudit, "start">
  | Omit<LayoutMessage, "start">
  | Omit<LayoutAuditRow, "start">;

interface SettingsLayout {
  items: LayoutItem[];
  focusableIds: FocusId[];
  totalRows: number;
}

interface HitZone {
  row: number;
  col: number;
  width: number;
  height: number;
  id: FocusId;
  action: "focus" | "edit" | "decrement" | "increment" | "activate";
}

const fontMin = 10;
const fontMax = 24;
const scrollbackMin = 1_000;
const scrollbackMax = 200_000;

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

export function OpenTuiSettingsModal({
  machines,
  draft,
  defaultSettings,
  sessionAudit,
  sessionAuditError,
  sessionAuditLoading,
  saving,
  onApplyDraft,
  onSave,
  onCancel,
  onUseDomFallback,
  onRunSessionAudit,
  onCleanupSession,
}: OpenTuiSettingsModalProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const hitsRef = useRef<HitZone[]>([]);
  const metricsRef = useRef<CellMetrics>({ width: 8, height: 16, cols: 1, rows: 1 });
  const draftRef = useRef(draft);
  const [focusId, setFocusId] = useState<FocusId>("font");
  const [editing, setEditing] = useState<EditState | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [viewportRows, setViewportRows] = useState(32);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const layout = useMemo(
    () => buildLayout(machines, draft, sessionAudit, sessionAuditError, sessionAuditLoading),
    [draft, machines, sessionAudit, sessionAuditError, sessionAuditLoading],
  );
  const visibleContentRows = Math.max(1, viewportRows - 7);
  const maxScrollOffset = Math.max(0, layout.totalRows - visibleContentRows);

  useEffect(() => {
    if (scrollOffset > maxScrollOffset) setScrollOffset(maxScrollOffset);
  }, [maxScrollOffset, scrollOffset]);

  useEffect(() => {
    if (layout.focusableIds.includes(focusId)) return;
    setFocusId(layout.focusableIds[0] ?? "save");
  }, [focusId, layout.focusableIds]);

  useEffect(() => {
    const item = itemForFocus(layout, focusId);
    if (!item) return;
    if (item.start < scrollOffset) {
      setScrollOffset(item.start);
    } else if (item.start + item.height > scrollOffset + visibleContentRows) {
      setScrollOffset(Math.min(maxScrollOffset, item.start + item.height - visibleContentRows));
    }
  }, [focusId, layout, maxScrollOffset, scrollOffset, visibleContentRows]);

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
      setViewportRows((current) => (current === metrics.rows ? current : metrics.rows));
      painter.paint(drawSettings(metrics, layout, focusId, editing, scrollOffset, saving, hitsRef.current, !!onUseDomFallback));
    };

    paint();
    const observer = observeCanvasViewport(canvas, paint);
    return () => {
      observer.disconnect();
      painter.dispose();
    };
  }, [editing, focusId, layout, onUseDomFallback, saving, scrollOffset]);

  const applyNextDraft = (nextDraft: WmuxSettings) => {
    draftRef.current = nextDraft;
    onApplyDraft(nextDraft);
  };

  const commitEditing = (): WmuxSettings => {
    if (!editing) return draftRef.current;
    const nextDraft = applyEditState(draftRef.current, editing);
    setEditing(null);
    applyNextDraft(nextDraft);
    return nextDraft;
  };

  const startEditing = (id: FieldId, initial?: string) => {
    const current = draftRef.current;
    if (id === "font") setEditing({ id, value: initial ?? String(current.terminalFontSize) });
    else if (id === "scrollback") setEditing({ id, value: initial ?? String(current.terminalScrollbackRows) });
    else {
      const machineId = id.slice("alias:".length);
      setEditing({ id, value: initial ?? current.machineAliases[machineId] ?? "" });
    }
    setFocusId(id);
  };

  const adjustNumber = (id: "font" | "scrollback", direction: -1 | 1) => {
    const current = commitEditing();
    const next =
      id === "font"
        ? { ...current, terminalFontSize: clampFontSize(current.terminalFontSize + direction) }
        : { ...current, terminalScrollbackRows: clampScrollbackRows(current.terminalScrollbackRows + direction * 1000) };
    applyNextDraft(next);
    setFocusId(id);
  };

  const activate = async (id: FocusId) => {
    if (id === "dom") {
      commitEditing();
      onUseDomFallback?.();
      return;
    }
    if (id === "close" || id === "cancel") {
      onCancel();
      return;
    }
    if (id === "save") {
      const nextDraft = commitEditing();
      await onSave(nextDraft);
      return;
    }
    if (id === "reset") {
      setEditing(null);
      applyNextDraft({ ...defaultSettings });
      return;
    }
    if (id === "audit") {
      commitEditing();
      await onRunSessionAudit();
      return;
    }
    if (id.startsWith("cleanup:")) {
      commitEditing();
      const [, backend, ...nameParts] = id.split(":");
      if (backend === "tmux" || backend === "screen") await onCleanupSession(backend, nameParts.join(":"));
      return;
    }
    if (isFieldId(id)) startEditing(id);
  };

  const moveFocus = (delta: number) => {
    const ids = layout.focusableIds;
    if (!ids.length) return;
    commitEditing();
    const currentIndex = Math.max(0, ids.indexOf(focusId));
    setFocusId(ids[modulo(currentIndex + delta, ids.length)]);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey) {
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        void activate("save");
      }
      return;
    }

    if (editing) {
      if (event.key === "Escape") {
        event.preventDefault();
        setEditing(null);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        commitEditing();
        return;
      }
      if (event.key === "Backspace") {
        event.preventDefault();
        setEditing({ ...editing, value: editing.value.slice(0, -1) });
        return;
      }
      if (event.key.length === 1) {
        event.preventDefault();
        const nextValue =
          editing.id === "font" || editing.id === "scrollback"
            ? `${editing.value}${event.key}`.replace(/\D/g, "").slice(0, 6)
            : `${editing.value}${event.key}`.slice(0, 40);
        setEditing({ ...editing, value: nextValue });
      }
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      moveFocus(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveFocus(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(-1);
      return;
    }
    if (event.key === "ArrowLeft" && (focusId === "font" || focusId === "scrollback")) {
      event.preventDefault();
      adjustNumber(focusId, -1);
      return;
    }
    if (event.key === "ArrowRight" && (focusId === "font" || focusId === "scrollback")) {
      event.preventDefault();
      adjustNumber(focusId, 1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      void activate(focusId);
      return;
    }
    if (event.key.length === 1 && isFieldId(focusId)) {
      event.preventDefault();
      startEditing(focusId, event.key);
    }
  };

  const onCanvasClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const hit = hitFromEvent(event.clientX, event.clientY);
    panelRef.current?.focus();
    if (!hit) return;
    if (hit.action === "increment" && (hit.id === "font" || hit.id === "scrollback")) {
      adjustNumber(hit.id, 1);
      return;
    }
    if (hit.action === "decrement" && (hit.id === "font" || hit.id === "scrollback")) {
      adjustNumber(hit.id, -1);
      return;
    }
    if (hit.action === "edit" && isFieldId(hit.id)) {
      startEditing(hit.id);
      return;
    }
    if (hit.action === "activate") {
      void activate(hit.id);
      return;
    }
    commitEditing();
    setFocusId(hit.id);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const hit = hitFromEvent(event.clientX, event.clientY);
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.style.cursor = hit ? "pointer" : "default";
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (maxScrollOffset <= 0) return;
    event.preventDefault();
    const deltaRows = Math.sign(event.deltaY) * Math.max(1, Math.round(Math.abs(event.deltaY) / metricsRef.current.height));
    setScrollOffset((current) => Math.min(maxScrollOffset, Math.max(0, current + deltaRows)));
  };

  const hitFromEvent = (clientX: number, clientY: number): HitZone | undefined => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const rect = canvas.getBoundingClientRect();
    const row = Math.floor((clientY - rect.top) / metricsRef.current.height);
    const col = Math.floor((clientX - rect.left) / metricsRef.current.width);
    return hitsRef.current.find(
      (hit) => row >= hit.row && row < hit.row + hit.height && col >= hit.col && col < hit.col + hit.width,
    );
  };

  return (
    <div className="settings-backdrop open-tui-settings-backdrop" onMouseDown={(event) => event.currentTarget === event.target && onCancel()}>
      <div
        ref={panelRef}
        className="open-tui-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onWheel={onWheel}
      >
        <canvas ref={canvasRef} className="open-tui-settings-canvas" onClick={onCanvasClick} onPointerMove={onPointerMove} />
      </div>
    </div>
  );
}

const buildLayout = (
  machines: MachineStatus[],
  draft: WmuxSettings,
  sessionAudit: DurableSessionAudit | null,
  sessionAuditError: string,
  sessionAuditLoading: boolean,
): SettingsLayout => {
  const items: LayoutItem[] = [];
  const focusableIds: FocusId[] = ["dom", "close"];
  let row = 0;

  const push = (item: LayoutItemInput) => {
    items.push({ ...item, start: row } as LayoutItem);
    if ("id" in item && typeof item.id === "string") focusableIds.push(item.id as FocusId);
    row += item.height;
  };

  push({ kind: "section", title: "GHOSTTY", height: 2 });
  push({
    kind: "number",
    id: "font",
    label: "font size",
    value: draft.terminalFontSize,
    min: fontMin,
    max: fontMax,
    step: 1,
    suffix: "px",
    height: 3,
  });
  push({
    kind: "number",
    id: "scrollback",
    label: "scrollback",
    value: draft.terminalScrollbackRows,
    min: scrollbackMin,
    max: scrollbackMax,
    step: 1000,
    suffix: "rows",
    height: 3,
  });

  push({ kind: "section", title: "HOST ALIASES", height: 2 });
  for (const machine of machines) {
    push({
      kind: "alias",
      id: `alias:${machine.id}`,
      machineId: machine.id,
      label: machine.name,
      value: draft.machineAliases[machine.id] ?? "",
      placeholder: machine.id,
      height: 2,
    });
  }

  push({ kind: "section", title: "DURABLE SESSIONS", height: 2 });
  push({
    kind: "audit",
    id: "audit",
    summary: sessionAuditLoading
      ? "running local tmux/screen audit"
      : sessionAudit
        ? `${sessionAudit.summary.orphanCount} orphan / ${sessionAudit.summary.duplicateCount} duplicate / ${sessionAudit.summary.missingCount} missing`
        : "read-only local tmux/screen check",
    height: 3,
  });
  if (sessionAuditError) push({ kind: "message", text: sessionAuditError, tone: "error", height: 2 });
  if (sessionAudit) {
    push({
      kind: "message",
      text: `${sessionAudit.summary.activePaneCount} panes / ${sessionAudit.summary.sessionCount} sessions`,
      tone: "muted",
      height: 2,
    });
    for (const session of sessionAudit.sessions) {
      const id = session.cleanupAllowed ? (`cleanup:${session.backend}:${session.name}` as const) : undefined;
      push({
        kind: "audit-row",
        id,
        backend: session.backend,
        name: session.name,
        status: session.status,
        meta: `${session.backend} ${session.name}`,
        detail: session.detail,
        height: 2,
      });
    }
    for (const missing of sessionAudit.missing) {
      push({
        kind: "audit-row",
        status: "missing",
        meta: missing.name,
        detail: missing.paneId,
        height: 2,
      });
    }
  }

  focusableIds.push("reset", "cancel", "save");
  return { items, focusableIds, totalRows: row };
};

const drawSettings = (
  metrics: CellMetrics,
  layout: SettingsLayout,
  focusId: FocusId,
  editing: EditState | null,
  scrollOffset: number,
  saving: boolean,
  hits: HitZone[],
  canUseDomFallback: boolean,
): CellGrid => {
  hits.length = 0;
  const { cols, rows } = metrics;
  const grid = createGrid(cols, rows, rgba.black, rgba.text);
  const write = (row: number, col: number, text: string, color: RGBA, weight: 400 | 600 | 700 = 600) => {
    writeText(grid, row, col, fitText(text, Math.max(0, cols - col - 1)), color, weight >= 700 ? 1 : 0);
  };
  const fillRow = (row: number, color: RGBA) => fillCells(grid, row, 0, cols, color);
  const contentTop = 4;
  const footerTop = Math.max(contentTop + 1, rows - 3);
  const contentBottom = Math.max(contentTop, footerTop - 1);

  for (let row = 0; row < rows; row += 1) {
    fillRow(row, row % 2 === 0 ? rgba.black : rgba.panel);
  }
  drawBox(grid, 0, 0, cols, rows, rgba.line, rgba.black);
  fillCells(grid, 1, 1, Math.max(0, cols - 2), rgba.panel);
  fillCells(grid, 3, 1, Math.max(0, cols - 2), rgba.line);
  fillCells(grid, footerTop, 1, Math.max(0, cols - 2), rgba.line);
  write(1, 2, "WMUX SETTINGS", rgba.gold, 700);
  write(2, 2, "wmux canvas console", rgba.faint, 600);

  let closeCol = Math.max(2, cols - 7);
  drawButton(grid, 1, closeCol, "X", focusId === "close", hits, "close", "activate");
  if (canUseDomFallback) {
    const domCol = Math.max(2, closeCol - 7);
    drawButton(grid, 1, domCol, "DOM", focusId === "dom", hits, "dom", "activate");
  }

  for (const item of layout.items) {
    const row = contentTop + item.start - scrollOffset;
    if (row + item.height <= contentTop || row >= contentBottom) continue;
    if (item.kind === "section") {
      fillCells(grid, row, 1, Math.max(0, cols - 2), rgba.black);
      write(row, 2, item.title, rgba.gold, 700);
    } else if (item.kind === "number") {
      drawNumber(grid, item, row, cols, focusId, editing, hits);
    } else if (item.kind === "alias") {
      drawAlias(grid, item, row, cols, focusId, editing, hits);
    } else if (item.kind === "audit") {
      const selected = focusId === item.id;
      fillCells(grid, row, 1, Math.max(0, cols - 2), selected ? rgba.active : rgba.panel);
      drawButton(grid, row, 2, "audit sessions", selected, hits, "audit", "activate");
      write(row, 20, item.summary, selected ? rgba.text : rgba.muted, selected ? 700 : 600);
    } else if (item.kind === "message") {
      write(row, 2, item.text, item.tone === "error" ? rgba.red : rgba.faint, 600);
    } else {
      const selected = item.id === focusId;
      fillCells(grid, row, 1, Math.max(0, cols - 2), selected ? rgba.active : rgba.black);
      write(row, 2, item.status.toUpperCase(), statusColor(item.status), 700);
      write(row, 14, item.meta, selected ? rgba.text : rgba.muted, selected ? 700 : 600);
      write(row + 1, 14, item.detail, rgba.faint, 400);
      if (item.id && item.backend && item.name) {
        drawButton(grid, row, Math.max(2, cols - 9), "quit", selected, hits, item.id, "activate");
      }
    }
  }

  const saveCol = Math.max(2, cols - 9);
  const cancelCol = Math.max(2, saveCol - 10);
  const resetCol = Math.max(2, cancelCol - 9);
  const hintMax = Math.max(0, resetCol - 4);
  if (hintMax >= 12) {
    writeText(
      grid,
      footerTop + 1,
      2,
      fitText(cols >= 80 ? "arrows select/change  enter edit/run  esc close" : "enter edit / esc close", hintMax),
      rgba.faint,
      1,
    );
  }
  drawButton(grid, footerTop + 1, resetCol, "reset", focusId === "reset", hits, "reset", "activate");
  drawButton(grid, footerTop + 1, cancelCol, "cancel", focusId === "cancel", hits, "cancel", "activate");
  drawButton(grid, footerTop + 1, saveCol, saving ? "saving" : "save", focusId === "save", hits, "save", "activate");

  return grid;
};

const drawNumber = (
  grid: CellGrid,
  item: LayoutNumber,
  row: number,
  cols: number,
  focusId: FocusId,
  editing: EditState | null,
  hits: HitZone[],
) => {
  const selected = focusId === item.id;
  const editValue = editing?.id === item.id ? editing.value : null;
  const displayValue = editValue === null ? item.value.toLocaleString() : `${editValue}_`;
  fillCells(grid, row, 1, Math.max(0, cols - 2), selected ? rgba.active : rgba.panel);
  writeText(grid, row, 2, item.label.toUpperCase(), selected ? rgba.gold : rgba.muted, 1);
  const fieldCol = Math.min(24, Math.max(16, Math.floor(cols * 0.34)));
  drawField(grid, row, fieldCol, Math.max(12, cols - fieldCol - 15), `${displayValue} ${item.suffix}`, selected, hits, item.id);
  drawButton(grid, row, Math.max(fieldCol + 12, cols - 13), "-", false, hits, item.id, "decrement");
  drawButton(grid, row, Math.max(fieldCol + 17, cols - 7), "+", false, hits, item.id, "increment");
  const barCol = fieldCol;
  const barWidth = Math.max(10, cols - barCol - 3);
  const filled = Math.max(1, Math.round(((item.value - item.min) / (item.max - item.min)) * barWidth));
  fillCells(grid, row + 1, barCol, barWidth, rgba.line);
  fillCells(grid, row + 1, barCol, Math.min(barWidth, filled), selected ? rgba.gold : rgba.faint);
  hits.push({ row, col: 1, width: Math.max(1, cols - 2), height: 2, id: item.id, action: "focus" });
};

const drawAlias = (
  grid: CellGrid,
  item: LayoutAlias,
  row: number,
  cols: number,
  focusId: FocusId,
  editing: EditState | null,
  hits: HitZone[],
) => {
  const selected = focusId === item.id;
  const editingValue = editing?.id === item.id ? editing.value : null;
  const value = editingValue === null ? item.value || item.placeholder : `${editingValue}_`;
  const valueColor = item.value || editingValue !== null ? rgba.text : rgba.faint;
  fillCells(grid, row, 1, Math.max(0, cols - 2), selected ? rgba.active : rgba.black);
  writeText(grid, row, 2, fitText(item.label.toUpperCase(), 18), selected ? rgba.gold : rgba.muted, 1);
  drawField(grid, row, 22, Math.max(12, cols - 25), value, selected, hits, item.id, valueColor);
  writeText(grid, row + 1, 22, fitText(`id ${item.machineId}`, Math.max(0, cols - 25)), rgba.faint, 0);
  hits.push({ row, col: 1, width: Math.max(1, cols - 2), height: 2, id: item.id, action: "focus" });
};

const drawField = (
  grid: CellGrid,
  row: number,
  col: number,
  width: number,
  value: string,
  selected: boolean,
  hits: HitZone[],
  id: FieldId,
  color: RGBA = rgba.text,
) => {
  if (width <= 0) return;
  fillCells(grid, row, col, width, selected ? rgba.black : rgba.panel);
  setCellBackground(grid, row, col, selected ? rgba.gold : rgba.line);
  setCellBackground(grid, row, col + width - 1, selected ? rgba.gold : rgba.line);
  writeText(grid, row, col + 1, fitText(value, width - 2), color, selected ? 1 : 0);
  hits.push({ row, col, width, height: 1, id, action: "edit" });
};

const drawButton = (
  grid: CellGrid,
  row: number,
  col: number,
  label: string,
  selected: boolean,
  hits: HitZone[],
  id: FocusId,
  action: HitZone["action"],
) => {
  const text = `[${label}]`;
  const width = text.length;
  fillCells(grid, row, col, width, selected ? rgba.active : rgba.black);
  writeText(grid, row, col, text, selected ? rgba.gold : rgba.text, selected ? 1 : 0);
  hits.push({ row, col, width, height: 1, id, action });
};

const drawBox = (grid: CellGrid, row: number, col: number, width: number, height: number, color: RGBA, background: RGBA) => {
  if (width <= 1 || height <= 1) return;
  const lastRow = row + height - 1;
  const lastCol = col + width - 1;
  for (let x = col; x <= lastCol; x += 1) {
    writeCell(grid, row, x, x === col || x === lastCol ? "+" : "-", color, background);
    writeCell(grid, lastRow, x, x === col || x === lastCol ? "+" : "-", color, background);
  }
  for (let y = row + 1; y < lastRow; y += 1) {
    writeCell(grid, y, col, "|", color, background);
    writeCell(grid, y, lastCol, "|", color, background);
  }
};

const writeCell = (grid: CellGrid, row: number, col: number, char: string, color: RGBA, background: RGBA) => {
  if (row < 0 || row >= grid.height || col < 0 || col >= grid.width) return;
  const index = row * grid.width + col;
  grid.chars[index] = char.codePointAt(0) ?? 0x20;
  grid.attrs[index] = 1;
  for (let offset = 0; offset < 4; offset += 1) {
    grid.fg[index * 4 + offset] = color[offset];
    grid.bg[index * 4 + offset] = background[offset];
  }
};

const itemForFocus = (layout: SettingsLayout, focusId: FocusId): LayoutItem | undefined =>
  layout.items.find((item) => "id" in item && item.id === focusId);

const isFieldId = (id: FocusId): id is FieldId => id === "font" || id === "scrollback" || id.startsWith("alias:");

const applyEditState = (draft: WmuxSettings, editing: EditState): WmuxSettings => {
  if (editing.id === "font") return { ...draft, terminalFontSize: clampFontSize(Number(editing.value)) };
  if (editing.id === "scrollback") return { ...draft, terminalScrollbackRows: clampScrollbackRows(Number(editing.value)) };
  const machineId = editing.id.slice("alias:".length);
  const machineAliases = { ...draft.machineAliases };
  const alias = cleanAlias(editing.value);
  if (alias) machineAliases[machineId] = alias;
  else delete machineAliases[machineId];
  return { ...draft, machineAliases };
};

const clampFontSize = (value: number): number => {
  const numeric = Number.isFinite(value) ? value : 14;
  return Math.min(fontMax, Math.max(fontMin, Math.round(numeric)));
};

const clampScrollbackRows = (value: number): number => {
  const numeric = Number.isFinite(value) ? value : 10_000;
  return Math.min(scrollbackMax, Math.max(scrollbackMin, Math.round(numeric)));
};

const cleanAlias = (value: string): string => value.replace(/\s+/g, " ").trim().slice(0, 40);

const statusColor = (status: string): RGBA => {
  if (status === "active") return rgba.green;
  if (status === "missing" || status === "duplicate") return rgba.gold;
  if (status === "orphan") return rgba.red;
  return rgba.muted;
};

const modulo = (value: number, divisor: number): number => ((value % divisor) + divisor) % divisor;
