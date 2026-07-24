export type MobileInteractionState =
  | "keyboard-closed"
  | "keyboard-opening"
  | "keyboard-open-chrome-collapsed"
  | "keyboard-closing-anchor-restore"
  | "drawer-open"
  | "drawer-closing-focus-return";

export type MobileInteractionEvent =
  | "editable-focused"
  | "editable-blurred"
  | "viewport-keyboard-opened"
  | "viewport-keyboard-closed"
  | "keyboard-anchor-restored"
  | "drawer-opened"
  | "drawer-closed"
  | "drawer-focus-restored"
  | "reset";

type MobileInteractionTransitions = Readonly<
  Partial<Record<MobileInteractionEvent, MobileInteractionState>>
>;

export const mobileInteractionTransitions: Readonly<
  Record<MobileInteractionState, MobileInteractionTransitions>
> = {
  "keyboard-closed": {
    "editable-focused": "keyboard-opening",
    "viewport-keyboard-opened": "keyboard-open-chrome-collapsed",
    "drawer-opened": "drawer-open",
  },
  "keyboard-opening": {
    "editable-blurred": "keyboard-closed",
    "viewport-keyboard-opened": "keyboard-open-chrome-collapsed",
    "viewport-keyboard-closed": "keyboard-opening",
    "drawer-opened": "drawer-open",
  },
  "keyboard-open-chrome-collapsed": {
    "viewport-keyboard-closed": "keyboard-closing-anchor-restore",
  },
  "keyboard-closing-anchor-restore": {
    "editable-focused": "keyboard-opening",
    "viewport-keyboard-opened": "keyboard-open-chrome-collapsed",
    "keyboard-anchor-restored": "keyboard-closed",
    "drawer-opened": "drawer-open",
  },
  "drawer-open": {
    "drawer-closed": "drawer-closing-focus-return",
  },
  "drawer-closing-focus-return": {
    "drawer-opened": "drawer-open",
    "drawer-focus-restored": "keyboard-closed",
  },
};

const resetState: MobileInteractionState = "keyboard-closed";

export const transitionMobileInteraction = (
  state: MobileInteractionState,
  event: MobileInteractionEvent,
): MobileInteractionState => {
  if (event === "reset") return resetState;
  return mobileInteractionTransitions[state][event] ?? state;
};

export interface MobileInteractionPresentation {
  chromeCollapsed: boolean;
  drawerOpen: boolean;
  restoreKeyboardAnchor: boolean;
  restoreDrawerFocus: boolean;
}

export const presentMobileInteraction = (
  state: MobileInteractionState,
): MobileInteractionPresentation => ({
  chromeCollapsed:
    state === "keyboard-opening" ||
    state === "keyboard-open-chrome-collapsed" ||
    state === "keyboard-closing-anchor-restore",
  drawerOpen: state === "drawer-open",
  restoreKeyboardAnchor: state === "keyboard-closing-anchor-restore",
  restoreDrawerFocus: state === "drawer-closing-focus-return",
});
