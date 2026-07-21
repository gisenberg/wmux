import type { MutableRefObject } from "react";
import { Terminal } from "ghostty-web";
import {
  isKittyPlaceholder,
  isKittyPlaceholderMark,
  nextNonMarkIsPlaceholder,
  type KittyMaterializedImage,
  type KittyPlaceholderStripState,
} from "./kitty-graphics";
import type { PaneClientMessage, PaneState, TerminalMedia, TerminalRun } from "./types";

export interface KittyInlineImage {
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

export interface KittyVirtualPlacement {
  cols: number;
  rows: number;
}

export interface KittyPlaceholderCell {
  imageId: string;
  col: number;
  row: number;
}

export interface CellMetrics {
  width: number;
  height: number;
}

export interface SynchronizedOutputState {
  active: boolean;
  pending: string;
  carry: string;
  flushTimer: number | undefined;
}

export interface AlternateScreenState { active: boolean; carry: string; }

export interface WheelScrollCoalescer {
  push: (lines: number) => void;
  dispose: () => void;
}

export interface TouchScrollGesture {
  start: (pointerId: number, y: number) => void;
  move: (pointerId: number, y: number, lineHeight: number) => { handled: boolean; lines: number };
  end: (pointerId: number) => { handled: boolean; tap: boolean };
  cancel: () => void;
}

interface WheelScrollCoalescerOptions {
  scrollLines: (lines: number) => void;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (frame: number) => void;
}

export interface TerminalFitter {
  fit: () => void;
  proposedDimensions: () => { cols: number; rows: number } | undefined;
  setAuthoritativeSize: (cols: number, rows: number, resizeOwner: boolean) => void;
  setForeground: (foreground: boolean) => void;
  dispose: () => void;
}

export const safeCols = (cols: number): number => (Number.isFinite(cols) && cols >= 2 ? Math.floor(cols) : 80);
export const safeRows = (rows: number): number => (Number.isFinite(rows) && rows >= 1 ? Math.floor(rows) : 24);

export const sendPaneMessage = (ws: WebSocket | null, message: PaneClientMessage): void => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
};

export const sendInput = (
  ws: WebSocket | null,
  data: string,
  terminalResponse = false,
  sequence?: number,
): void => {
  sendPaneMessage(ws, { type: "input", data, terminalResponse, ...(sequence === undefined ? {} : { sequence }) });
};

export const createTerminalFitter = (
  term: Terminal,
  element: HTMLElement,
  onProposedDimensions?: (dimensions: { cols: number; rows: number }) => void,
): TerminalFitter => {
  let frame: number | undefined;
  let proposed: { cols: number; rows: number } | undefined;
  let authoritative: { cols: number; rows: number } | undefined;
  let resizeOwner = true;
  let foreground = true;
  const proposedDimensions = () => {
    const metrics = term.renderer?.getMetrics();
    if (!metrics?.width || !metrics.height || !element.clientWidth || !element.clientHeight) return undefined;
    const style = window.getComputedStyle(element);
    const horizontalPadding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const verticalPadding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    return {
      cols: Math.max(2, Math.floor((element.clientWidth - horizontalPadding) / metrics.width)),
      rows: Math.max(1, Math.floor((element.clientHeight - verticalPadding) / metrics.height)),
    };
  };
  const applySize = (dimensions: { cols: number; rows: number }) => {
    if (dimensions.cols !== term.cols || dimensions.rows !== term.rows) {
      term.resize(dimensions.cols, dimensions.rows);
    }
  };
  const fit = () => {
    const next = proposedDimensions();
    if (!next) return;
    if (!proposed || proposed.cols !== next.cols || proposed.rows !== next.rows) {
      proposed = next;
      onProposedDimensions?.(next);
    }
    if (!authoritative || (resizeOwner && foreground)) applySize(next);
    else applySize(authoritative);
  };
  const scheduleFit = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = undefined;
      fit();
    });
  };
  const observer = new ResizeObserver(scheduleFit);
  observer.observe(element);
  return {
    fit,
    proposedDimensions: () => proposed ?? proposedDimensions(),
    setAuthoritativeSize: (cols, rows, nextResizeOwner) => {
      authoritative = { cols: safeCols(cols), rows: safeRows(rows) };
      resizeOwner = nextResizeOwner;
      if (resizeOwner && foreground) fit();
      else applySize(authoritative);
    },
    setForeground: (nextForeground) => {
      foreground = nextForeground;
      if (authoritative && !(resizeOwner && foreground)) applySize(authoritative);
    },
    dispose: () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    },
  };
};

export const sendResizeDimensions = (
  ws: WebSocket | null,
  type: "resize" | "activate",
  dimensions: { cols: number; rows: number },
  foreground = false,
): void => {
  sendPaneMessage(ws, {
    type: foreground ? type : "resize",
    cols: safeCols(dimensions.cols),
    rows: safeRows(dimensions.rows),
    foreground,
  });
};

export const isForegroundTerminal = (active: boolean): boolean =>
  active && document.visibilityState === "visible" && document.hasFocus();

export const inputMayLeaveShellPrompt = (data: string): boolean => data.includes("\r") || data.includes("\n") || data.includes("\x04");

export const WMUX_CONTROL_PREFIX = "\x1b]777;wmux;";
export const WMUX_SHELL_CURSOR_PREFIX = "\x1b[9000;";
export const MAX_WMUX_CONTROL_CARRY = 256;
export const SYNCHRONIZED_OUTPUT_START = "\x1b[?2026h";
export const SYNCHRONIZED_OUTPUT_END = "\x1b[?2026l";
export const SYNCHRONIZED_OUTPUT_SEQUENCES = [SYNCHRONIZED_OUTPUT_START, SYNCHRONIZED_OUTPUT_END];
export const MAX_SYNCHRONIZED_OUTPUT_BUFFER_CHARS = 512 * 1024;
export const MAX_SYNCHRONIZED_OUTPUT_HOLD_MS = 500;
export const TERMINAL_OUTPUT_BATCH_MS = 16;
export const INTERACTIVE_OUTPUT_FAST_PATH_MS = 250;
export const createAlternateScreenState = (): AlternateScreenState => ({ active: false, carry: "" });
export const resetAlternateScreenState = (state: AlternateScreenState): void => {
  state.active = false;
  state.carry = "";
};
// Track DEC alternate-buffer switches without transforming output. This is
// deliberately separate from synchronized output: DEC 2026 bytes still flow
// through the existing atomic-output path unchanged.
export const pushAlternateScreenState = (state: AlternateScreenState, data: string): boolean => {
  const input = state.carry + data;
  state.carry = input.slice(Math.max(0, input.length - 12));
  for (const match of input.matchAll(/\x1b\[\?(?:47|1047|1049)([hl])/g)) state.active = match[1] === "h";
  return state.active;
};
export const terminalOutputDelay = (
  alternateScreen: boolean,
  tuiFrameRate: 15 | 30 | 60,
  lastOutputAt: number,
  now: number,
  lastInteractiveInputAt = Number.NEGATIVE_INFINITY,
): number => {
  if (now - lastInteractiveInputAt <= INTERACTIVE_OUTPUT_FAST_PATH_MS) return 0;
  if (!alternateScreen) return TERMINAL_OUTPUT_BATCH_MS;
  return now - lastOutputAt > 180 ? 0 : Math.round(1000 / tuiFrameRate);
};

export const createWheelScrollCoalescer = ({
  scrollLines,
  requestFrame,
  cancelFrame,
}: WheelScrollCoalescerOptions): WheelScrollCoalescer => {
  let pendingLines = 0;
  let frame: number | undefined;
  let disposed = false;

  const flush = () => {
    frame = undefined;
    const lines = Math.trunc(pendingLines);
    pendingLines -= lines;
    if (lines !== 0) scrollLines(lines);
  };

  return {
    push: (lines) => {
      if (disposed || !Number.isFinite(lines) || lines === 0) return;
      pendingLines += lines;
      if (pendingLines === 0 && frame !== undefined) {
        cancelFrame(frame);
        frame = undefined;
        return;
      }
      if (frame === undefined) frame = requestFrame(flush);
    },
    dispose: () => {
      disposed = true;
      pendingLines = 0;
      if (frame !== undefined) cancelFrame(frame);
      frame = undefined;
    },
  };
};

export const createTouchScrollGesture = (thresholdPx = 8): TouchScrollGesture => {
  let activePointer: number | undefined;
  let startY = 0;
  let lastY = 0;
  let pendingLines = 0;
  let scrolling = false;

  const cancel = () => {
    activePointer = undefined;
    pendingLines = 0;
    scrolling = false;
  };

  return {
    start: (pointerId, y) => {
      activePointer = pointerId;
      startY = y;
      lastY = y;
      pendingLines = 0;
      scrolling = false;
    },
    move: (pointerId, y, lineHeight) => {
      if (activePointer !== pointerId || !Number.isFinite(y)) return { handled: false, lines: 0 };
      if (!scrolling && Math.abs(y - startY) < thresholdPx) {
        return { handled: false, lines: 0 };
      }
      scrolling = true;
      const height = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 20;
      pendingLines += (lastY - y) / height;
      lastY = y;
      const lines = Math.trunc(pendingLines);
      pendingLines -= lines;
      return { handled: true, lines };
    },
    end: (pointerId) => {
      if (activePointer !== pointerId) return { handled: false, tap: false };
      const tap = !scrolling;
      cancel();
      return { handled: true, tap };
    },
    cancel,
  };
};

export const shouldShieldTerminalBeforeResume = (
  inactiveTabStreaming: "suspend" | "live",
  tabVisible: boolean,
  wasSuspended: boolean,
): boolean => inactiveTabStreaming === "suspend" && tabVisible && wasSuspended;
// Replay chunk size in UTF-16 code units; ~128 KiB keeps each drain step
// well under a frame budget while a 2 MiB replay finishes in ~16 steps.
export const REPLAY_CHUNK_CHARS = 128 * 1024;
export const CONTEXT_COPY_BRIDGE_TIMEOUT_MS = 30_000;
export const OSC52_PENDING_MS = 60_000;

export const DURABLE_REFRESH_FIRST_NUDGE_MS = 120;
export const DURABLE_REFRESH_QUIET_MS = 80;
export const DURABLE_REFRESH_FALLBACK_MS = 700;

export interface DurableRefreshRevealGate {
  begin: () => void;
  noteOutput: () => void;
  cancel: () => void;
}

interface DurableRefreshRevealGateOptions {
  onReveal: () => void;
  isReady?: () => boolean;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (timer: number) => void;
}

export const shouldWaitForDurableRefresh = (ready: {
  replay: string;
  replayKind: "raw" | "checkpoint";
  waitForRefresh?: true;
}): boolean => ready.waitForRefresh === true && ready.replayKind === "raw" && ready.replay === "";

export const createDurableRefreshRevealGate = ({
  onReveal,
  isReady = () => true,
  now = () => Date.now(),
  setTimer = (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimer = (timer) => window.clearTimeout(timer),
}: DurableRefreshRevealGateOptions): DurableRefreshRevealGate => {
  let generation = 0;
  let startedAt = 0;
  let pending = false;
  let quietTimer: number | undefined;
  let fallbackTimer: number | undefined;

  const clearTimers = () => {
    if (quietTimer !== undefined) clearTimer(quietTimer);
    if (fallbackTimer !== undefined) clearTimer(fallbackTimer);
    quietTimer = undefined;
    fallbackTimer = undefined;
  };
  const reveal = (expectedGeneration: number) => {
    if (!pending || generation !== expectedGeneration) return;
    pending = false;
    clearTimers();
    onReveal();
  };
  const revealAfterQuiet = (expectedGeneration: number) => {
    quietTimer = undefined;
    if (!pending || generation !== expectedGeneration) return;
    if (!isReady()) {
      quietTimer = setTimer(() => revealAfterQuiet(expectedGeneration), DURABLE_REFRESH_QUIET_MS);
      return;
    }
    reveal(expectedGeneration);
  };
  const cancel = () => {
    generation += 1;
    pending = false;
    clearTimers();
  };

  return {
    begin: () => {
      cancel();
      pending = true;
      startedAt = now();
      const expectedGeneration = generation;
      fallbackTimer = setTimer(() => reveal(expectedGeneration), DURABLE_REFRESH_FALLBACK_MS);
    },
    noteOutput: () => {
      if (!pending) return;
      if (quietTimer !== undefined) clearTimer(quietTimer);
      const expectedGeneration = generation;
      const currentTime = now();
      const revealAt = Math.max(
        startedAt + DURABLE_REFRESH_FIRST_NUDGE_MS + DURABLE_REFRESH_QUIET_MS,
        currentTime + DURABLE_REFRESH_QUIET_MS,
      );
      quietTimer = setTimer(() => revealAfterQuiet(expectedGeneration), Math.max(0, revealAt - currentTime));
    },
    cancel,
  };
};

export const createSynchronizedOutputState = (): SynchronizedOutputState => ({
  active: false,
  pending: "",
  carry: "",
  flushTimer: undefined,
});

export const resetSynchronizedOutput = (state: SynchronizedOutputState): void => {
  if (state.flushTimer !== undefined) window.clearTimeout(state.flushTimer);
  state.active = false;
  state.pending = "";
  state.carry = "";
  state.flushTimer = undefined;
};

export const drainSynchronizedOutput = (state: SynchronizedOutputState): string => {
  if (state.flushTimer !== undefined) window.clearTimeout(state.flushTimer);
  const output = state.pending;
  state.active = false;
  state.pending = "";
  state.carry = "";
  state.flushTimer = undefined;
  return output;
};

export const pushSynchronizedOutput = (state: SynchronizedOutputState, data: string): string[] => {
  const outputs: string[] = [];
  const combined = state.carry + data;
  const carryLength = synchronizedOutputPartialSuffixLength(combined);
  const input = carryLength > 0 ? combined.slice(0, -carryLength) : combined;
  state.carry = carryLength > 0 ? combined.slice(-carryLength) : "";

  const emit = (text: string) => {
    if (!text) return;
    if (!state.active) {
      outputs.push(text);
      return;
    }

    state.pending += text;
    if (state.pending.length > MAX_SYNCHRONIZED_OUTPUT_BUFFER_CHARS) {
      outputs.push(drainSynchronizedOutput(state));
    }
  };

  let offset = 0;
  while (offset < input.length) {
    const start = input.indexOf(SYNCHRONIZED_OUTPUT_START, offset);
    const end = input.indexOf(SYNCHRONIZED_OUTPUT_END, offset);
    const next = nextSynchronizedOutputMarker(start, end);

    if (!next) {
      emit(input.slice(offset));
      break;
    }

    emit(input.slice(offset, next.index));
    if (next.sequence === SYNCHRONIZED_OUTPUT_START) {
      state.active = true;
    } else if (state.active) {
      const pending = drainSynchronizedOutput(state);
      if (pending) outputs.push(pending);
    }
    offset = next.index + next.sequence.length;
  }

  return outputs;
};

export const nextSynchronizedOutputMarker = (
  start: number,
  end: number,
): { index: number; sequence: string } | null => {
  if (start === -1 && end === -1) return null;
  if (end === -1 || (start !== -1 && start < end)) {
    return { index: start, sequence: SYNCHRONIZED_OUTPUT_START };
  }
  return { index: end, sequence: SYNCHRONIZED_OUTPUT_END };
};

export const synchronizedOutputPartialSuffixLength = (input: string): number =>
  SYNCHRONIZED_OUTPUT_SEQUENCES.reduce((best, sequence) => Math.max(best, partialSuffixLength(input, sequence)), 0);

export const stripWmuxControlSequences = (
  carryRef: MutableRefObject<string>,
  data: string,
  onControl: (control: string) => void,
): string => {
  let input = carryRef.current + data;
  carryRef.current = "";
  let output = "";

  while (input.length > 0) {
    const start = input.indexOf(WMUX_CONTROL_PREFIX);
    if (start === -1) {
      const partialLength = partialSuffixLength(input, WMUX_CONTROL_PREFIX);
      if (partialLength > 0) {
        output += input.slice(0, -partialLength);
        carryRef.current = input.slice(-partialLength);
      } else {
        output += input;
      }
      break;
    }

    output += input.slice(0, start);
    const bodyStart = start + WMUX_CONTROL_PREFIX.length;
    const end = findOscTerminator(input, bodyStart);
    if (!end) {
      carryRef.current = input.slice(start).slice(0, MAX_WMUX_CONTROL_CARRY);
      break;
    }

    onControl(input.slice(bodyStart, end.index));
    input = input.slice(end.index + end.length);
  }

  return output;
};

export const findOscTerminator = (input: string, start: number): { index: number; length: number } | null => {
  for (let index = start; index < input.length; index += 1) {
    if (input[index] === "\x07") return { index, length: 1 };
    if (input[index] === "\x1b" && input[index + 1] === "\\") return { index, length: 2 };
  }
  return null;
};

export const partialSuffixLength = (input: string, prefix: string): number => {
  const max = Math.min(input.length, prefix.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (input.slice(-length) === prefix.slice(0, length)) return length;
  }
  return 0;
};

export interface TerminalSelectionPosition {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export interface TerminalSelectionManagerAccess {
  getSelectionPosition: () => TerminalSelectionPosition | undefined;
  finishMouseSelection?: (event: MouseEvent) => void;
}

export const terminalSelectionManager = (term: Terminal): TerminalSelectionManagerAccess | undefined => {
  const selectionManager = (term as unknown as {
    selectionManager?: {
      getSelectionPosition: () => TerminalSelectionPosition | undefined;
      boundMouseUpHandler?: (event: MouseEvent) => void;
    };
  }).selectionManager;
  if (!selectionManager) return undefined;
  return {
    getSelectionPosition: selectionManager.getSelectionPosition.bind(selectionManager),
    ...(selectionManager.boundMouseUpHandler
      ? { finishMouseSelection: selectionManager.boundMouseUpHandler.bind(selectionManager) }
      : {}),
  };
};

// Mouse-aware apps clear Ghostty's selection when the release is encoded as
// terminal input. Preserve its viewport range so browser selection still wins.
export const readTerminalSelectionPosition = (term: Terminal): TerminalSelectionPosition | undefined => {
  if (!term.hasSelection()) return undefined;
  return terminalSelectionManager(term)?.getSelectionPosition();
};

export const restoreTerminalSelection = (term: Terminal, position: TerminalSelectionPosition): void => {
  const rows = Math.max(0, position.end.y - position.start.y);
  const length = rows * Math.max(1, term.cols) + position.end.x - position.start.x + 1;
  if (length > 0) term.select(position.start.x, position.start.y, length);
};

export const shellCursorPlacementSequence = (
  event: MouseEvent,
  term: Terminal,
  shellCursorPlacementEnabled: boolean,
): string | null => {
  if (!shellCursorPlacementEnabled) return null;
  if (event.button !== 0 || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return null;
  if (term.getViewportY() > 0.5) return null;
  if (isScrollbarMouseDown(event, term)) return null;
  const cell = mouseCellInGrid(event, term);
  if (!cell) return null;
  const cursor = term.wasmTerm?.getCursor();
  const cursorCol = clamp((cursor?.x ?? 0) + 1, 1, safeCols(term.cols));
  const cursorRow = clamp((cursor?.y ?? 0) + 1, 1, safeRows(term.rows));
  return `${WMUX_SHELL_CURSOR_PREFIX}${cell.col};${cell.row};${cursorCol};${cursorRow}~`;
};

export const isScrollbarMouseDown = (event: MouseEvent, term: Terminal): boolean => {
  if (term.getScrollbackLength() <= 0) return false;
  const rect = term.element?.getBoundingClientRect();
  return rect ? event.clientX - rect.left >= rect.width - 12 : false;
};

export const mouseCellInGrid = (event: MouseEvent, term: Terminal): { col: number; row: number } | null => {
  const rect = term.element?.getBoundingClientRect();
  const metrics = term.renderer?.getMetrics?.();
  const width = metrics?.width ?? 8;
  const height = metrics?.height ?? 16;
  if (!rect || width <= 0 || height <= 0) return null;
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const gridWidth = safeCols(term.cols) * width;
  const gridHeight = safeRows(term.rows) * height;
  if (x < 0 || y < 0 || x >= gridWidth || y >= gridHeight) return null;
  return {
    col: Math.floor(x / width) + 1,
    row: Math.floor(y / height) + 1,
  };
};

export const kittyImageToMedia = (image: KittyMaterializedImage, pane: PaneState, imageId?: string): TerminalMedia => ({
  id: createLocalMediaId(imageId),
  workspaceId: "",
  tabId: "",
  paneId: pane.id,
  name: image.name,
  mimeType: image.mimeType,
  data: image.data,
  createdAt: new Date().toISOString(),
});

export const createLocalMediaId = (imageId = "image"): string =>
  `kitty_${imageId.replace(/[^A-Za-z0-9-]/g, "_")}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export const wheelLines = (event: WheelEvent, term: Terminal): number => {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * safeRows(term.rows);
  const lineHeight = term.renderer?.getMetrics?.().height ?? 20;
  return event.deltaY / lineHeight;
};

export const hasMouseTracking = (term: Terminal): boolean => {
  try {
    return term.hasMouseTracking();
  } catch {
    return false;
  }
};

export const mouseWheelSequence = (event: WheelEvent, term: Terminal): string => {
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

export const mouseReleaseSequence = (event: MouseEvent, term: Terminal): string => {
  const modifier = (event.shiftKey ? 4 : 0) + (event.metaKey ? 8 : 0) + (event.ctrlKey ? 16 : 0);
  const { col, row } = mouseCell(event, term);
  if (supportsSgrMouse(term)) return `\x1b[<${event.button + modifier};${col};${row}m`;
  return `\x1b[M${String.fromCharCode(32 + 3 + modifier)}${String.fromCharCode(32 + col)}${String.fromCharCode(32 + row)}`;
};

export const mousePressSequence = (event: MouseEvent, term: Terminal): string => {
  const modifier = (event.shiftKey ? 4 : 0) + (event.metaKey ? 8 : 0) + (event.ctrlKey ? 16 : 0);
  const { col, row } = mouseCell(event, term);
  if (supportsSgrMouse(term)) return `\x1b[<${event.button + modifier};${col};${row}M`;
  return `\x1b[M${String.fromCharCode(32 + event.button + modifier)}${String.fromCharCode(32 + col)}${String.fromCharCode(32 + row)}`;
};

export const supportsSgrMouse = (term: Terminal): boolean => {
  try {
    return term.getMode(1006);
  } catch {
    return true;
  }
};

export const mouseCell = (event: MouseEvent | WheelEvent, term: Terminal): { col: number; row: number } => {
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

export const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

export const runLabel = (run: TerminalRun): string => {
  if (run.status === "started") return "running";
  if (run.exitCode === 0) return "exit 0";
  return `exit ${run.exitCode ?? "?"}`;
};

export const runTitle = (run: TerminalRun): string => {
  const elapsed = run.completedAt ? ` (${formatDuration(run.startedAt, run.completedAt)})` : "";
  return `${run.command} - ${runLabel(run)}${elapsed}`;
};

export const formatDuration = (startedAt: string, completedAt: string): string => {
  const elapsedMs = Date.parse(completedAt) - Date.parse(startedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "unknown duration";
  if (elapsedMs < 1000) return `${elapsedMs}ms`;
  return `${(elapsedMs / 1000).toFixed(elapsedMs < 10_000 ? 1 : 0)}s`;
};

export const DECSTR_SHIM = "\x1b[0m\x1b[?1l\x1b>\x1b[?6l\x1b[?7h\x1b[4l\x1b[r\x1b[?25h\x1b(B";
export const PARTIAL_DECSTR = /\x1b(?:\[[?0-9;]*!?)?$/;
export const DECSTR = /\x1b\[[0-9;]*!p/g;

export const writeTerminalOutput = (
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

export const writeTerminalBody = (
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
    writePreservingScrollbackViewport(term, pending);
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

export const writePreservingScrollbackViewport = (term: Terminal, data: string): void => {
  const viewportY = term.getViewportY();
  const previousScrollbackLength = viewportY > 0 ? term.getScrollbackLength() : 0;
  term.write(data);
  if (viewportY <= 0) return;

  const nextScrollbackLength = term.getScrollbackLength();
  const scrollbackDelta = nextScrollbackLength - previousScrollbackLength;
  term.scrollToLine(viewportY + scrollbackDelta);
};

export const cursorPositionResponse = (term: Terminal, privateMode: boolean): string => {
  const cursor = term.wasmTerm?.getCursor();
  const row = clamp((cursor?.y ?? 0) + 1, 1, safeRows(term.rows));
  const col = clamp((cursor?.x ?? 0) + 1, 1, safeCols(term.cols));
  return privateMode ? `\x1b[?${row};${col}R` : `\x1b[${row};${col}R`;
};

export const readCellMetrics = (term: Terminal): CellMetrics | null => {
  const metrics = term.renderer?.getMetrics?.();
  if (!metrics || metrics.width <= 0 || metrics.height <= 0) return null;
  return { width: metrics.width, height: metrics.height };
};

export const waitForVisibleBox = (element: HTMLElement): Promise<void> =>
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
