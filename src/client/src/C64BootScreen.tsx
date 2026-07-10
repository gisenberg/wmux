import { useEffect, useRef, useState } from "react";
import { FitAddon, Terminal } from "ghostty-web";
import { api } from "./api";
import { ensureGhostty } from "./terminal-loader";
import { setToken } from "./token";

interface C64BootScreenProps {
  authRequired: boolean;
  ready: boolean;
  onAuthenticated: () => void;
  onComplete: () => void;
}

const C64_BLUE = "#40318d";
const C64_LIGHT_BLUE = "#7869c4";
const C64_FONT_FAMILY = '"C64 Pro Mono", monospace';

export function C64BootScreen({ authRequired, ready, onAuthenticated, onComplete }: C64BootScreenProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const authRequiredRef = useRef(authRequired);
  const readyRef = useRef(ready);
  const [status, setStatus] = useState("Starting Ghostty");

  useEffect(() => {
    authRequiredRef.current = authRequired;
  }, [authRequired]);

  useEffect(() => {
    readyRef.current = ready;
  }, [ready]);

  useEffect(() => {
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
      write("USERNAME> ");
      requestAnimationFrame(() => terminal?.focus());
    };

    const submitCredentials = async () => {
      const password = credentialInput;
      credentialInput = "";
      authStage = "submitting";
      setStatus("Verifying credentials");
      write("VERIFYING...\n");
      try {
        const result = await api.login(username, password);
        if (cancelled) return;
        setToken(result.token);
        onAuthenticated();
      } catch {
        if (cancelled) return;
        write("?LOGIN FAILED ERROR\n");
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
        write("PASSWORD> ");
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
        "fonts" in document ? document.fonts.load(`400 16px ${C64_FONT_FAMILY}`) : Promise.resolve(),
      ]);
      if (cancelled || !hostRef.current) return;

      terminal = new Terminal({
        cols: 40,
        rows: 25,
        cursorBlink: true,
        cursorStyle: "block",
        disableStdin: false,
        fontSize: window.matchMedia("(max-width: 600px)").matches ? 13 : 17,
        fontFamily: C64_FONT_FAMILY,
        scrollback: 0,
        theme: {
          background: C64_BLUE,
          foreground: C64_LIGHT_BLUE,
          cursor: C64_LIGHT_BLUE,
          cursorAccent: C64_BLUE,
          selectionBackground: C64_LIGHT_BLUE,
          selectionForeground: C64_BLUE,
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

      setStatus("Reading wmux disk directory");
      write("\x1b[2J\x1b[H");
      write("    **** COMMODORE 64 BASIC V2 ****\n\n");
      write(" 64K RAM SYSTEM  38911 BASIC BYTES FREE\n\n");
      write("READY.\n");
      await pause(130);
      write('LOAD "$",8\n\n');
      await pause(100);
      write("SEARCHING FOR $\nLOADING\nREADY.\n");
      await pause(120);
      write("LIST\n\n");

      const directory = [
        '0 "WMUX BOOT DISK" 64 2A',
        '4    "GHOSTTY"          PRG',
        '8    "MACHINES"         SEQ',
        '12   "WORKSPACES"       SEQ',
        '16   "SESSIONS"         PRG',
        '20   "EVENTS"           REL',
        "644 BLOCKS FREE.",
      ];
      for (const line of directory) {
        if (cancelled) return;
        write(`${line}\n`);
        await pause(55);
      }

      setStatus("Loading wmux bootstrap program");
      await pause(100);
      write("\nREADY.\n");
      write('LOAD "*",8\n\n');
      await pause(120);
      write("SEARCHING FOR *\nLOADING\nREADY.\n");
      await pause(120);
      write("LIST\n\n");

      const program = [
        '10 PRINT "WMUX LOADING"',
        "20 SYS 49152 : REM START GHOSTTY",
        "30 GOSUB 100 : REM MACHINES",
        "40 GOSUB 200 : REM WORKSPACES",
        "50 GOSUB 300 : REM SESSIONS",
        "60 GOSUB 400 : REM EVENTS",
        '70 PRINT "READY."',
        "80 END",
      ];
      for (const line of program) {
        if (cancelled) return;
        write(`${line}\n`);
        await pause(45);
      }

      setStatus("Waiting for wmux service");
      write("\nREADY.\nRUN\n");
      let challenged = false;
      const showAuthChallenge = async () => {
        if (challenged || !authRequiredRef.current) return;
        challenged = true;
        setStatus("Authentication required");
        write("\n?AUTHENTICATION REQUIRED\n");
        try {
          const info = await api.authInfo();
          if (cancelled) return;
          if (!info.loginEnabled) {
            write("ACCESS TOKEN REQUIRED.\nOPEN THE STARTUP URL WITH ?TOKEN=...\n");
            setStatus("Access token required");
            return;
          }
          promptForUsername();
        } catch {
          if (!cancelled) {
            write("?AUTH SERVICE UNAVAILABLE ERROR\n");
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
      write(challenged ? "\nACCESS GRANTED.\nWMUX READY.\n" : "\nWMUX READY.\n");
      await pause(260);
      if (!cancelled) onComplete();
    };

    void start();
    return () => {
      cancelled = true;
      fitAddon?.dispose();
      terminal?.dispose();
    };
  }, [onComplete]);

  return (
    <main className="c64-boot-screen">
      <section className="c64-boot-bezel" aria-label="wmux loading">
        <div ref={hostRef} className="c64-boot-terminal" aria-label="C64 authentication console" />
        <span className="visually-hidden" role="status" aria-live="polite">
          {status}
        </span>
      </section>
    </main>
  );
}
