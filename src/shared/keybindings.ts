export const KEYBINDING_ACTIONS = [
  "commandPalette.open",
  "settings.open",
  "sidebar.toggle",
  "workspace.new",
  "workspace.close",
  "workspace.previous",
  "workspace.next",
  "workspace.select1",
  "workspace.select2",
  "workspace.select3",
  "workspace.select4",
  "workspace.select5",
  "workspace.select6",
  "workspace.select7",
  "workspace.select8",
  "workspace.select9",
  "tab.new",
  "tab.close",
  "tab.previous",
  "tab.next",
  "tab.select1",
  "tab.select2",
  "tab.select3",
  "tab.select4",
  "tab.select5",
  "tab.select6",
  "tab.select7",
  "tab.select8",
  "tab.select9",
  "pane.splitRight",
  "pane.splitDown",
  "pane.focusPrevious",
  "pane.focusNext",
  "notification.latestUnread",
  "terminal.insertNewline",
  "terminal.wordPrevious",
  "terminal.wordNext",
  "settings.save",
] as const;

export type KeybindingAction = (typeof KEYBINDING_ACTIONS)[number];
export type KeybindingMap = Record<KeybindingAction, string[]>;
export type KeybindingOverrides = Partial<KeybindingMap>;
export type KeybindingContext = "global" | "terminal" | "settings";

const actionSet = new Set<string>(KEYBINDING_ACTIONS);

export const isKeybindingAction = (value: string): value is KeybindingAction => actionSet.has(value);

const globalActions = new Set<KeybindingAction>([
  "commandPalette.open",
  "settings.open",
  "sidebar.toggle",
  "workspace.new",
  "workspace.close",
  "workspace.previous",
  "workspace.next",
  "workspace.select1",
  "workspace.select2",
  "workspace.select3",
  "workspace.select4",
  "workspace.select5",
  "workspace.select6",
  "workspace.select7",
  "workspace.select8",
  "workspace.select9",
  "tab.new",
  "tab.close",
  "tab.previous",
  "tab.next",
  "tab.select1",
  "tab.select2",
  "tab.select3",
  "tab.select4",
  "tab.select5",
  "tab.select6",
  "tab.select7",
  "tab.select8",
  "tab.select9",
  "pane.splitRight",
  "pane.splitDown",
  "pane.focusPrevious",
  "pane.focusNext",
  "notification.latestUnread",
]);

const terminalActions = new Set<KeybindingAction>([
  "terminal.insertNewline",
  "terminal.wordPrevious",
  "terminal.wordNext",
]);

export const keybindingContext = (action: KeybindingAction): KeybindingContext =>
  globalActions.has(action) ? "global" : terminalActions.has(action) ? "terminal" : "settings";

const primaryBindings = (code: string, ...extra: string[]): string[] => [
  [`Meta`, ...extra, code].join("+"),
  [`Ctrl`, ...extra, code].join("+"),
];

const numberedDefaults = (prefix: "workspace" | "tab"): Partial<KeybindingMap> => {
  const bindings: Partial<KeybindingMap> = {};
  for (let digit = 1; digit <= 9; digit += 1) {
    const action = `${prefix}.select${digit}` as KeybindingAction;
    bindings[action] = prefix === "workspace"
      ? primaryBindings(`Digit${digit}`)
      : [`Alt+Digit${digit}`];
  }
  return bindings;
};

export const defaultKeybindings: KeybindingMap = {
  "commandPalette.open": primaryBindings("KeyK"),
  "settings.open": [],
  "sidebar.toggle": primaryBindings("KeyB"),
  "workspace.new": primaryBindings("KeyN"),
  "workspace.close": primaryBindings("KeyW", "Shift"),
  "workspace.previous": ["Meta+Ctrl+BracketLeft", "Ctrl+Alt+BracketLeft"],
  "workspace.next": ["Meta+Ctrl+BracketRight", "Ctrl+Alt+BracketRight"],
  ...numberedDefaults("workspace"),
  "tab.new": primaryBindings("KeyT"),
  "tab.close": primaryBindings("KeyW"),
  "tab.previous": [...primaryBindings("BracketLeft", "Shift"), "Ctrl+Shift+Tab"],
  "tab.next": [...primaryBindings("BracketRight", "Shift"), "Ctrl+Tab"],
  ...numberedDefaults("tab"),
  "pane.splitRight": primaryBindings("KeyD"),
  "pane.splitDown": primaryBindings("KeyD", "Shift"),
  "pane.focusPrevious": [
    "Meta+Alt+ArrowLeft",
    "Meta+Alt+ArrowUp",
    "Ctrl+Alt+ArrowLeft",
    "Ctrl+Alt+ArrowUp",
  ],
  "pane.focusNext": [
    "Meta+Alt+ArrowRight",
    "Meta+Alt+ArrowDown",
    "Ctrl+Alt+ArrowRight",
    "Ctrl+Alt+ArrowDown",
  ],
  "notification.latestUnread": primaryBindings("KeyU", "Shift"),
  "terminal.insertNewline": ["Shift+Enter"],
  "terminal.wordPrevious": ["Alt+ArrowLeft"],
  "terminal.wordNext": ["Alt+ArrowRight"],
  "settings.save": primaryBindings("KeyS"),
} as KeybindingMap;

export const resolveKeybindings = (overrides?: KeybindingOverrides): KeybindingMap => {
  const resolved = {} as KeybindingMap;
  for (const action of KEYBINDING_ACTIONS) {
    resolved[action] = [...(overrides && Object.hasOwn(overrides, action)
      ? overrides[action] ?? []
      : defaultKeybindings[action])];
  }
  return resolved;
};

const MODIFIERS = ["Primary", "Ctrl", "Alt", "Shift", "Meta"] as const;
type KeyModifier = (typeof MODIFIERS)[number];
const modifierSet = new Set<string>(MODIFIERS);
const modifierOrder = new Map<string, number>(MODIFIERS.map((modifier, index) => [modifier, index]));

const namedCodes = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "Backspace",
  "Backquote",
  "Backslash",
  "BracketLeft",
  "BracketRight",
  "Comma",
  "Delete",
  "End",
  "Enter",
  "Equal",
  "Escape",
  "Home",
  "Insert",
  "IntlBackslash",
  "IntlRo",
  "IntlYen",
  "Minus",
  "PageDown",
  "PageUp",
  "Pause",
  "Period",
  "PrintScreen",
  "Quote",
  "ScrollLock",
  "Semicolon",
  "Slash",
  "Space",
  "Tab",
]);

const isKeyCode = (value: string): boolean =>
  /^Key[A-Z]$/.test(value)
  || /^Digit[0-9]$/.test(value)
  || /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(value)
  || /^Numpad(?:[0-9]|Add|Decimal|Divide|Enter|Equal|Multiply|Subtract)$/.test(value)
  || namedCodes.has(value);

export interface ParsedKeyChord {
  canonical: string;
  code: string;
  modifiers: ReadonlySet<KeyModifier>;
}

export const parseKeyChord = (input: string): ParsedKeyChord => {
  if (input.trim() !== input || input.length === 0) throw new Error("chord must not be empty or contain outer whitespace");
  const tokens = input.split("+");
  if (tokens.some((token) => token.length === 0)) throw new Error("chord contains an empty token");
  const code = tokens.at(-1) as string;
  if (!isKeyCode(code)) throw new Error(`unknown key code ${JSON.stringify(code)}`);
  const modifiers = tokens.slice(0, -1);
  const unknownModifier = modifiers.find((modifier) => !modifierSet.has(modifier));
  if (unknownModifier) throw new Error(`unknown modifier ${JSON.stringify(unknownModifier)}`);
  if (new Set(modifiers).size !== modifiers.length) throw new Error("chord contains a duplicate modifier");
  if (modifiers.includes("Primary") && (modifiers.includes("Ctrl") || modifiers.includes("Meta"))) {
    throw new Error("Primary cannot be combined with Ctrl or Meta");
  }
  const ordered = [...modifiers].sort((left, right) => (modifierOrder.get(left) ?? 0) - (modifierOrder.get(right) ?? 0));
  return {
    canonical: [...ordered, code].join("+"),
    code,
    modifiers: new Set(ordered as KeyModifier[]),
  };
};

export interface KeyboardEventLike {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export const keyChordMatches = (event: KeyboardEventLike, chord: ParsedKeyChord, apple: boolean): boolean => {
  const primary = chord.modifiers.has("Primary");
  const ctrl = chord.modifiers.has("Ctrl") || (primary && !apple);
  const meta = chord.modifiers.has("Meta") || (primary && apple);
  return event.code === chord.code
    && event.ctrlKey === ctrl
    && event.altKey === chord.modifiers.has("Alt")
    && event.shiftKey === chord.modifiers.has("Shift")
    && event.metaKey === meta;
};

export type CompiledKeybindingMap = Record<KeybindingAction, ParsedKeyChord[]>;

export const compileKeybindings = (bindings: KeybindingMap): CompiledKeybindingMap => {
  const compiled = {} as CompiledKeybindingMap;
  for (const action of KEYBINDING_ACTIONS) compiled[action] = bindings[action].map(parseKeyChord);
  return compiled;
};

export const eventMatchesAction = (
  event: KeyboardEventLike,
  bindings: CompiledKeybindingMap,
  action: KeybindingAction,
  apple: boolean,
): boolean => bindings[action].some((chord) => keyChordMatches(event, chord, apple));

const friendlyCode = (code: string): string => {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code === "BracketLeft") return "[";
  if (code === "BracketRight") return "]";
  if (code === "Comma") return ",";
  if (code === "Period") return ".";
  if (code === "Space") return "Space";
  return code.replace("Arrow", "");
};

export const formatKeyChord = (input: string, apple: boolean): string => {
  const chord = parseKeyChord(input);
  const labels: string[] = [];
  if (chord.modifiers.has("Primary")) labels.push(apple ? "Cmd" : "Ctrl");
  if (chord.modifiers.has("Meta")) labels.push(apple ? "Cmd" : "Meta");
  if (chord.modifiers.has("Ctrl")) labels.push("Ctrl");
  if (chord.modifiers.has("Alt")) labels.push(apple ? "Option" : "Alt");
  if (chord.modifiers.has("Shift")) labels.push("Shift");
  labels.push(friendlyCode(chord.code));
  return labels.join("+");
};

export const displayBindingForAction = (
  bindings: KeybindingMap,
  action: KeybindingAction,
  apple: boolean,
): string | undefined => {
  const values = bindings[action];
  if (!values.length) return undefined;
  const preferred = [...values].sort((left, right) => {
    const score = (value: string): number => {
      const modifiers = parseKeyChord(value).modifiers;
      if (modifiers.has("Primary")) return 3;
      if (apple && modifiers.has("Meta")) return 2;
      if (!apple && modifiers.has("Ctrl") && !modifiers.has("Meta")) return 2;
      return 0;
    };
    return score(right) - score(left);
  })[0];
  return formatKeyChord(preferred, apple);
};

const contextsOverlap = (left: KeybindingContext, right: KeybindingContext): boolean =>
  left === right || (left !== "settings" && right !== "settings");

const resolvedSignature = (chord: ParsedKeyChord, apple: boolean): string => {
  const primary = chord.modifiers.has("Primary");
  return [
    chord.code,
    chord.modifiers.has("Ctrl") || (primary && !apple) ? "C" : "-",
    chord.modifiers.has("Alt") ? "A" : "-",
    chord.modifiers.has("Shift") ? "S" : "-",
    chord.modifiers.has("Meta") || (primary && apple) ? "M" : "-",
  ].join(":");
};

export const validateKeybindingMap = (bindings: KeybindingMap): string[] => {
  const errors: string[] = [];
  const parsed = new Map<KeybindingAction, ParsedKeyChord[]>();
  for (const action of KEYBINDING_ACTIONS) {
    const chords: ParsedKeyChord[] = [];
    for (const value of bindings[action]) {
      try {
        chords.push(parseKeyChord(value));
      } catch (error) {
        errors.push(`${action}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    parsed.set(action, chords);
  }
  for (let leftIndex = 0; leftIndex < KEYBINDING_ACTIONS.length; leftIndex += 1) {
    const leftAction = KEYBINDING_ACTIONS[leftIndex];
    const own = new Set<string>();
    for (const chord of parsed.get(leftAction) ?? []) {
      if (own.has(chord.canonical)) errors.push(`${leftAction}: duplicate chord ${chord.canonical}`);
      own.add(chord.canonical);
    }
    for (const apple of [false, true]) {
      const resolved = new Set<string>();
      for (const chord of parsed.get(leftAction) ?? []) {
        const signature = resolvedSignature(chord, apple);
        if (resolved.has(signature)) {
          errors.push(`${leftAction}: duplicate resolved chord ${chord.canonical} on ${apple ? "Apple" : "non-Apple"} platforms`);
        }
        resolved.add(signature);
      }
    }
    for (let rightIndex = leftIndex + 1; rightIndex < KEYBINDING_ACTIONS.length; rightIndex += 1) {
      const rightAction = KEYBINDING_ACTIONS[rightIndex];
      if (!contextsOverlap(keybindingContext(leftAction), keybindingContext(rightAction))) continue;
      for (const apple of [false, true]) {
        const leftSignatures = new Set((parsed.get(leftAction) ?? []).map((chord) => resolvedSignature(chord, apple)));
        const collision = (parsed.get(rightAction) ?? []).find((chord) => leftSignatures.has(resolvedSignature(chord, apple)));
        if (collision) {
          errors.push(`${leftAction} and ${rightAction}: conflicting chord ${collision.canonical} on ${apple ? "Apple" : "non-Apple"} platforms`);
          break;
        }
      }
    }
  }
  return errors;
};
