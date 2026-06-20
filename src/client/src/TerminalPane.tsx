import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { FitAddon, Terminal } from "ghostty-web";
import { Clipboard, Columns2, Maximize2, RotateCcw, Rows2, X } from "lucide-react";
import { ensureGhostty } from "./terminal-loader";
import type { MachineStatus, PaneState, SplitDirection, TerminalMedia, TerminalRun } from "./types";

interface Props {
  pane: PaneState;
  active: boolean;
  unreadCount: number;
  machines: MachineStatus[];
  splitMachineId: string;
  terminalFontSize: number;
  canClose: boolean;
  mediaItems: TerminalMedia[];
  lastRun?: TerminalRun;
  onActivate: () => void;
  onSplit: (direction: SplitDirection, machineId: string) => void;
  onClose: () => void;
  onDismissMedia: (mediaId: string) => void;
}

export function TerminalPane({
  pane,
  active,
  unreadCount,
  machines,
  splitMachineId,
  terminalFontSize,
  canClose,
  mediaItems,
  lastRun,
  onActivate,
  onSplit,
  onClose,
  onDismissMedia,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const outputCarryRef = useRef("");
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let removed = false;
    let fitAddon: FitAddon | null = null;
    let reconnectTimer: number | undefined;
    let reconnectDelayMs = 350;
    let connectCount = 0;

    const scheduleReconnect = () => {
      if (cancelled || removed || reconnectTimer) return;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, reconnectDelayMs);
      reconnectDelayMs = Math.min(3000, Math.round(reconnectDelayMs * 1.6));
    };

    const connect = () => {
      const term = terminalRef.current;
      if (cancelled || removed || !term) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const shouldClearOnReady = connectCount > 0;
      connectCount += 1;
      const ws = new WebSocket(
        `${protocol}//${window.location.host}/ws/panes/${pane.id}?cols=${safeCols(term.cols)}&rows=${safeRows(term.rows)}`,
      );
      socketRef.current = ws;

      ws.onopen = () => {
        if (cancelled || removed) {
          ws.close();
          return;
        }
        reconnectDelayMs = 350;
        setConnected(true);
        ws.send(JSON.stringify({ type: "resize", cols: safeCols(term.cols), rows: safeRows(term.rows) }));
      };
      ws.onclose = () => {
        if (socketRef.current === ws) socketRef.current = null;
        setConnected(false);
        scheduleReconnect();
      };
      ws.onerror = () => {
        setConnected(false);
      };
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "ready") {
          outputCarryRef.current = "";
          if (shouldClearOnReady || !message.replay) term.clear();
          if (message.replay) writeTerminalOutput(term, outputCarryRef, message.replay);
        }
        if (message.type === "output") writeTerminalOutput(term, outputCarryRef, message.data);
        if (message.type === "exit") term.write(`\r\n[wmux] process exited with code ${message.code}\r\n`);
        if (message.type === "removed") {
          removed = true;
          ws.close();
        }
      };
    };

    const start = async () => {
      await ensureGhostty();
      if (cancelled || !containerRef.current) return;
      const term = new Terminal({
        cursorBlink: true,
        fontSize: terminalFontSize,
        fontFamily: 'Menlo, Monaco, "Cascadia Mono", "Courier New", monospace',
        scrollback: 10000,
        theme: {
          background: "#101114",
          foreground: "#d8dee9",
          cursor: "#f7c95c",
          selectionBackground: "#31445f",
        },
      });
      fitAddon = new FitAddon();
      fitAddonRef.current = fitAddon;
      term.loadAddon(fitAddon);
      term.open(containerRef.current);
      terminalRef.current = term;
      await waitForVisibleBox(containerRef.current);
      fitAddon.fit();
      fitAddon.observeResize();

      term.attachCustomKeyEventHandler((event) => {
        if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
          if (event.key === "ArrowLeft") {
            sendInput(socketRef.current, "\x1bb");
            return true;
          }
          if (event.key === "ArrowRight") {
            sendInput(socketRef.current, "\x1bf");
            return true;
          }
        }
        return false;
      });
      term.attachCustomWheelEventHandler((event) => {
        if (!event.shiftKey && hasMouseTracking(term)) {
          const sequence = mouseWheelSequence(event, term);
          if (sequence) sendInput(socketRef.current, sequence);
          return true;
        }
        const lines = wheelLines(event, term);
        if (lines !== 0) term.scrollLines(lines);
        return true;
      });

      term.onData((data) => {
        sendInput(socketRef.current, data);
      });
      term.onResize((size) => {
        const ws = socketRef.current;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: size.cols, rows: size.rows }));
        }
      });
      connect();
    };
    void start();

    return () => {
      cancelled = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socketRef.current?.close();
      fitAddon?.dispose();
      terminalRef.current?.dispose();
      socketRef.current = null;
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [pane.id]);

  useEffect(() => {
    const term = terminalRef.current;
    if (!term?.renderer) return;
    term.renderer.setFontSize(terminalFontSize);
    requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
    });
  }, [terminalFontSize]);

  const currentMachine = machines.find((machine) => machine.id === pane.machineId);
  const selectedMachine = machines.find((machine) => machine.id === splitMachineId);
  const canSplit = selectedMachine?.reachable ?? false;
  const rerunLastCommand = () => {
    if (!lastRun?.command || !socketRef.current) return;
    sendInput(socketRef.current, `${lastRun.command}\r`);
  };

  return (
    <section
      className={`terminal-pane ${active ? "active" : ""} ${unreadCount > 0 ? "unread" : ""} ${
        mediaItems.length > 0 ? "has-media" : ""
      }`}
      onMouseDown={onActivate}
    >
      <div className="pane-toolbar">
        <div className="pane-title">
          <span className={`status-dot ${connected ? "on" : ""}`} />
          <span>{pane.title}</span>
          <span className="machine-label">{currentMachine?.name ?? pane.machineId}</span>
          {unreadCount > 0 ? <span className="badge">{unreadCount}</span> : null}
        </div>
        <div className="pane-actions">
          {lastRun ? (
            <div className={`run-chip ${lastRun.status}`} title={runTitle(lastRun)}>
              <span>{runLabel(lastRun)}</span>
              <button
                title="Copy last command"
                disabled={!navigator.clipboard}
                onClick={() => void navigator.clipboard?.writeText(lastRun.command)}
              >
                <Clipboard size={13} />
              </button>
              <button title="Rerun last command" disabled={!connected || !lastRun.command} onClick={rerunLastCommand}>
                <RotateCcw size={13} />
              </button>
            </div>
          ) : null}
          <button title={`Split right on ${selectedMachine?.name ?? splitMachineId}`} disabled={!canSplit} onClick={() => onSplit("vertical", splitMachineId)}>
            <Columns2 size={16} />
          </button>
          <button title={`Split down on ${selectedMachine?.name ?? splitMachineId}`} disabled={!canSplit} onClick={() => onSplit("horizontal", splitMachineId)}>
            <Rows2 size={16} />
          </button>
          <button title="Focus pane" onClick={onActivate}>
            <Maximize2 size={15} />
          </button>
          <button title="Close pane" disabled={!canClose} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </div>
      <div ref={containerRef} className="terminal-host" />
      {mediaItems.length > 0 ? (
        <div className="media-shelf">
          {mediaItems.slice(0, 3).map((item) => (
            <MediaPreview key={item.id} item={item} onDismiss={() => onDismissMedia(item.id)} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function MediaPreview({ item, onDismiss }: { item: TerminalMedia; onDismiss: () => void }) {
  const src = `data:${item.mimeType};base64,${item.data}`;
  return (
    <figure className="media-preview">
      <div className="media-preview-header">
        <span>{item.name}</span>
        <button title="Dismiss media" onClick={onDismiss}>
          <X size={14} />
        </button>
      </div>
      {renderMedia(item, src)}
    </figure>
  );
}

const renderMedia = (item: TerminalMedia, src: string) => {
  if (item.mimeType.startsWith("image/") && item.mimeType !== "image/svg+xml") {
    return <img src={src} alt={item.name} />;
  }
  if (item.mimeType.startsWith("audio/")) {
    return <audio controls src={src} />;
  }
  if (item.mimeType.startsWith("video/")) {
    return <video controls src={src} />;
  }
  return (
    <a className="media-download" download={item.name} href={src}>
      Download {item.mimeType}
    </a>
  );
};

const safeCols = (cols: number): number => (Number.isFinite(cols) && cols >= 2 ? Math.floor(cols) : 80);
const safeRows = (rows: number): number => (Number.isFinite(rows) && rows >= 1 ? Math.floor(rows) : 24);

const sendInput = (ws: WebSocket | null, data: string): void => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
};

const wheelLines = (event: WheelEvent, term: Terminal): number => {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * safeRows(term.rows);
  const lineHeight = term.renderer?.getMetrics?.().height ?? 20;
  return event.deltaY / lineHeight;
};

const hasMouseTracking = (term: Terminal): boolean => {
  try {
    return term.hasMouseTracking();
  } catch {
    return false;
  }
};

const mouseWheelSequence = (event: WheelEvent, term: Terminal): string => {
  const lines = Math.min(Math.max(1, Math.round(Math.abs(wheelLines(event, term)))), 5);
  const button = event.deltaY < 0 ? 64 : 65;
  const modifier = (event.shiftKey ? 4 : 0) + (event.altKey ? 8 : 0) + (event.ctrlKey ? 16 : 0);
  const { col, row } = mouseCell(event, term);
  const code = button + modifier;
  const sequence = supportsSgrMouse(term)
    ? `\x1b[<${code};${col};${row}M`
    : `\x1b[M${String.fromCharCode(32 + code)}${String.fromCharCode(32 + col)}${String.fromCharCode(32 + row)}`;
  return sequence.repeat(lines);
};

const supportsSgrMouse = (term: Terminal): boolean => {
  try {
    return term.getMode(1006);
  } catch {
    return true;
  }
};

const mouseCell = (event: WheelEvent, term: Terminal): { col: number; row: number } => {
  const rect = term.element?.getBoundingClientRect();
  const metrics = term.renderer?.getMetrics?.();
  const width = metrics?.width ?? 8;
  const height = metrics?.height ?? 16;
  if (!rect) return { col: 1, row: 1 };
  return {
    col: clamp(Math.floor((event.clientX - rect.left) / width) + 1, 1, safeCols(term.cols)),
    row: clamp(Math.floor((event.clientY - rect.top) / height) + 1, 1, safeRows(term.rows)),
  };
};

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

const runLabel = (run: TerminalRun): string => {
  if (run.status === "started") return "running";
  if (run.exitCode === 0) return "exit 0";
  return `exit ${run.exitCode ?? "?"}`;
};

const runTitle = (run: TerminalRun): string => {
  const elapsed = run.completedAt ? ` (${formatDuration(run.startedAt, run.completedAt)})` : "";
  return `${run.command} - ${runLabel(run)}${elapsed}`;
};

const formatDuration = (startedAt: string, completedAt: string): string => {
  const elapsedMs = Date.parse(completedAt) - Date.parse(startedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "unknown duration";
  if (elapsedMs < 1000) return `${elapsedMs}ms`;
  return `${(elapsedMs / 1000).toFixed(elapsedMs < 10_000 ? 1 : 0)}s`;
};

const DECSTR_SHIM = "\x1b[0m\x1b[?1l\x1b>\x1b[?6l\x1b[?7h\x1b[4l\x1b[r\x1b[?25h\x1b(B";
const PARTIAL_DECSTR = /\x1b(?:\[[0-9;]*!?)?$/;
const DECSTR = /\x1b\[[0-9;]*!p/g;

const writeTerminalOutput = (term: Terminal, carryRef: MutableRefObject<string>, data: string): void => {
  const combined = carryRef.current + data;
  const partial = combined.match(PARTIAL_DECSTR);
  const body = partial ? combined.slice(0, -partial[0].length) : combined;
  carryRef.current = partial?.[0] ?? "";
  const normalized = body.replace(DECSTR, DECSTR_SHIM);
  if (normalized) term.write(normalized);
};

const waitForVisibleBox = (element: HTMLElement): Promise<void> =>
  new Promise((resolve) => {
    const hasSize = () => element.clientWidth > 0 && element.clientHeight > 0;
    if (hasSize()) {
      resolve();
      return;
    }
    let frames = 0;
    const tick = () => {
      frames += 1;
      if (hasSize() || frames > 10) {
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
