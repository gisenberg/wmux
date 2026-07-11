import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { playRetroPostSound } from "./retro-boot-audio";
import { retroFramebufferStyle, useRetroFramebuffer } from "./retro-framebuffer";
import type { RetroBootProfile } from "./retro-boot-profiles";
import { setToken } from "./token";

const macBootFrame = new URL("./assets/retro/system6-happy-mac.png", import.meta.url).href;
const nextLogo = new URL("./assets/retro/logos/next.svg", import.meta.url).href;
const os2Logo = new URL("./assets/retro/logos/os2-warp.png", import.meta.url).href;
const sgiLogo = new URL("./assets/retro/logos/sgi.svg", import.meta.url).href;
const macDesktopFrame = new URL("./assets/retro/system6-desktop.png", import.meta.url).href;
const tosStartupFrame = new URL("./assets/retro/tos-1.04-desktop.png", import.meta.url).href;

interface RetroGraphicalBootScreenProps {
  profile: RetroBootProfile;
  authRequired: boolean;
  ready: boolean;
  onAuthenticated: () => void;
  onComplete: () => void;
}

type GraphicalPhase = "boot" | "username" | "password" | "verifying" | "failed" | "token" | "ready";

const shellCopy = {
  "risc-os": { title: "WMUX Logon", user: "User name", password: "Password", action: "Log on" },
  "atari-st": { title: "WMUX REMOTE ACCESS", user: "User name:", password: "Password:", action: "OK" },
  lisa: { title: "LisaTerminal — Remote System", user: "Name", password: "Password", action: "Log On" },
  irix: { title: "Welcome to the WMUX network", user: "Login name:", password: "Password:", action: "Login" },
  nextstep: { title: "WMUX Network Login", user: "Name:", password: "Password:", action: "Log In" },
  macintosh: { title: "AppleShare", user: "Name:", password: "Password:", action: "OK" },
  os2: { title: "Logon to WMUX", user: "User ID:", password: "Password:", action: "Logon" },
} as const;

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
      await pause(shell === "macintosh" ? 1_450 : 1_100);
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
    const timeout = window.setTimeout(onComplete, 3_500);
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
      setToken(result.token);
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
  const copy = shellCopy[shell];

  return (
    <main
      ref={hostRef}
      className={`retro-boot-screen retro-graphical-boot retro-graphical-${shell}`}
      style={style}
      data-boot-profile={profile.id}
      data-boot-presentation="graphical"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={() => inputRef.current?.focus()}
    >
      <section className="retro-graphical-display" aria-label={`${profile.name} graphical startup`}>
        <div className="retro-graphical-framebuffer">
          <GraphicalDesktop shell={shell} booting={phase === "boot"} />
          {phase !== "boot" ? (
            <div className="retro-graphical-login" role="group" aria-label={copy.title}>
              <div className="retro-graphical-login-title">{copy.title}</div>
              {shell === "irix" ? <img className="retro-graphical-login-logo retro-graphical-sgi-logo" src={sgiLogo} alt="SGI" /> : null}
              <div className="retro-graphical-field-row">
                <span>{copy.user}</span>
                <span className={`retro-graphical-field ${phase === "username" ? "is-active" : ""}`}>{username}</span>
              </div>
              <div className="retro-graphical-field-row">
                <span>{copy.password}</span>
                <span className={`retro-graphical-field ${phase === "password" ? "is-active" : ""}`}>{"•".repeat(password.length)}</span>
              </div>
              <div className="retro-graphical-message">
                {phase === "verifying" ? "Checking credentials…" : null}
                {phase === "failed" ? "Name or password not recognized." : null}
                {phase === "token" ? "This server requires an access token. Open its startup URL with ?token=…" : null}
                {phase === "ready" ? "WMUX READY" : null}
              </div>
              <div className="retro-graphical-actions" aria-hidden="true">
                <span>Cancel</span>
                <span className="is-default">{copy.action}</span>
              </div>
            </div>
          ) : null}
          <textarea
            ref={inputRef}
            className="retro-graphical-input"
            aria-label="Authentication input"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
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

function GraphicalDesktop({ shell, booting }: { shell: NonNullable<RetroBootProfile["graphicalShell"]>; booting: boolean }) {
  if (booting) {
    if (shell === "macintosh") return <img className="retro-graphical-full-frame" src={macBootFrame} alt="Happy Mac" />;
    if (shell === "atari-st") return <img className="retro-graphical-full-frame" src={tosStartupFrame} alt="Atari TOS 1.04 startup" />;
    if (shell === "irix") return <div className="retro-graphical-logo-boot"><img src={sgiLogo} alt="Silicon Graphics" /><span>Starting up the system…</span></div>;
    if (shell === "nextstep") return <div className="retro-graphical-logo-boot retro-next-boot"><img src={nextLogo} alt="NeXT" /><span>Loading from SCSI disk</span></div>;
    if (shell === "os2") return <div className="retro-graphical-logo-boot retro-os2-boot"><img src={os2Logo} alt="IBM OS/2 Warp" /></div>;
    return <div className="retro-graphical-blank" />;
  }

  if (shell === "macintosh") return <img className="retro-graphical-full-frame" src={macDesktopFrame} alt="Macintosh System 6 desktop" />;
  if (shell === "atari-st") return <div className="retro-atari-desktop"><div className="retro-atari-menu">Desk　 File　 View　 Options</div><span className="retro-atari-disk retro-atari-drive"><i /><small>Floppy A</small></span><span className="retro-atari-disk retro-atari-trash"><i /><small>Trash</small></span></div>;
  if (shell === "risc-os") return <div className="retro-riscos-desktop"><div className="retro-riscos-iconbar"><span className="retro-riscos-apps"><i />Apps</span><span className="retro-riscos-drive"><i />4</span><span className="retro-riscos-acorn" aria-label="Acorn system"><i /></span></div></div>;
  if (shell === "lisa") return <div className="retro-lisa-desktop"><div className="retro-lisa-menu">Desk　File/Print　Edit　Housekeeping</div><div className="retro-lisa-icons"><span className="retro-lisa-icon retro-lisa-clock"><i />Clock</span><span className="retro-lisa-icon retro-lisa-calculator"><i />Calculator</span><span className="retro-lisa-icon retro-lisa-terminal"><i />LisaTerminal</span><span className="retro-lisa-icon retro-lisa-wastebasket"><i />Wastebasket</span></div></div>;
  if (shell === "irix") return <div className="retro-irix-desktop"><div className="retro-irix-toolchest">Toolchest</div></div>;
  if (shell === "nextstep") return <div className="retro-next-desktop"><div className="retro-next-menu">Workspace　Info　File　Edit　Disk　View</div><div className="retro-next-dock"><img src={nextLogo} alt="NeXT" /></div></div>;
  return <div className="retro-os2-desktop"><div className="retro-os2-icon retro-os2-system"><i />OS/2 System</div><div className="retro-os2-icon retro-os2-connections"><i />Connections</div><div className="retro-os2-launchpad"><img src={os2Logo} alt="IBM OS/2 Warp" /><span className="retro-os2-launch-icons"><i className="retro-os2-window-icon" /><i className="retro-os2-folder-icon" /><i className="retro-os2-help-icon">?</i></span></div></div>;
}
