import { useEffect, useState } from "react";
import { api, UnauthorizedError } from "./api";
import { App } from "./App";
import { LoginView } from "./LoginView";
import { clearNonSessionToken, getToken, setToken } from "./token";

type GateState = "checking" | "compatibility" | "login" | "authenticated" | "unavailable";

const transientRetryDelaysMs = [0, 250, 750, 1_500] as const;

const retryTransient = async <T,>(request: () => Promise<T>): Promise<T> => {
  let lastError: unknown;
  for (const delayMs of transientRetryDelaysMs) {
    if (delayMs > 0) await new Promise((resolve) => window.setTimeout(resolve, delayMs));
    try {
      return await request();
    } catch (error) {
      if (error instanceof UnauthorizedError) throw error;
      lastError = error;
    }
  }
  throw lastError;
};

export const BrowserAuthGate = () => {
  const [state, setState] = useState<GateState>("checking");
  const [retryGeneration, setRetryGeneration] = useState(0);

  const validateSession = async (): Promise<void> => {
    setState("checking");
    try {
      await retryTransient(api.authSession);
      setState("authenticated");
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        setToken("");
        setState("login");
      } else {
        setState("unavailable");
      }
    }
  };

  useEffect(() => {
    let cancelled = false;
    setState("checking");
    void retryTransient(api.authInfo).then(async (info) => {
      if (cancelled) return;
      if (info.browserAuthMode !== "login-only") {
        setState("compatibility");
        return;
      }
      clearNonSessionToken();
      if (!getToken()) {
        setState("login");
        return;
      }
      try {
        await retryTransient(api.authSession);
        if (!cancelled) setState("authenticated");
      } catch (error) {
        if (!cancelled) {
          if (error instanceof UnauthorizedError) {
            setToken("");
            setState("login");
          } else {
            setState("unavailable");
          }
        }
      }
    }).catch(() => {
      if (!cancelled) setState("unavailable");
    });
    return () => { cancelled = true; };
  }, [retryGeneration]);

  if (state === "compatibility" || state === "authenticated") return <App />;
  if (state === "login") return <LoginView loginEnabled onAuthenticated={() => void validateSession()} />;
  if (state === "unavailable") {
    return (
      <div className="wmux-login">
        <div className="wmux-login-card">
          <p className="wmux-login-error">Authentication service unavailable</p>
          <button type="button" className="wmux-login-submit" onClick={() => setRetryGeneration((value) => value + 1)}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  return null;
};
