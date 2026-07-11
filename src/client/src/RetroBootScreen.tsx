import { type CSSProperties, useEffect, useRef, useState } from "react";
import { FitAddon, Terminal } from "ghostty-web";
import { api } from "./api";
import { RetroBootArtwork } from "./RetroBootArtwork";
import { playRetroPostSound } from "./retro-boot-audio";
import { selectRetroBootProfile } from "./retro-boot-profiles";
import { ensureGhostty } from "./terminal-loader";
import { setToken } from "./token";

interface RetroBootScreenProps {
  authRequired: boolean;
  ready: boolean;
  onAuthenticated: () => void;
  onComplete: () => void;
}

const LAST_BOOT_PROFILE_KEY = "wmux:last-retro-boot-profile";

const chooseBootProfile = () => {
  let previousId: string | null = null;
  try {
    previousId = window.sessionStorage.getItem(LAST_BOOT_PROFILE_KEY);
  } catch {
    // Private browsing can make session storage unavailable.
  }
  const profile = selectRetroBootProfile(Math.random(), previousId);
  try {
    window.sessionStorage.setItem(LAST_BOOT_PROFILE_KEY, profile.id);
  } catch {
    // The random profile still works without persistence.
  }
  return profile;
};

export function RetroBootScreen({ authRequired, ready, onAuthenticated, onComplete }: RetroBootScreenProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const authRequiredRef = useRef(authRequired);
  const readyRef = useRef(ready);
  const onAuthenticatedRef = useRef(onAuthenticated);
  const onCompleteRef = useRef(onComplete);
  const [profile] = useState(chooseBootProfile);
  const [showArtwork, setShowArtwork] = useState(true);
  const [status, setStatus] = useState(`Starting ${profile.name}`);

  useEffect(() => {
    authRequiredRef.current = authRequired;
  }, [authRequired]);

  useEffect(() => {
    readyRef.current = ready;
  }, [ready]);

  useEffect(() => {
    onAuthenticatedRef.current = onAuthenticated;
  }, [onAuthenticated]);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    const stopPostSound = playRetroPostSound(profile.id);
    let cancelled = false;
    let terminal: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let authStage: "idle" | "username" | "password" | "submitting" = "idle";
    let username = "";
    let credentialInput = "";
    let previousInputWasCarriageReturn = false;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pause = (milliseconds: number) =>
      new Promise<void>((resolve) => window.setTimeout(resolve, reducedMotion ? 0 : milliseconds));
    const write = (text: string) => terminal?.write(text.replaceAll("\n", "\r\n"));

    const promptForUsername = () => {
      username = "";
      credentialInput = "";
      authStage = "username";
      write(profile.auth.usernamePrompt);
      requestAnimationFrame(() => terminal?.focus());
    };

    const submitCredentials = async () => {
      const password = credentialInput;
      credentialInput = "";
      authStage = "submitting";
      setStatus("Verifying credentials");
      write(profile.auth.verifying);
      try {
        const result = await api.login(username, password);
        if (cancelled) return;
        setToken(result.token);
        onAuthenticatedRef.current();
      } catch {
        if (cancelled) return;
        write(profile.auth.failed);
        setStatus("Authentication failed");
        promptForUsername();
      }
    };

    const finishCredentialLine = () => {
      write("\n");
      if (authStage === "username") {
        username = credentialInput;
        credentialInput = "";
        authStage = "password";
        write(profile.auth.passwordPrompt);
        return;
      }
      if (authStage === "password") void submitCredentials();
    };

    const acceptCredentialInput = (data: string) => {
      if (authStage !== "username" && authStage !== "password") return;
      if (data.includes("\x1b")) return;
      for (const character of data) {
        if (authStage !== "username" && authStage !== "password") return;
        if (character === "\r") {
          previousInputWasCarriageReturn = true;
          finishCredentialLine();
          continue;
        }
        if (character === "\n") {
          if (previousInputWasCarriageReturn) {
            previousInputWasCarriageReturn = false;
            continue;
          }
          finishCredentialLine();
          continue;
        }
        previousInputWasCarriageReturn = false;
        if (character === "\b" || character === "\x7f") {
          if (!credentialInput) continue;
          credentialInput = credentialInput.slice(0, -1);
          if (authStage === "username") write("\b \b");
          continue;
        }
        if ((character.codePointAt(0) ?? 0) < 0x20 || credentialInput.length >= 128) continue;
        credentialInput += character;
        if (authStage === "username") write(character);
      }
    };

    const start = async () => {
      await Promise.all([
        ensureGhostty(),
        "fonts" in document ? document.fonts.load(`400 16px ${profile.fontFamily}`) : Promise.resolve(),
      ]);
      if (cancelled || !hostRef.current) return;

      const mobile = window.matchMedia("(max-width: 600px)").matches;
      terminal = new Terminal({
        cols: profile.columns,
        rows: profile.rows,
        cursorBlink: true,
        cursorStyle: "block",
        disableStdin: false,
        fontSize: mobile ? profile.fontSize.mobile : profile.fontSize.desktop,
        fontFamily: profile.fontFamily,
        scrollback: 0,
        theme: {
          background: profile.colors.background,
          foreground: profile.colors.foreground,
          cursor: profile.colors.foreground,
          cursorAccent: profile.colors.background,
          selectionBackground: profile.colors.foreground,
          selectionForeground: profile.colors.background,
        },
      });
      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(hostRef.current);
      terminal.onData(acceptCredentialInput);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (cancelled) return;
      fitAddon.fit();
      fitAddon.observeResize();

      await pause(700);
      if (cancelled) return;
      setShowArtwork(false);
      setStatus(profile.bootStatus);
      write("\x1b[2J\x1b[H");
      for (const bootStep of profile.boot) {
        if (cancelled) return;
        write(bootStep.text);
        await pause(bootStep.delay);
      }

      setStatus("Waiting for wmux service");
      let challenged = false;
      const showAuthChallenge = async () => {
        if (challenged || !authRequiredRef.current) return;
        challenged = true;
        setStatus("Authentication required");
        write(profile.auth.required);
        try {
          const info = await api.authInfo();
          if (cancelled) return;
          if (!info.loginEnabled) {
            for (const line of profile.auth.tokenRequired) write(line);
            setStatus("Access token required");
            return;
          }
          promptForUsername();
        } catch {
          if (!cancelled) {
            write(profile.auth.unavailable);
            setStatus("Authentication service unavailable");
          }
        }
      };
      void showAuthChallenge();
      while (!readyRef.current && !cancelled) {
        void showAuthChallenge();
        await pause(80);
      }
      if (cancelled) return;

      setStatus("Running wmux");
      await pause(650);
      if (cancelled) return;
      write(challenged ? `${profile.auth.granted}${profile.auth.ready}` : `\n${profile.auth.ready}`);
      await pause(3_500);
      if (!cancelled) onCompleteRef.current();
    };

    void start();
    return () => {
      cancelled = true;
      stopPostSound();
      fitAddon?.dispose();
      terminal?.dispose();
    };
  }, [profile]);

  const style = {
    "--retro-page": profile.colors.page,
    "--retro-border": profile.colors.border,
    "--retro-background": profile.colors.background,
    "--retro-foreground": profile.colors.foreground,
  } as CSSProperties;

  return (
    <main className={`retro-boot-screen retro-boot-${profile.id}`} style={style} data-boot-profile={profile.id}>
      <section className="retro-boot-bezel" aria-label={`${profile.name} wmux loading`}>
        <div ref={hostRef} className="retro-boot-terminal" aria-label={profile.ariaLabel} />
        {showArtwork ? <RetroBootArtwork profileId={profile.id} profileName={profile.name} /> : null}
        <span className="visually-hidden" role="status" aria-live="polite">
          {status}
        </span>
      </section>
    </main>
  );
}
