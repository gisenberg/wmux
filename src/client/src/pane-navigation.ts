import type { LayoutNode } from "./types";

export type PaneDirection = "left" | "right" | "up" | "down";
type Rect = { id: string; x: number; y: number; width: number; height: number };

/** Resolve neighbors in layout space, independent of browser pixels and hidden tabs. */
export function directionalPane(layout: LayoutNode, activeId: string, direction: PaneDirection): string | undefined {
  const rectangles: Rect[] = [];
  const visit = (node: LayoutNode, x: number, y: number, width: number, height: number) => {
    if (node.type === "pane") { rectangles.push({ id: node.paneId, x, y, width, height }); return; }
    const ratio = node.ratio;
    if (node.direction === "vertical") {
      visit(node.first, x, y, width * ratio, height);
      visit(node.second, x + width * ratio, y, width * (1 - ratio), height);
    } else {
      visit(node.first, x, y, width, height * ratio);
      visit(node.second, x, y + height * ratio, width, height * (1 - ratio));
    }
  };
  visit(layout, 0, 0, 1, 1);
  const active = rectangles.find((rect) => rect.id === activeId);
  if (!active) return;
  const horizontal = direction === "left" || direction === "right";
  const sign = direction === "left" || direction === "up" ? -1 : 1;
  const center = (rect: Rect) => horizontal ? rect.x + rect.width / 2 : rect.y + rect.height / 2;
  const cross = (rect: Rect) => horizontal ? rect.y + rect.height / 2 : rect.x + rect.width / 2;
  const aligned = (rect: Rect) => horizontal
    ? rect.y < active.y + active.height && rect.y + rect.height > active.y
    : rect.x < active.x + active.width && rect.x + rect.width > active.x;
  return rectangles.filter((rect) => rect.id !== activeId && (center(rect) - center(active)) * sign > 0 && aligned(rect))
    .sort((a, b) => Math.abs(center(a) - center(active)) - Math.abs(center(b) - center(active))
      || Math.abs(cross(a) - cross(active)) - Math.abs(cross(b) - cross(active)))[0]?.id;
}
