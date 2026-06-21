import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { FitAddon, Terminal } from "ghostty-web";
import { Clipboard, Columns2, Maximize2, RotateCcw, Rows2, X } from "lucide-react";
import {
  KittyGraphicsParser,
  isKittyPlaceholder,
  isKittyPlaceholderMark,
  kittyResponse,
  materializeKittyGraphic,
  nextNonMarkIsPlaceholder,
  shouldDisplayKittyGraphic,
  shouldRespondToKitty,
  type KittyControlOperation,
  type KittyGraphicPayload,
  type KittyMaterializedImage,
  type KittyPlaceholderStripState,
} from "./kitty-graphics";
import { ensureGhostty } from "./terminal-loader";
import type { MachineStatus, PaneState, SplitDirection, TerminalMedia, TerminalRun } from "./types";

interface Props {
  pane: PaneState;
  active: boolean;
  unreadCount: number;
  machines: MachineStatus[];
  terminalFontSize: number;
  canClose: boolean;
  mediaItems: TerminalMedia[];
  lastRun?: TerminalRun;
  onActivate: () => void;
  onSplit: (direction: SplitDirection, machineId?: string) => void;
  onClose: () => void;
  onDismissMedia: (mediaId: string) => void;
}

interface KittyInlineImage {
  id: string;
  imageId: string;
  name: string;
  mimeType: string;
  data: string;
  col: number;
  row: number;
  cols: number;
  rows: number;
  createdAt: string;
}

interface KittyVirtualPlacement {
  cols: number;
  rows: number;
}

interface KittyPlaceholderCell {
  imageId: string;
  col: number;
  row: number;
}

interface CellMetrics {
  width: number;
  height: number;
}

export function TerminalPane({
  pane,
  active,
  unreadCount,
  machines,
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
  const kittyParserRef = useRef(new KittyGraphicsParser());
  const kittyPlaceholderStripRef = useRef<KittyPlaceholderStripState>({ pendingPlaceholderMarks: false });
  const kittyImageCacheRef = useRef(new Map<string, TerminalMedia>());
  const kittyVirtualPlacementsRef = useRef(new Map<string, KittyVirtualPlacement>());
  const pendingVirtualImageIdRef = useRef<string | undefined>();
  const [connected, setConnected] = useState(false);
  const [kittyMediaItems, setKittyMediaItems] = useState<TerminalMedia[]>([]);
  const [kittyInlineItems, setKittyInlineItems] = useState<KittyInlineImage[]>([]);
  const [terminalMetrics, setTerminalMetrics] = useState<CellMetrics>({ width: 8, height: 16 });
  const [viewportY, setViewportY] = useState(0);
  const visibleMediaItems = [...kittyMediaItems, ...mediaItems];
  const visibleInlineItems = viewportY < 1 ? kittyInlineItems.filter((item) => item.data) : [];

  useEffect(() => {
    let cancelled = false;
    let removed = false;
    let fitAddon: FitAddon | null = null;
    let reconnectTimer: number | undefined;
    let scrollDisposable: { dispose: () => void } | undefined;
    let renderDisposable: { dispose: () => void } | undefined;
    let reconnectDelayMs = 350;
    kittyParserRef.current = new KittyGraphicsParser();
    kittyPlaceholderStripRef.current.pendingPlaceholderMarks = false;
    kittyImageCacheRef.current.clear();
    kittyVirtualPlacementsRef.current.clear();
    pendingVirtualImageIdRef.current = undefined;
    setKittyMediaItems([]);
    setKittyInlineItems([]);
    setViewportY(0);

    const refreshMetrics = (term: Terminal) => {
      const metrics = readCellMetrics(term);
      if (!metrics) return;
      setTerminalMetrics((previous) =>
        previous.width === metrics.width && previous.height === metrics.height ? previous : metrics,
      );
    };

    const sendKittyResponse = (imageId: string | undefined, quiet: string, status: "ok" | "error", message: string) => {
      if (!imageId || !shouldRespondToKitty(quiet, status)) return;
      sendInput(socketRef.current, kittyResponse(imageId, message));
    };

    const addKittyMedia = (media: TerminalMedia) => {
      setKittyMediaItems((items) => [media, ...items.filter((item) => item.id !== media.id)].slice(0, 10));
    };

    const updateKittyInlineMedia = (imageId: string, media: TerminalMedia) => {
      setKittyInlineItems((items) =>
        items.map((item) =>
          item.imageId === imageId
            ? { ...item, name: media.name, mimeType: media.mimeType, data: media.data }
            : item,
        ),
      );
    };

    const recordKittyPlaceholderCells = (cells: KittyPlaceholderCell[]) => {
      if (cells.length === 0) return;

      const grouped = new Map<string, KittyPlaceholderCell[]>();
      for (const cell of cells) {
        const group = grouped.get(cell.imageId);
        if (group) {
          group.push(cell);
        } else {
          grouped.set(cell.imageId, [cell]);
        }
      }

      setKittyInlineItems((items) => {
        let next = items;
        for (const [imageId, imageCells] of grouped) {
          const meta = kittyVirtualPlacementsRef.current.get(imageId);
          const media = kittyImageCacheRef.current.get(imageId);
          const col = Math.min(...imageCells.map((cell) => cell.col));
          const row = Math.min(...imageCells.map((cell) => cell.row));
          const maxCol = Math.max(...imageCells.map((cell) => cell.col));
          const maxRow = Math.max(...imageCells.map((cell) => cell.row));
          const inlineItem: KittyInlineImage = {
            id: `kitty_inline_${imageId}`,
            imageId,
            name: media?.name ?? `kitty-${imageId}.png`,
            mimeType: media?.mimeType ?? "image/png",
            data: media?.data ?? "",
            col,
            row,
            cols: Math.max(1, meta?.cols ?? maxCol - col + 1),
            rows: Math.max(1, meta?.rows ?? maxRow - row + 1),
            createdAt: new Date().toISOString(),
          };
          const existing = next.findIndex((item) => item.imageId === imageId);
          next =
            existing === -1
              ? [inlineItem, ...next].slice(0, 20)
              : next.map((item, index) => (index === existing ? { ...item, ...inlineItem } : item));
        }
        return next;
      });
    };

    const handleKittyControl = (control: KittyControlOperation) => {
      if (control.error) {
        sendKittyResponse(control.imageId, control.quiet, "error", control.error);
        return;
      }
      if (control.action === "p") {
        const cached = control.imageId ? kittyImageCacheRef.current.get(control.imageId) : undefined;
        if (!cached) {
          sendKittyResponse(control.imageId, control.quiet, "error", "ENOENT: Kitty image id not found");
          return;
        }
        const media = { ...cached, id: createLocalMediaId() };
        addKittyMedia(media);
        sendKittyResponse(control.imageId, control.quiet, "ok", "OK");
        return;
      }
      if (control.action === "d") {
        if (control.imageId) {
          kittyImageCacheRef.current.delete(control.imageId);
          kittyVirtualPlacementsRef.current.delete(control.imageId);
          setKittyMediaItems((items) => items.filter((item) => !item.id.includes(`_${control.imageId}_`)));
          setKittyInlineItems((items) => items.filter((item) => item.imageId !== control.imageId));
        }
        sendKittyResponse(control.imageId, control.quiet, "ok", "OK");
      }
    };

    const handleKittyGraphic = (graphic: KittyGraphicPayload) => {
      if (graphic.virtualPlacement && graphic.imageId) {
        kittyVirtualPlacementsRef.current.set(graphic.imageId, {
          cols: Math.max(1, graphic.displayColumns ?? 1),
          rows: Math.max(1, graphic.displayRows ?? 1),
        });
        pendingVirtualImageIdRef.current = graphic.imageId;
        setKittyInlineItems((items) => items.filter((item) => item.imageId !== graphic.imageId));
      }

      void materializeKittyGraphic(graphic)
        .then((image) => {
          if (cancelled || removed) return;
          const media = kittyImageToMedia(image, pane, graphic.imageId);
          if (graphic.action !== "q" && graphic.imageId) kittyImageCacheRef.current.set(graphic.imageId, media);
          if (graphic.virtualPlacement && graphic.imageId) updateKittyInlineMedia(graphic.imageId, media);
          if (shouldDisplayKittyGraphic(graphic)) addKittyMedia(media);
          sendKittyResponse(graphic.imageId, graphic.quiet, "ok", "OK");
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "Kitty graphics decode failed";
          sendKittyResponse(graphic.imageId, graphic.quiet, "error", `EINVAL: ${message}`);
        });
    };

    const handleOutput = (term: Terminal, data: string) => {
      const parsed = kittyParserRef.current.push(data);
      for (const event of parsed.events) {
        if (event.kind === "text") {
          const placeholderCells: KittyPlaceholderCell[] = [];
          writeTerminalOutput(
            term,
            outputCarryRef,
            kittyPlaceholderStripRef,
            event.text,
            () => {
              const imageId = pendingVirtualImageIdRef.current;
              const cursor = term.wasmTerm?.getCursor();
              if (!imageId || !cursor) return;
              placeholderCells.push({ imageId, col: cursor.x, row: cursor.y });
            },
            (privateMode) => {
              sendInput(socketRef.current, cursorPositionResponse(term, privateMode));
            },
          );
          recordKittyPlaceholderCells(placeholderCells);
        }
        if (event.kind === "control") handleKittyControl(event.control);
        if (event.kind === "graphic") handleKittyGraphic(event.graphic);
      }
    };

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
        if (cancelled) return;
        if (socketRef.current === ws) socketRef.current = null;
        setConnected(false);
        scheduleReconnect();
      };
      ws.onerror = () => {
        if (cancelled || socketRef.current !== ws) return;
        setConnected(false);
      };
      ws.onmessage = (event) => {
        if (cancelled || socketRef.current !== ws) return;
        const message = JSON.parse(event.data);
        if (typeof message.paneId === "string" && message.paneId !== pane.id) return;
        if (message.type === "ready") {
          outputCarryRef.current = "";
          term.clear();
          setKittyInlineItems([]);
          if (message.replay) handleOutput(term, message.replay);
        }
        if (message.type === "output") handleOutput(term, message.data);
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
      configureTerminalInput(term);
      terminalRef.current = term;
      await waitForVisibleBox(containerRef.current);
      fitAddon.fit();
      fitAddon.observeResize();
      refreshMetrics(term);
      scrollDisposable = term.onScroll((position) => setViewportY(position));
      renderDisposable = term.onRender(() => refreshMetrics(term));

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
      scrollDisposable?.dispose();
      renderDisposable?.dispose();
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
      const metrics = readCellMetrics(term);
      if (metrics) setTerminalMetrics(metrics);
    });
  }, [terminalFontSize]);

  const currentMachine = machines.find((machine) => machine.id === pane.machineId);
  const canSplit = currentMachine?.reachable ?? false;
  const rerunLastCommand = () => {
    if (!lastRun?.command || !socketRef.current) return;
    sendInput(socketRef.current, `${lastRun.command}\r`);
  };

  return (
    <section
      className={`terminal-pane ${active ? "active" : ""} ${unreadCount > 0 ? "unread" : ""} ${
        visibleMediaItems.length > 0 ? "has-media" : ""
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
          <button title={`Split right on ${currentMachine?.name ?? pane.machineId}`} disabled={!canSplit} onClick={() => onSplit("vertical")}>
            <Columns2 size={16} />
          </button>
          <button title={`Split down on ${currentMachine?.name ?? pane.machineId}`} disabled={!canSplit} onClick={() => onSplit("horizontal")}>
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
      <div
        className="terminal-host-shell"
        onPointerDown={() => {
          onActivate();
          terminalRef.current?.focus();
        }}
      >
        <div ref={containerRef} className="terminal-host" />
        {visibleInlineItems.length > 0 ? (
          <div className="kitty-inline-layer" aria-hidden="true">
            {visibleInlineItems.map((item) => (
              <img
                key={item.id}
                className="kitty-inline-image"
                src={`data:${item.mimeType};base64,${item.data}`}
                alt=""
                style={{
                  left: item.col * terminalMetrics.width,
                  top: item.row * terminalMetrics.height,
                  width: item.cols * terminalMetrics.width,
                  height: item.rows * terminalMetrics.height,
                }}
              />
            ))}
          </div>
        ) : null}
      </div>
      {visibleMediaItems.length > 0 ? (
        <div className="media-shelf">
          {visibleMediaItems.slice(0, 3).map((item) => (
            <MediaPreview
              key={item.id}
              item={item}
              onDismiss={() => {
                if (item.id.startsWith("kitty_")) {
                  setKittyMediaItems((items) => items.filter((candidate) => candidate.id !== item.id));
                } else {
                  onDismissMedia(item.id);
                }
              }}
            />
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

const configureTerminalInput = (term: Terminal): void => {
  const textarea = term.textarea;
  if (!textarea) return;
  textarea.setAttribute("autocomplete", "off");
  textarea.setAttribute("autocorrect", "off");
  textarea.setAttribute("autocapitalize", "none");
  textarea.setAttribute("spellcheck", "false");
  textarea.setAttribute("enterkeyhint", "enter");
  textarea.setAttribute("aria-autocomplete", "none");
  textarea.setAttribute("data-form-type", "other");
  textarea.setAttribute("data-lpignore", "true");
  textarea.setAttribute("data-gramm", "false");
  textarea.setAttribute("data-ms-editor", "false");
};

const sendInput = (ws: WebSocket | null, data: string): void => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
};

const kittyImageToMedia = (image: KittyMaterializedImage, pane: PaneState, imageId?: string): TerminalMedia => ({
  id: createLocalMediaId(imageId),
  workspaceId: "",
  tabId: "",
  paneId: pane.id,
  name: image.name,
  mimeType: image.mimeType,
  data: image.data,
  createdAt: new Date().toISOString(),
});

const createLocalMediaId = (imageId = "image"): string =>
  `kitty_${imageId.replace(/[^A-Za-z0-9-]/g, "_")}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

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
const PARTIAL_DECSTR = /\x1b(?:\[[?0-9;]*!?)?$/;
const DECSTR = /\x1b\[[0-9;]*!p/g;

const writeTerminalOutput = (
  term: Terminal,
  carryRef: MutableRefObject<string>,
  kittyPlaceholderStripRef: MutableRefObject<KittyPlaceholderStripState>,
  data: string,
  onKittyPlaceholder?: () => void,
  onCursorPositionReportRequest?: (privateMode: boolean) => void,
): void => {
  const combined = carryRef.current + data;
  const partial = combined.match(PARTIAL_DECSTR);
  const body = partial ? combined.slice(0, -partial[0].length) : combined;
  carryRef.current = partial?.[0] ?? "";
  writeTerminalBody(
    term,
    kittyPlaceholderStripRef.current,
    body.replace(DECSTR, DECSTR_SHIM),
    onKittyPlaceholder,
    onCursorPositionReportRequest,
  );
};

const writeTerminalBody = (
  term: Terminal,
  state: KittyPlaceholderStripState,
  data: string,
  onKittyPlaceholder?: () => void,
  onCursorPositionReportRequest?: (privateMode: boolean) => void,
): void => {
  let pending = "";
  const chars = Array.from(data);
  let previousWasPlaceholder = state.pendingPlaceholderMarks;
  state.pendingPlaceholderMarks = false;

  const flush = () => {
    if (!pending) return;
    term.write(pending);
    pending = "";
  };

  const flushCursorPositionReport = (privateMode: boolean) => {
    flush();
    onCursorPositionReportRequest?.(privateMode);
  };

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (char === "\x1b" && chars[index + 1] === "[" && chars[index + 2] === "6" && chars[index + 3] === "n") {
      flushCursorPositionReport(false);
      index += 3;
      continue;
    }
    if (
      char === "\x1b" &&
      chars[index + 1] === "[" &&
      chars[index + 2] === "?" &&
      chars[index + 3] === "6" &&
      chars[index + 4] === "n"
    ) {
      flushCursorPositionReport(true);
      index += 4;
      continue;
    }
    if (isKittyPlaceholder(char)) {
      flush();
      onKittyPlaceholder?.();
      pending += " ";
      while (isKittyPlaceholderMark(chars[index + 1])) index += 1;
      previousWasPlaceholder = true;
      continue;
    }
    if (previousWasPlaceholder && isKittyPlaceholderMark(char)) {
      previousWasPlaceholder = true;
      continue;
    }
    if (char === "\b" && (previousWasPlaceholder || nextNonMarkIsPlaceholder(chars, index + 1))) {
      pending += char;
      previousWasPlaceholder = true;
      continue;
    }
    pending += char;
    previousWasPlaceholder = false;
  }

  state.pendingPlaceholderMarks = previousWasPlaceholder;
  flush();
};

const cursorPositionResponse = (term: Terminal, privateMode: boolean): string => {
  const cursor = term.wasmTerm?.getCursor();
  const row = clamp((cursor?.y ?? 0) + 1, 1, safeRows(term.rows));
  const col = clamp((cursor?.x ?? 0) + 1, 1, safeCols(term.cols));
  return privateMode ? `\x1b[?${row};${col}R` : `\x1b[${row};${col}R`;
};

const readCellMetrics = (term: Terminal): CellMetrics | null => {
  const metrics = term.renderer?.getMetrics?.();
  if (!metrics || metrics.width <= 0 || metrics.height <= 0) return null;
  return { width: metrics.width, height: metrics.height };
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
