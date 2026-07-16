import { memo, useEffect, useRef, useState, type MutableRefObject } from "react";
import { Terminal } from "ghostty-web";
import { X } from "lucide-react";
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
import { ensureWmuxFonts, WMUX_MONO_FONT_FAMILY } from "./fonts";
import { ensureGhostty } from "./terminal-loader";
import { configureTerminalInput } from "./terminal-input";
import { isTerminalProtocolResponse } from "./terminal-protocol";
import { OpenTuiPaneToolbar } from "./OpenTuiPaneToolbar";
import { writeBrowserClipboard } from "./clipboard";
import { api } from "./api";
import { canApplyStagedPasteImage, imagesFromClipboard, quoteStagedImagePath } from "./clipboard-images";
import { Osc52Parser } from "./terminal-osc52";
import { RectangularSelection } from "./terminal-rectangular-selection";
import { PaneSocketController } from "./pane-socket";
import {
  type KittyInlineImage,
  type KittyVirtualPlacement,
  type KittyPlaceholderCell,
  type CellMetrics,
  type SynchronizedOutputState,
  type TerminalFitter,
  safeCols,
  safeRows,
  sendInput,
  createTerminalFitter,
  sendResizeMessage,
  isForegroundTerminal,
  inputMayLeaveShellPrompt,
  MAX_SYNCHRONIZED_OUTPUT_HOLD_MS,
  TERMINAL_OUTPUT_BATCH_MS,
  REPLAY_CHUNK_CHARS,
  CONTEXT_COPY_BRIDGE_TIMEOUT_MS,
  OSC52_PENDING_MS,
  createSynchronizedOutputState,
  resetSynchronizedOutput,
  drainSynchronizedOutput,
  pushSynchronizedOutput,
  stripWmuxControlSequences,
  terminalSelectionManager,
  readTerminalSelectionPosition,
  restoreTerminalSelection,
  shellCursorPlacementSequence,
  kittyImageToMedia,
  createLocalMediaId,
  wheelLines,
  hasMouseTracking,
  mouseWheelSequence,
  mouseReleaseSequence,
  mousePressSequence,
  runLabel,
  runTitle,
  writeTerminalOutput,
  cursorPositionResponse,
  readCellMetrics,
  waitForVisibleBox,
} from "./terminal-pane-runtime";
import type {
  MachineStatus,
  PaneState,
  SplitDirection,
  TerminalMedia,
  TerminalRun,
} from "./types";

interface Props {
  pane: PaneState;
  active: boolean;
  unreadCount: number;
  machines: MachineStatus[];
  terminalFontSize: number;
  terminalScrollbackRows: number;
  mediaItems: TerminalMedia[];
  lastRun?: TerminalRun;
  focusSignal?: number;
  onActivate: () => void;
  onSplit: (direction: SplitDirection, machineId?: string) => void;
  onClose: () => void;
  onBell: () => void;
  onDismissMedia: (mediaId: string) => void;
}

// Memoized: with structural sharing in refresh (reconcile.ts) and the stable
// callbacks from LayoutPane, unrelated state events skip this subtree.
export const TerminalPane = memo(function TerminalPane({
  pane,
  active,
  unreadCount,
  machines,
  terminalFontSize,
  terminalScrollbackRows,
  mediaItems,
  lastRun,
  focusSignal = 0,
  onActivate,
  onSplit,
  onClose,
  onBell,
  onDismissMedia,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const rectangularSelectionRef = useRef<RectangularSelection | null>(null);
  const fitAddonRef = useRef<TerminalFitter | null>(null);
  const reconnectRef = useRef<(() => void) | null>(null);
  const outputCarryRef = useRef("");
  const osc52ParserRef = useRef(new Osc52Parser());
  const pendingOsc52Ref = useRef<{ text: string; generation: number; expiresAt: number } | undefined>();
  const osc52GenerationRef = useRef(0);
  const osc52WriteAtRef = useRef(0);
  const [hasPendingOsc52, setHasPendingOsc52] = useState(false);
  const kittyParserRef = useRef(new KittyGraphicsParser());
  const kittyPlaceholderStripRef = useRef<KittyPlaceholderStripState>({ pendingPlaceholderMarks: false });
  const kittyImageCacheRef = useRef(new Map<string, TerminalMedia>());
  const kittyVirtualPlacementsRef = useRef(new Map<string, KittyVirtualPlacement>());
  const pendingVirtualImageIdRef = useRef<string | undefined>();
  const wmuxControlCarryRef = useRef("");
  const synchronizedOutputRef = useRef<SynchronizedOutputState>(createSynchronizedOutputState());
  const shellCursorPlacementRef = useRef(false);
  const onActivateRef = useRef(onActivate);
  const activeRef = useRef(active);
  const focusSignalRef = useRef(focusSignal);
  const connectedRef = useRef(false);
  const inputEpochRef = useRef(0);
  const [connected, setConnected] = useState(false);
  const [connectionIssue, setConnectionIssue] = useState("");
  const [kittyMediaItems, setKittyMediaItems] = useState<TerminalMedia[]>([]);
  const [kittyInlineItems, setKittyInlineItems] = useState<KittyInlineImage[]>([]);
  const [terminalMetrics, setTerminalMetrics] = useState<CellMetrics>({ width: 8, height: 16 });
  const [viewportY, setViewportY] = useState(0);
  const [terminalReady, setTerminalReady] = useState(false);
  const [rectangleVersion, setRectangleVersion] = useState(0);
  const visibleMediaItems = [...kittyMediaItems, ...mediaItems];
  const visibleInlineItems = viewportY < 1 ? kittyInlineItems.filter((item) => item.data) : [];

  useEffect(() => {
    onActivateRef.current = onActivate;
  }, [onActivate]);

  useEffect(() => {
    if (activeRef.current !== active) inputEpochRef.current += 1;
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    focusSignalRef.current = focusSignal;
  }, [focusSignal]);

  useEffect(() => {
    let cancelled = false;
    let removed = false;
    let fitAddon: TerminalFitter | null = null;
    let socketController: PaneSocketController | undefined;
    let scrollDisposable: { dispose: () => void } | undefined;
    let renderDisposable: { dispose: () => void } | undefined;
    let bufferDisposable: { dispose: () => void } | undefined;
    let mouseDownListener: ((event: MouseEvent) => void) | undefined;
    let mouseUpListener: ((event: MouseEvent) => void) | undefined;
    let mouseShieldDownListener: ((event: MouseEvent) => void) | undefined;
    let mouseShieldMoveListener: ((event: MouseEvent) => void) | undefined;
    let mouseGestureEndListener: (() => void) | undefined;
    let contextMenuListener: ((event: MouseEvent) => void) | undefined;
    let copyListener: ((event: ClipboardEvent) => void) | undefined;
    let pasteListener: ((event: ClipboardEvent) => void) | undefined;
    let windowFocusListener: (() => void) | undefined;
    let windowBlurListener: (() => void) | undefined;
    let pageShowListener: (() => void) | undefined;
    let visibilityChangeListener: (() => void) | undefined;
    let rectangularSelection: RectangularSelection | undefined;
    let contextMenuSelection = "";
    let pendingCursorPlacement: { sequence: string; x: number; y: number } | null = null;
    let browserPrimaryMouseGesture = false;
    let contextCopyBridge: HTMLTextAreaElement | undefined;
    let contextCopyBridgeTimer: number | undefined;
    let selectionRestoreTimer: number | undefined;
    let removeContextCopyBridgeDismissListeners: (() => void) | undefined;
    let terminalOutputTimer: number | undefined;
    let osc52PendingTimer: number | undefined;
    let queuedTerminalOutput = "";
    let replayChunks: string[] = [];
    let replayBufferedOutput: string[] = [];
    let replayDrainTimer: number | undefined;
    let replayingTerminalOutput = false;
    // The server preserves a pane whose process died abnormally instead of
    // deleting it, so a keypress here re-attaches (and re-spawns) on demand
    // rather than looping against a down host.
    let awaitingRestart = false;
    kittyParserRef.current = new KittyGraphicsParser();
    kittyPlaceholderStripRef.current.pendingPlaceholderMarks = false;
    kittyImageCacheRef.current.clear();
    kittyVirtualPlacementsRef.current.clear();
    pendingVirtualImageIdRef.current = undefined;
    wmuxControlCarryRef.current = "";
    resetSynchronizedOutput(synchronizedOutputRef.current);
    shellCursorPlacementRef.current = false;
    osc52ParserRef.current.reset();
    pendingOsc52Ref.current = undefined;
    setHasPendingOsc52(false);
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

    const copyRectangularSelection = (term: Terminal, selection: string): void => {
      if (!selection) return;
      let copied = false;

      const previousActive = document.activeElement;
      const shouldRestoreFocus = previousActive !== term.element;
      if (shouldRestoreFocus) term.focus();
      try {
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      } finally {
        if (
          shouldRestoreFocus &&
          previousActive instanceof HTMLElement &&
          typeof previousActive.focus === "function"
        ) {
          previousActive.focus({ preventScroll: true });
        }
      }

      if (!copied) {
        void writeBrowserClipboard(selection).catch(() => undefined);
      }
    };

    const clearContextCopyBridge = () => {
      if (contextCopyBridgeTimer !== undefined) {
        window.clearTimeout(contextCopyBridgeTimer);
        contextCopyBridgeTimer = undefined;
      }
      removeContextCopyBridgeDismissListeners?.();
      removeContextCopyBridgeDismissListeners = undefined;
      const bridge = contextCopyBridge;
      contextCopyBridge = undefined;
      if (!bridge) return;
      const bridgeHadFocus = document.activeElement === bridge;
      bridge.remove();
      if (bridgeHadFocus && activeRef.current) terminalRef.current?.focus();
    };

    const prepareContextCopyBridge = (selection: string) => {
      clearContextCopyBridge();
      const bridge = document.createElement("textarea");
      bridge.value = selection;
      bridge.readOnly = true;
      bridge.tabIndex = -1;
      bridge.setAttribute("aria-hidden", "true");
      bridge.className = "terminal-context-copy-bridge";
      document.body.appendChild(bridge);
      bridge.focus({ preventScroll: true });
      bridge.select();

      const dismiss = () => clearContextCopyBridge();
      document.addEventListener("pointerdown", dismiss, true);
      removeContextCopyBridgeDismissListeners = () => {
        document.removeEventListener("pointerdown", dismiss, true);
      };
      bridge.addEventListener("copy", () => window.setTimeout(clearContextCopyBridge, 0), { once: true });
      contextCopyBridge = bridge;
      contextCopyBridgeTimer = window.setTimeout(clearContextCopyBridge, CONTEXT_COPY_BRIDGE_TIMEOUT_MS);
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

    const writeTerminalTextNow = (term: Terminal, text: string) => {
      if (!text) return;
      const placeholderCells: KittyPlaceholderCell[] = [];
      writeTerminalOutput(
        term,
        outputCarryRef,
        kittyPlaceholderStripRef,
        text,
        () => {
          const imageId = pendingVirtualImageIdRef.current;
          const cursor = term.wasmTerm?.getCursor();
          if (!imageId || !cursor) return;
          placeholderCells.push({ imageId, col: cursor.x, row: cursor.y });
        },
        (privateMode) => {
          if (!replayingTerminalOutput) sendInput(socketRef.current, cursorPositionResponse(term, privateMode), true);
        },
      );
      recordKittyPlaceholderCells(placeholderCells);
    };

    const flushQueuedTerminalText = (term: Terminal) => {
      if (terminalOutputTimer !== undefined) {
        window.clearTimeout(terminalOutputTimer);
        terminalOutputTimer = undefined;
      }
      const text = queuedTerminalOutput;
      queuedTerminalOutput = "";
      if (text) writeTerminalTextNow(term, text);
    };

    const queueTerminalText = (term: Terminal, text: string) => {
      if (!text) return;
      queuedTerminalOutput += text;
      if (terminalOutputTimer !== undefined) return;
      terminalOutputTimer = window.setTimeout(() => flushQueuedTerminalText(term), TERMINAL_OUTPUT_BATCH_MS);
    };

    const flushSynchronizedOutput = (term: Terminal) => {
      const text = drainSynchronizedOutput(synchronizedOutputRef.current);
      if (text) queueTerminalText(term, text);
    };

    const scheduleSynchronizedOutputFlush = (term: Terminal) => {
      const state = synchronizedOutputRef.current;
      if (!state.active || state.flushTimer !== undefined) return;
      state.flushTimer = window.setTimeout(() => {
        state.flushTimer = undefined;
        flushSynchronizedOutput(term);
      }, MAX_SYNCHRONIZED_OUTPUT_HOLD_MS);
    };

    const handleTerminalText = (term: Terminal, text: string) => {
      const chunks = pushSynchronizedOutput(synchronizedOutputRef.current, text);
      for (const chunk of chunks) queueTerminalText(term, chunk);
      scheduleSynchronizedOutputFlush(term);
    };

    const nextOsc52Request = (text: string) => ({ text, generation: ++osc52GenerationRef.current, expiresAt: Date.now() + OSC52_PENDING_MS });
    const retainOsc52 = (request: { text: string; generation: number; expiresAt: number }) => {
      if (osc52PendingTimer !== undefined) window.clearTimeout(osc52PendingTimer);
      pendingOsc52Ref.current = request;
      setHasPendingOsc52(true);
      osc52PendingTimer = window.setTimeout(() => {
        if (pendingOsc52Ref.current?.generation === request.generation) {
          pendingOsc52Ref.current = undefined;
          setHasPendingOsc52(false);
        }
      }, OSC52_PENDING_MS);
    };
    const tryOsc52Write = (request: { text: string; generation: number; expiresAt: number }) => {
      if (!isForegroundTerminal(activeRef.current) || !navigator.userActivation?.isActive || Date.now() - osc52WriteAtRef.current < 1000) {
        retainOsc52(request);
        return;
      }
      osc52WriteAtRef.current = Date.now();
      void writeBrowserClipboard(request.text).then(
        () => {
          if (!pendingOsc52Ref.current || pendingOsc52Ref.current.generation <= request.generation) {
            pendingOsc52Ref.current = undefined;
            setHasPendingOsc52(false);
          }
        },
        () => {
          // A later request must remain the one the user can explicitly copy.
          if (!pendingOsc52Ref.current || pendingOsc52Ref.current.generation <= request.generation) retainOsc52(request);
        },
      );
    };
    const handleOutput = (term: Terminal, data: string) => {
      const osc52 = osc52ParserRef.current.push(data);
      if (osc52.text.includes("\x07")) onBell();
      if (!replayingTerminalOutput) {
        for (const write of osc52.writes) {
          const request = nextOsc52Request(write.text);
          tryOsc52Write(request);
        }
      }
      const parsed = kittyParserRef.current.push(osc52.text);
      for (const event of parsed.events) {
        if (event.kind === "text") {
          const text = stripWmuxControlSequences(wmuxControlCarryRef, event.text, (control) => {
            if (control === "cursor=1") shellCursorPlacementRef.current = true;
            if (control === "cursor=0") shellCursorPlacementRef.current = false;
          });
          if (text) handleTerminalText(term, text);
        }
        if (event.kind === "control") handleKittyControl(event.control);
        if (event.kind === "graphic") handleKittyGraphic(event.graphic);
      }
    };

    // Large reconnect replays (up to 2 MiB) are parsed and written in chunks
    // across macrotasks so the main thread never blocks on one giant write.
    // Live output arriving mid-drain is buffered to preserve ordering.
    const replayDraining = () => replayChunks.length > 0 || replayDrainTimer !== undefined;

    const revealTerminal = () => {
      requestAnimationFrame(() => {
        if (!cancelled) setTerminalReady(true);
      });
    };

    const resetReplayDrain = () => {
      if (replayDrainTimer !== undefined) {
        window.clearTimeout(replayDrainTimer);
        replayDrainTimer = undefined;
      }
      replayChunks = [];
      replayBufferedOutput = [];
      replayingTerminalOutput = false;
      osc52ParserRef.current.reset();
    };

    // Replay is display-only. Never let an incomplete replay request borrow a
    // terminator from subsequent live output.
    const finishReplay = () => {
      replayingTerminalOutput = false;
      osc52ParserRef.current.reset();
    };

    const startReplayDrain = (term: Terminal, replay: string) => {
      replayingTerminalOutput = true;
      if (replay.length <= REPLAY_CHUNK_CHARS) {
        handleOutput(term, replay);
        flushQueuedTerminalText(term);
        finishReplay();
        revealTerminal();
        return;
      }
      for (let index = 0; index < replay.length; index += REPLAY_CHUNK_CHARS) {
        replayChunks.push(replay.slice(index, index + REPLAY_CHUNK_CHARS));
      }
      scheduleReplayDrainStep(term);
    };

    const scheduleReplayDrainStep = (term: Terminal) => {
      if (replayDrainTimer !== undefined) return;
      replayDrainTimer = window.setTimeout(() => {
        replayDrainTimer = undefined;
        if (cancelled) return;
        const chunk = replayChunks.shift();
        if (chunk !== undefined) handleOutput(term, chunk);
        if (replayChunks.length > 0) {
          scheduleReplayDrainStep(term);
          return;
        }
        flushQueuedTerminalText(term);
        finishReplay();
        const buffered = replayBufferedOutput;
        replayBufferedOutput = [];
        for (const data of buffered) handleOutput(term, data);
        flushQueuedTerminalText(term);
        revealTerminal();
      }, 0);
    };

    const finishReplayDrainNow = (term: Terminal) => {
      if (replayDrainTimer !== undefined) {
        window.clearTimeout(replayDrainTimer);
        replayDrainTimer = undefined;
      }
      const chunks = replayChunks;
      replayChunks = [];
      for (const chunk of chunks) handleOutput(term, chunk);
      flushQueuedTerminalText(term);
      finishReplay();
      const buffered = replayBufferedOutput;
      replayBufferedOutput = [];
      for (const data of buffered) handleOutput(term, data);
      flushQueuedTerminalText(term);
      revealTerminal();
    };

    const foreground = () => isForegroundTerminal(activeRef.current);

    const announceResizeState = () => {
      const term = terminalRef.current;
      if (!term) return;
      if (activeRef.current && document.visibilityState === "visible") fitAddonRef.current?.fit();
      sendResizeMessage(socketRef.current, activeRef.current ? "activate" : "resize", term, foreground());
    };

    const announceResizeStateSoon = () => requestAnimationFrame(announceResizeState);

    const createSocketController = (term: Terminal) => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      return new PaneSocketController({
        paneId: pane.id,
        url: () => `${protocol}//${window.location.host}/ws/panes/${pane.id}?cols=${safeCols(term.cols)}&rows=${safeRows(term.rows)}`,
        onSocketChange: (socket) => {
          socketRef.current = socket;
        },
        onConnectionChange: (nextConnected, issue) => {
          if (cancelled) return;
          if (connectedRef.current !== nextConnected) inputEpochRef.current += 1;
          connectedRef.current = nextConnected;
          setConnected(nextConnected);
          setConnectionIssue(issue);
        },
        onOpen: (socket) => {
          sendResizeMessage(socket, activeRef.current ? "activate" : "resize", term, foreground());
        },
        onMessage: (message) => {
          if (cancelled) return;
        if (message.type === "ready") {
          setTerminalReady(false);
          outputCarryRef.current = "";
          osc52ParserRef.current.reset();
          pendingOsc52Ref.current = undefined;
          if (osc52PendingTimer !== undefined) window.clearTimeout(osc52PendingTimer);
          setHasPendingOsc52(false);
          queuedTerminalOutput = "";
          if (terminalOutputTimer !== undefined) {
            window.clearTimeout(terminalOutputTimer);
            terminalOutputTimer = undefined;
          }
          resetReplayDrain();
          resetSynchronizedOutput(synchronizedOutputRef.current);
          term.clear();
          setKittyInlineItems([]);
          if (message.replay) startReplayDrain(term, message.replay);
          else revealTerminal();
        }
        if (message.type === "output") {
          if (replayDraining()) replayBufferedOutput.push(message.data);
          else handleOutput(term, message.data);
        }
        if (message.type === "exit") {
          finishReplayDrainNow(term);
          flushQueuedTerminalText(term);
          term.write(`\r\n[wmux] process exited with code ${message.code}. Press any key to restart.\r\n`);
          setConnectionIssue(`Process exited with code ${message.code}`);
          awaitingRestart = true;
        }
        if (message.type === "removed") {
          finishReplayDrainNow(term);
          flushQueuedTerminalText(term);
          removed = true;
          socketController?.markRemoved();
        }
        },
      });
    };

    const start = async () => {
      await Promise.all([ensureGhostty(), ensureWmuxFonts()]);
      if (cancelled || !containerRef.current) return;
      const term = new Terminal({
        cursorBlink: true,
        fontSize: terminalFontSize,
        fontFamily: WMUX_MONO_FONT_FAMILY,
        scrollback: terminalScrollbackRows,
        theme: {
          background: "#101114",
          foreground: "#d8dee9",
          cursor: "#f7c95c",
          selectionBackground: "#31445f",
        },
      });
      term.open(containerRef.current);
      configureTerminalInput(term);
      terminalRef.current = term;
      rectangularSelection = new RectangularSelection(
        term,
        () => setRectangleVersion((version) => version + 1),
        (text) => {
          if (text) copyRectangularSelection(term, text);
        },
      );
      rectangularSelectionRef.current = rectangularSelection;
      if (activeRef.current && focusSignalRef.current > 0) requestAnimationFrame(() => term.focus());
      await waitForVisibleBox(containerRef.current);
      fitAddon = createTerminalFitter(term, containerRef.current);
      fitAddonRef.current = fitAddon;
      fitAddon.fit();
      refreshMetrics(term);
      scrollDisposable = term.onScroll((position) => setViewportY(position));
      renderDisposable = term.onRender(() => {
        refreshMetrics(term);
        if (rectangularSelection?.overlay) setRectangleVersion((version) => version + 1);
      });
      bufferDisposable = term.buffer.onBufferChange(() => rectangularSelection?.clear());

      mouseDownListener = (event) => {
        if (event.button === 0 && !event.altKey && !event.ctrlKey) rectangularSelection?.clear();
        if (event.button === 2 || (event.button === 0 && event.ctrlKey)) {
          contextMenuSelection = term.getSelection();
        }
        const sequence = shellCursorPlacementSequence(event, term, shellCursorPlacementRef.current);
        if (!sequence) return;
        // Don't intercept the press: swallowing mousedown here would make
        // drag-selection impossible whenever the shell prompt is active.
        // Remember the candidate placement and only send it on mouseup if the
        // gesture turned out to be a plain click rather than a selection drag.
        pendingCursorPlacement = { sequence, x: event.clientX, y: event.clientY };
      };
      term.element?.addEventListener("mousedown", mouseDownListener, { capture: true });
      mouseShieldDownListener = (event) => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey) return;
        browserPrimaryMouseGesture = true;
        // SelectionManager's canvas listener runs first. Stop here so Ghostty's
        // parent input handler cannot turn the same gesture into terminal mouse
        // bytes that clear the selection. Plain clicks are replayed on mouseup.
        event.stopPropagation();
      };
      mouseShieldMoveListener = (event) => {
        if (browserPrimaryMouseGesture) event.stopPropagation();
      };
      term.renderer?.getCanvas().addEventListener("mousedown", mouseShieldDownListener);
      term.renderer?.getCanvas().addEventListener("mousemove", mouseShieldMoveListener);
      mouseUpListener = (event) => {
        const browserGesture = browserPrimaryMouseGesture;
        browserPrimaryMouseGesture = false;
        const selectionPosition = readTerminalSelectionPosition(term);
        const selectionManager = terminalSelectionManager(term);
        if (browserGesture && selectionManager?.finishMouseSelection) {
          selectionManager.finishMouseSelection(event);
          if (selectionPosition) {
            pendingCursorPlacement = null;
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
          }
        }
        if (selectionPosition) {
          if (selectionRestoreTimer !== undefined) window.clearTimeout(selectionRestoreTimer);
          selectionRestoreTimer = window.setTimeout(() => {
            selectionRestoreTimer = undefined;
            if (!cancelled && !term.hasSelection()) restoreTerminalSelection(term, selectionPosition);
          }, 0);
        }
        const pending = pendingCursorPlacement;
        pendingCursorPlacement = null;
        if (pending && event.button === 0) {
          const dragged = Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 4;
          if (!dragged && !term.getSelection()) {
            onActivateRef.current();
            term.focus();
            term.clearSelection();
            inputEpochRef.current += 1;
            sendInput(socketRef.current, pending.sequence);
          }
        } else if (browserGesture && event.button === 0 && hasMouseTracking(term)) {
          inputEpochRef.current += 1;
          sendInput(socketRef.current, mousePressSequence(event, term));
          sendInput(socketRef.current, mouseReleaseSequence(event, term));
        }
        if (browserGesture) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      };
      term.element?.addEventListener("mouseup", mouseUpListener, { capture: true });
      mouseGestureEndListener = () => {
        browserPrimaryMouseGesture = false;
      };
      document.addEventListener("mouseup", mouseGestureEndListener);
      contextMenuListener = () => {
        const selection = rectangularSelection?.text || term.getSelection() || contextMenuSelection;
        contextMenuSelection = "";
        if (!selection) {
          clearContextCopyBridge();
          return;
        }
        prepareContextCopyBridge(selection);
      };
      term.element?.addEventListener("contextmenu", contextMenuListener, { capture: true });
      copyListener = (event) => {
        const selection = rectangularSelection?.text || term.getSelection();
        if (!selection) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (event.clipboardData) {
          event.clipboardData.setData("text/plain", selection);
        } else {
          void navigator.clipboard?.writeText(selection);
        }
      };
      pasteListener = (event) => {
        const image = event.clipboardData ? imagesFromClipboard(event.clipboardData)[0] : undefined;
        if (image) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          const captured = { paneId: pane.id, inputEpoch: ++inputEpochRef.current };
          void api.stagePanePasteImage(pane.id, image).then(async (staged) => {
            const canApply = canApplyStagedPasteImage(captured, {
              paneId: pane.id,
              inputEpoch: inputEpochRef.current,
              mounted: !cancelled && terminalRef.current === term && Boolean(containerRef.current?.isConnected),
              active: activeRef.current,
              visible: document.visibilityState === "visible",
              connected: connectedRef.current && socketRef.current?.readyState === WebSocket.OPEN,
            });
            if (!canApply) {
              await api.discardPanePasteImage(pane.id, staged.stageId).catch(() => undefined);
              if (!cancelled) setConnectionIssue("Image paste discarded because the active pane changed.");
              return;
            }
            let quotedPath: string;
            try {
              quotedPath = quoteStagedImagePath(staged.targetPath);
            } catch {
              await api.discardPanePasteImage(pane.id, staged.stageId).catch(() => undefined);
              if (!cancelled) setConnectionIssue("Image paste failed: invalid staged path.");
              return;
            }
            try {
              if (term.getViewportY() > 0) term.scrollToBottom();
              rectangularSelection?.clear();
              term.clearSelection();
              term.paste(quotedPath);
            } catch {
              await api.discardPanePasteImage(pane.id, staged.stageId).catch(() => undefined);
              if (!cancelled) setConnectionIssue("Image paste failed while applying the staged path.");
            }
          }).catch((error: unknown) => {
            if (cancelled) return;
            const code = error instanceof Error ? error.message : "paste_image_stage_failed";
            const detail = code === "paste_image_target_unsupported"
              ? "this pane target does not support image paste"
              : code === "paste_image_pane_not_live"
                ? "the pane is not connected"
                : code === "paste_image_input_changed"
                  ? "pane input changed while the image was staging"
                  : code === "paste_image_unsupported_type"
                    ? "the clipboard image type is not supported"
                    : "staging failed";
            setConnectionIssue(`Image paste failed: ${detail}.`);
          });
          return;
        }
        const text = event.clipboardData?.getData("text/plain") || event.clipboardData?.getData("text") || "";
        if (!text) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (term.getViewportY() > 0) term.scrollToBottom();
        rectangularSelection?.clear();
        term.clearSelection();
        term.paste(text);
      };
      term.element?.addEventListener("copy", copyListener, { capture: true });
      term.element?.addEventListener("paste", pasteListener, { capture: true });
      windowFocusListener = announceResizeStateSoon;
      windowBlurListener = announceResizeState;
      pageShowListener = announceResizeStateSoon;
      visibilityChangeListener = () => {
        if (document.visibilityState === "visible") announceResizeStateSoon();
        else announceResizeState();
      };
      window.addEventListener("focus", windowFocusListener);
      window.addEventListener("blur", windowBlurListener);
      window.addEventListener("pageshow", pageShowListener);
      document.addEventListener("visibilitychange", visibilityChangeListener);

      term.attachCustomKeyEventHandler((event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          event.code === "KeyC" &&
          (rectangularSelection?.text || term.hasSelection())
        ) {
          const selection = rectangularSelection?.text;
          if (selection) copyRectangularSelection(term, selection);
          else term.copySelection();
          return true;
        }
        if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
          if (event.key === "ArrowLeft") {
            rectangularSelection?.clear();
            inputEpochRef.current += 1;
            sendInput(socketRef.current, "\x1bb");
            return true;
          }
          if (event.key === "ArrowRight") {
            rectangularSelection?.clear();
            inputEpochRef.current += 1;
            sendInput(socketRef.current, "\x1bf");
            return true;
          }
        }
        return false;
      });
      term.attachCustomWheelEventHandler((event) => {
        if (!event.shiftKey && hasMouseTracking(term)) {
          const sequence = mouseWheelSequence(event, term);
          if (sequence) {
            inputEpochRef.current += 1;
            sendInput(socketRef.current, sequence);
          }
          return true;
        }
        const lines = wheelLines(event, term);
        if (lines !== 0) term.scrollLines(lines);
        return true;
      });

      term.onData((data) => {
        const terminalResponse = isTerminalProtocolResponse(data);
        if (!terminalResponse) inputEpochRef.current += 1;
        if (!terminalResponse) rectangularSelection?.clear();
        if (awaitingRestart && !terminalResponse) {
          awaitingRestart = false;
          term.write("\r\n[wmux] restarting…\r\n");
          socketController?.reconnect("Restarting pane");
          return;
        }
        if (inputMayLeaveShellPrompt(data)) shellCursorPlacementRef.current = false;
        if (term.getViewportY() > 0) term.scrollToBottom();
        if (terminalResponse && replayingTerminalOutput) return;
        sendInput(socketRef.current, data, terminalResponse);
      });
      term.onResize(() => {
        rectangularSelection?.clear();
        const ws = socketRef.current;
        if (ws?.readyState === WebSocket.OPEN) {
          sendResizeMessage(ws, "resize", term, foreground());
        }
      });
      socketController = createSocketController(term);
      reconnectRef.current = () => {
        awaitingRestart = false;
        socketController?.reconnect();
      };
      socketController.start();
    };
    void start();

    return () => {
      cancelled = true;
      rectangularSelection?.dispose();
      rectangularSelectionRef.current = null;
      socketController?.dispose();
      if (replayDrainTimer !== undefined) window.clearTimeout(replayDrainTimer);
      scrollDisposable?.dispose();
      renderDisposable?.dispose();
      bufferDisposable?.dispose();
      if (terminalOutputTimer !== undefined) window.clearTimeout(terminalOutputTimer);
      if (osc52PendingTimer !== undefined) window.clearTimeout(osc52PendingTimer);
      if (selectionRestoreTimer !== undefined) window.clearTimeout(selectionRestoreTimer);
      clearContextCopyBridge();
      if (mouseDownListener) terminalRef.current?.element?.removeEventListener("mousedown", mouseDownListener, { capture: true });
      if (mouseUpListener) terminalRef.current?.element?.removeEventListener("mouseup", mouseUpListener, { capture: true });
      if (mouseShieldDownListener) terminalRef.current?.renderer?.getCanvas().removeEventListener("mousedown", mouseShieldDownListener);
      if (mouseShieldMoveListener) terminalRef.current?.renderer?.getCanvas().removeEventListener("mousemove", mouseShieldMoveListener);
      if (mouseGestureEndListener) document.removeEventListener("mouseup", mouseGestureEndListener);
      if (contextMenuListener) terminalRef.current?.element?.removeEventListener("contextmenu", contextMenuListener, { capture: true });
      if (copyListener) terminalRef.current?.element?.removeEventListener("copy", copyListener, { capture: true });
      if (pasteListener) terminalRef.current?.element?.removeEventListener("paste", pasteListener, { capture: true });
      if (windowFocusListener) window.removeEventListener("focus", windowFocusListener);
      if (windowBlurListener) window.removeEventListener("blur", windowBlurListener);
      if (pageShowListener) window.removeEventListener("pageshow", pageShowListener);
      if (visibilityChangeListener) document.removeEventListener("visibilitychange", visibilityChangeListener);
      resetSynchronizedOutput(synchronizedOutputRef.current);
      fitAddon?.dispose();
      terminalRef.current?.dispose();
      socketRef.current = null;
      terminalRef.current = null;
      connectedRef.current = false;
      fitAddonRef.current = null;
      reconnectRef.current = null;
      pendingOsc52Ref.current = undefined;
    };
  }, [pane.id]);

  useEffect(() => {
    const term = terminalRef.current;
    if (!active || !term) return;
    requestAnimationFrame(() => {
      if (focusSignal > 0) term.focus();
      fitAddonRef.current?.fit();
      sendResizeMessage(socketRef.current, "activate", term, isForegroundTerminal(activeRef.current));
    });
  }, [active, focusSignal]);

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
    inputEpochRef.current += 1;
    sendInput(socketRef.current, `${lastRun.command}\r`);
  };
  const copyLastCommand = () => {
    if (!lastRun?.command || !navigator.clipboard) return;
    void navigator.clipboard.writeText(lastRun.command);
  };
  const copyPendingOsc52 = () => {
    const request = pendingOsc52Ref.current;
    if (!request || request.expiresAt < Date.now()) {
      pendingOsc52Ref.current = undefined;
      setHasPendingOsc52(false);
      return;
    }
    void writeBrowserClipboard(request.text).then(() => {
      if (pendingOsc52Ref.current?.generation === request.generation) {
        pendingOsc52Ref.current = undefined;
        setHasPendingOsc52(false);
      }
    });
  };
  const paneMachineLabel = currentMachine?.name ?? pane.machineId;
  const paneRun = lastRun
    ? {
        status: lastRun.status,
        label: runLabel(lastRun),
        title: runTitle(lastRun),
      }
    : undefined;

  return (
    <section
      className={`terminal-pane ${active ? "active" : ""} ${terminalReady ? "terminal-ready" : ""} ${unreadCount > 0 ? "unread" : ""} ${
        visibleMediaItems.length > 0 ? "has-media" : ""
      }`}
      onMouseDown={onActivate}
    >
      <OpenTuiPaneToolbar
        title={pane.title}
        machineLabel={paneMachineLabel}
        connected={connected}
        unreadCount={unreadCount}
        run={paneRun}
        canCopyLastCommand={Boolean(lastRun?.command && navigator.clipboard)}
        hasPendingTerminalCopy={hasPendingOsc52}
        canRerunLastCommand={Boolean(connected && lastRun?.command)}
        canSplit={canSplit}
        canReconnect={!connected || pane.status === "exited" || Boolean(connectionIssue)}
        connectionIssue={connectionIssue || undefined}
        onSplit={onSplit}
        onActivate={onActivate}
        onClose={onClose}
        onReconnect={() => reconnectRef.current?.()}
        onCopyLastCommand={copyLastCommand}
        onCopyTerminalRequest={copyPendingOsc52}
        onRerunLastCommand={rerunLastCommand}
      />
      <div
        className="terminal-host-shell"
        onPointerDown={() => {
          onActivate();
          terminalRef.current?.focus();
        }}
      >
        <div ref={containerRef} className="terminal-host" />
        {(() => {
          void rectangleVersion;
          const range = rectangularSelectionRef.current?.visibleOverlay;
          if (!range) return null;
          return (
            <div
              className="terminal-rectangle-selection"
              aria-hidden="true"
              style={{
                left: range.start.col * terminalMetrics.width,
                top: range.start.row * terminalMetrics.height,
                width: (range.end.col - range.start.col + 1) * terminalMetrics.width,
                height: (range.end.row - range.start.row + 1) * terminalMetrics.height,
              }}
            />
          );
        })()}
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
});

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
