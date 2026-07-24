import { useCallback, useEffect, useRef, useState } from "react";
import {
  presentMobileInteraction,
  transitionMobileInteraction,
  type MobileInteractionEvent,
  type MobileInteractionState,
} from "./mobile/keyboard-machine";
import { mobileViewportMediaQuery } from "./useSidebar";

export interface MobileViewportBaseline {
  width: number;
  height: number;
}

export interface MobileKeyboardSample {
  isMobile: boolean;
  layoutHeight: number;
  viewportHeight: number;
  viewportWidth: number;
  editableFocused: boolean;
  keyboardWasOpen?: boolean;
}

const directKeyboardDelta = 80;
const baselineKeyboardDelta = 120;

export const mobileViewportShapeChanged = (
  baseline: MobileViewportBaseline,
  width: number,
): boolean => {
  if (baseline.width <= 0 || baseline.height <= 0) return true;
  const widthTolerance = Math.max(24, baseline.width * 0.08);
  return Math.abs(width - baseline.width) > widthTolerance;
};

export const mobileKeyboardLikelyOpen = (
  sample: MobileKeyboardSample,
  baseline: MobileViewportBaseline,
): boolean => {
  if (!sample.isMobile) return false;
  const directlyOccluded = sample.layoutHeight - sample.viewportHeight > directKeyboardDelta;
  const baselineOccluded =
    !mobileViewportShapeChanged(baseline, sample.viewportWidth) &&
    baseline.height - sample.viewportHeight > baselineKeyboardDelta;
  if (!directlyOccluded && !baselineOccluded) return false;
  return sample.editableFocused || Boolean(sample.keyboardWasOpen);
};

export const isEditableViewportTarget = (target: Element | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.matches("input:not([type='button']):not([type='checkbox']):not([type='radio']), textarea, select")) {
    return !target.hasAttribute("disabled") && !target.hasAttribute("readonly");
  }
  return target.isContentEditable;
};

export interface MobileViewportState {
  isMobile: boolean;
  keyboardOpen: boolean;
  interactionState: MobileInteractionState;
  restoreKeyboardAnchor: boolean;
  dispatchInteraction: (event: MobileInteractionEvent) => void;
}

interface MobileViewportMetrics {
  isMobile: boolean;
  keyboardOpen: boolean;
  height: number;
  width: number;
  offsetTop: number;
  offsetLeft: number;
}

export const useMobileViewportState = (): MobileViewportState => {
  const initialMetrics = measureMobileViewport();
  const initialInteractionState: MobileInteractionState = initialMetrics.keyboardOpen
    ? "keyboard-open-chrome-collapsed"
    : "keyboard-closed";
  const [state, setState] = useState<Omit<MobileViewportState, "dispatchInteraction">>(() => ({
    isMobile: initialMetrics.isMobile,
    keyboardOpen: presentMobileInteraction(initialInteractionState).chromeCollapsed,
    interactionState: initialInteractionState,
    restoreKeyboardAnchor: false,
  }));
  const viewportBaseline = useRef<MobileViewportBaseline>({
    width: initialMetrics.isMobile ? initialMetrics.width : 0,
    height: initialMetrics.isMobile ? initialMetrics.height : 0,
  });
  const keyboardOpen = useRef(initialMetrics.keyboardOpen);
  const interactionState = useRef<MobileInteractionState>(initialInteractionState);

  const dispatchInteraction = useCallback((event: MobileInteractionEvent) => {
    interactionState.current = transitionMobileInteraction(interactionState.current, event);
    const presentation = presentMobileInteraction(interactionState.current);
    setState((current) => {
      const next = {
        ...current,
        keyboardOpen: presentation.chromeCollapsed,
        interactionState: interactionState.current,
        restoreKeyboardAnchor: presentation.restoreKeyboardAnchor,
      };
      return current.keyboardOpen === next.keyboardOpen &&
        current.interactionState === next.interactionState &&
        current.restoreKeyboardAnchor === next.restoreKeyboardAnchor
        ? current
        : next;
    });
  }, []);

  useEffect(() => {
    const update = (resetBaseline = false) => {
      const viewport = window.visualViewport;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      if (resetBaseline || mobileViewportShapeChanged(viewportBaseline.current, viewportWidth)) {
        viewportBaseline.current = { width: viewportWidth, height: viewportHeight };
      }
      const metrics = measureMobileViewport(viewportBaseline.current, keyboardOpen.current);
      if (metrics.isMobile && !metrics.keyboardOpen) {
        viewportBaseline.current = { width: metrics.width, height: metrics.height };
      } else if (!metrics.isMobile) {
        viewportBaseline.current = { width: 0, height: 0 };
      }
      keyboardOpen.current = metrics.isMobile && metrics.keyboardOpen;
      if (!metrics.isMobile) {
        interactionState.current = transitionMobileInteraction(interactionState.current, "reset");
      } else {
        interactionState.current = transitionMobileInteraction(
          interactionState.current,
          metrics.keyboardOpen ? "viewport-keyboard-opened" : "viewport-keyboard-closed",
        );
      }
      const presentation = presentMobileInteraction(interactionState.current);
      const next: Omit<MobileViewportState, "dispatchInteraction"> = {
        isMobile: metrics.isMobile,
        keyboardOpen: metrics.isMobile && presentation.chromeCollapsed,
        interactionState: interactionState.current,
        restoreKeyboardAnchor: metrics.isMobile && presentation.restoreKeyboardAnchor,
      };
      document.documentElement.style.setProperty("--wmux-viewport-height", `${Math.max(1, Math.floor(metrics.height))}px`);
      document.documentElement.style.setProperty("--wmux-viewport-width", `${Math.max(1, Math.floor(metrics.width))}px`);
      document.documentElement.style.setProperty("--wmux-viewport-top", `${Math.max(0, Math.floor(metrics.offsetTop))}px`);
      document.documentElement.style.setProperty("--wmux-viewport-left", `${Math.max(0, Math.floor(metrics.offsetLeft))}px`);
      setState((current) =>
        current.isMobile === next.isMobile &&
        current.keyboardOpen === next.keyboardOpen &&
        current.interactionState === next.interactionState &&
        current.restoreKeyboardAnchor === next.restoreKeyboardAnchor
          ? current
          : next,
      );
    };
    update();
    const visualViewport = window.visualViewport;
    const updateViewport = () => update(false);
    const resetForOrientation = () => update(true);
    const updateForFocusIn = (event: FocusEvent) => {
      if (isEditableViewportTarget(event.target instanceof Element ? event.target : null)) {
        dispatchInteraction("editable-focused");
      }
      update(false);
    };
    const updateForFocusOut = (event: FocusEvent) => {
      if (!isEditableViewportTarget(event.relatedTarget instanceof Element ? event.relatedTarget : null)) {
        dispatchInteraction("editable-blurred");
      }
      update(false);
    };
    window.addEventListener("resize", updateViewport);
    window.addEventListener("orientationchange", resetForOrientation);
    document.addEventListener("focusin", updateForFocusIn);
    document.addEventListener("focusout", updateForFocusOut);
    visualViewport?.addEventListener("resize", updateViewport);
    visualViewport?.addEventListener("scroll", updateViewport);
    return () => {
      window.removeEventListener("resize", updateViewport);
      window.removeEventListener("orientationchange", resetForOrientation);
      document.removeEventListener("focusin", updateForFocusIn);
      document.removeEventListener("focusout", updateForFocusOut);
      visualViewport?.removeEventListener("resize", updateViewport);
      visualViewport?.removeEventListener("scroll", updateViewport);
    };
  }, [dispatchInteraction]);

  useEffect(() => {
    if (!state.restoreKeyboardAnchor) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.isConnected) {
      active.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    const next = transitionMobileInteraction(state.interactionState, "keyboard-anchor-restored");
    interactionState.current = next;
    const presentation = presentMobileInteraction(next);
    setState((current) => ({
      ...current,
      keyboardOpen: presentation.chromeCollapsed,
      interactionState: next,
      restoreKeyboardAnchor: presentation.restoreKeyboardAnchor,
    }));
  }, [state.interactionState, state.restoreKeyboardAnchor]);

  return { ...state, dispatchInteraction };
};

const measureMobileViewport = (
  baseline: MobileViewportBaseline = { width: 0, height: 0 },
  keyboardWasOpen = false,
): MobileViewportMetrics => {
  const isMobile = window.matchMedia(mobileViewportMediaQuery).matches;
  const viewport = window.visualViewport;
  const viewportHeight = viewport?.height ?? window.innerHeight;
  const viewportWidth = viewport?.width ?? window.innerWidth;
  const keyboardOpen = mobileKeyboardLikelyOpen({
    isMobile,
    layoutHeight: window.innerHeight,
    viewportHeight,
    viewportWidth,
    editableFocused: isEditableViewportTarget(document.activeElement),
    keyboardWasOpen,
  }, baseline);
  return {
    isMobile,
    keyboardOpen,
    height: viewportHeight,
    width: viewportWidth,
    offsetTop: viewport?.offsetTop ?? 0,
    offsetLeft: viewport?.offsetLeft ?? 0,
  };
};
