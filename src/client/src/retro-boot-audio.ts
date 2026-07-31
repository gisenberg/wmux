export interface RetroPostTone {
  frequency: number;
  durationMs: number;
  offsetMs?: number;
  endFrequency?: number;
  filterFrequency?: number;
  type?: OscillatorType;
  volume?: number;
}

const tone = (
  frequency: number,
  durationMs: number,
  offsetMs = 0,
  type: OscillatorType = "square",
  endFrequency?: number,
): RetroPostTone => ({ frequency, durationMs, offsetMs, type, ...(endFrequency ? { endFrequency } : {}) });

const floppyClunk = (frequency: number, offsetMs: number): RetroPostTone => ({
  ...tone(frequency, 65, offsetMs),
  filterFrequency: 520,
  volume: 0.012,
});

export const RETRO_POST_SOUNDS: Readonly<Record<string, readonly RetroPostTone[]>> = {
  "commodore-64": [tone(262, 70), tone(330, 70, 75), tone(392, 110, 150)],
  "commodore-128": [tone(196, 70), tone(262, 70, 65), tone(330, 70, 130), tone(392, 120, 195)],
  "apple-iie": [tone(1000, 100)],
  "ibm-pc-at": [tone(1000, 120)],
  "bbc-micro": [tone(1047, 85), tone(1319, 95, 95)],
  "acorn-archimedes": [tone(523, 75, 0, "sine"), tone(784, 120, 85, "sine")],
  "trs-80-model-4": [tone(780, 130)],
  "zx-spectrum": [tone(1200, 45), tone(2400, 45, 48), tone(1200, 55, 96)],
  "atari-st": [tone(880, 150, 0, "sine")],
  "amiga-workbench": [floppyClunk(115, 80), floppyClunk(105, 360), floppyClunk(120, 720)],
  "amiga-guru-meditation": [tone(130, 180, 0, "sawtooth"), tone(110, 260, 170, "sawtooth")],
  "osborne-1": [tone(880, 145, 0, "sine")],
  "sinclair-ql": [tone(698, 65), tone(932, 100, 75)],
  "amstrad-cpc": [tone(262, 55), tone(392, 55, 60), tone(523, 110, 120)],
  msx2: [tone(330, 55), tone(494, 55, 60), tone(659, 120, 120)],
  "apple-lisa": [tone(440, 120, 0, "sine"), tone(659, 180, 105, "sine")],
  "vax-vms": [tone(1000, 110, 0, "sine")],
  "sun-sparcstation": [tone(880, 90, 0, "sine"), tone(1175, 120, 100, "sine")],
  "sgi-irix": [tone(523, 100, 0, "sine"), tone(659, 100, 75, "sine"), tone(784, 180, 150, "sine")],
  nextcube: [tone(196, 180, 0, "sine"), tone(294, 180, 45, "sine"), tone(392, 240, 90, "sine")],
  "pdp-11-rt11": [tone(1000, 120, 0, "sine")],
  "ibm-3270-mvs": [tone(660, 85, 0, "sine"), tone(880, 120, 105, "sine")],
  "ti-99-4a": [tone(440, 70), tone(660, 100, 80)],
  "trs-80-coco": [tone(784, 110)],
  "amstrad-pcw": [tone(880, 90, 0, "sine")],
  "sharp-x68000": [tone(440, 80, 0, "sine"), tone(880, 120, 90, "sine")],
  "nec-pc-9801": [tone(2000, 80)],
  "os2-warp": [tone(330, 90, 0, "sine"), tone(494, 130, 100, "sine")],
  "enterprise-128": [tone(523, 65), tone(659, 65, 70), tone(784, 110, 140)],
  "oric-atmos": [tone(660, 80), tone(990, 100, 90)],
  "commodore-pet": [tone(440, 90)],
  "commodore-vic-20": [tone(262, 65), tone(392, 100, 75)],
  "sam-coupe": [tone(523, 70), tone(784, 110, 80)],
  "memotech-mtx": [tone(700, 100)],
  "tatung-einstein": [tone(880, 110, 0, "sine")],
  "atari-8-bit": [tone(440, 70), tone(660, 90, 80)],
};

type AudioContextConstructor = new () => AudioContext;

const audioContextConstructor = (): AudioContextConstructor | undefined => {
  const audioWindow = window as typeof window & { webkitAudioContext?: AudioContextConstructor };
  return window.AudioContext ?? audioWindow.webkitAudioContext;
};

const playRetroSound = (tones: readonly RetroPostTone[] | undefined): (() => void) => {
  const AudioContextClass = audioContextConstructor();
  if (!tones || !AudioContextClass || document.visibilityState !== "visible") return () => undefined;

  let cancelled = false;
  let context: AudioContext | null = null;
  let closeTimer: number | undefined;
  const oscillators: OscillatorNode[] = [];

  const close = () => {
    if (closeTimer !== undefined) window.clearTimeout(closeTimer);
    closeTimer = undefined;
    for (const oscillator of oscillators) {
      try {
        oscillator.stop();
      } catch {
        // It may already have stopped at its scheduled end time.
      }
    }
    oscillators.length = 0;
    const activeContext = context;
    context = null;
    if (activeContext && activeContext.state !== "closed") void activeContext.close().catch(() => undefined);
  };

  void (async () => {
    try {
      context = new AudioContextClass();
      await context.resume();
      if (cancelled || context.state !== "running") {
        close();
        return;
      }

      const startAt = context.currentTime + 0.015;
      let finishMs = 0;
      for (const postTone of tones) {
        const offsetMs = postTone.offsetMs ?? 0;
        const toneStart = startAt + offsetMs / 1000;
        const toneEnd = toneStart + postTone.durationMs / 1000;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = postTone.type ?? "square";
        oscillator.frequency.setValueAtTime(postTone.frequency, toneStart);
        if (postTone.endFrequency) oscillator.frequency.linearRampToValueAtTime(postTone.endFrequency, toneEnd);
        gain.gain.setValueAtTime(0.0001, toneStart);
        gain.gain.exponentialRampToValueAtTime(postTone.volume ?? 0.025, toneStart + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, toneEnd);
        if (postTone.filterFrequency) {
          const filter = context.createBiquadFilter();
          filter.type = "lowpass";
          filter.frequency.setValueAtTime(postTone.filterFrequency, toneStart);
          oscillator.connect(filter).connect(gain).connect(context.destination);
        } else {
          oscillator.connect(gain).connect(context.destination);
        }
        oscillator.start(toneStart);
        oscillator.stop(toneEnd + 0.01);
        oscillators.push(oscillator);
        finishMs = Math.max(finishMs, offsetMs + postTone.durationMs);
      }
      closeTimer = window.setTimeout(close, finishMs + 100);
    } catch {
      // Autoplay policy commonly blocks boot audio. Never defer a blocked POST
      // cue until a later credential keystroke, where it would be surprising.
      close();
    }
  })();

  return () => {
    cancelled = true;
    close();
  };
};

export const playRetroPostSound = (profileId: string): (() => void) => playRetroSound(RETRO_POST_SOUNDS[profileId]);

export const playRetroFloppySound = (): (() => void) =>
  playRetroSound([floppyClunk(115, 60), floppyClunk(105, 330), floppyClunk(120, 690)]);
