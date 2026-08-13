import { useEffect, useRef } from "react";

export function WorkspaceRenameDialog({
  workspaceId,
  title,
  onRename,
  onClose,
}: {
  workspaceId: string;
  title: string;
  onRename: (workspaceId: string, title: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLFormElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const backdrop = backdropRef.current;
    const dialog = dialogRef.current;
    if (!backdrop || !dialog) return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const restoreInert = inertOutsideBranch(backdrop);
    const focusFrame = window.requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.select();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!dialog.contains(event.target as Node)) inputRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
      restoreInert();
      window.requestAnimationFrame(() => {
        if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      });
    };
  }, []);

  return (
    <div
      ref={backdropRef}
      className="workspace-rename-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <form
        ref={dialogRef}
        className="workspace-rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-rename-title"
        tabIndex={-1}
        onSubmit={(event) => {
          event.preventDefault();
          const input = inputRef.current;
          if (!input) return;
          const nextTitle = input.value.trim();
          if (!nextTitle) {
            input.setCustomValidity("Enter a workspace name.");
            input.reportValidity();
            return;
          }
          input.setCustomValidity("");
          onClose();
          void onRename(workspaceId, nextTitle);
        }}
      >
        <div className="workspace-rename-heading">
          <span>// RENAME WORKSPACE</span>
          <strong id="workspace-rename-title">Rename {title}</strong>
        </div>
        <label htmlFor={`command-workspace-rename-${workspaceId}`}>Workspace name</label>
        <input
          ref={inputRef}
          id={`command-workspace-rename-${workspaceId}`}
          name="title"
          type="text"
          defaultValue={title}
          maxLength={50}
          required
          onInput={(event) => event.currentTarget.setCustomValidity("")}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="workspace-rename-actions">
          <button type="button" onClick={onClose}>[ESC] Cancel</button>
          <button type="submit">[OK] Save name</button>
        </div>
      </form>
    </div>
  );
}

const focusableSelector = [
  "button:not([disabled])",
  "input:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const focusableElements = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) =>
    !element.hidden && element.getAttribute("aria-hidden") !== "true");

const inertOutsideBranch = (modalRoot: HTMLElement): (() => void) => {
  const changed: Array<{ element: HTMLElement; inert: boolean }> = [];
  let branch: HTMLElement = modalRoot;
  while (branch.parentElement) {
    const parent = branch.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (!(sibling instanceof HTMLElement) || sibling === branch) continue;
      changed.push({ element: sibling, inert: sibling.inert });
      sibling.inert = true;
    }
    branch = parent;
    if (parent === document.body) break;
  }
  return () => {
    for (const { element, inert } of changed.reverse()) element.inert = inert;
  };
};
