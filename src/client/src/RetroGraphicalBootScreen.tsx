import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { playRetroPostSound } from "./retro-boot-audio";
import { retroFramebufferStyle, useRetroFramebuffer } from "./retro-framebuffer";
import type { RetroBootProfile } from "./retro-boot-profiles";
import { GRAPHICAL_BOOT_STAGES, GRAPHICAL_DESKTOP_STAGE, GraphicalScene } from "./RetroGraphicalDesktop";
import { setToken } from "./token";
import "./retro-graphical-desktop.css";

interface RetroGraphicalBootScreenProps {
  profile: RetroBootProfile;
  authRequired: boolean;
  ready: boolean;
  onAuthenticated: () => void;
  onComplete: () => void;
}

type GraphicalPhase = "boot" | "username" | "password" | "verifying" | "failed" | "token" | "ready";

export function RetroGraphicalBootScreen({
  profile,
  authRequired,
  ready,
  onAuthenticated,
  onComplete,
}: RetroGraphicalBootScreenProps) {
  const shell = profile.graphicalShell;
  if (!shell) throw new Error(`Graphical boot profile ${profile.id} has no graphical shell`);

  const hostRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [phase, setPhase] = useState<GraphicalPhase>("boot");
  const [bootStage, setBootStage] = useState(GRAPHICAL_BOOT_STAGES[shell][0]?.id ?? GRAPHICAL_DESKTOP_STAGE);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState(profile.bootStatus);
  useRetroFramebuffer(hostRef, profile.id);

  useEffect(() => {
    const stopPostSound = playRetroPostSound(profile.id);
    let cancelled = false;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pause = (milliseconds: number) =>
      new Promise<void>((resolve) => window.setTimeout(resolve, reducedMotion ? 0 : milliseconds));

    const start = async () => {
      for (const stage of GRAPHICAL_BOOT_STAGES[shell]) {
        if (reducedMotion) break;
        setBootStage(stage.id);
        await pause(stage.duration);
        if (cancelled) return;
      }
      if (cancelled) return;
      if (!authRequired) {
        setPhase("ready");
        setStatus("WMUX ready");
        return;
      }
      try {
        const info = await api.authInfo();
        if (cancelled) return;
        if (!info.loginEnabled) {
          setPhase("token");
          setStatus("Access token required");
          return;
        }
        setPhase("username");
        setStatus("Authentication required");
        requestAnimationFrame(() => inputRef.current?.focus());
      } catch {
        if (!cancelled) {
          setPhase("failed");
          setStatus("Authentication service unavailable");
        }
      }
    };

    void start();
    return () => {
      cancelled = true;
      stopPostSound();
    };
  }, [authRequired, profile.bootStatus, profile.id, shell]);

  useEffect(() => {
    if (!ready || authRequired || phase !== "ready") return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timeout = window.setTimeout(onComplete, reducedMotion ? 0 : 3_500);
    return () => window.clearTimeout(timeout);
  }, [authRequired, onComplete, phase, ready]);

  const submit = async () => {
    if (phase === "username") {
      if (!username) return;
      setPhase("password");
      return;
    }
    if (phase !== "password") return;
    setPhase("verifying");
    setStatus("Verifying credentials");
    try {
      const result = await api.login(username, password);
      if (result.token) setToken(result.token);
      onAuthenticated();
      setPhase("ready");
      setStatus("WMUX ready");
    } catch {
      setPassword("");
      setPhase("failed");
      setStatus("Authentication failed");
      window.setTimeout(() => {
        setPhase("username");
        requestAnimationFrame(() => inputRef.current?.focus());
      }, 850);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (phase !== "username" && phase !== "password") return;
    if (event.key === "Enter") {
      event.preventDefault();
      void submit();
      return;
    }
    if (event.key === "Backspace") {
      event.preventDefault();
      if (phase === "username") setUsername((value) => value.slice(0, -1));
      else setPassword((value) => value.slice(0, -1));
      return;
    }
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target instanceof HTMLTextAreaElement) return;
    event.preventDefault();
    if (phase === "username") setUsername((value) => `${value}${event.key}`.slice(0, 128));
    else setPassword((value) => `${value}${event.key}`.slice(0, 128));
  };

  const style = {
    ...retroFramebufferStyle(profile.id),
    "--retro-page": profile.colors.page,
    "--retro-border": profile.colors.border,
    "--retro-background": profile.colors.background,
    "--retro-foreground": profile.colors.foreground,
  } as CSSProperties;

  return (
    <main
      ref={hostRef}
      className={`retro-boot-screen retro-graphical-boot retro-graphical-${shell}${ready ? " retro-boot-overlay" : ""}`}
      style={style}
      data-boot-profile={profile.id}
      data-boot-presentation="graphical"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={() => inputRef.current?.focus()}
    >
      <section className="retro-graphical-display" aria-label={`${profile.name} graphical startup`}>
        <div className="retro-graphical-framebuffer">
          <GraphicalScene
            shell={shell}
            stage={phase === "boot" ? bootStage : GRAPHICAL_DESKTOP_STAGE}
            login={phase === "boot" ? undefined : {
              field: phase === "username" ? "username" : phase === "password" ? "password" : null,
              username,
              secretLength: password.length,
              message: phase === "verifying"
                ? "Checking credentials…"
                : phase === "failed"
                  ? "Name or password not recognized."
                  : phase === "token"
                    ? "This server requires an access token. Open its startup URL with ?token=…"
                    : phase === "ready" ? "WMUX READY" : "",
              submitDisabled: phase !== "username" && phase !== "password",
              onSubmit: () => void submit(),
            }}
          />
          <textarea
            ref={inputRef}
            className="retro-graphical-input"
            aria-label="Authentication input"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="next"
            onInput={(event) => {
              if (phase !== "username" && phase !== "password") return;
              const characters = event.currentTarget.value.replace(/[\r\n]/g, "");
              event.currentTarget.value = "";
              if (!characters) return;
              if (phase === "username") setUsername((value) => `${value}${characters}`.slice(0, 128));
              else setPassword((value) => `${value}${characters}`.slice(0, 128));
            }}
          />
          <span className="visually-hidden" role="status" aria-live="polite">{status}</span>
        </div>
      </section>
    </main>
  );
}
