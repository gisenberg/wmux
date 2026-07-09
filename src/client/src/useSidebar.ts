import { useCallback, useEffect, useRef, useState } from "react";

const sidebarWidthStorageKey = "wmux.sidebarWidth";
const defaultSidebarWidth = 288;
const minSidebarWidth = 220;
export const maxSidebarWidth = 520;
const collapseSidebarDragThreshold = 128;
export const mobileViewportMediaQuery = "(max-width: 800px), (max-height: 500px) and (pointer: coarse)";

// Sidebar chrome state: collapse toggle, persisted width, pointer-drag resize
// (with drag-to-collapse), and the keyboard-accessible resizer.
export function useSidebar(isMobile: boolean) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.matchMedia(mobileViewportMediaQuery).matches);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const previousIsMobile = useRef(isMobile);

  // Crossing the mobile/desktop boundary snaps the sidebar to that mode's
  // default; within a mode the user's explicit toggle wins.
  useEffect(() => {
    if (isMobile && !previousIsMobile.current) setSidebarCollapsed(true);
    if (!isMobile && previousIsMobile.current) setSidebarCollapsed(false);
    previousIsMobile.current = isMobile;
  }, [isMobile]);

  useEffect(() => {
    window.localStorage.setItem(sidebarWidthStorageKey, String(sidebarWidth));
  }, [sidebarWidth]);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((value) => !value);
  }, []);

  const collapseSidebar = useCallback(() => {
    setSidebarCollapsed(true);
  }, []);

  const startSidebarResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (isMobile || event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarCollapsed ? 0 : sidebarWidth;
    let latestWidth = sidebarWidth;

    const onPointerMove = (moveEvent: PointerEvent) => {
      const rawWidth = startWidth + moveEvent.clientX - startX;
      if (rawWidth < collapseSidebarDragThreshold) {
        setSidebarCollapsed(true);
        return;
      }
      const nextWidth = clampSidebarWidth(rawWidth);
      latestWidth = nextWidth;
      setSidebarCollapsed(false);
      setSidebarWidth(nextWidth);
    };
    const stopResize = () => {
      document.body.classList.remove("sidebar-resizing");
      window.localStorage.setItem(sidebarWidthStorageKey, String(latestWidth));
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };

    document.body.classList.add("sidebar-resizing");
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopResize, { once: true });
    window.addEventListener("pointercancel", stopResize, { once: true });
  }, [isMobile, sidebarCollapsed, sidebarWidth]);

  const onSidebarResizerKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isMobile) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleSidebar();
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setSidebarCollapsed(true);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setSidebarCollapsed(false);
      setSidebarWidth(maxSidebarWidth);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.shiftKey ? 48 : 16;
    const nextWidth = clampSidebarWidth(sidebarWidth + (event.key === "ArrowRight" ? delta : -delta));
    setSidebarCollapsed(false);
    setSidebarWidth(nextWidth);
  }, [isMobile, sidebarWidth, toggleSidebar]);

  return { sidebarCollapsed, sidebarWidth, toggleSidebar, collapseSidebar, startSidebarResize, onSidebarResizerKeyDown };
}

const clampSidebarWidth = (value: number): number =>
  Math.min(maxSidebarWidth, Math.max(minSidebarWidth, Math.round(value)));

const loadSidebarWidth = (): number => {
  const stored = window.localStorage.getItem(sidebarWidthStorageKey);
  const numeric = stored === null ? defaultSidebarWidth : Number(stored);
  return clampSidebarWidth(Number.isFinite(numeric) ? numeric : defaultSidebarWidth);
};
