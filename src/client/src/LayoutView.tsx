import { memo, useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { TerminalPane } from "./TerminalPane";
import type { KeybindingMap, LayoutNode, MachineStatus, PaneState, SplitDirection, SurfaceTab, TerminalMedia, TerminalRun, TerminalScrollMode } from "./types";

interface Props {
  tab: SurfaceTab;
  viewActive: boolean;
  inactiveTabStreaming: "suspend" | "live";
  tuiFrameRate: 15 | 30 | 60;
  terminalScrollMode: TerminalScrollMode;
  keybindings: KeybindingMap;
  appleKeybindings: boolean;
  machines: MachineStatus[];
  terminalFontFamily: string;
  terminalFontSize: number;
  terminalScrollbackRows: number;
  unreadByPaneId: Map<string, number>;
  mediaByPaneId: Map<string, TerminalMedia[]>;
  runsByPaneId: Map<string, TerminalRun>;
  pendingPaneLabels: ReadonlyMap<string, string>;
  focusActivePaneSignal?: number;
  onActivatePane: (tabId: string, paneId: string) => void;
  onSplit: (tabId: string, paneId: string, direction: SplitDirection, machineId?: string) => void;
  onResizeSplit: (tabId: string, path: string, ratio: number) => void;
  onClosePane: (tabId: string, paneId: string) => void;
  onBell: (paneId: string) => void;
  onDismissMedia: (mediaId: string) => void;
}

// Memoized: bootstrap resyncs preserve object identity for unchanged tabs
// (see reconcile.ts), so a state event only re-renders the layouts whose
// content actually changed.
export const LayoutView = memo(function LayoutView({
  tab,
  viewActive,
  inactiveTabStreaming,
  tuiFrameRate,
  terminalScrollMode,
  keybindings,
  appleKeybindings,
  machines,
  terminalFontFamily,
  terminalFontSize,
  terminalScrollbackRows,
  unreadByPaneId,
  mediaByPaneId,
  runsByPaneId,
  pendingPaneLabels,
  focusActivePaneSignal = 0,
  onActivatePane,
  onSplit,
  onResizeSplit,
  onClosePane,
  onBell,
  onDismissMedia,
}: Props) {
  const [draftRatios, setDraftRatios] = useState<Record<string, number>>({});
  const dragRef = useRef<{
    direction: SplitDirection;
    path: string;
    pointerId: number;
    rect: DOMRect;
    ratio: number;
  } | null>(null);
  const paneById = new Map(tab.panes.map((pane) => [pane.id, pane]));

  useEffect(() => {
    setDraftRatios({});
  }, [tab.id]);

  const updateDraftRatio = (event: Pick<PointerEvent, "clientX" | "clientY">) => {
    const drag = dragRef.current;
    if (!drag) return;
    const rawRatio =
      drag.direction === "vertical"
        ? (event.clientX - drag.rect.left) / drag.rect.width
        : (event.clientY - drag.rect.top) / drag.rect.height;
    const ratio = clampRatio(rawRatio);
    drag.ratio = ratio;
    setDraftRatios((current) => ({ ...current, [drag.path]: ratio }));
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>, path: string, direction: SplitDirection) => {
    const container = event.currentTarget.parentElement;
    if (!container) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      direction,
      path,
      pointerId: event.pointerId,
      rect: container.getBoundingClientRect(),
      ratio: draftRatios[path] ?? splitRatioAtPath(tab.layout, path) ?? 0.5,
    };
    updateDraftRatio(event.nativeEvent);
  };

  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    updateDraftRatio(event.nativeEvent);
  };

  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    onResizeSplit(tab.id, drag.path, drag.ratio);
  };

  const renderNode = (node: LayoutNode, path = "") => {
    if (node.type === "pane") {
      const pane = paneById.get(node.paneId) as PaneState | undefined;
      if (!pane) return <div className="missing-pane">Missing pane</div>;
      return (
        <LayoutPane
          key={`${pane.id}:${terminalScrollbackRows}`}
          pane={pane}
          tabId={tab.id}
          active={viewActive && tab.activePaneId === pane.id}
          tabVisible={viewActive}
          inactiveTabStreaming={inactiveTabStreaming}
          tuiFrameRate={tuiFrameRate}
          terminalScrollMode={terminalScrollMode}
          keybindings={keybindings}
          appleKeybindings={appleKeybindings}
          unreadCount={unreadByPaneId.get(pane.id) ?? 0}
          machines={machines}
          terminalFontFamily={terminalFontFamily}
          terminalFontSize={terminalFontSize}
          terminalScrollbackRows={terminalScrollbackRows}
          mediaItems={mediaByPaneId.get(pane.id) ?? emptyMedia}
          lastRun={runsByPaneId.get(pane.id)}
          pendingLabel={pendingPaneLabels.get(pane.id)}
          focusSignal={viewActive && tab.activePaneId === pane.id ? focusActivePaneSignal : 0}
          onActivatePane={onActivatePane}
          onSplit={onSplit}
          onClosePane={onClosePane}
          onBell={onBell}
          onDismissMedia={onDismissMedia}
        />
      );
    }

    const ratio = draftRatios[path] ?? node.ratio;
    return (
      <div
        className={`split ${node.direction} ${dragRef.current?.path === path ? "resizing" : ""}`}
        style={{ "--ratio": ratio } as CSSProperties}
      >
        <div className="split-child">{renderNode(node.first, `${path}0`)}</div>
        <div
          className="split-handle"
          role="separator"
          aria-orientation={node.direction === "vertical" ? "vertical" : "horizontal"}
          aria-valuemin={15}
          aria-valuemax={85}
          aria-valuenow={Math.round(ratio * 100)}
          title="Drag to resize split"
          onPointerDown={(event) => startResize(event, path, node.direction)}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
        />
        <div className="split-child">{renderNode(node.second, `${path}1`)}</div>
      </div>
    );
  };

  return <div className="layout-view">{renderNode(tab.layout)}</div>;
});

interface LayoutPaneProps {
  pane: PaneState;
  tabId: string;
  active: boolean;
  tabVisible: boolean;
  inactiveTabStreaming: "suspend" | "live";
  tuiFrameRate: 15 | 30 | 60;
  terminalScrollMode: TerminalScrollMode;
  keybindings: KeybindingMap;
  appleKeybindings: boolean;
  unreadCount: number;
  machines: MachineStatus[];
  terminalFontFamily: string;
  terminalFontSize: number;
  terminalScrollbackRows: number;
  mediaItems: TerminalMedia[];
  lastRun?: TerminalRun;
  pendingLabel?: string;
  focusSignal: number;
  onActivatePane: (tabId: string, paneId: string) => void;
  onSplit: (tabId: string, paneId: string, direction: SplitDirection, machineId?: string) => void;
  onClosePane: (tabId: string, paneId: string) => void;
  onBell: (paneId: string) => void;
  onDismissMedia: (mediaId: string) => void;
}

// Bridges the tab-level callbacks to TerminalPane's pane-scoped props with
// stable identities, so the memoized TerminalPane skips re-rendering when a
// sibling pane (or another tab) changes.
const LayoutPane = memo(function LayoutPane({
  pane,
  tabId,
  active,
  tabVisible,
  inactiveTabStreaming,
  tuiFrameRate,
  terminalScrollMode,
  keybindings,
  appleKeybindings,
  unreadCount,
  machines,
  terminalFontFamily,
  terminalFontSize,
  terminalScrollbackRows,
  mediaItems,
  lastRun,
  pendingLabel,
  focusSignal,
  onActivatePane,
  onSplit,
  onClosePane,
  onBell,
  onDismissMedia,
}: LayoutPaneProps) {
  const paneId = pane.id;
  const onActivate = useCallback(() => onActivatePane(tabId, paneId), [onActivatePane, tabId, paneId]);
  const onPaneSplit = useCallback(
    (direction: SplitDirection, machineId?: string) => onSplit(tabId, paneId, direction, machineId),
    [onSplit, tabId, paneId],
  );
  const onClose = useCallback(() => onClosePane(tabId, paneId), [onClosePane, tabId, paneId]);
  const onPaneBell = useCallback(() => onBell(paneId), [onBell, paneId]);
  return (
    <TerminalPane
      pane={pane}
      active={active}
      tabVisible={tabVisible}
      inactiveTabStreaming={inactiveTabStreaming}
      tuiFrameRate={tuiFrameRate}
      terminalScrollMode={terminalScrollMode}
      keybindings={keybindings}
      appleKeybindings={appleKeybindings}
      unreadCount={unreadCount}
      machines={machines}
      terminalFontFamily={terminalFontFamily}
      terminalFontSize={terminalFontSize}
      terminalScrollbackRows={terminalScrollbackRows}
      mediaItems={mediaItems}
      lastRun={lastRun}
      pendingLabel={pendingLabel}
      focusSignal={focusSignal}
      onActivate={onActivate}
      onSplit={onPaneSplit}
      onClose={onClose}
      onBell={onPaneBell}
      onDismissMedia={onDismissMedia}
    />
  );
});

const emptyMedia: TerminalMedia[] = [];

const clampRatio = (value: number): number => Math.min(0.85, Math.max(0.15, value));

const splitRatioAtPath = (node: LayoutNode, path: string): number | null => {
  let current = node;
  for (const segment of path) {
    if (current.type !== "split") return null;
    current = segment === "0" ? current.first : current.second;
  }
  return current.type === "split" ? current.ratio : null;
};
