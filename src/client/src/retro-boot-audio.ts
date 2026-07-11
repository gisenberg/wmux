export interface RetroPostTone {
  frequency: number;
  durationMs: number;
  offsetMs?: number;
  endFrequency?: number;
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

export const RETRO_POST_SOUNDS: Readonly<Record<string, readonly RetroPostTone[]>> = {
  "commodore-64": [tone(262, 70), tone(330, 70, 75), tone(392, 110, 150)],
  "commodore-128": [tone(196, 70), tone(262, 70, 65), tone(330, 70, 130), tone(392, 120, 195)],
  "apple-iie": [tone(880, 95, 0, "square", 1320)],
  "ibm-pc-at": [tone(1000, 120)],
  "bbc-micro": [tone(1047, 85), tone(1319, 95, 95)],
  "acorn-archimedes": [tone(523, 75, 0, "sine"), tone(784, 120, 85, "sine")],
  "trs-80-model-4": [tone(780, 130)],
  "zx-spectrum": [tone(1200, 45), tone(2400, 45, 48), tone(1200, 55, 96)],
  "atari-st": [tone(620, 90), tone(930, 105, 100)],
  "amiga-workbench": [tone(220, 35), tone(440, 35, 45), tone(660, 35, 90), tone(880, 120, 135)],
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
  "pico-8": [tone(262, 55), tone(330, 55, 60), tone(392, 55, 120), tone(523, 100, 180)],
};

type AudioContextConstructor = new () => AudioContext;

const audioContextConstructor = (): AudioContextConstructor | undefined => {
  const audioWindow = window as typeof window & { webkitAudioContext?: AudioContextConstructor };
  return window.AudioContext ?? audioWindow.webkitAudioContext;
};

export const playRetroPostSound = (profileId: string): (() => void) => {
  const tones = RETRO_POST_SOUNDS[profileId];
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
        oscillator.connect(gain).connect(context.destination);
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
