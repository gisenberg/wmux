import { type CSSProperties, useEffect, useRef, useState } from "react";
import { Terminal } from "ghostty-web";
import { api } from "./api";
import { RetroBootArtwork } from "./RetroBootArtwork";
import { RetroGraphicalBootScreen } from "./RetroGraphicalBootScreen";
import { playRetroPostSound } from "./retro-boot-audio";
import { retroFramebufferStyle, useRetroFramebuffer } from "./retro-framebuffer";
import { selectRetroBootProfile, type RetroBootProfile } from "./retro-boot-profiles";
import { ensureGhostty } from "./terminal-loader";
import { configureTerminalInput } from "./terminal-input";
import { setToken } from "./token";

interface RetroBootScreenProps {
  authRequired: boolean;
  isMobile: boolean;
  ready: boolean;
  onAuthenticated: () => void;
  onComplete: () => void;
}

const LAST_BOOT_PROFILE_KEY = "wmux:last-retro-boot-profile";
type BootVisualPhase = "blank" | "artwork" | "guru" | "terminal";

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

export function RetroBootScreen({ isMobile, ...props }: RetroBootScreenProps) {
  const [profile] = useState(chooseBootProfile);
  useEffect(() => {
    if (isMobile && props.ready && !props.authRequired) props.onComplete();
  }, [isMobile, props.authRequired, props.onComplete, props.ready]);
  if (profile.graphicalShell) return <RetroGraphicalBootScreen profile={profile} {...props} />;
  return <RetroTerminalBootScreen profile={profile} {...props} />;
}

function RetroTerminalBootScreen({
  profile,
  authRequired,
  ready,
  onAuthenticated,
  onComplete,
}: Omit<RetroBootScreenProps, "isMobile"> & { profile: RetroBootProfile }) {
  const screenRef = useRef<HTMLElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const authRequiredRef = useRef(authRequired);
  const readyRef = useRef(ready);
  const onAuthenticatedRef = useRef(onAuthenticated);
  const onCompleteRef = useRef(onComplete);
  const hasBootArtwork = profile.showBootArtwork !== false;
  const isAmiga = profile.id === "amiga-workbench" || profile.id === "amiga-guru-meditation";
  const [visualPhase, setVisualPhase] = useState<BootVisualPhase>(() =>
    !hasBootArtwork ? "terminal" : profile.specialBoot === "amiga-guru" ? "guru" : isAmiga ? "blank" : "artwork",
  );
  const [status, setStatus] = useState(`Starting ${profile.name}`);
  useRetroFramebuffer(screenRef, profile.id);

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
    let authStage: "idle" | "username" | "password" | "submitting" = "idle";
    let username = "";
    let credentialInput = "";
    let previousInputWasCarriageReturn = false;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pause = (milliseconds: number) =>
      new Promise<void>((resolve) => window.setTimeout(resolve, reducedMotion ? 0 : milliseconds));
    const terminalText = (text: string) => text.replaceAll("\n", "\r\n");
    const write = (text: string) => terminal?.write(terminalText(text));
    const writeCommitted = (text: string) =>
      new Promise<void>((resolve) => {
        if (!terminal || !text) {
          resolve();
          return;
        }
        terminal.write(terminalText(text), resolve);
      });

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
      terminal.open(hostRef.current);
      configureTerminalInput(terminal);
      terminal.onData(acceptCredentialInput);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (cancelled) return;

      if (!hasBootArtwork) {
        setVisualPhase("terminal");
      } else if (profile.specialBoot === "amiga-guru") {
        await pause(2_000);
        if (cancelled) return;
        setStatus("Restarting after Guru Meditation");
        setVisualPhase("blank");
        await pause(450);
        if (cancelled) return;
        setStatus("Waiting for Workbench disk");
        setVisualPhase("artwork");
        await pause(1_600);
      } else if (isAmiga) {
        await pause(600);
        if (cancelled) return;
        setStatus("Waiting for Workbench disk");
        setVisualPhase("artwork");
        await pause(1_600);
      } else {
        await pause(700);
      }
      if (cancelled) return;
      setVisualPhase("terminal");
      setStatus(profile.bootStatus);
      write("\x1b[2J\x1b[H");
      for (const bootStep of profile.boot) {
        if (cancelled) return;
        if (bootStep.typedFrom === undefined) {
          write(bootStep.text);
        } else {
          await writeCommitted(bootStep.text.slice(0, bootStep.typedFrom));
          for (const character of bootStep.text.slice(bootStep.typedFrom)) {
            if (cancelled) return;
            await writeCommitted(character);
            if (character !== "\n") await pause(character === " " ? 22 : 38);
          }
        }
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
      terminal?.dispose();
    };
  }, [hasBootArtwork, profile]);

  const recoveredAmigaBackdrop = profile.specialBoot === "amiga-guru" && visualPhase !== "guru" ? "#ffffff" : null;
  const style = {
    ...retroFramebufferStyle(profile.id),
    "--retro-page": recoveredAmigaBackdrop ?? profile.colors.page,
    "--retro-border": recoveredAmigaBackdrop ?? profile.colors.border,
    "--retro-background": profile.colors.background,
    "--retro-foreground": profile.colors.foreground,
  } as CSSProperties;

  return (
    <main ref={screenRef} className={`retro-boot-screen retro-boot-${profile.id}`} style={style} data-boot-profile={profile.id}>
      <section className="retro-boot-bezel" aria-label={`${profile.name} wmux loading`}>
        <div className="retro-boot-framebuffer">
          <div className="retro-boot-terminal-frame">
            {isAmiga ? (
              <div className="retro-amiga-shell-titlebar" aria-hidden="true">
                <span className="retro-amiga-shell-gadget">0</span>
                <span>AmigaShell</span>
                <span className="retro-amiga-shell-depth-gadget" />
              </div>
            ) : null}
            <div ref={hostRef} className="retro-boot-terminal" aria-label={profile.ariaLabel} />
          </div>
          {visualPhase === "blank" ? <div className="retro-boot-amiga-blank" aria-hidden="true" /> : null}
          {visualPhase === "guru" ? (
            <div className="retro-amiga-guru" role="img" aria-label="Amiga Guru Meditation software failure">
              <div className="retro-amiga-guru-alert">
                <span>Software Failure. Press left mouse button to continue.</span>
                <span>Guru Meditation #0000000B.00C01570</span>
              </div>
            </div>
          ) : null}
          {visualPhase === "artwork" ? <RetroBootArtwork profileId={profile.id} profileName={profile.name} /> : null}
          <span className="visually-hidden" role="status" aria-live="polite">
            {status}
          </span>
        </div>
      </section>
    </main>
  );
}
