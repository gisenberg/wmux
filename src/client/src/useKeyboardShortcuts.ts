import { useEffect, useRef } from "react";
import {
  compileKeybindings,
  eventMatchesAction,
  type CompiledKeybindingMap,
  type KeybindingAction,
  type KeybindingMap,
} from "../../shared/keybindings";
import type { SplitDirection } from "./types";

export interface KeyboardShortcutHandlers {
  keybindings: KeybindingMap;
  apple: boolean;
  // When a modal surface (settings, command palette) is open, only the
  // palette toggle itself remains active.
  modalOpen: boolean;
  openCommandPalette: () => void;
  openSettings: () => void;
  toggleSidebar: () => void;
  createWorkspace: () => void | Promise<void>;
  createTab: () => void | Promise<void>;
  closeActiveTab: () => void | Promise<void>;
  closeActiveWorkspace: () => void | Promise<void>;
  // null when there is no active pane to split (shortcut is ignored).
  splitActivePane: ((direction: SplitDirection) => void | Promise<void>) | null;
  focusPaneRelative: (delta: number) => void | Promise<void>;
  activateWorkspaceRelative: (delta: number) => void | Promise<void>;
  activateTabRelative: (delta: number) => void | Promise<void>;
  // null when state has not loaded / no workspace is active.
  activateWorkspaceAtDigit: ((digit: number) => void | Promise<void>) | null;
  activateTabAtDigit: ((digit: number) => void | Promise<void>) | null;
  jumpLatestUnread: () => void | Promise<void>;
}

// Global keyboard shortcuts, registered once on window with capture so they
// win over the focused terminal. Handlers are read through a ref so the
// listener never needs re-registering.
export function useKeyboardShortcuts(handlers: KeyboardShortcutHandlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const bindingsRef = useRef<CompiledKeybindingMap>(compileKeybindings(handlers.keybindings));
  bindingsRef.current = compileKeybindings(handlers.keybindings);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const current = handlersRef.current;
      const run = (action: () => void | Promise<void>) => {
        event.preventDefault();
        event.stopPropagation();
        void action();
      };

      if (current.modalOpen) return;
      const target = event.target as HTMLElement | null;
      const terminalInput = Boolean(target?.closest(".terminal-host"));
      if (target && !terminalInput && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      const matches = (action: KeybindingAction): boolean =>
        eventMatchesAction(event, bindingsRef.current, action, current.apple);
      const directActions: Array<[KeybindingAction, () => void | Promise<void>]> = [
        ["commandPalette.open", current.openCommandPalette],
        ["settings.open", current.openSettings],
        ["sidebar.toggle", current.toggleSidebar],
        ["workspace.new", current.createWorkspace],
        ["workspace.close", current.closeActiveWorkspace],
        ["workspace.previous", () => current.activateWorkspaceRelative(-1)],
        ["workspace.next", () => current.activateWorkspaceRelative(1)],
        ["tab.new", current.createTab],
        ["tab.close", current.closeActiveTab],
        ["tab.previous", () => current.activateTabRelative(-1)],
        ["tab.next", () => current.activateTabRelative(1)],
        ["pane.focusPrevious", () => current.focusPaneRelative(-1)],
        ["pane.focusNext", () => current.focusPaneRelative(1)],
        ["notification.latestUnread", current.jumpLatestUnread],
      ];
      for (const [action, handler] of directActions) {
        if (!matches(action)) continue;
        run(handler);
        return;
      }
      if (matches("pane.splitRight") || matches("pane.splitDown")) {
        const splitActivePane = current.splitActivePane;
        if (!splitActivePane) return;
        run(() => splitActivePane(matches("pane.splitDown") ? "horizontal" : "vertical"));
        return;
      }
      for (let digit = 1; digit <= 9; digit += 1) {
        if (matches(`workspace.select${digit}` as KeybindingAction)) {
          const activateWorkspaceAtDigit = current.activateWorkspaceAtDigit;
          if (!activateWorkspaceAtDigit) return;
          run(() => activateWorkspaceAtDigit(digit));
          return;
        }
        if (matches(`tab.select${digit}` as KeybindingAction)) {
          const activateTabAtDigit = current.activateTabAtDigit;
          if (!activateTabAtDigit) return;
          run(() => activateTabAtDigit(digit));
          return;
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);
}
