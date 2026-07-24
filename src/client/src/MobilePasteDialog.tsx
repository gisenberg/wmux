import { useEffect, useRef, useState } from "react";

export function MobilePasteDialog({
  reason,
  onInsert,
  onCancel,
}: {
  reason: string;
  onInsert: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const dialogRef = useRef<HTMLElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCancelRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", onKeyDown);
      returnFocus?.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div className="mobile-paste-backdrop" onMouseDown={(event) => event.currentTarget === event.target && onCancel()}>
      <section
        ref={dialogRef}
        className="mobile-paste-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-paste-title"
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>("textarea, button:not(:disabled)") ?? [])];
          if (controls.length === 0) return;
          const activeIndex = controls.indexOf(document.activeElement as HTMLElement);
          const nextIndex = event.shiftKey
            ? (activeIndex <= 0 ? controls.length - 1 : activeIndex - 1)
            : (activeIndex + 1) % controls.length;
          event.preventDefault();
          controls[nextIndex]?.focus();
        }}
      >
        <header>
          <span>// CLIPBOARD FALLBACK</span>
          <strong id="mobile-paste-title">Paste into terminal</strong>
        </header>
        <p>{reason} Touch and hold in the field, choose Paste, then review the text before inserting it.</p>
        <textarea
          ref={textareaRef}
          value={text}
          aria-label="Text to paste into terminal"
          placeholder="Paste text here"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="mobile-paste-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="primary"
            disabled={!text}
            onClick={() => onInsert(text)}
          >
            Insert text
          </button>
        </div>
      </section>
    </div>
  );
}
