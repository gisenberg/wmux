import { useEffect, useMemo, useRef, useState } from "react";
import type { Workspace } from "./types";
import { workspaceMoveIntents, type WorkspaceMoveIntent } from "./workspace-tree";

export function WorkspaceMoveDialog({
  workspaceId,
  workspaces,
  onMove,
  onClose,
  returnFocus,
}: {
  workspaceId: string;
  workspaces: Workspace[];
  onMove: (intent: WorkspaceMoveIntent) => void | Promise<void>;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
}) {
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const intents = useMemo(() => workspaceMoveIntents(workspaces, workspaceId), [workspaceId, workspaces]);
  const source = workspaces.find((workspace) => workspace.id === workspaceId);
  const targetWorkspaces = useMemo(
    () => workspaces.filter((workspace) => intents.some((intent) => intent.targetWorkspaceId === workspace.id)),
    [intents, workspaces],
  );
  const [targetId, setTargetId] = useState(targetWorkspaces[0]?.id ?? "");
  useEffect(() => {
    const dialog = dialogRef.current;
    const backdrop = backdropRef.current;
    if (!dialog || !backdrop) return;
    const returnFocusTarget = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const restoreInert = inertOutsideBranch(backdrop);
    const focusFirst = () => (focusableElements(dialog)[0] ?? dialog).focus({ preventScroll: true });
    const focusFrame = window.requestAnimationFrame(focusFirst);
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
      if (!dialog.contains(event.target as Node)) focusFirst();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
      restoreInert();
      window.requestAnimationFrame(() => {
        if (returnFocusTarget?.isConnected) returnFocusTarget.focus({ preventScroll: true });
      });
    };
  }, [returnFocus]);
  useEffect(() => {
    if (!targetWorkspaces.some((workspace) => workspace.id === targetId)) setTargetId(targetWorkspaces[0]?.id ?? "");
  }, [targetId, targetWorkspaces]);
  const move = (position: WorkspaceMoveIntent["position"]) => {
    const intent = intents.find((candidate) => candidate.position === position && (
      position === "out-of" || candidate.targetWorkspaceId === targetId
    ));
    if (!intent) return;
    onClose();
    void onMove(intent);
  };
  const supported = (position: WorkspaceMoveIntent["position"]) => intents.some((intent) =>
    intent.position === position && (position === "out-of" || intent.targetWorkspaceId === targetId));

  return (
    <div ref={backdropRef} className="workspace-move-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        ref={dialogRef}
        className="workspace-move-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-move-title"
        tabIndex={-1}
      >
        <div className="workspace-move-heading">
          <strong id="workspace-move-title">Move {source?.name ?? "workspace"}</strong>
          <button type="button" onClick={onClose} aria-label="Close move menu">×</button>
        </div>
        {targetWorkspaces.length > 0 ? (
          <label>
            Target workspace
            <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
              {targetWorkspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
            </select>
          </label>
        ) : <p>No valid tree targets.</p>}
        <div className="workspace-move-actions">
          <button type="button" disabled={!supported("before")} onClick={() => move("before")}>Move before</button>
          <button type="button" disabled={!supported("after")} onClick={() => move("after")}>Move after</button>
          <button type="button" disabled={!supported("into")} onClick={() => move("into")}>Nest inside</button>
          <button type="button" disabled={!supported("out-of")} onClick={() => move("out-of")}>Move out one level</button>
        </div>
      </div>
    </div>
  );
}

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
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
