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
  if (!sample.isMobile || !sample.editableFocused) return false;
  if (sample.layoutHeight - sample.viewportHeight > directKeyboardDelta) return true;
  if (mobileViewportShapeChanged(baseline, sample.viewportWidth)) return false;
  return baseline.height - sample.viewportHeight > baselineKeyboardDelta;
};

export const isEditableViewportTarget = (target: Element | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.matches("input:not([type='button']):not([type='checkbox']):not([type='radio']), textarea, select")) {
    return !target.hasAttribute("disabled") && !target.hasAttribute("readonly");
  }
  return target.isContentEditable;
};
