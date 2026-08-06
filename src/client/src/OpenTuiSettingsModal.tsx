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
  observeCanvasViewport,
  setCellBackground,
  syncPainterViewport,
  writeText,
  type CellGrid,
  type CellMetrics,
  type RGBA,
} from "./opentui-grid";
import { WMUX_MONO_FONT_FAMILY } from "./fonts";
import { terminalColorSchemes } from "./color-schemes";
import { useOpenTuiTheme, type OpenTuiTheme } from "./color-scheme-context";
import { compileKeybindings, eventMatchesAction } from "../../shared/keybindings";
import { MAX_TERMINAL_FONT_SIZE, MIN_TERMINAL_FONT_SIZE } from "./types";
import type { DurableSessionAudit, KeybindingMap, MachineStatus, WmuxSettings } from "./types";
import type {
  BrowserSessionMetadata,
  ScopedCredentialMetadata,
} from "./api";

interface OpenTuiSettingsModalProps {
  machines: MachineStatus[];
  draft: WmuxSettings;
  defaultSettings: WmuxSettings;
  sessionAudit: DurableSessionAudit | null;
  sessionAuditError: string;
  sessionAuditLoading: boolean;
  browserSessions: BrowserSessionMetadata[];
  currentSessionId?: string;
  scopedCredentials: ScopedCredentialMetadata[];
  securityAvailable: boolean;
  securityLoading: boolean;
  securityError: string;
  saving: boolean;
  keybindings: KeybindingMap;
  appleKeybindings: boolean;
  onApplyDraft: (settings: WmuxSettings) => void;
  onSave: (settings: WmuxSettings) => void | Promise<void>;
  onCancel: () => void;
  onManageMachines: () => void;
  onRunSessionAudit: () => void | Promise<void>;
  onCleanupSession: (
    backend: "tmux" | "screen" | "agent",
    name: string,
    cleanupKey?: string,
  ) => void | Promise<void>;
  onRevokeBrowserSession: (session: BrowserSessionMetadata) => void | Promise<void>;
  onRotateScopedCredential: (credential: ScopedCredentialMetadata) => void | Promise<void>;
}

type FieldId = "font" | "scrollback" | `alias:${string}`;
type ChoiceId = "scheme" | "inactive-streaming" | "frame-rate" | "terminal-scroll" | "sidebar-host-grouping";
type FocusId = FieldId | ChoiceId | "manage" | "close" | "audit" | "reset" | "cancel" | "save" | `cleanup:${string}` | `revoke:${string}` | `rotate:${string}`;

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

interface LayoutChoice {
  kind: "choice";
  id: ChoiceId;
  label: string;
  value: string;
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
  backend?: "tmux" | "screen" | "agent";
  name?: string;
  status: string;
  meta: string;
  detail: string;
  actionLabel?: string;
  start: number;
  height: number;
}

type LayoutItem = LayoutSection | LayoutNumber | LayoutChoice | LayoutAlias | LayoutAudit | LayoutMessage | LayoutAuditRow;
type LayoutItemInput =
  | Omit<LayoutSection, "start">
  | Omit<LayoutNumber, "start">
  | Omit<LayoutChoice, "start">
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

const fontMin = MIN_TERMINAL_FONT_SIZE;
const fontMax = MAX_TERMINAL_FONT_SIZE;
const scrollbackMin = 1_000;
const scrollbackMax = 200_000;

export function OpenTuiSettingsModal({
  machines,
  draft,
  defaultSettings,
  sessionAudit,
  sessionAuditError,
  sessionAuditLoading,
  browserSessions,
  currentSessionId,
  scopedCredentials,
  securityAvailable,
  securityLoading,
  securityError,
  saving,
  keybindings,
  appleKeybindings,
  onApplyDraft,
  onSave,
  onCancel,
  onManageMachines,
  onRunSessionAudit,
  onCleanupSession,
  onRevokeBrowserSession,
  onRotateScopedCredential,
}: OpenTuiSettingsModalProps) {
  const theme = useOpenTuiTheme();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const editorInputRef = useRef<HTMLInputElement | null>(null);
  const hitsRef = useRef<HitZone[]>([]);
  const metricsRef = useRef<CellMetrics>({ width: 8, height: 16, cols: 1, rows: 1 });
  const draftRef = useRef(draft);
  const pointerScrollRef = useRef<{
    pointerId: number;
    startY: number;
    startOffset: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [focusId, setFocusId] = useState<FocusId>("font");
  const [editing, setEditing] = useState<EditState | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [viewportRows, setViewportRows] = useState(32);
  const [semanticMetrics, setSemanticMetrics] = useState<CellMetrics>(metricsRef.current);
  const compiledKeybindings = useMemo(() => compileKeybindings(keybindings), [keybindings]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    const focusPanel = () => panelRef.current?.focus({ preventScroll: true });
    focusPanel();
    const focusFrame = window.requestAnimationFrame(focusPanel);
    return () => window.cancelAnimationFrame(focusFrame);
  }, []);

  useEffect(() => {
    if (!editing) return;
    const input = editorInputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  }, [editing?.id]);

  const layout = useMemo(
    () => buildLayout(
      machines,
      draft,
      sessionAudit,
      sessionAuditError,
      sessionAuditLoading,
      browserSessions,
      currentSessionId,
      scopedCredentials,
      securityAvailable,
      securityLoading,
      securityError,
    ),
    [
      browserSessions,
      currentSessionId,
      draft,
      machines,
      scopedCredentials,
      securityAvailable,
      securityError,
      securityLoading,
      sessionAudit,
      sessionAuditError,
      sessionAuditLoading,
    ],
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
      clearColor: theme.colors.black,
    });

    const paint = (entry?: ResizeObserverEntry) => {
      const metrics = syncPainterViewport(painter, canvas, entry);
      metricsRef.current = metrics;
      setSemanticMetrics((current) =>
        current.width === metrics.width && current.height === metrics.height && current.cols === metrics.cols && current.rows === metrics.rows
          ? current
          : metrics);
      setViewportRows((current) => (current === metrics.rows ? current : metrics.rows));
      painter.paint(drawSettings(metrics, layout, focusId, editing, scrollOffset, saving, hitsRef.current, theme));
    };

    paint();
    const observer = observeCanvasViewport(canvas, paint);
    return () => {
      observer.disconnect();
      painter.dispose();
    };
  }, [editing, focusId, layout, saving, scrollOffset, theme]);

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

  const adjustScheme = (direction: -1 | 1) => {
    const current = commitEditing();
    const currentIndex = Math.max(0, terminalColorSchemes.findIndex((scheme) => scheme.id === current.colorScheme));
    const colorScheme = terminalColorSchemes[modulo(currentIndex + direction, terminalColorSchemes.length)].id;
    applyNextDraft({ ...current, colorScheme });
    setFocusId("scheme");
  };

  const adjustInactiveStreaming = () => {
    const current = commitEditing();
    applyNextDraft({ ...current, inactiveTabStreaming: current.inactiveTabStreaming === "suspend" ? "live" : "suspend" });
    setFocusId("inactive-streaming");
  };
  const adjustTerminalScroll = () => {
    const current = commitEditing();
    applyNextDraft({ ...current, terminalScrollMode: current.terminalScrollMode === "batched" ? "immediate" : "batched" });
    setFocusId("terminal-scroll");
  };
  const toggleSidebarHostGrouping = () => {
    const current = commitEditing();
    applyNextDraft({ ...current, groupSidebarSessionsByHost: !current.groupSidebarSessionsByHost });
    setFocusId("sidebar-host-grouping");
  };
  const adjustFrameRate = (direction: -1 | 1) => {
    const current = commitEditing();
    const rates = [15, 30, 60] as const;
    const index = Math.max(0, rates.indexOf(current.tuiFrameRate));
    applyNextDraft({ ...current, tuiFrameRate: rates[modulo(index + direction, rates.length)] });
    setFocusId("frame-rate");
  };

  const activate = async (id: FocusId) => {
    if (id === "manage") {
      commitEditing();
      onManageMachines();
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
    if (id === "scheme") {
      adjustScheme(1);
      return;
    }
    if (id === "inactive-streaming") {
      adjustInactiveStreaming();
      return;
    }
    if (id === "frame-rate") { adjustFrameRate(1); return; }
    if (id === "terminal-scroll") { adjustTerminalScroll(); return; }
    if (id === "sidebar-host-grouping") { toggleSidebarHostGrouping(); return; }
    if (id.startsWith("cleanup:")) {
      commitEditing();
      const [backend, name, cleanupKey] = JSON.parse(
        decodeURIComponent(id.slice("cleanup:".length)),
      ) as ["tmux" | "screen" | "agent", string, string | null];
      if (backend === "tmux" || backend === "screen" || backend === "agent") {
        await onCleanupSession(backend, name, cleanupKey ?? undefined);
      }
      return;
    }
    if (id.startsWith("revoke:")) {
      const sessionId = decodeURIComponent(id.slice("revoke:".length));
      const session = browserSessions.find((candidate) => candidate.id === sessionId);
      if (session) await onRevokeBrowserSession(session);
      return;
    }
    if (id.startsWith("rotate:")) {
      const kind = id.slice("rotate:".length);
      const credential = scopedCredentials.find((candidate) => candidate.kind === kind);
      if (credential) await onRotateScopedCredential(credential);
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
    if (eventMatchesAction(event, compiledKeybindings, "settings.save", appleKeybindings)) {
      event.preventDefault();
      void activate("save");
      return;
    }
    if (event.metaKey || event.ctrlKey) {
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
    if (event.key === "ArrowLeft" && (focusId === "font" || focusId === "scrollback" || focusId === "scheme" || focusId === "inactive-streaming" || focusId === "frame-rate" || focusId === "terminal-scroll" || focusId === "sidebar-host-grouping")) {
      event.preventDefault();
      if (focusId === "scheme") adjustScheme(-1);
      else if (focusId === "inactive-streaming") adjustInactiveStreaming();
      else if (focusId === "frame-rate") adjustFrameRate(-1);
      else if (focusId === "terminal-scroll") adjustTerminalScroll();
      else if (focusId === "sidebar-host-grouping") toggleSidebarHostGrouping();
      else adjustNumber(focusId, -1);
      return;
    }
    if (event.key === "ArrowRight" && (focusId === "font" || focusId === "scrollback" || focusId === "scheme" || focusId === "inactive-streaming" || focusId === "frame-rate" || focusId === "terminal-scroll" || focusId === "sidebar-host-grouping")) {
      event.preventDefault();
      if (focusId === "scheme") adjustScheme(1);
      else if (focusId === "inactive-streaming") adjustInactiveStreaming();
      else if (focusId === "frame-rate") adjustFrameRate(1);
      else if (focusId === "terminal-scroll") adjustTerminalScroll();
      else if (focusId === "sidebar-host-grouping") toggleSidebarHostGrouping();
      else adjustNumber(focusId, 1);
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

  useEffect(() => {
    const routeDetachedKeyDown = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel || panel.contains(event.target as Node)) return;
      event.stopPropagation();
      onKeyDown(event as unknown as ReactKeyboardEvent<HTMLDivElement>);
    };
    document.addEventListener("keydown", routeDetachedKeyDown, true);
    return () => document.removeEventListener("keydown", routeDetachedKeyDown, true);
  });

  const onCanvasClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const hit = hitFromEvent(event.clientX, event.clientY);
    panelRef.current?.focus();
    if (!hit) return;
    if (hit.action === "increment" && (hit.id === "font" || hit.id === "scrollback" || hit.id === "scheme" || hit.id === "inactive-streaming" || hit.id === "frame-rate" || hit.id === "terminal-scroll" || hit.id === "sidebar-host-grouping")) {
      if (hit.id === "scheme") adjustScheme(1);
      else if (hit.id === "inactive-streaming") adjustInactiveStreaming();
      else if (hit.id === "frame-rate") adjustFrameRate(1);
      else if (hit.id === "terminal-scroll") adjustTerminalScroll();
      else if (hit.id === "sidebar-host-grouping") toggleSidebarHostGrouping();
      else adjustNumber(hit.id, 1);
      return;
    }
    if (hit.action === "decrement" && (hit.id === "font" || hit.id === "scrollback" || hit.id === "scheme" || hit.id === "inactive-streaming" || hit.id === "frame-rate" || hit.id === "terminal-scroll" || hit.id === "sidebar-host-grouping")) {
      if (hit.id === "scheme") adjustScheme(-1);
      else if (hit.id === "inactive-streaming") adjustInactiveStreaming();
      else if (hit.id === "frame-rate") adjustFrameRate(-1);
      else if (hit.id === "terminal-scroll") adjustTerminalScroll();
      else if (hit.id === "sidebar-host-grouping") toggleSidebarHostGrouping();
      else adjustNumber(hit.id, -1);
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

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerScrollRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startOffset: scrollOffset,
      moved: false,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const scroll = pointerScrollRef.current;
    if (scroll?.pointerId === event.pointerId) {
      const deltaY = scroll.startY - event.clientY;
      if (!scroll.moved && Math.abs(deltaY) > 5) {
        scroll.moved = true;
        suppressClickRef.current = true;
      }
      if (scroll.moved) {
        event.preventDefault();
        const deltaRows = Math.round(deltaY / metricsRef.current.height);
        setScrollOffset(Math.min(
          maxScrollOffset,
          Math.max(0, scroll.startOffset + deltaRows),
        ));
      }
    }
    const hit = hitFromEvent(event.clientX, event.clientY);
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.style.cursor = hit ? "pointer" : "default";
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const scroll = pointerScrollRef.current;
    if (!scroll || scroll.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    pointerScrollRef.current = null;
    if (scroll.moved) {
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
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

  const sidebarGroupingItem = layout.items.find((item): item is LayoutChoice =>
    item.kind === "choice" && item.id === "sidebar-host-grouping");
  const contentTop = 4;
  const footerTop = Math.max(contentTop + 1, semanticMetrics.rows - 3);
  const groupingRow = sidebarGroupingItem
    ? contentTop + sidebarGroupingItem.start - scrollOffset
    : -1;
  const groupingVisible = Boolean(sidebarGroupingItem
    && groupingRow >= contentTop
    && groupingRow + sidebarGroupingItem.height <= footerTop);
  const saveCol = Math.max(2, semanticMetrics.cols - 9);

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
        <canvas
          ref={canvasRef}
          className="open-tui-settings-canvas"
          onClick={onCanvasClick}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        />
        {groupingVisible && sidebarGroupingItem ? (
          <button
            type="button"
            className="open-tui-settings-semantic"
            style={{
              top: groupingRow * semanticMetrics.height,
              height: sidebarGroupingItem.height * semanticMetrics.height,
              left: semanticMetrics.width,
              right: semanticMetrics.width,
            }}
            aria-label="Group sidebar sessions by host"
            aria-pressed={draft.groupSidebarSessionsByHost}
            onClick={toggleSidebarHostGrouping}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") event.stopPropagation();
            }}
          />
        ) : null}
        <button
          type="button"
          className="open-tui-settings-save-semantic"
          style={{
            top: (footerTop + 1) * semanticMetrics.height,
            left: saveCol * semanticMetrics.width,
            width: (saving ? "[saving]" : "[save]").length * semanticMetrics.width,
            height: semanticMetrics.height,
          }}
          aria-label="Save settings"
          onClick={() => void activate("save")}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") event.stopPropagation();
          }}
        />
        {editing ? (
          <input
            ref={editorInputRef}
            className="open-tui-settings-editor-input"
            aria-label={editing.id.startsWith("alias:") ? "Edit host alias" : `Edit ${editing.id}`}
            inputMode={editing.id === "font" || editing.id === "scrollback" ? "numeric" : "text"}
            value={editing.value}
            onChange={(event) => {
              const value = editing.id === "font" || editing.id === "scrollback"
                ? event.currentTarget.value.replace(/\D/g, "").slice(0, 6)
                : event.currentTarget.value.slice(0, 40);
              setEditing({ ...editing, value });
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                commitEditing();
                panelRef.current?.focus({ preventScroll: true });
              } else if (event.key === "Escape") {
                event.preventDefault();
                setEditing(null);
                panelRef.current?.focus({ preventScroll: true });
              }
            }}
            onBlur={() => {
              if (!editing) return;
              commitEditing();
            }}
          />
        ) : null}
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
  browserSessions: BrowserSessionMetadata[],
  currentSessionId: string | undefined,
  scopedCredentials: ScopedCredentialMetadata[],
  securityAvailable: boolean,
  securityLoading: boolean,
  securityError: string,
): SettingsLayout => {
  const items: LayoutItem[] = [];
  const focusableIds: FocusId[] = ["manage", "close"];
  let row = 0;

  const push = (item: LayoutItemInput) => {
    items.push({ ...item, start: row } as LayoutItem);
    if ("id" in item && typeof item.id === "string") focusableIds.push(item.id as FocusId);
    row += item.height;
  };

  push({ kind: "section", title: "APPEARANCE", height: 2 });
  push({
    kind: "choice",
    id: "scheme",
    label: "app color scheme",
    value: terminalColorSchemes.find((scheme) => scheme.id === draft.colorScheme)?.name ?? terminalColorSchemes[0].name,
    height: 2,
  });
  push({ kind: "choice", id: "frame-rate", label: "full-screen redraw", value: `${draft.tuiFrameRate} FPS`, height: 2 });
  push({ kind: "choice", id: "terminal-scroll", label: "terminal scrolling", value: draft.terminalScrollMode === "batched" ? "Performance (batched)" : "Smooth (immediate)", height: 2 });
  push({
    kind: "choice",
    id: "sidebar-host-grouping",
    label: "group sidebar sessions by host",
    value: draft.groupSidebarSessionsByHost ? "Grouped" : "Global tree",
    height: 2,
  });
  push({
    kind: "choice",
    id: "inactive-streaming",
    label: "hidden tabs",
    value: draft.inactiveTabStreaming === "suspend" ? "suspend streaming" : "keep streaming live",
    height: 2,
  });
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

  push({ kind: "section", title: "SESSIONS AND CREDENTIALS", height: 2 });
  if (securityLoading && !securityAvailable) {
    push({ kind: "message", text: "loading security inventory", tone: "muted", height: 2 });
  } else if (!securityAvailable && !securityError) {
    push({ kind: "message", text: "available with login-only browser authentication", tone: "muted", height: 2 });
  }
  if (securityError) push({ kind: "message", text: securityError, tone: "error", height: 2 });
  if (securityAvailable) {
    for (const session of browserSessions) {
      push({
        kind: "audit-row",
        id: `revoke:${encodeURIComponent(session.id)}`,
        status: session.id === currentSessionId ? "current" : "session",
        meta: `${session.device} @ ${session.address}`,
        detail: `issued ${formatTimestamp(session.issuedAt)} / seen ${formatTimestamp(session.lastSeenAt)}`,
        actionLabel: "revoke",
        height: 2,
      });
    }
    for (const credential of scopedCredentials) {
      push({
        kind: "audit-row",
        id: credential.rotatable ? `rotate:${credential.kind}` : undefined,
        status: credential.kind,
        meta: `issued ${formatTimestamp(credential.issuedAt)}`,
        detail: `expires ${formatTimestamp(credential.expiresAt)}${credential.rotatable ? "" : " / environment-backed"}`,
        actionLabel: credential.rotatable ? "rotate" : undefined,
        height: 2,
      });
    }
  }

  push({ kind: "section", title: "DURABLE SESSIONS", height: 2 });
  push({
    kind: "audit",
    id: "audit",
    summary: sessionAuditLoading
      ? "running local and registered-host durable-session audit"
      : sessionAudit
        ? `${sessionAudit.summary.orphanCount} orphan / ${sessionAudit.summary.duplicateCount} duplicate / ${sessionAudit.summary.missingCount} missing / ${sessionAudit.summary.unreachableCount ?? 0} unreachable`
        : "read-only local and registered-host durable-session check",
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
      const id = session.cleanupAllowed
        ? (`cleanup:${encodeURIComponent(JSON.stringify([
          session.backend,
          session.name,
          session.cleanupKey ?? null,
        ]))}` as const)
        : undefined;
      push({
        kind: "audit-row",
        id,
        backend: session.backend,
        name: session.name,
        status: session.status,
        meta: `${session.backend} ${session.name}`,
        detail: session.endpoint ? `${session.endpoint}: ${session.detail}` : session.detail,
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
  theme: OpenTuiTheme,
): CellGrid => {
  const { rgba } = theme;
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
  drawButton(grid, 1, closeCol, "X", focusId === "close", hits, "close", "activate", theme);
  const manageCol = Math.max(2, closeCol - 17);
  drawButton(grid, 1, manageCol, "MACHINES", focusId === "manage", hits, "manage", "activate", theme);

  for (const item of layout.items) {
    const row = contentTop + item.start - scrollOffset;
    if (row + item.height <= contentTop || row >= contentBottom) continue;
    if (item.kind === "section") {
      fillCells(grid, row, 1, Math.max(0, cols - 2), rgba.black);
      write(row, 2, item.title, rgba.gold, 700);
    } else if (item.kind === "number") {
      drawNumber(grid, item, row, cols, focusId, editing, hits, theme);
    } else if (item.kind === "choice") {
      drawChoice(grid, item, row, cols, focusId, hits, theme);
    } else if (item.kind === "alias") {
      drawAlias(grid, item, row, cols, focusId, editing, hits, theme);
    } else if (item.kind === "audit") {
      const selected = focusId === item.id;
      fillCells(grid, row, 1, Math.max(0, cols - 2), selected ? rgba.active : rgba.panel);
      drawButton(grid, row, 2, "audit sessions", selected, hits, "audit", "activate", theme);
      write(row, 20, item.summary, selected ? rgba.text : rgba.muted, selected ? 700 : 600);
    } else if (item.kind === "message") {
      write(row, 2, item.text, item.tone === "error" ? rgba.red : rgba.faint, 600);
    } else {
      const selected = item.id === focusId;
      fillCells(grid, row, 1, Math.max(0, cols - 2), selected ? rgba.active : rgba.black);
      write(row, 2, item.status.toUpperCase(), statusColor(item.status, theme), 700);
      write(row, 14, item.meta, selected ? rgba.text : rgba.muted, selected ? 700 : 600);
      write(row + 1, 14, item.detail, rgba.faint, 400);
      if (item.id && item.actionLabel) {
        drawButton(grid, row, Math.max(2, cols - item.actionLabel.length - 4), item.actionLabel, selected, hits, item.id, "activate", theme);
      } else if (item.id && item.backend && item.name) {
        drawButton(grid, row, Math.max(2, cols - 9), "quit", selected, hits, item.id, "activate", theme);
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
  drawButton(grid, footerTop + 1, resetCol, "reset", focusId === "reset", hits, "reset", "activate", theme);
  drawButton(grid, footerTop + 1, cancelCol, "cancel", focusId === "cancel", hits, "cancel", "activate", theme);
  drawButton(grid, footerTop + 1, saveCol, saving ? "saving" : "save", focusId === "save", hits, "save", "activate", theme);

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
  theme: OpenTuiTheme,
) => {
  const { rgba } = theme;
  const selected = focusId === item.id;
  const editValue = editing?.id === item.id ? editing.value : null;
  const displayValue = editValue === null ? item.value.toLocaleString() : `${editValue}_`;
  fillCells(grid, row, 1, Math.max(0, cols - 2), selected ? rgba.active : rgba.panel);
  writeText(grid, row, 2, item.label.toUpperCase(), selected ? rgba.gold : rgba.muted, 1);
  const fieldCol = Math.min(24, Math.max(16, Math.floor(cols * 0.34)));
  drawField(grid, row, fieldCol, Math.max(12, cols - fieldCol - 15), `${displayValue} ${item.suffix}`, selected, hits, item.id, theme);
  drawButton(grid, row, Math.max(fieldCol + 12, cols - 13), "-", false, hits, item.id, "decrement", theme);
  drawButton(grid, row, Math.max(fieldCol + 17, cols - 7), "+", false, hits, item.id, "increment", theme);
  const barCol = fieldCol;
  const barWidth = Math.max(10, cols - barCol - 3);
  const filled = Math.max(1, Math.round(((item.value - item.min) / (item.max - item.min)) * barWidth));
  fillCells(grid, row + 1, barCol, barWidth, rgba.line);
  fillCells(grid, row + 1, barCol, Math.min(barWidth, filled), selected ? rgba.gold : rgba.faint);
  hits.push({ row, col: 1, width: Math.max(1, cols - 2), height: 2, id: item.id, action: "focus" });
};

const drawChoice = (
  grid: CellGrid,
  item: LayoutChoice,
  row: number,
  cols: number,
  focusId: FocusId,
  hits: HitZone[],
  theme: OpenTuiTheme,
) => {
  const { rgba } = theme;
  const selected = focusId === item.id;
  fillCells(grid, row, 1, Math.max(0, cols - 2), selected ? rgba.active : rgba.panel);
  writeText(grid, row, 2, item.label.toUpperCase(), selected ? rgba.gold : rgba.muted, 1);
  const valueCol = Math.min(24, Math.max(16, Math.floor(cols * 0.34)));
  writeText(grid, row, valueCol, fitText(item.value, Math.max(0, cols - valueCol - 15)), rgba.text, selected ? 1 : 0);
  drawButton(grid, row, Math.max(valueCol + 12, cols - 13), "<", false, hits, item.id, "decrement", theme);
  drawButton(grid, row, Math.max(valueCol + 17, cols - 7), ">", false, hits, item.id, "increment", theme);
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
  theme: OpenTuiTheme,
) => {
  const { rgba } = theme;
  const selected = focusId === item.id;
  const editingValue = editing?.id === item.id ? editing.value : null;
  const value = editingValue === null ? item.value || item.placeholder : `${editingValue}_`;
  const valueColor = item.value || editingValue !== null ? rgba.text : rgba.faint;
  fillCells(grid, row, 1, Math.max(0, cols - 2), selected ? rgba.active : rgba.black);
  writeText(grid, row, 2, fitText(item.label.toUpperCase(), 18), selected ? rgba.gold : rgba.muted, 1);
  drawField(grid, row, 22, Math.max(12, cols - 25), value, selected, hits, item.id, theme, valueColor);
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
  theme: OpenTuiTheme,
  color?: RGBA,
) => {
  const { rgba } = theme;
  if (width <= 0) return;
  fillCells(grid, row, col, width, selected ? rgba.black : rgba.panel);
  setCellBackground(grid, row, col, selected ? rgba.gold : rgba.line);
  setCellBackground(grid, row, col + width - 1, selected ? rgba.gold : rgba.line);
  writeText(grid, row, col + 1, fitText(value, width - 2), color ?? rgba.text, selected ? 1 : 0);
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
  theme: OpenTuiTheme,
) => {
  const { rgba } = theme;
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

const statusColor = (status: string, { rgba }: OpenTuiTheme): RGBA => {
  if (status === "active") return rgba.green;
  if (status === "missing" || status === "duplicate") return rgba.gold;
  if (status === "orphan") return rgba.red;
  return rgba.muted;
};

const modulo = (value: number, divisor: number): number => ((value % divisor) + divisor) % divisor;

const formatTimestamp = (timestamp: number): string =>
  new Date(timestamp).toLocaleString();
