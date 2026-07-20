import { useEffect, useState } from "react";
import { api } from "./api";
import { App } from "./App";
import { LoginView } from "./LoginView";
import { clearNonSessionToken, getToken, setToken } from "./token";

type GateState = "checking" | "compatibility" | "login" | "authenticated" | "unavailable";

export const BrowserAuthGate = () => {
  const [state, setState] = useState<GateState>("checking");

  const validateSession = async (): Promise<void> => {
    try {
      await api.authSession();
      setState("authenticated");
    } catch {
      setToken("");
      setState("login");
    }
  };

  useEffect(() => {
    let cancelled = false;
    void api.authInfo().then(async (info) => {
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
        await api.authSession();
        if (!cancelled) setState("authenticated");
      } catch {
        if (!cancelled) {
          setToken("");
          setState("login");
        }
      }
    }).catch(() => {
      if (!cancelled) setState("unavailable");
    });
    return () => { cancelled = true; };
  }, []);

  if (state === "compatibility" || state === "authenticated") return <App />;
  if (state === "login") return <LoginView onAuthenticated={() => void validateSession()} />;
  if (state === "unavailable") return <div className="wmux-login"><p className="wmux-login-error">Authentication service unavailable</p></div>;
  return null;
};
