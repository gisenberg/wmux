import { useEffect, useRef } from "react";

/** Shared keyboard and focus contract for DOM-backed console dialogs. */
export function useConsoleDialog<T extends HTMLElement>(onClose: () => void, enabled = true) {
  const ref = useRef<T>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const root = ref.current;
    if (!root || !enabled) return;
    const previous = document.activeElement;
    const controls = () => Array.from(root.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
    )).filter((element) => element.getClientRects().length > 0 && !element.closest('[inert], [aria-hidden="true"]'));
    (controls()[0] ?? root).focus();
    const keydown = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== root) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      } else if (event.key === "Tab") {
        const items = controls();
        const index = items.indexOf(document.activeElement as HTMLElement);
        if (!items.length || index < 0 || (event.shiftKey ? index === 0 : index === items.length - 1)) {
          event.preventDefault();
          (items[event.shiftKey ? items.length - 1 : 0] ?? root).focus();
        }
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      queueMicrotask(() => {
        if (previous instanceof HTMLElement && previous.isConnected && !document.querySelector('[aria-modal="true"]')) previous.focus();
      });
    };
  }, [enabled]);
  return ref;
}
