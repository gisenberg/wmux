import { useEffect, useRef } from "react";

export interface MobileCloseRequest {
  kind: "pane" | "tab" | "workspace";
  title: string;
  sessionCount: number;
  run: () => void | Promise<void>;
}

export function MobileCloseDialog({
  request,
  onCancel,
}: {
  request: MobileCloseRequest;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      returnFocus?.focus();
    };
  }, [onCancel]);

  const noun = request.sessionCount === 1 ? "session" : "sessions";
  return (
    <div className="mobile-close-backdrop" onMouseDown={(event) => event.currentTarget === event.target && onCancel()}>
      <section
        ref={dialogRef}
        className="mobile-close-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-close-title"
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const buttons = [...(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
          if (buttons.length === 0) return;
          const activeIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const nextIndex = event.shiftKey
            ? (activeIndex <= 0 ? buttons.length - 1 : activeIndex - 1)
            : (activeIndex + 1) % buttons.length;
          event.preventDefault();
          buttons[nextIndex]?.focus();
        }}
      >
        <header>
          <span>// DESTRUCTIVE ACTION</span>
          <strong id="mobile-close-title">Close {request.kind}?</strong>
        </header>
        <p>
          Closing <strong>{request.title}</strong> will kill {request.sessionCount} backing {noun}.
        </p>
        <div className="mobile-close-actions">
          <button ref={cancelRef} type="button" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              onCancel();
              void request.run();
            }}
          >
            Close {request.kind}
          </button>
        </div>
      </section>
    </div>
  );
}
