import "@fontsource/fira-code/latin.css";
import { DEFAULT_TERMINAL_FONT_FAMILY } from "./types";

export const WMUX_MONO_FONT_FAMILY = DEFAULT_TERMINAL_FONT_FAMILY;
const BUNDLED_MESLO_FONT_FAMILY = "MesloLGM Nerd Font";

export const WMUX_FONT_FEATURE_SETTINGS = '"calt" 1, "liga" 1';

let fontLoadPromise: Promise<void> | undefined;
let mesloFontLoadPromise: Promise<void> | undefined;
const requestedFontLoads = new Map<string, Promise<void>>();

export const terminalFontFamilyStack = (preferred?: string): string => {
  const cleaned = preferred?.trim();
  if (!cleaned || cleaned === WMUX_MONO_FONT_FAMILY) return WMUX_MONO_FONT_FAMILY;
  if (typeof CSS !== "undefined" && !CSS.supports("font-family", cleaned)) return WMUX_MONO_FONT_FAMILY;
  return `${cleaned}, ${WMUX_MONO_FONT_FAMILY}`;
};

export const ensureWmuxFonts = async (preferred?: string, fontSize = 14): Promise<void> => {
  fontLoadPromise ??= loadWmuxFonts();
  if (preferred?.includes(BUNDLED_MESLO_FONT_FAMILY)) {
    mesloFontLoadPromise ??= loadBundledMesloFonts();
    await Promise.all([fontLoadPromise, mesloFontLoadPromise]);
    return;
  }
  const family = terminalFontFamilyStack(preferred);
  if (family === WMUX_MONO_FONT_FAMILY || !("fonts" in document)) return fontLoadPromise;
  const key = `${fontSize}:${family}`;
  let requested = requestedFontLoads.get(key);
  if (!requested) {
    requested = Promise.race([
      Promise.all([
        document.fonts.load(`400 ${fontSize}px ${family}`),
        document.fonts.load(`600 ${fontSize}px ${family}`),
        document.fonts.load(`700 ${fontSize}px ${family}`),
      ]).then(() => undefined).catch(() => undefined),
      timeout(1800),
    ]);
    requestedFontLoads.set(key, requested);
  }
  await Promise.all([fontLoadPromise, requested]);
};

const loadBundledMesloFonts = async (): Promise<void> => {
  if (!("fonts" in document)) return;
  try {
    const [regular, bold] = await Promise.all([
      document.fonts.load(`400 14px "${BUNDLED_MESLO_FONT_FAMILY}"`),
      document.fonts.load(`700 14px "${BUNDLED_MESLO_FONT_FAMILY}"`),
    ]);
    if (regular.length === 0 || bold.length === 0) {
      console.warn("wmux: bundled MesloLGM Nerd Font faces were not registered; using the terminal fallback stack");
    }
  } catch (error) {
    console.warn("wmux: bundled MesloLGM Nerd Font failed to load; using the terminal fallback stack", error);
  }
};

const loadWmuxFonts = async (): Promise<void> => {
  if (!("fonts" in document)) return;
  const fonts = document.fonts;
  const ready = Promise.all([
    fonts.load(`400 14px "Fira Code"`),
    fonts.load(`600 12px "Fira Code"`),
    fonts.load(`700 12px "Fira Code"`),
    fonts.ready,
  ]).then(() => undefined);
  await Promise.race([ready, timeout(1800)]);
};

const timeout = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
