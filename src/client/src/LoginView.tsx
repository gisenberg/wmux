import { useState } from "react";
import { api } from "./api";
import { setToken } from "./token";

interface LoginViewProps {
  embedded?: boolean;
  loginEnabled: boolean;
  onAuthenticated: () => void;
}

/**
 * Shown when the app is unauthenticated. If credential login is configured it
 * offers a username/password form (minting a session token); otherwise it
 * explains the token-URL path used by machine clients.
 */
export const LoginView = ({ embedded = false, loginEnabled, onAuthenticated }: LoginViewProps) => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { token } = await api.login(username, password);
      setToken(token);
      onAuthenticated();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`wmux-login ${embedded ? "c64-login" : ""}`}>
      <form className="wmux-login-card" onSubmit={submit}>
        <h1 className="wmux-login-title">{embedded ? "Authentication required" : "wmux"}</h1>
        {loginEnabled === false ? (
          <p className="wmux-login-hint">
            {embedded ? "ACCESS TOKEN REQUIRED. OPEN THE STARTUP URL INCLUDING" : "This server requires an access token. Open the URL the server printed on startup, including"}
            <code> ?token=…</code>.
          </p>
        ) : (
          <>
            <label className="wmux-login-field">
              <span>Username</span>
              <input
                autoFocus
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>
            <label className="wmux-login-field">
              <span>Password</span>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            {error ? <p className="wmux-login-error">{embedded ? `?${error}` : error}</p> : null}
            <button type="submit" className="wmux-login-submit" disabled={busy}>
              {embedded ? (busy ? "VERIFYING..." : "PRESS RETURN") : busy ? "Signing in…" : "Sign in"}
            </button>
          </>
        )}
      </form>
    </div>
  );
};
