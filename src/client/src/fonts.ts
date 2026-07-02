import "@fontsource/fira-code/latin.css";

export const WMUX_MONO_FONT_FAMILY =
  '"Fira Code", "Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace';

export const WMUX_FONT_FEATURE_SETTINGS = '"calt" 1, "liga" 1';

let fontLoadPromise: Promise<void> | undefined;

export const ensureWmuxFonts = (): Promise<void> => {
  fontLoadPromise ??= loadWmuxFonts();
  return fontLoadPromise;
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
