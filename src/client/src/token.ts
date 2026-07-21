// Shared access token handling for the browser client.
//
// The token arrives once via `?token=…` (from the URL the server logs on
// startup). We persist it to localStorage, strip it from the address bar so it
// doesn't linger in history/screenshots, and attach it to every API call and
// WebSocket connection thereafter.

const STORAGE_KEY = "wmux.token";

let cachedToken = "";

export const initToken = (): void => {
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("token");
    if (fromUrl) {
      window.localStorage.setItem(STORAGE_KEY, fromUrl);
      params.delete("token");
      const query = params.toString();
      const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
      window.history.replaceState(null, "", nextUrl);
    }
    cachedToken = window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    cachedToken = "";
  }
};

export const getToken = (): string => cachedToken;

export const isBrowserSessionToken = (token: string): boolean => token.startsWith("wsess.");

export const clearNonSessionToken = (): void => {
  if (!isBrowserSessionToken(cachedToken)) setToken("");
};

export const setToken = (token: string): void => {
  cachedToken = token.trim();
  try {
    if (cachedToken) window.localStorage.setItem(STORAGE_KEY, cachedToken);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable; keep the in-memory value */
  }
};

export const authHeaders = (): Record<string, string> =>
  cachedToken ? { authorization: `Bearer ${cachedToken}` } : {};

/** Append the token as a query param — used for WebSocket URLs, which can't send headers. */
export const withTokenParam = (url: string): string => {
  if (!cachedToken) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(cachedToken)}`;
};
