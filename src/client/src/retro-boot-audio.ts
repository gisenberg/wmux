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

// Deliberately sparse: a made-up melody is not a historical startup sound.
// These are quiet synthesized approximations, not recordings of ROM routines.
export const RETRO_POST_SOUNDS: Readonly<Partial<Record<string, readonly RetroPostTone[]>>> = {
  "apple-iie": [tone(1000, 100)],
  "ibm-pc-at": [tone(1000, 120)],
  "amiga-workbench": [floppyClunk(115, 80), floppyClunk(105, 360), floppyClunk(120, 720)],
};

type AudioContextConstructor = new () => AudioContext;

const audioContextConstructor = (): AudioContextConstructor | undefined => {
  const audioWindow = window as typeof window & { webkitAudioContext?: AudioContextConstructor };
  return window.AudioContext ?? audioWindow.webkitAudioContext;
};

const playRetroSound = (tones: readonly RetroPostTone[] | undefined): (() => void) => {
  const AudioContextClass = audioContextConstructor();
  if (!tones?.length || !AudioContextClass || document.visibilityState !== "visible") return () => undefined;

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
