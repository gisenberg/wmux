import { memo, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { Terminal } from "ghostty-web";
import { X } from "lucide-react";
import {
  TerminalGraphicsParser,
  kittyErrorResponse,
  normalizeKittyTransfer,
  type KittyGraphicsTransfer,
  type TerminalGraphicsDiagnostic,
} from "./kitty-graphics";
import { ensureWmuxFonts, terminalFontFamilyStack } from "./fonts";
import { ensureGhostty } from "./terminal-loader";
import { configureTerminalInput } from "./terminal-input";
import {
  canApplyMobileClipboardRead,
  mobileTerminalArrowSequence,
  mobileTerminalKeySequences,
  oneShotControlSequence,
  type MobileTerminalArrow,
} from "./mobile-terminal-keys";
import { isTerminalProtocolResponse } from "../../shared/terminal-protocol";
import { OpenTuiPaneToolbar } from "./OpenTuiPaneToolbar";
import { MobilePasteDialog } from "./MobilePasteDialog";
import { writeBrowserClipboard } from "./clipboard";
import { api } from "./api";
import { canApplyStagedPasteImage, imagesFromClipboard, quoteStagedImagePath } from "./clipboard-images";
import { Osc52ClipboardController } from "./terminal-osc52";
import { OscColorQueryParser } from "../../shared/terminal-color-queries";
import { RectangularSelection } from "./terminal-rectangular-selection";
import {
  createTerminalPredictionEchoProbe,
  extendTerminalPredictionEchoProbe,
  layoutPredictedTerminalInput,
  predictedTerminalInput,
  terminalPredictionCursorMatches,
  terminalPredictionCellPaint,
  terminalPredictionStyleAtCursor,
  terminalPredictionEchoProbeMatches,
  type PredictedTerminalInput,
  type TerminalPredictionEchoProbe,
  type TerminalPredictionScreen,
} from "./terminal-input-prediction";
import { TerminalPredictionRenderer } from "./terminal-prediction-renderer";
import { terminalRendererDevicePixelRatio } from "./terminal-render-scale";
import {
  classifyTerminalLatencyInput,
  normalizeDomEventTimestamp,
  terminalLatency,
} from "./terminal-latency";
import { useColorScheme } from "./color-scheme-context";
import { PaneSocketController } from "./pane-socket";
import { compileKeybindings, eventMatchesAction, type CompiledKeybindingMap } from "../../shared/keybindings";
import {
  type CellMetrics,
  type SynchronizedOutputState,
  type TerminalFitter,
  safeCols,
  safeRows,
  sendInput,
  createTerminalFitter,
  sendResizeDimensions,
  isForegroundTerminal,
  inputMayLeaveShellPrompt,
  MAX_SYNCHRONIZED_OUTPUT_HOLD_MS,
  TERMINAL_OUTPUT_BATCH_MS,
  REPLAY_CHUNK_CHARS,
  CONTEXT_COPY_BRIDGE_TIMEOUT_MS,
  OSC52_PENDING_MS,
  createSynchronizedOutputState,
  createAlternateScreenState,
  resetAlternateScreenState,
  resetSynchronizedOutput,
  drainSynchronizedOutput,
  pushSynchronizedOutput,
  pushAlternateScreenState,
  terminalOutputDelay,
  stripWmuxControlSequences,
  terminalSelectionManager,
  readTerminalSelectionPosition,
  restoreTerminalSelection,
  shellCursorPlacementSequence,
  wheelLines,
  createWheelScrollCoalescer,
  createTouchScrollGesture,
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
  createDurableRefreshRevealGate,
  shouldWaitForDurableRefresh,
  shouldShieldTerminalBeforeResume,
  type DurableRefreshRevealGate,
} from "./terminal-pane-runtime";
import type {
  MachineStatus,
  KeybindingMap,
  PaneState,
  SplitDirection,
  TerminalMedia,
  TerminalRun,
  TerminalScrollMode,
} from "./types";

export interface TerminalPaneProps {
  pane: PaneState;
  active: boolean;
  tabVisible: boolean;
  inactiveTabStreaming: "suspend" | "live";
  tuiFrameRate: 15 | 30 | 60;
  terminalScrollMode: TerminalScrollMode;
  keybindings: KeybindingMap;
  appleKeybindings: boolean;
  unreadCount: number;
  machines: MachineStatus[];
  terminalFontFamily: string;
  terminalFontSize: number;
  terminalScrollbackRows: number;
  mediaItems: TerminalMedia[];
  lastRun?: TerminalRun;
  pendingLabel?: string;
  focusSignal?: number;
  onActivate: () => void;
  onSplit: (direction: SplitDirection, machineId?: string) => void;
  onClose: () => void;
  onBell: () => void;
  onDismissMedia: (mediaId: string) => void;
}

// Memoized: with structural sharing in refresh (reconcile.ts) and the stable
// callbacks from LayoutPane, unrelated state events skip this subtree.
export const TerminalPaneRuntime = memo(function TerminalPaneRuntime({
  pane,
  active,
  tabVisible,
  inactiveTabStreaming,
  tuiFrameRate,
  terminalScrollMode,
  keybindings,
  appleKeybindings,
  unreadCount,
  machines,
  terminalFontFamily,
  terminalFontSize,
  terminalScrollbackRows,
  mediaItems,
  lastRun,
  pendingLabel,
  focusSignal = 0,
  onActivate,
  onSplit,
  onClose,
  onBell,
  onDismissMedia,
}: TerminalPaneProps) {
  const colorScheme = useColorScheme();
  const colorSchemeRef = useRef(colorScheme);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalHostShellRef = useRef<HTMLDivElement | null>(null);
  const predictionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const rectangularSelectionRef = useRef<RectangularSelection | null>(null);
  const fitAddonRef = useRef<TerminalFitter | null>(null);
  const reconnectRef = useRef<(() => void) | null>(null);
  const socketControllerRef = useRef<PaneSocketController | null>(null);
  const suspendSocketRef = useRef(inactiveTabStreaming === "suspend" && !tabVisible);
  const discardPendingOutputRef = useRef<(() => void) | null>(null);
  const invalidatePredictionRef = useRef<(() => void) | null>(null);
  const tuiFrameRateRef = useRef(tuiFrameRate);
  const terminalScrollModeRef = useRef(terminalScrollMode);
  const keybindingsRef = useRef<CompiledKeybindingMap>(compileKeybindings(keybindings));
  const appleKeybindingsRef = useRef(appleKeybindings);
  const outputCarryRef = useRef("");
  const osc52ControllerRef = useRef<Osc52ClipboardController | null>(null);
  const [hasPendingOsc52, setHasPendingOsc52] = useState(false);
  const graphicsParserRef = useRef(new TerminalGraphicsParser());
  const wmuxControlCarryRef = useRef("");
  const synchronizedOutputRef = useRef<SynchronizedOutputState>(createSynchronizedOutputState());
  const shellCursorPlacementRef = useRef(false);
  const onActivateRef = useRef(onActivate);
  const activeRef = useRef(active);
  const focusSignalRef = useRef(focusSignal);
  const appliedFocusSignalRef = useRef(0);
  const connectedRef = useRef(false);
  const inputEpochRef = useRef(0);
  const terminalInputRef = useRef<(data: string) => void>(() => undefined);
  const mobileControlArmedRef = useRef(false);
  const [connected, setConnected] = useState(false);
  const [connectionIssue, setConnectionIssue] = useState("");
  const [startupLabel, setStartupLabel] = useState("Connecting to terminal…");
  const [graphicsDiagnostic, setGraphicsDiagnostic] = useState<TerminalGraphicsDiagnostic | null>(null);
  const [terminalMetrics, setTerminalMetrics] = useState<CellMetrics>({ width: 8, height: 16 });
  const [terminalReady, setTerminalReady] = useState(false);
  const [rectangleVersion, setRectangleVersion] = useState(0);
  const [mobileControlArmed, setMobileControlArmed] = useState(false);
  const [mobilePasteFallback, setMobilePasteFallback] = useState<string | null>(null);
  const [mobilePasteReading, setMobilePasteReading] = useState(false);
  const visibleMediaItems = mediaItems;

  useEffect(() => {
    colorSchemeRef.current = colorScheme;
  }, [colorScheme]);

  useEffect(() => {
    onActivateRef.current = onActivate;
  }, [onActivate]);

  useEffect(() => {
    tuiFrameRateRef.current = tuiFrameRate;
  }, [tuiFrameRate]);

  useEffect(() => {
    terminalScrollModeRef.current = terminalScrollMode;
  }, [terminalScrollMode]);

  useEffect(() => {
    keybindingsRef.current = compileKeybindings(keybindings);
    appleKeybindingsRef.current = appleKeybindings;
  }, [appleKeybindings, keybindings]);

  useEffect(() => {
    if (activeRef.current !== active) inputEpochRef.current += 1;
    activeRef.current = active;
    if (!active) {
      mobileControlArmedRef.current = false;
      setMobileControlArmed(false);
    }
  }, [active]);

  useEffect(() => {
    mobileControlArmedRef.current = false;
    setMobileControlArmed(false);
  }, [pane.id]);

  useLayoutEffect(() => {
    if (shouldShieldTerminalBeforeResume(inactiveTabStreaming, tabVisible, suspendSocketRef.current)) {
      setTerminalReady(false);
    }
  }, [inactiveTabStreaming, tabVisible]);

  useEffect(() => {
    const shouldSuspend = inactiveTabStreaming === "suspend" && !tabVisible;
    const wasSuspended = suspendSocketRef.current;
    suspendSocketRef.current = shouldSuspend;
    if (shouldSuspend) {
      socketControllerRef.current?.pause();
      if (!wasSuspended) discardPendingOutputRef.current?.();
    }
    else socketControllerRef.current?.resume();
  }, [inactiveTabStreaming, tabVisible]);

  useEffect(() => {
    focusSignalRef.current = focusSignal;
  }, [focusSignal]);

  useEffect(() => {
    let cancelled = false;
    let removed = false;
    let fitAddon: TerminalFitter | null = null;
    let socketController: PaneSocketController | undefined;
    let renderDisposable: { dispose: () => void } | undefined;
    if (pendingLabel) {
      setTerminalReady(false);
      setConnected(false);
      return;
    }
    setStartupLabel("Connecting to terminal…");
    let bufferDisposable: { dispose: () => void } | undefined;
    let mouseDownListener: ((event: MouseEvent) => void) | undefined;
    let mouseUpListener: ((event: MouseEvent) => void) | undefined;
    let mouseShieldDownListener: ((event: MouseEvent) => void) | undefined;
    let mouseShieldMoveListener: ((event: MouseEvent) => void) | undefined;
    let mouseHostShieldDownListener: ((event: MouseEvent) => void) | undefined;
    let mouseHostShieldMoveListener: ((event: MouseEvent) => void) | undefined;
    let mouseGestureEndListener: (() => void) | undefined;
    let contextMenuListener: ((event: MouseEvent) => void) | undefined;
    let copyListener: ((event: ClipboardEvent) => void) | undefined;
    let latencyKeyDownListener: ((event: KeyboardEvent) => void) | undefined;
    let terminalBlurListener: (() => void) | undefined;
    let pasteKeyListener: ((event: KeyboardEvent) => void) | undefined;
    let pasteListener: ((event: ClipboardEvent) => void) | undefined;
    let windowFocusListener: (() => void) | undefined;
    let windowBlurListener: (() => void) | undefined;
    let pageShowListener: (() => void) | undefined;
    let visibilityChangeListener: (() => void) | undefined;
    let fontLoadingDoneListener: (() => void) | undefined;
    let rectangularSelection: RectangularSelection | undefined;
    let contextMenuSelection = "";
    let pendingCursorPlacement: { sequence: string; x: number; y: number } | null = null;
    let browserPrimaryMouseGesture = false;
    let contextCopyBridge: HTMLTextAreaElement | undefined;
    let contextCopyBridgeTimer: number | undefined;
    let selectionRestoreTimer: number | undefined;
    let removeContextCopyBridgeDismissListeners: (() => void) | undefined;
    let terminalOutputTimer: number | undefined;
    let predictionExpiryTimer: number | undefined;
    let predictionProbeTimer: number | undefined;
    let predictionProbeVerificationFrame: number | undefined;
    let predictionRenderer: TerminalPredictionRenderer | undefined;
    let predictionAcknowledgedSequence: number | undefined;
    let clearPredictionsAfterRender = false;
    let rendererDevicePixelRatio = 1;
    let predictionMetricsStale = true;
    let deviceScaleQuery: MediaQueryList | undefined;
    let deviceScaleQueryListener: (() => void) | undefined;
    let windowScaleListener: (() => void) | undefined;
    let viewportFitFrame: number | undefined;
    let viewportFitTimer: number | undefined;
    let queuedTerminalOutput = "";
    const alternateScreenState = createAlternateScreenState();
    let lastTerminalOutputAt = 0;
    let lastInteractiveInputAt = Number.NEGATIVE_INFINITY;
    let nextInputSequence = 0;
    let predictedInputs: PredictedTerminalInput[] = [];
    let predictionArmedScreen: TerminalPredictionScreen | undefined;
    // Full-screen applications can repaint asynchronously and move the real
    // cursor into a footer or status row. Prediction is safe only at the exact
    // cursor position whose authoritative echo was verified.
    let predictionArmedCursor: { x: number; y: number } | undefined;
    let predictionProbe: TerminalPredictionEchoProbe | undefined;
    let predictionProbeAcknowledgedSequence: number | undefined;
    let pendingLatencyKeyEvent: { eventAt: number; observedAt: number } | undefined;
    let replayChunks: string[] = [];
    let replayBufferedOutput: string[] = [];
    let replayDrainTimer: number | undefined;
    let replayingTerminalOutput = false;
    let outputGeneration = 0;
    let graphicsOutputChain = Promise.resolve();
    let pendingGraphicsWork = 0;
    let revealGeneration = 0;
    let durableRefreshRevealGate: DurableRefreshRevealGate | undefined;
    let wheelScroll: ReturnType<typeof createWheelScrollCoalescer> | undefined;
    const touchScroll = createTouchScrollGesture();
    let touchPointerMoveListener: ((event: PointerEvent) => void) | undefined;
    let touchPointerUpListener: ((event: PointerEvent) => void) | undefined;
    let touchPointerCancelListener: ((event: PointerEvent) => void) | undefined;
    let touchPointerDownListener: ((event: PointerEvent) => void) | undefined;
    let terminalHostShell: HTMLDivElement | null = null;
    let terminalCanvas: HTMLCanvasElement | undefined;
    // The server preserves a pane whose process died abnormally instead of
    // deleting it, so a keypress here re-attaches (and re-spawns) on demand
    // rather than looping against a down host.
    let awaitingRestart = false;
    const colorQueryParser = new OscColorQueryParser();
    graphicsParserRef.current = new TerminalGraphicsParser();
    wmuxControlCarryRef.current = "";
    resetSynchronizedOutput(synchronizedOutputRef.current);
    shellCursorPlacementRef.current = false;
    const osc52Controller = new Osc52ClipboardController({
      pendingMs: OSC52_PENDING_MS,
      isImmediateWriteAllowed: () =>
        isForegroundTerminal(activeRef.current) && Boolean(navigator.userActivation?.isActive),
      writeClipboard: writeBrowserClipboard,
      onPendingChange: setHasPendingOsc52,
    });
    osc52ControllerRef.current = osc52Controller;
    setGraphicsDiagnostic(null);

    const refreshMetrics = (term: Terminal) => {
      const metrics = readCellMetrics(term);
      if (!metrics) return;
      setTerminalMetrics((previous) =>
        previous.width === metrics.width && previous.height === metrics.height ? previous : metrics,
      );
    };

    const clearPredictionLayer = () => {
      predictionRenderer?.clear();
    };

    const clearPredictions = () => {
      predictedInputs = [];
      predictionAcknowledgedSequence = undefined;
      clearPredictionsAfterRender = false;
      if (predictionExpiryTimer !== undefined) window.clearTimeout(predictionExpiryTimer);
      predictionExpiryTimer = undefined;
      clearPredictionLayer();
    };

    const clearPredictionProbe = () => {
      predictionProbe = undefined;
      predictionProbeAcknowledgedSequence = undefined;
      if (predictionProbeTimer !== undefined) window.clearTimeout(predictionProbeTimer);
      predictionProbeTimer = undefined;
      if (predictionProbeVerificationFrame !== undefined) {
        window.cancelAnimationFrame(predictionProbeVerificationFrame);
      }
      predictionProbeVerificationFrame = undefined;
    };

    const disarmPrediction = () => {
      predictionArmedScreen = undefined;
      predictionArmedCursor = undefined;
      if (predictionCanvasRef.current) {
        delete predictionCanvasRef.current.dataset.armedScreen;
        delete predictionCanvasRef.current.dataset.armedCursor;
      }
      clearPredictionProbe();
      clearPredictions();
    };
    invalidatePredictionRef.current = disarmPrediction;

    const predictionScreen = (term: Terminal): TerminalPredictionScreen =>
      term.wasmTerm?.isAlternateScreen() ? "alternate" : "normal";

    const terminalCodepoint = (term: Terminal, col: number, row: number): number | undefined =>
      term.wasmTerm?.getLine(row)?.[col]?.codepoint;

    const schedulePredictionProbeExpiry = () => {
      if (predictionProbeTimer !== undefined) window.clearTimeout(predictionProbeTimer);
      predictionProbeTimer = window.setTimeout(clearPredictionProbe, 1000);
    };

    const probePredictionEcho = (
      prediction: PredictedTerminalInput,
      term: Terminal,
      screen: TerminalPredictionScreen,
    ) => {
      const cols = safeCols(term.cols);
      const rows = safeRows(term.rows);
      if (predictionProbe?.screen === screen) {
        const extended = extendTerminalPredictionEchoProbe(predictionProbe, prediction, cols, rows);
        if (extended) {
          predictionProbe = extended;
          schedulePredictionProbeExpiry();
        }
        return;
      }
      clearPredictionProbe();
      const cursor = term.wasmTerm?.getCursor();
      if (!cursor) return;
      predictionProbe = createTerminalPredictionEchoProbe(
        prediction,
        cursor,
        cols,
        rows,
        screen,
        terminalCodepoint(term, cursor.x, cursor.y),
      ) ?? undefined;
      if (predictionProbe) schedulePredictionProbeExpiry();
    };

    const acknowledgePredictionProbe = (sequence: number | undefined) => {
      if (!predictionProbe || sequence === undefined || sequence < predictionProbe.inputs[0]!.sequence) return;
      predictionProbeAcknowledgedSequence = Math.max(predictionProbeAcknowledgedSequence ?? 0, sequence);
    };

    const schedulePredictionProbeVerification = (term: Terminal) => {
      if (predictionProbeVerificationFrame !== undefined) return;
      predictionProbeVerificationFrame = window.requestAnimationFrame(() => {
        predictionProbeVerificationFrame = undefined;
        verifyPredictionProbe(term);
      });
    };

    function verifyPredictionProbe(term: Terminal): void {
      const probe = predictionProbe;
      const cursor = term.wasmTerm?.getCursor();
      if (!probe || !cursor || predictionProbeAcknowledgedSequence === undefined) return;
      const screen = predictionScreen(term);
      if (!terminalPredictionEchoProbeMatches(
        probe,
        predictionProbeAcknowledgedSequence,
        cursor,
        safeCols(term.cols),
        safeRows(term.rows),
        screen,
        (col, row) => terminalCodepoint(term, col, row),
      )) {
        schedulePredictionProbeVerification(term);
        return;
      }
      predictionArmedScreen = screen;
      predictionArmedCursor = { x: cursor.x, y: cursor.y };
      if (predictionCanvasRef.current) {
        predictionCanvasRef.current.dataset.armedScreen = screen;
        predictionCanvasRef.current.dataset.armedCursor = JSON.stringify(predictionArmedCursor);
      }
      clearPredictionProbe();
    }

    const schedulePredictionExpiry = () => {
      if (predictionExpiryTimer !== undefined) window.clearTimeout(predictionExpiryTimer);
      predictionExpiryTimer = window.setTimeout(
        clearPredictions,
        predictionAcknowledgedSequence === undefined ? 1000 : 2000,
      );
    };

    const renderPredictions = (term: Terminal) => {
      const renderer = predictionRenderer;
      const metrics = term.renderer?.getMetrics();
      const cursor = term.wasmTerm?.getCursor();
      const anchor = predictionArmedCursor;
      const currentDevicePixelRatio = terminalRendererDevicePixelRatio(window.devicePixelRatio);
      if (
        !renderer
        || !metrics
        || !cursor
        || !anchor
        || !terminalPredictionCursorMatches(cursor, anchor)
        || predictionMetricsStale
        || currentDevicePixelRatio !== rendererDevicePixelRatio
        || predictionArmedScreen !== predictionScreen(term)
        || replayingTerminalOutput
        || term.getViewportY() > 0
      ) {
        disarmPrediction();
        return;
      }
      const layout = layoutPredictedTerminalInput(
        { ...anchor, visible: true },
        safeCols(term.cols),
        safeRows(term.rows),
        predictedInputs,
      );
      if (!layout) {
        disarmPrediction();
        return;
      }

      const cols = safeCols(term.cols);
      const viewport = term.wasmTerm?.getViewport();
      if (!viewport) {
        disarmPrediction();
        return;
      }
      const cellAt = (col: number, row: number) => viewport[row * cols + col];
      const predictionStyle = terminalPredictionStyleAtCursor(
        viewport,
        cols,
        anchor,
        (row) => term.wasmTerm?.isRowWrapped(row) ?? false,
      );
      const authoritativeCanvas = term.renderer?.getCanvas();
      if (!authoritativeCanvas || !renderer.paint({
        metrics,
        devicePixelRatio: rendererDevicePixelRatio,
        cols,
        rows: safeRows(term.rows),
        fontSize: term.options.fontSize,
        fontFamily: term.options.fontFamily,
        theme: colorSchemeRef.current.terminal,
        layout,
        style: predictionStyle,
        cellAt,
        cellPaint: terminalPredictionCellPaint,
        cursorStyle: cursor.style ?? term.options.cursorStyle ?? "block",
        authoritativeCanvas,
      })) {
        disarmPrediction();
      }
    };

    const acknowledgePredictions = (sequence: number | undefined) => {
      if (sequence === undefined || predictedInputs.length === 0) return;
      predictionAcknowledgedSequence = Math.max(predictionAcknowledgedSequence ?? 0, sequence);
      if (predictionExpiryTimer !== undefined) window.clearTimeout(predictionExpiryTimer);
      predictionExpiryTimer = window.setTimeout(disarmPrediction, 2000);
    };

    const settlePredictionsAfterRender = (term: Terminal) => {
      if (clearPredictionsAfterRender) {
        disarmPrediction();
        return;
      }
      if (predictionAcknowledgedSequence !== undefined) {
        const acknowledgedSequence = predictionAcknowledgedSequence;
        predictionAcknowledgedSequence = undefined;
        const acknowledged = predictedInputs.filter((prediction) => prediction.sequence <= acknowledgedSequence);
        const anchor = predictionArmedCursor;
        const cursor = term.wasmTerm?.getCursor();
        if (acknowledged.length > 0) {
          const acknowledgedLayout = anchor
            ? layoutPredictedTerminalInput(
              { ...anchor, visible: true },
              safeCols(term.cols),
              safeRows(term.rows),
              acknowledged,
            )
            : null;
          const nextAnchor = acknowledgedLayout
            ? { x: acknowledgedLayout.cursor.col, y: acknowledgedLayout.cursor.row }
            : undefined;
          if (!nextAnchor || !terminalPredictionCursorMatches(cursor, nextAnchor)) {
            disarmPrediction();
            return;
          }
          predictionArmedCursor = nextAnchor;
          if (predictionCanvasRef.current) {
            predictionCanvasRef.current.dataset.armedCursor = JSON.stringify(nextAnchor);
          }
        }
        predictedInputs = predictedInputs.filter((prediction) => prediction.sequence > acknowledgedSequence);
        if (predictedInputs.length === 0) {
          clearPredictions();
          return;
        }
      }
      if (predictedInputs.length > 0) renderPredictions(term);
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

    const writeTerminalTextNow = (term: Terminal, text: string) => {
      if (!text) return;
      terminalLatency.recordWrite(pane.id, performance.now());
      writeTerminalOutput(
        term,
        outputCarryRef,
        text,
        (privateMode) => {
          if (!replayingTerminalOutput) sendInput(socketRef.current, cursorPositionResponse(term, privateMode), true);
        },
      );
      if (
        predictedInputs.length > 0
        && predictionAcknowledgedSequence === undefined
        && !clearPredictionsAfterRender
      ) {
        renderPredictions(term);
      }
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
      // Let the first full-screen frame after an idle prompt appear promptly;
      // sustained redraw remains capped at the configured cadence.
      const now = Date.now();
      const delay = terminalOutputDelay(
        alternateScreenState.active,
        tuiFrameRateRef.current,
        lastTerminalOutputAt,
        now,
        lastInteractiveInputAt,
      );
      lastTerminalOutputAt = now;
      if (delay === 0) {
        flushQueuedTerminalText(term);
        return;
      }
      terminalOutputTimer = window.setTimeout(() => flushQueuedTerminalText(term), delay);
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
      pushAlternateScreenState(alternateScreenState, text);
      const chunks = pushSynchronizedOutput(synchronizedOutputRef.current, text);
      for (const chunk of chunks) queueTerminalText(term, chunk);
      scheduleSynchronizedOutputFlush(term);
    };

    const showGraphicsDiagnostic = (diagnostic: TerminalGraphicsDiagnostic) => {
      if (!cancelled) setGraphicsDiagnostic(diagnostic);
    };

    const enqueueGraphicsWork = (work: () => Promise<void> | void) => {
      pendingGraphicsWork += 1;
      graphicsOutputChain = graphicsOutputChain
        .then(work)
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "terminal graphics processing failed";
          showGraphicsDiagnostic({ protocol: "kitty", message });
        })
        .finally(() => {
          pendingGraphicsWork -= 1;
        });
    };

    const handleOrderedTerminalText = (term: Terminal, text: string) => {
      const generation = outputGeneration;
      const stripped = stripWmuxControlSequences(wmuxControlCarryRef, text, (control) => {
        if (control === "cursor=1") shellCursorPlacementRef.current = true;
        if (control === "cursor=0") shellCursorPlacementRef.current = false;
      });
      if (!stripped) return;
      if (pendingGraphicsWork > 0) {
        enqueueGraphicsWork(() => {
          if (!cancelled && generation === outputGeneration) handleTerminalText(term, stripped);
        });
      } else {
        handleTerminalText(term, stripped);
      }
    };

    const handleKittyTransfer = (term: Terminal, transfer: KittyGraphicsTransfer) => {
      const generation = outputGeneration;
      const displayOnly = replayingTerminalOutput;
      flushQueuedTerminalText(term);
      enqueueGraphicsWork(async () => {
        try {
          const normalized = await normalizeKittyTransfer(
            transfer,
            (request) => api.readKittyGraphicsSource(pane.id, request),
          );
          if (cancelled || removed || generation !== outputGeneration) return;
          handleTerminalText(term, normalized);
        } catch (error) {
          if (cancelled || removed || generation !== outputGeneration) return;
          const message = error instanceof Error ? error.message : "Kitty graphics processing failed";
          showGraphicsDiagnostic({ protocol: "kitty", message });
          const response = kittyErrorResponse(transfer, message);
          if (response && !displayOnly) sendInput(socketRef.current, response, true);
        }
      });
    };

    const handleOutput = (term: Terminal, data: string) => {
      // The server owns color replies. The browser still identifies query BEL
      // terminators so they do not become audible notification bells.
      const colorQueries = colorQueryParser.push(data, colorSchemeRef.current.terminal);
      const osc52 = osc52Controller.push(data, !replayingTerminalOutput);
      const bellCount = osc52.text.split("\x07").length - 1;
      if (bellCount > colorQueries.bellTerminators) onBell();
      const events = graphicsParserRef.current.push(osc52.text);
      for (const event of events) {
        if (event.kind === "text") {
          handleOrderedTerminalText(term, event.text);
        }
        if (event.kind === "kitty") {
          handleKittyTransfer(term, event.transfer);
        }
        if (event.kind === "diagnostic") {
          showGraphicsDiagnostic(event.diagnostic);
        }
      }
    };

    // Large reconnect replays (up to 2 MiB) are parsed and written in chunks
    // across macrotasks so the main thread never blocks on one giant write.
    // Live output arriving mid-drain is buffered to preserve ordering.
    const replayDraining = () => replayChunks.length > 0 || replayDrainTimer !== undefined;

    const revealTerminal = (flushPendingWrite = false) => {
      const generation = revealGeneration;
      if (pendingGraphicsWork > 0) {
        void graphicsOutputChain.then(() => {
          if (!cancelled && generation === revealGeneration) revealTerminal(true);
        });
        return;
      }
      requestAnimationFrame(() => {
        if (cancelled || generation !== revealGeneration) return;
        const term = terminalRef.current;
        if (flushPendingWrite && term) flushQueuedTerminalText(term);
        setTerminalReady(true);
      });
    };

    const cancelPendingReveal = () => {
      revealGeneration += 1;
      durableRefreshRevealGate?.cancel();
    };

    durableRefreshRevealGate = createDurableRefreshRevealGate({
      onReveal: () => revealTerminal(true),
      isReady: () => {
        const synchronized = synchronizedOutputRef.current;
        return !synchronized.active && synchronized.carry === "";
      },
    });

    const resetReplayDrain = () => {
      if (replayDrainTimer !== undefined) {
        window.clearTimeout(replayDrainTimer);
        replayDrainTimer = undefined;
      }
      replayChunks = [];
      replayBufferedOutput = [];
      replayingTerminalOutput = false;
    };

    const resetPendingOutput = () => {
      cancelPendingReveal();
      outputGeneration += 1;
      if (terminalOutputTimer !== undefined) {
        window.clearTimeout(terminalOutputTimer);
        terminalOutputTimer = undefined;
      }
      queuedTerminalOutput = "";
      resetAlternateScreenState(alternateScreenState);
      lastTerminalOutputAt = 0;
      lastInteractiveInputAt = Number.NEGATIVE_INFINITY;
      disarmPrediction();
      resetReplayDrain();
      resetSynchronizedOutput(synchronizedOutputRef.current);
      outputCarryRef.current = "";
      osc52Controller.resetParser();
      colorQueryParser.reset();
      graphicsParserRef.current.reset();
      wmuxControlCarryRef.current = "";
      setGraphicsDiagnostic(null);
    };
    discardPendingOutputRef.current = resetPendingOutput;

    // Replay is display-only. Never let an incomplete replay request borrow a
    // terminator from subsequent live output.
    const finishReplay = () => {
      replayingTerminalOutput = false;
      osc52Controller.resetParser();
      colorQueryParser.reset();
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

    const finishReplayDrainNow = (term: Terminal, reveal = true) => {
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
      if (reveal) revealTerminal();
    };

    const foreground = () => isForegroundTerminal(activeRef.current);
    const proposedDimensions = (term: Terminal) =>
      fitAddonRef.current?.proposedDimensions() ?? { cols: term.cols, rows: term.rows };

    const announceResizeState = () => {
      const term = terminalRef.current;
      if (!term) return;
      const isForeground = foreground();
      fitAddonRef.current?.setForeground(isForeground);
      if (activeRef.current && document.visibilityState === "visible") fitAddonRef.current?.fit();
      sendResizeDimensions(
        socketRef.current,
        activeRef.current ? "activate" : "resize",
        proposedDimensions(term),
        isForeground,
      );
    };

    const announceResizeStateSoon = () => requestAnimationFrame(announceResizeState);
    const settleVisualViewportResize = () => {
      if (!activeRef.current) return;
      if (viewportFitFrame !== undefined) window.cancelAnimationFrame(viewportFitFrame);
      viewportFitFrame = window.requestAnimationFrame(() => {
        viewportFitFrame = undefined;
        announceResizeState();
      });
      if (viewportFitTimer !== undefined) window.clearTimeout(viewportFitTimer);
      viewportFitTimer = window.setTimeout(() => {
        viewportFitTimer = undefined;
        announceResizeState();
      }, 160);
    };
    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener("resize", settleVisualViewportResize);
    visualViewport?.addEventListener("scroll", settleVisualViewportResize);
    window.addEventListener("orientationchange", settleVisualViewportResize);

    const createSocketController = (term: Terminal) => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      return new PaneSocketController({
        paneId: pane.id,
        url: () => {
          const size = proposedDimensions(term);
          return `${protocol}//${window.location.host}/ws/panes/${pane.id}?cols=${safeCols(size.cols)}&rows=${safeRows(size.rows)}`;
        },
        onSocketChange: (socket) => {
          socketRef.current = socket;
        },
        onConnectionChange: (nextConnected, issue) => {
          if (cancelled) return;
          if (!nextConnected) cancelPendingReveal();
          if (connectedRef.current !== nextConnected) inputEpochRef.current += 1;
          connectedRef.current = nextConnected;
          setConnected(nextConnected);
          setConnectionIssue(issue);
          if (!nextConnected) {
            disarmPrediction();
            setStartupLabel(issue || "Connecting to terminal…");
          }
        },
        onOpen: (socket) => {
          const isForeground = foreground();
          fitAddonRef.current?.setForeground(isForeground);
          fitAddonRef.current?.fit();
          sendResizeDimensions(
            socket,
            activeRef.current ? "activate" : "resize",
            proposedDimensions(term),
            isForeground,
          );
        },
        onMessage: (message) => {
          if (cancelled) return;
          if (message.type === "starting") {
            setStartupLabel(message.label);
          }
          if (message.type === "ready") {
            fitAddonRef.current?.setAuthoritativeSize(message.cols, message.rows, message.resizeOwner);
            setStartupLabel(message.replay ? "Restoring terminal state…" : "Preparing terminal…");
            setTerminalReady(false);
            resetPendingOutput();
            osc52Controller.clearPending();
            term.clear();
            setGraphicsDiagnostic(null);
            if (message.replay) startReplayDrain(term, message.replay);
            else if (shouldWaitForDurableRefresh(message)) durableRefreshRevealGate?.begin();
            else revealTerminal();
          }
          if (message.type === "size") {
            rectangularSelection?.clear();
            disarmPrediction();
            fitAddonRef.current?.setAuthoritativeSize(message.cols, message.rows, message.resizeOwner);
            refreshMetrics(term);
          }
          if (message.type === "output") {
            terminalLatency.recordOutput(pane.id, message.inputSequence, message.data.length, performance.now());
            acknowledgePredictionProbe(message.inputSequence);
            acknowledgePredictions(message.inputSequence);
            if (predictedInputs.length > 0 && message.inputSequence === undefined) {
              clearPredictionsAfterRender = true;
            }
            if (replayDraining()) replayBufferedOutput.push(message.data);
            else handleOutput(term, message.data);
            durableRefreshRevealGate?.noteOutput();
          }
          if (message.type === "exit") {
            cancelPendingReveal();
            finishReplayDrainNow(term, false);
            flushQueuedTerminalText(term);
            term.write(`\r\n[wmux] process exited with code ${message.code}. Press any key to restart.\r\n`);
            revealTerminal();
            setConnectionIssue(`Process exited with code ${message.code}`);
            awaitingRestart = true;
          }
          if (message.type === "removed") {
            cancelPendingReveal();
            finishReplayDrainNow(term, false);
            flushQueuedTerminalText(term);
            removed = true;
            socketController?.markRemoved();
          }
        },
      });
    };

    const start = async () => {
      await Promise.all([ensureGhostty(), ensureWmuxFonts(terminalFontFamily, terminalFontSize)]);
      if (cancelled || !containerRef.current) return;
      const term = new Terminal({
        cursorBlink: true,
        fontSize: terminalFontSize,
        fontFamily: terminalFontFamilyStack(terminalFontFamily),
        scrollback: terminalScrollbackRows,
        theme: colorScheme.terminal,
      });
      wheelScroll = createWheelScrollCoalescer({
        scrollLines: (lines) => term.scrollLines(lines),
        requestFrame: (callback) => requestAnimationFrame(callback),
        cancelFrame: (frame) => cancelAnimationFrame(frame),
      });
      const touchHostShell = terminalHostShellRef.current;
      terminalHostShell = touchHostShell;
      if (touchHostShell) {
        touchPointerDownListener = (event) => {
          if (event.pointerType !== "touch" || !event.isPrimary) return;
          touchScroll.start(event.pointerId, event.clientX, event.clientY);
          try {
            touchHostShell.setPointerCapture(event.pointerId);
          } catch {
            // Some WebKit versions reject capture during synthesized pointer events.
          }
        };
        touchPointerMoveListener = (event) => {
          if (event.pointerType !== "touch" || !event.isPrimary) return;
          const lineHeight = term.renderer?.getMetrics?.().height ?? 20;
          const gesture = touchScroll.move(event.pointerId, event.clientX, event.clientY, lineHeight);
          if (!gesture.handled) return;
          event.preventDefault();
          if (gesture.lines === 0) return;
          if (hasMouseTracking(term)) {
            const wheelEvent = {
              deltaMode: WheelEvent.DOM_DELTA_LINE,
              deltaY: gesture.lines,
              clientX: event.clientX,
              clientY: event.clientY,
              shiftKey: false,
              altKey: false,
              ctrlKey: false,
            } as WheelEvent;
            const sequence = mouseWheelSequence(wheelEvent, term);
            if (sequence) {
              inputEpochRef.current += 1;
              sendInput(socketRef.current, sequence);
            }
          } else if (terminalScrollModeRef.current === "immediate") {
            term.scrollLines(gesture.lines);
          } else {
            wheelScroll?.push(gesture.lines);
          }
        };
        touchPointerUpListener = (event) => {
          if (event.pointerType !== "touch" || !event.isPrimary) return;
          const gesture = touchScroll.end(event.pointerId);
          if (!gesture.handled) return;
          if (gesture.tap) term.focus();
          try {
            touchHostShell.releasePointerCapture(event.pointerId);
          } catch {
            // Capture may already have been released by the browser.
          }
        };
        touchPointerCancelListener = (event) => {
          if (event.pointerType === "touch" && event.isPrimary) touchScroll.cancel();
        };
        touchHostShell.addEventListener("pointerdown", touchPointerDownListener);
        touchHostShell.addEventListener("pointermove", touchPointerMoveListener, { passive: false });
        touchHostShell.addEventListener("pointerup", touchPointerUpListener);
        touchHostShell.addEventListener("pointercancel", touchPointerCancelListener);
      }
      term.open(containerRef.current);
      rendererDevicePixelRatio = terminalRendererDevicePixelRatio(window.devicePixelRatio);
      term.setDevicePixelRatio(rendererDevicePixelRatio);
      if (predictionCanvasRef.current) {
        predictionRenderer = new TerminalPredictionRenderer(predictionCanvasRef.current);
      }
      configureTerminalInput(term);
      terminalBlurListener = () => {
        mobileControlArmedRef.current = false;
        setMobileControlArmed(false);
      };
      term.textarea?.addEventListener("blur", terminalBlurListener);
      terminalRef.current = term;
      rectangularSelection = new RectangularSelection(
        term,
        () => setRectangleVersion((version) => version + 1),
        (text) => {
          if (text) copyRectangularSelection(term, text);
        },
      );
      rectangularSelectionRef.current = rectangularSelection;
      if (
        activeRef.current &&
        focusSignalRef.current > appliedFocusSignalRef.current
      ) {
        appliedFocusSignalRef.current = focusSignalRef.current;
        requestAnimationFrame(() => term.focus());
      }
      await waitForVisibleBox(containerRef.current);
      fitAddon = createTerminalFitter(term, containerRef.current, (dimensions) => {
        sendResizeDimensions(socketRef.current, "resize", dimensions, foreground());
      });
      fitAddonRef.current = fitAddon;
      fitAddon.setForeground(foreground());
      fitAddon.fit();
      refreshMetrics(term);
      if ("fonts" in document) {
        fontLoadingDoneListener = () => {
          if (cancelled || terminalRef.current !== term || !term.renderer) return;
          disarmPrediction();
          const family = term.options.fontFamily;
          // FontFaceSet completion does not invalidate an existing canvas.
          // A whitespace-only option transition forces Ghostty to remeasure
          // and redraw synchronously without changing the CSS family stack.
          term.options.fontFamily = `${family} `;
          term.options.fontFamily = family;
          fitAddon?.fit();
          refreshMetrics(term);
        };
        document.fonts.addEventListener("loadingdone", fontLoadingDoneListener);
        void document.fonts.ready.then(() => fontLoadingDoneListener?.());
      }
      renderDisposable = term.onRender(() => {
        terminalLatency.recordRender(pane.id, performance.now());
        verifyPredictionProbe(term);
        if (rendererDevicePixelRatio === terminalRendererDevicePixelRatio(window.devicePixelRatio)) {
          predictionMetricsStale = false;
        }
        refreshMetrics(term);
        settlePredictionsAfterRender(term);
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
      terminalCanvas = term.renderer?.getCanvas();
      terminalCanvas?.addEventListener("mousedown", mouseShieldDownListener);
      terminalCanvas?.addEventListener("mousemove", mouseShieldMoveListener);
      mouseHostShieldDownListener = (event) => {
        if (event.target === terminalCanvas) return;
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey) return;
        browserPrimaryMouseGesture = true;
        term.focus();
        // Ghostty listens for mouse reports on the terminal container, not
        // only its canvas. Own gestures that begin on its hidden textarea or
        // unused host space so a tiny drag cannot reach tmux as MouseDrag1Pane.
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      mouseHostShieldMoveListener = (event) => {
        if (!browserPrimaryMouseGesture || event.target === terminalCanvas) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      term.element?.addEventListener("mousedown", mouseHostShieldDownListener, { capture: true });
      term.element?.addEventListener("mousemove", mouseHostShieldMoveListener, { capture: true });
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
      pasteKeyListener = (event) => {
        if (!(event.ctrlKey || event.metaKey) || event.code !== "KeyV") return;
        // Keep Ghostty from forwarding Ctrl+V before the browser dispatches
        // the text/image paste event. Do not prevent the browser default.
        event.stopImmediatePropagation();
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
      term.element?.addEventListener("keydown", pasteKeyListener, { capture: true });
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

      const refreshRendererDeviceScale = () => {
        const nextDevicePixelRatio = terminalRendererDevicePixelRatio(window.devicePixelRatio);
        if (
          nextDevicePixelRatio === rendererDevicePixelRatio
          && !predictionMetricsStale
        ) return;
        predictionMetricsStale = true;
        disarmPrediction();
        rendererDevicePixelRatio = nextDevicePixelRatio;
        term.setDevicePixelRatio(nextDevicePixelRatio);
        fitAddon?.fit();
        refreshMetrics(term);
      };
      const armDeviceScaleQuery = () => {
        if (!window.matchMedia) return;
        if (deviceScaleQuery && deviceScaleQueryListener) {
          deviceScaleQuery.removeEventListener("change", deviceScaleQueryListener);
        }
        deviceScaleQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
        deviceScaleQueryListener = () => {
          refreshRendererDeviceScale();
          armDeviceScaleQuery();
        };
        deviceScaleQuery.addEventListener("change", deviceScaleQueryListener);
      };
      rendererDevicePixelRatio = terminalRendererDevicePixelRatio(window.devicePixelRatio);
      predictionMetricsStale = false;
      windowScaleListener = refreshRendererDeviceScale;
      window.addEventListener("resize", windowScaleListener);
      armDeviceScaleQuery();

      const forwardTerminalData = (rawData: string) => {
        let data = rawData;
        if (mobileControlArmedRef.current) {
          const control = oneShotControlSequence(data);
          mobileControlArmedRef.current = false;
          setMobileControlArmed(false);
          if (control !== undefined) data = control;
        }
        const terminalResponse = isTerminalProtocolResponse(data);
        if (!terminalResponse) refreshRendererDeviceScale();
        if (!terminalResponse) inputEpochRef.current += 1;
        if (!terminalResponse) rectangularSelection?.clear();
        if (awaitingRestart && !terminalResponse) {
          awaitingRestart = false;
          term.write("\r\n[wmux] restarting…\r\n");
          socketController?.reconnect("Restarting pane");
          return;
        }
        let sequence: number | undefined;
        if (!terminalResponse) {
          sequence = ++nextInputSequence;
          const handledAt = performance.now();
          const inputAt = pendingLatencyKeyEvent && handledAt - pendingLatencyKeyEvent.observedAt <= 250
            ? pendingLatencyKeyEvent.eventAt
            : handledAt;
          pendingLatencyKeyEvent = undefined;
          terminalLatency.recordInput(
            pane.id,
            sequence,
            classifyTerminalLatencyInput(data),
            alternateScreenState.active ? "alternate" : "normal",
            inputAt,
            handledAt,
          );
          lastInteractiveInputAt = Date.now();
          const prediction = predictedTerminalInput(sequence, data);
          const screen = predictionScreen(term);
          const cursor = term.wasmTerm?.getCursor();
          const predictionAnchorMatches = terminalPredictionCursorMatches(cursor, predictionArmedCursor);
          const canPredict = connectedRef.current
            && activeRef.current
            && !replayingTerminalOutput
            && term.getViewportY() <= 0;
          const awaitingAuthoritativeRender = clearPredictionsAfterRender
            || predictionAcknowledgedSequence !== undefined;
          if (
            prediction
            && predictionArmedScreen === screen
            && predictionAnchorMatches
            && canPredict
            && !clearPredictionsAfterRender
          ) {
            predictedInputs.push(prediction);
            renderPredictions(term);
            terminalLatency.recordPredictionMutation(pane.id, sequence, performance.now());
            requestAnimationFrame((timestamp) => terminalLatency.recordPredictionPaint(pane.id, sequence!, timestamp));
            schedulePredictionExpiry();
          } else if (!awaitingAuthoritativeRender) {
            clearPredictions();
            if (prediction && canPredict) {
              if (predictionArmedScreen) disarmPrediction();
              probePredictionEcho(prediction, term, screen);
            }
            else disarmPrediction();
          }
        }
        if (
          inputMayLeaveShellPrompt(data)
          && !clearPredictionsAfterRender
          && predictionAcknowledgedSequence === undefined
        ) {
          shellCursorPlacementRef.current = false;
          disarmPrediction();
        }
        if (term.getViewportY() > 0) term.scrollToBottom();
        if (terminalResponse && replayingTerminalOutput) return;
        sendInput(socketRef.current, data, terminalResponse, sequence);
      };
      terminalInputRef.current = forwardTerminalData;

      term.attachCustomKeyEventHandler((event) => {
        if (eventMatchesAction(
          event,
          keybindingsRef.current,
          "terminal.insertNewline",
          appleKeybindingsRef.current,
        )) {
          forwardTerminalData("\n");
          return true;
        }
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
        if (eventMatchesAction(event, keybindingsRef.current, "terminal.wordPrevious", appleKeybindingsRef.current)) {
          rectangularSelection?.clear();
          forwardTerminalData("\x1bb");
          return true;
        }
        if (eventMatchesAction(event, keybindingsRef.current, "terminal.wordNext", appleKeybindingsRef.current)) {
          rectangularSelection?.clear();
          forwardTerminalData("\x1bf");
          return true;
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
        if (terminalScrollModeRef.current === "immediate") {
          if (lines !== 0) term.scrollLines(lines);
        } else {
          wheelScroll?.push(lines);
        }
        return true;
      });

      term.onData(forwardTerminalData);
      latencyKeyDownListener = (event) => {
        const observedAt = performance.now();
        pendingLatencyKeyEvent = {
          eventAt: normalizeDomEventTimestamp(event.timeStamp, observedAt, performance.timeOrigin),
          observedAt,
        };
      };
      term.element?.addEventListener("keydown", latencyKeyDownListener, { capture: true });
      term.onResize(() => {
        rectangularSelection?.clear();
        disarmPrediction();
        refreshMetrics(term);
      });
      socketController = createSocketController(term);
      socketControllerRef.current = socketController;
      reconnectRef.current = () => {
        awaitingRestart = false;
        socketController?.reconnect();
      };
      if (suspendSocketRef.current) socketController.pause();
      else socketController.start();
    };
    void start();

    return () => {
      cancelled = true;
      cancelPendingReveal();
      wheelScroll?.dispose();
      touchScroll.cancel();
      if (discardPendingOutputRef.current === resetPendingOutput) discardPendingOutputRef.current = null;
      if (invalidatePredictionRef.current === disarmPrediction) invalidatePredictionRef.current = null;
      rectangularSelection?.dispose();
      rectangularSelectionRef.current = null;
      socketController?.dispose();
      if (socketControllerRef.current === socketController) socketControllerRef.current = null;
      if (replayDrainTimer !== undefined) window.clearTimeout(replayDrainTimer);
      renderDisposable?.dispose();
      bufferDisposable?.dispose();
      if (terminalOutputTimer !== undefined) window.clearTimeout(terminalOutputTimer);
      if (predictionExpiryTimer !== undefined) window.clearTimeout(predictionExpiryTimer);
      if (predictionProbeTimer !== undefined) window.clearTimeout(predictionProbeTimer);
      clearPredictionLayer();
      osc52Controller.dispose();
      if (osc52ControllerRef.current === osc52Controller) osc52ControllerRef.current = null;
      if (viewportFitFrame !== undefined) window.cancelAnimationFrame(viewportFitFrame);
      if (viewportFitTimer !== undefined) window.clearTimeout(viewportFitTimer);
      visualViewport?.removeEventListener("resize", settleVisualViewportResize);
      visualViewport?.removeEventListener("scroll", settleVisualViewportResize);
      window.removeEventListener("orientationchange", settleVisualViewportResize);
      if (selectionRestoreTimer !== undefined) window.clearTimeout(selectionRestoreTimer);
      clearContextCopyBridge();
      if (mouseDownListener) terminalRef.current?.element?.removeEventListener("mousedown", mouseDownListener, { capture: true });
      if (mouseUpListener) terminalRef.current?.element?.removeEventListener("mouseup", mouseUpListener, { capture: true });
      if (mouseShieldDownListener) terminalCanvas?.removeEventListener("mousedown", mouseShieldDownListener);
      if (mouseShieldMoveListener) terminalCanvas?.removeEventListener("mousemove", mouseShieldMoveListener);
      if (mouseHostShieldDownListener) terminalRef.current?.element?.removeEventListener("mousedown", mouseHostShieldDownListener, { capture: true });
      if (mouseHostShieldMoveListener) terminalRef.current?.element?.removeEventListener("mousemove", mouseHostShieldMoveListener, { capture: true });
      if (mouseGestureEndListener) document.removeEventListener("mouseup", mouseGestureEndListener);
      if (contextMenuListener) terminalRef.current?.element?.removeEventListener("contextmenu", contextMenuListener, { capture: true });
      if (copyListener) terminalRef.current?.element?.removeEventListener("copy", copyListener, { capture: true });
      if (latencyKeyDownListener) terminalRef.current?.element?.removeEventListener("keydown", latencyKeyDownListener, { capture: true });
      if (terminalBlurListener) terminalRef.current?.textarea?.removeEventListener("blur", terminalBlurListener);
      if (pasteKeyListener) terminalRef.current?.element?.removeEventListener("keydown", pasteKeyListener, { capture: true });
      if (pasteListener) terminalRef.current?.element?.removeEventListener("paste", pasteListener, { capture: true });
      if (windowFocusListener) window.removeEventListener("focus", windowFocusListener);
      if (windowBlurListener) window.removeEventListener("blur", windowBlurListener);
      if (pageShowListener) window.removeEventListener("pageshow", pageShowListener);
      if (visibilityChangeListener) document.removeEventListener("visibilitychange", visibilityChangeListener);
      if (windowScaleListener) window.removeEventListener("resize", windowScaleListener);
      if (deviceScaleQuery && deviceScaleQueryListener) {
        deviceScaleQuery.removeEventListener("change", deviceScaleQueryListener);
      }
      if (fontLoadingDoneListener && "fonts" in document) {
        document.fonts.removeEventListener("loadingdone", fontLoadingDoneListener);
      }
      if (terminalHostShell && touchPointerDownListener) terminalHostShell.removeEventListener("pointerdown", touchPointerDownListener);
      if (terminalHostShell && touchPointerMoveListener) terminalHostShell.removeEventListener("pointermove", touchPointerMoveListener);
      if (terminalHostShell && touchPointerUpListener) terminalHostShell.removeEventListener("pointerup", touchPointerUpListener);
      if (terminalHostShell && touchPointerCancelListener) terminalHostShell.removeEventListener("pointercancel", touchPointerCancelListener);
      resetSynchronizedOutput(synchronizedOutputRef.current);
      terminalLatency.abandonPane(pane.id, performance.now());
      fitAddon?.dispose();
      terminalRef.current?.dispose();
      socketRef.current = null;
      terminalInputRef.current = () => undefined;
      terminalRef.current = null;
      connectedRef.current = false;
      fitAddonRef.current = null;
      reconnectRef.current = null;
    };
  }, [pane.id, pendingLabel]);

  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    requestAnimationFrame(() => {
      const foreground = isForegroundTerminal(activeRef.current);
      fitAddonRef.current?.setForeground(foreground);
      if (active && focusSignal > appliedFocusSignalRef.current) {
        appliedFocusSignalRef.current = focusSignal;
        term.focus();
      }
      if (active) fitAddonRef.current?.fit();
      const dimensions = fitAddonRef.current?.proposedDimensions() ?? { cols: term.cols, rows: term.rows };
      sendResizeDimensions(socketRef.current, "activate", dimensions, foreground);
    });
  }, [active, focusSignal]);

  useEffect(() => {
    const term = terminalRef.current;
    invalidatePredictionRef.current?.();
    if (!term?.renderer) return;
    let cancelled = false;
    void ensureWmuxFonts(terminalFontFamily, terminalFontSize).then(() => {
      if (cancelled || !term.renderer) return;
      term.options.fontSize = terminalFontSize;
      term.options.fontFamily = terminalFontFamilyStack(terminalFontFamily);
      requestAnimationFrame(() => {
        fitAddonRef.current?.fit();
        const metrics = readCellMetrics(term);
        if (metrics) setTerminalMetrics(metrics);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [terminalFontFamily, terminalFontSize]);

  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    invalidatePredictionRef.current?.();
    term.options.theme = colorScheme.terminal;
  }, [colorScheme]);

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
    osc52ControllerRef.current?.copyPending();
  };
  const paneMachineLabel = currentMachine?.name ?? pane.machineId;
  const paneRun = lastRun
    ? {
        status: lastRun.status,
        label: runLabel(lastRun),
        title: runTitle(lastRun),
      }
    : undefined;
  const resolvedTerminalFontFamily = terminalFontFamilyStack(terminalFontFamily);
  const sendMobileTerminalKey = (data: string) => {
    mobileControlArmedRef.current = false;
    setMobileControlArmed(false);
    terminalInputRef.current(data);
    terminalRef.current?.focus();
  };
  const sendMobileTerminalArrow = (arrow: MobileTerminalArrow) => {
    sendMobileTerminalKey(mobileTerminalArrowSequence(arrow, terminalRef.current?.getMode(1) ?? false));
  };
  const pasteMobileText = (text: string) => {
    const term = terminalRef.current;
    if (!term || !text) return;
    mobileControlArmedRef.current = false;
    setMobileControlArmed(false);
    if (term.getViewportY() > 0) term.scrollToBottom();
    rectangularSelectionRef.current?.clear();
    term.clearSelection();
    term.paste(text);
    term.focus();
  };
  const pasteMobileClipboard = async () => {
    if (mobilePasteReading) return;
    mobileControlArmedRef.current = false;
    setMobileControlArmed(false);
    if (!navigator.clipboard?.readText) {
      setMobilePasteFallback("Direct clipboard access is unavailable in this browser.");
      return;
    }
    const term = terminalRef.current;
    if (!term) return;
    const captured = { paneId: pane.id, inputEpoch: ++inputEpochRef.current };
    const targetIsCurrent = () => canApplyMobileClipboardRead(captured, {
      paneId: pane.id,
      inputEpoch: inputEpochRef.current,
      mounted: terminalRef.current === term && Boolean(containerRef.current?.isConnected),
      active: activeRef.current,
      visible: document.visibilityState === "visible",
      connected: connectedRef.current && socketRef.current?.readyState === WebSocket.OPEN,
    });
    setMobilePasteReading(true);
    try {
      const text = await navigator.clipboard.readText();
      if (!targetIsCurrent()) return;
      if (text) pasteMobileText(text);
      else setMobilePasteFallback("The browser returned an empty clipboard.");
    } catch {
      if (targetIsCurrent()) setMobilePasteFallback("The browser blocked direct clipboard access.");
    } finally {
      setMobilePasteReading(false);
    }
  };

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
        ref={terminalHostShellRef}
        className="terminal-host-shell"
        onPointerDown={(event) => {
          onActivate();
          if (event.pointerType !== "touch") terminalRef.current?.focus();
        }}
      >
        <div
          ref={containerRef}
          className="terminal-host"
          style={{ fontFamily: resolvedTerminalFontFamily }}
        />
        <canvas
          ref={predictionCanvasRef}
          className="terminal-input-prediction-canvas"
          aria-hidden="true"
        />
        {!terminalReady ? (
          <div className="terminal-startup-status" role="status" aria-live="polite">
            <span className="terminal-startup-spinner" aria-hidden="true" />
            <span>{pendingLabel ?? startupLabel}</span>
          </div>
        ) : null}
        {graphicsDiagnostic ? (
          <div className="terminal-graphics-diagnostic" role="status" aria-live="polite">
            <span>
              [GRAPHICS WARN] {graphicsDiagnostic.protocol.toUpperCase()}: {graphicsDiagnostic.message}
            </span>
            <button
              type="button"
              aria-label="Dismiss graphics warning"
              onClick={() => setGraphicsDiagnostic(null)}
            >
              [X]
            </button>
          </div>
        ) : null}
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
      </div>
      <div className="mobile-terminal-keys" role="toolbar" aria-label="Terminal keys">
        <button
          type="button"
          aria-label="Paste clipboard"
          aria-busy={mobilePasteReading}
          disabled={mobilePasteReading}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => void pasteMobileClipboard()}
        >
          Paste
        </button>
        <button type="button" onPointerDown={(event) => event.preventDefault()} onClick={() => sendMobileTerminalKey(mobileTerminalKeySequences.escape)}>Esc</button>
        <button type="button" onPointerDown={(event) => event.preventDefault()} onClick={() => sendMobileTerminalKey(mobileTerminalKeySequences.tab)}>Tab</button>
        <button
          type="button"
          className={mobileControlArmed ? "active" : ""}
          aria-pressed={mobileControlArmed}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            const next = !mobileControlArmedRef.current;
            mobileControlArmedRef.current = next;
            setMobileControlArmed(next);
            terminalRef.current?.focus();
          }}
        >
          Ctrl
        </button>
        <button type="button" aria-label="Arrow left" onPointerDown={(event) => event.preventDefault()} onClick={() => sendMobileTerminalArrow("left")}>←</button>
        <button type="button" aria-label="Arrow down" onPointerDown={(event) => event.preventDefault()} onClick={() => sendMobileTerminalArrow("down")}>↓</button>
        <button type="button" aria-label="Arrow up" onPointerDown={(event) => event.preventDefault()} onClick={() => sendMobileTerminalArrow("up")}>↑</button>
        <button type="button" aria-label="Arrow right" onPointerDown={(event) => event.preventDefault()} onClick={() => sendMobileTerminalArrow("right")}>→</button>
      </div>
      {mobilePasteFallback ? (
        <MobilePasteDialog
          reason={mobilePasteFallback}
          onCancel={() => setMobilePasteFallback(null)}
          onInsert={(text) => {
            setMobilePasteFallback(null);
            pasteMobileText(text);
          }}
        />
      ) : null}
      {visibleMediaItems.length > 0 ? (
        <div className="media-shelf">
          {visibleMediaItems.slice(0, 3).map((item) => (
            <MediaPreview
              key={item.id}
              item={item}
              onDismiss={() => onDismissMedia(item.id)}
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
