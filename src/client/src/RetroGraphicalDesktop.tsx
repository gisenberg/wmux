import { type ReactNode, useLayoutEffect, useRef } from "react";
import type { RetroBootProfile } from "./retro-boot-profiles";

// Shared by wmux and the werdr boot console; keep this file free of
// application imports beyond the boot profiles. Screens that render it also
// import retro-graphical-desktop.css.
const nextLogo = new URL("./assets/retro/logos/next.svg", import.meta.url).href;
const os2Logo = new URL("./assets/retro/logos/os2-warp.png", import.meta.url).href;

export type GraphicalShell = NonNullable<RetroBootProfile["graphicalShell"]>;

export interface GraphicalBootStage {
  readonly id: string;
  readonly duration: number;
}

// Each scene is drawn at the machine's native resolution and scaled to the
// displayed picture, so non-square pixels stretch as they did on the monitor.
export const GRAPHICAL_SCREEN: Readonly<Record<GraphicalShell, readonly [width: number, height: number]>> = {
  "risc-os": [640, 256],
  "atari-st": [320, 200],
  lisa: [720, 364],
  irix: [1280, 1024],
  nextstep: [1120, 832],
  os2: [640, 480],
};

// Startup scenes in order; the login dialog follows on the desktop.
export const GRAPHICAL_BOOT_STAGES: Readonly<Record<GraphicalShell, readonly GraphicalBootStage[]>> = {
  "risc-os": [
    { id: "post-purple", duration: 200 },
    { id: "post-blue", duration: 500 },
    { id: "post-purple-again", duration: 150 },
    { id: "post-green", duration: 250 },
    { id: "banner", duration: 700 },
    { id: "initialising", duration: 900 },
  ],
  "atari-st": [
    { id: "blank", duration: 600 },
    { id: "busy", duration: 700 },
  ],
  lisa: [
    { id: "test-0", duration: 300 },
    { id: "test-1", duration: 250 },
    { id: "test-2", duration: 250 },
    { id: "test-3", duration: 250 },
    { id: "test-4", duration: 350 },
    { id: "office", duration: 1100 },
  ],
  irix: [
    { id: "diagnostics", duration: 900 },
    { id: "starting", duration: 900 },
    { id: "coming-up", duration: 700 },
  ],
  nextstep: [
    { id: "rom-testing", duration: 700 },
    { id: "rom-loading", duration: 900 },
    { id: "initializing", duration: 1000 },
  ],
  os2: [
    { id: "corner", duration: 500 },
    { id: "logo", duration: 1300 },
  ],
};

export const GRAPHICAL_DESKTOP_STAGE = "desktop";

export interface GraphicalLoginState {
  field: "username" | "password" | "token" | null;
  username: string;
  secretLength: number;
  message: string;
  submitDisabled: boolean;
  onSubmit?: () => void;
}

interface LoginCopy {
  title: string;
  user: string;
  password: string;
  action?: string;
  secondary?: readonly string[];
  fixed?: readonly (readonly [label: string, value: string])[];
  note?: string;
}

const LOGIN_COPY: Readonly<Record<GraphicalShell, LoginCopy>> = {
  // RISC OS NetFS logon fields; the file server names the fictional service.
  "risc-os": { title: "Logon", user: "User name", password: "Password", action: "Logon", fixed: [["File server", "WMUX"]] },
  "atari-st": { title: "WMUX REMOTE ACCESS", user: "User name:", password: "Password:", action: "OK", secondary: ["Cancel"] },
  lisa: { title: "LisaTerminal", user: "Name", password: "Password", action: "Log On" },
  // clogin asks for the name first; the password field follows.
  irix: { title: "Clogin", user: "Login name:", password: "Password:", action: "Log In", secondary: ["Help"] },
  // loginwindow has no title or submit button; Return logs in.
  nextstep: { title: "", user: "Name", password: "Password" },
  os2: {
    title: "LAN Logon",
    user: "User ID",
    password: "Password",
    action: "OK",
    secondary: ["Cancel", "Help"],
    note: "Note: The password will not display.",
    fixed: [["Verification", "Local"]],
  },
};

export const graphicalLoginTitle = (shell: GraphicalShell) => LOGIN_COPY[shell].title || "NEXTSTEP login";

// Lays children out on a native-resolution screen scaled to fill its parent,
// stretching non-uniformly as the monitor did.
export function NativeScreen({
  width,
  height,
  className,
  children,
}: {
  width: number;
  height: number;
  className?: string;
  children: ReactNode;
}) {
  const outerRef = useRef<HTMLSpanElement>(null);
  const screenRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const screen = screenRef.current;
    if (!outer || !screen) return;
    const fit = () => {
      screen.style.transform = `scale(${outer.clientWidth / width}, ${outer.clientHeight / height})`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(outer);
    return () => observer.disconnect();
  }, [height, width]);

  // Spans keep the screen valid inside interactive parents such as the Guru button.
  return (
    <span ref={outerRef} className="retro-gx">
      <span ref={screenRef} className={`retro-gx-screen${className ? ` ${className}` : ""}`} style={{ width, height }}>
        {children}
      </span>
    </span>
  );
}

export function GraphicalScene({
  shell,
  stage,
  login,
  brand = (text) => text,
}: {
  shell: GraphicalShell;
  stage: string;
  login?: GraphicalLoginState;
  brand?: (text: string) => string;
}) {
  const [width, height] = GRAPHICAL_SCREEN[shell];
  return (
    <NativeScreen width={width} height={height} className={`retro-gx-${shell}`}>
      <div className="retro-gx-fill" data-graphical-stage={stage}>
        {stage === GRAPHICAL_DESKTOP_STAGE ? (
          <>
            <Desktop shell={shell} />
            {login ? <GraphicalLogin shell={shell} login={login} brand={brand} /> : null}
          </>
        ) : (
          <BootStage shell={shell} stage={stage} />
        )}
      </div>
    </NativeScreen>
  );
}

// Exec's alert: a 40-line red frame across the top of a 640x200 screen.
export function AmigaGuruAlert() {
  return (
    <NativeScreen width={640} height={200} className="retro-amiga-guru-screen">
      <span className="retro-amiga-guru-alert">
        <span className="retro-amiga-guru-failure">Software Failure.</span>
        <span className="retro-amiga-guru-press">Press left mouse button to continue.</span>
        <span className="retro-amiga-guru-number">Guru Meditation #0000000B.00C01570</span>
      </span>
    </NativeScreen>
  );
}

// MSX2 BIOS title: the logo scrolls up on blue, above the VRAM size.
export function Msx2Title({ logo }: { logo: string }) {
  return (
    <NativeScreen width={256} height={212} className="retro-msx2-title">
      <img src={logo} alt="MSX" />
      <span>VRAM:128Kbytes</span>
    </NativeScreen>
  );
}

function BootStage({ shell, stage }: { shell: GraphicalShell; stage: string }): ReactNode {
  switch (shell) {
    case "risc-os":
      if (stage.startsWith("post-")) return <div className={`retro-gx-fill retro-riscos-${stage}`} />;
      if (stage === "banner") return <div className="retro-gx-fill retro-riscos-banner">RISC OS 2048K</div>;
      return (
        <div className="retro-gx-fill retro-riscos-backdrop">
          <div className="retro-riscos-startup">
            <i className="retro-riscos-acorn-logo" />
            <strong>RISC OS 3</strong>
            <span>© Acorn Computers Ltd, 1992</span>
            <b>Initialising . . .</b>
          </div>
        </div>
      );
    case "atari-st":
      return <div className="retro-gx-fill retro-atari-blank">{stage === "busy" ? <BusyBee /> : null}</div>;
    case "lisa": {
      if (stage === "office") {
        return (
          <div className="retro-gx-fill retro-lisa-pattern">
            <div className="retro-lisa-office">
              <span className="retro-lisa-wait">Wait</span>
              <span className="retro-lisa-release">
                <span><em>Lisa</em> 7/7</span>
                <span>Office System{"   "}Release 3.1</span>
                <span>©1983, 1984 apple computer, inc.</span>
              </span>
            </div>
          </div>
        );
      }
      const passed = Number(stage.slice("test-".length));
      return (
        <div className="retro-gx-fill retro-lisa-pattern">
          <div className="retro-lisa-rom-strip"><span>H/88</span></div>
          <div className="retro-lisa-testing">
            <span>TESTING...</span>
            <span className="retro-lisa-test-icons">
              {["CPU", "MEM", "I/O", "DISK"].map((label, index) => (
                <span key={label} className={index < passed ? "is-passed" : undefined}><i />{label}</span>
              ))}
            </span>
          </div>
        </div>
      );
    }
    case "irix":
      return (
        <div className="retro-gx-fill retro-irix-prom">
          <span className="retro-irix-welcome">W E L C O M E{"   "}T O</span>
          <span className="retro-irix-indigo">INDIGO<sup>2</sup></span>
          <span className="retro-irix-sgi">Silicon Graphics Computer Systems</span>
          <div className={`retro-irix-notifier retro-irix-${stage}`}>
            {stage === "coming-up" ? null : <i className="retro-irix-hourglass" />}
            <span>
              {stage === "diagnostics" ? "Running power-on diagnostics..." : null}
              {stage === "starting" ? "Starting up the system..." : null}
              {stage === "coming-up" ? "The system is coming up." : null}
            </span>
            {stage === "starting" ? <span className="retro-irix-button">Stop for Maintenance</span> : null}
          </div>
        </div>
      );
    case "nextstep":
      if (stage === "initializing") {
        return (
          <div className="retro-gx-fill retro-next-screen">
            <div className="retro-next-panel">
              <strong className="retro-next-wordmark">NEXTSTEP</strong>
              <span className="retro-next-progress"><i /></span>
              <em>Initializing system</em>
              <img src={nextLogo} alt="" />
            </div>
          </div>
        );
      }
      return (
        <div className="retro-gx-fill retro-next-screen">
          <div className="retro-next-rom">
            <img src={nextLogo} alt="NeXT" />
            <span>{stage === "rom-testing" ? "Testing\nsystem ..." : "Loading\nfrom\ndisk ..."}</span>
            {stage === "rom-loading" ? <i className="retro-next-scsi" /> : null}
          </div>
        </div>
      );
    case "os2":
      if (stage === "corner") return <div className="retro-gx-fill retro-os2-black"><i className="retro-os2-corner" /></div>;
      return (
        <div className="retro-gx-fill retro-os2-black">
          <div className="retro-os2-logo">
            <span>IBM</span>
            <img src={os2Logo} alt="OS/2 Warp" />
          </div>
          <pre className="retro-os2-copyright">
            {"Operating System/2 Version 3\n(C) Copyright IBM Corp. 1987, 1994.  All rights reserved."}
          </pre>
        </div>
      );
  }
}

function Desktop({ shell }: { shell: GraphicalShell }): ReactNode {
  switch (shell) {
    case "risc-os":
      return (
        <div className="retro-gx-fill retro-riscos-backdrop">
          <div className="retro-riscos-iconbar">
            <span className="retro-riscos-icon retro-riscos-floppy"><i />:0</span>
            <span className="retro-riscos-icon retro-riscos-apps"><i />Apps</span>
            <span className="retro-riscos-icon retro-riscos-palette"><i /></span>
            <span className="retro-riscos-icon retro-riscos-taskmanager" aria-label="Acorn task manager"><i /></span>
          </div>
        </div>
      );
    case "atari-st":
      return (
        <div className="retro-gx-fill retro-atari-desktop">
          <div className="retro-atari-menu">{" Desk  File  View  Options"}</div>
          <AtariIcon className="retro-atari-drive-a" letter="A" label="FLOPPY DISK" />
          <AtariIcon className="retro-atari-drive-b" letter="B" label="FLOPPY DISK" />
          <AtariIcon className="retro-atari-trash" label="TRASH" />
        </div>
      );
    case "lisa":
      return (
        <div className="retro-gx-fill retro-lisa-pattern">
          <div className="retro-lisa-menu">Desk{"  "}File/Print{"  "}Edit{"  "}Housekeeping</div>
          {["Preferences", "Wastebasket", "Clipboard", "Disk"].map((label) => (
            <span key={label} className={`retro-lisa-icon retro-lisa-${label.toLowerCase()}`}><i /><small>{label}</small></span>
          ))}
        </div>
      );
    case "irix":
      return <div className="retro-gx-fill retro-irix-root" />;
    case "nextstep":
      return <div className="retro-gx-fill retro-next-screen" />;
    case "os2":
      return (
        <div className="retro-gx-fill retro-os2-desktop">
          {[
            ["system", "OS/2 System"],
            ["information", "Information"],
            ["templates", "Templates"],
            ["dos", "DOS Programs"],
            ["winos2", "WIN-OS/2 Groups"],
            ["windows", "Windows Programs"],
            ["multimedia", "Multimedia"],
          ].map(([id, label]) => (
            <span key={id} className={`retro-os2-icon retro-os2-${id}`}><i />{label}</span>
          ))}
          <div className="retro-os2-launchpad">
            {["Lockup", "Find", "Shut down", "Window list"].map((label) => <span key={label}>{label}</span>)}
            <span className="retro-os2-drawers">{["printer", "drives", "window", "help", "shredder"].map((id) => <i key={id} className={`retro-os2-drawer-${id}`} />)}</span>
          </div>
        </div>
      );
  }
}

function GraphicalLogin({ shell, login, brand }: { shell: GraphicalShell; login: GraphicalLoginState; brand: (text: string) => string }) {
  const copy = LOGIN_COPY[shell];
  const title = brand(copy.title);
  const showPassword = shell !== "irix" || login.field !== "username";
  return (
    <div className="retro-graphical-login" role="group" aria-label={brand(graphicalLoginTitle(shell))}>
      {title ? <div className="retro-graphical-login-title">{title}</div> : null}
      {shell === "nextstep" ? <strong className="retro-next-wordmark">NEXTSTEP</strong> : null}
      {shell === "irix" ? (
        <div className="retro-irix-users" aria-hidden="true">
          {["root", "EZsetup", "guest"].map((user) => <span key={user} className={`retro-irix-user-${user.toLowerCase()}`}><i />{user}</span>)}
        </div>
      ) : null}
      {copy.note ? <div className="retro-graphical-note">{copy.note}</div> : null}
      {copy.fixed?.map(([label, value]) => (
        <div key={label} className="retro-graphical-field-row">
          <span>{label}</span>
          <span className="retro-graphical-static-field">{brand(value)}</span>
        </div>
      ))}
      <div className="retro-graphical-field-row">
        <span>{copy.user}</span>
        <span className={`retro-graphical-field ${login.field === "username" ? "is-active" : ""}`}>{login.username}</span>
      </div>
      {showPassword ? (
        <div className="retro-graphical-field-row">
          <span>{login.field === "token" ? "Access token" : copy.password}</span>
          <span className={`retro-graphical-field ${login.field === "password" || login.field === "token" ? "is-active" : ""}`}>
            {"•".repeat(Math.min(login.secretLength, 32))}
          </span>
        </div>
      ) : null}
      <div className="retro-graphical-message" role="status">{login.message}</div>
      {shell === "irix" ? <span className="retro-irix-hostname">IRIS</span> : null}
      <div className="retro-graphical-actions">
        {shell === "nextstep" ? (
          <>
            <img src={nextLogo} alt="" />
            <span>Restart</span>
            <span>Power</span>
          </>
        ) : null}
        {copy.secondary?.map((label) => <span key={label} aria-hidden="true">{label}</span>)}
        {copy.action ? (
          <button type="button" className="is-default" disabled={login.submitDisabled} onClick={login.onSubmit}>
            {copy.action}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function AtariIcon({ className, letter, label }: { className: string; letter?: string; label: string }) {
  return (
    <span className={`retro-atari-icon ${className}`}>
      <i>{letter}</i>
      <small>{label}</small>
    </span>
  );
}

// TOS draws its busy cursor as a bee; this is a 16x16 approximation of it.
function BusyBee() {
  return (
    <svg className="retro-atari-bee" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 1h2v2H5zM9 1h2v2H9zM3 4h4v3H3zM9 4h4v3H9zM6 6h4v9H6z" fill="#000" />
      <path d="M7 8h2v1H7zM7 11h2v1H7z" fill="#fff" />
    </svg>
  );
}
