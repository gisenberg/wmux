import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { filterCommands } from "./command-filter";

export interface PaletteCommand {
  id: string;
  title: string;
  subtitle?: string;
  section: string;
  shortcut?: string;
  keywords?: string[];
  filters?: import("./command-filter").FilterableCommand["filters"];
  disabled?: boolean;
  run: () => void | Promise<void>;
}

export function CommandPalette({
  commands,
  query,
  onQueryChange,
  onClose,
  autoFocus = true,
}: {
  commands: PaletteCommand[];
  query: string;
  onQueryChange: (query: string) => void;
  onClose: () => void;
  autoFocus?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const liveQueryRef = useRef(query);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const filteredCommands = useMemo(() => filterCommands(commands, query), [commands, query]);

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (autoFocus) inputRef.current?.focus();
    else panelRef.current?.focus();
    return () => returnFocusRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    const firstEnabled = filteredCommands.findIndex((command) => !command.disabled);
    setSelectedIndex(firstEnabled === -1 ? 0 : firstEnabled);
  }, [filteredCommands]);

  const closePalette = () => {
    const input = inputRef.current;
    if (input && document.activeElement === input) input.blur();
    onClose();
  };

  const runCommand = async (command: PaletteCommand | undefined) => {
    if (!command || command.disabled) return;
    closePalette();
    await command.run();
  };

  const moveSelection = (delta: number) => {
    if (!filteredCommands.length) return;
    let next = selectedIndex;
    for (let step = 0; step < filteredCommands.length; step += 1) {
      next = modulo(next + delta, filteredCommands.length);
      if (!filteredCommands[next].disabled) {
        setSelectedIndex(next);
        return;
      }
    }
  };

  return (
    <div className="command-backdrop" onMouseDown={(event) => event.currentTarget === event.target && closePalette()}>
      <div
        ref={panelRef}
        className="command-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            closePalette();
            return;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            moveSelection(1);
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            moveSelection(-1);
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            const inputQuery = liveQueryRef.current || inputRef.current?.value || "";
            const submittedCommands = filterCommands(commands, inputQuery);
            const submittedIndex = inputQuery === query ? selectedIndex : 0;
            const selectedCommand = submittedCommands[submittedIndex];
            void runCommand(
              selectedCommand && !selectedCommand.disabled
                ? selectedCommand
                : submittedCommands.find((command) => !command.disabled),
            );
          }
        }}
      >
        <div className="command-input-row">
          <Search size={17} aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            aria-label="Search commands"
            value={query}
            placeholder="Search commands, workspaces, tabs, hosts"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            onInputCapture={(event) => {
              liveQueryRef.current = event.currentTarget.value;
            }}
            onChange={(event) => {
              liveQueryRef.current = event.target.value;
              onQueryChange(event.target.value);
            }}
          />
          <button
            type="button"
            className="command-close"
            title="Close command palette"
            aria-label="Close command palette"
            onClick={closePalette}
          >
            <X size={18} />
          </button>
        </div>
        <div className="command-list">
          {filteredCommands.length ? (
            filteredCommands.map((command, index) => (
              <button
                key={command.id}
                type="button"
                className={`command-item ${index === selectedIndex ? "selected" : ""}`}
                disabled={command.disabled}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => void runCommand(command)}
              >
                <span className="command-section">{command.section}</span>
                <span className="command-text">
                  <span className="command-title">{command.title}</span>
                  {command.subtitle ? <span className="command-subtitle">{command.subtitle}</span> : null}
                </span>
                {command.shortcut ? <span className="command-shortcut">{command.shortcut}</span> : null}
              </button>
            ))
          ) : (
            <div className="command-empty">No commands</div>
          )}
        </div>
      </div>
    </div>
  );
}

const modulo = (value: number, length: number): number => ((value % length) + length) % length;
