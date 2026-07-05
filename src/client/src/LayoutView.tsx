import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { TerminalPane } from "./TerminalPane";
import type { LayoutNode, MachineStatus, PaneState, SplitDirection, SurfaceTab, TerminalMedia, TerminalRun } from "./types";

interface Props {
  tab: SurfaceTab;
  machines: MachineStatus[];
  terminalFontSize: number;
  terminalScrollbackRows: number;
  unreadByPaneId: Map<string, number>;
  mediaByPaneId: Map<string, TerminalMedia[]>;
  runsByPaneId: Map<string, TerminalRun>;
  focusActivePaneSignal?: number;
  onActivatePane: (paneId: string) => void;
  onSplit: (paneId: string, direction: SplitDirection, machineId?: string) => void;
  onResizeSplit: (path: string, ratio: number) => void;
  onClosePane: (paneId: string) => void;
  onBell: (paneId: string) => void;
  onDismissMedia: (mediaId: string) => void;
}

export function LayoutView({
  tab,
  machines,
  terminalFontSize,
  terminalScrollbackRows,
  unreadByPaneId,
  mediaByPaneId,
  runsByPaneId,
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
    onResizeSplit(drag.path, drag.ratio);
  };

  const renderNode = (node: LayoutNode, path = "") => {
    if (node.type === "pane") {
      const pane = paneById.get(node.paneId) as PaneState | undefined;
      if (!pane) return <div className="missing-pane">Missing pane</div>;
      return (
        <TerminalPane
          key={`${pane.id}:${terminalScrollbackRows}`}
          pane={pane}
          active={tab.activePaneId === pane.id}
          unreadCount={unreadByPaneId.get(pane.id) ?? 0}
          machines={machines}
          terminalFontSize={terminalFontSize}
          terminalScrollbackRows={terminalScrollbackRows}
          mediaItems={mediaByPaneId.get(pane.id) ?? []}
          lastRun={runsByPaneId.get(pane.id)}
          focusSignal={tab.activePaneId === pane.id ? focusActivePaneSignal : 0}
          onActivate={() => onActivatePane(pane.id)}
          onSplit={(direction, machineId) => onSplit(pane.id, direction, machineId)}
          onClose={() => onClosePane(pane.id)}
          onBell={() => onBell(pane.id)}
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
}

const clampRatio = (value: number): number => Math.min(0.85, Math.max(0.15, value));

const splitRatioAtPath = (node: LayoutNode, path: string): number | null => {
  let current = node;
  for (const segment of path) {
    if (current.type !== "split") return null;
    current = segment === "0" ? current.first : current.second;
  }
  return current.type === "split" ? current.ratio : null;
};
