import { useCallback, useEffect, useRef, useState } from "react";
import { api, UnauthorizedError } from "./api";
import { writeBrowserClipboard } from "./clipboard";
import { withTokenParam } from "./token";
import type {
  BootstrapPayload,
  EventClientMessage,
  EventServerMessage,
  TerminalMedia,
  TerminalNotification,
} from "./types";

export type ServiceConnection = "connecting" | "online" | "offline";

interface UseEventStreamCallbacks {
  // Receives either a revisioned socket snapshot or a recovery bootstrap.
  onResync: (payload: BootstrapPayload) => void;
  onHealth: (delta: Extract<EventServerMessage, { type: "health" }>) => void;
  onAuthRequired: () => void;
  enabled?: boolean;
}

  // Owns the /ws/events socket: connection lifecycle with reconnect, recovery
  // bootstrap, revisioned snapshots, notifications, media, and clipboard pushes.
export function useEventStream(callbacks: UseEventStreamCallbacks) {
  const [serviceConnection, setServiceConnection] = useState<ServiceConnection>("connecting");
  const [mediaItems, setMediaItems] = useState<TerminalMedia[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  // Latest callbacks without resubscribing the socket effect.
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    if (callbacks.enabled === false) {
      setServiceConnection("offline");
      return;
    }
    let closed = false;
    let reconnectTimer: number | undefined;
    let resyncTimer: number | undefined;
    let resyncAttempts = 0;
    let socket: WebSocket | null = null;
    // Coalesce recovery bootstraps when a socket connects or a legacy server
    // emits state-only events. Current servers send complete typed snapshots.
    const scheduleResync = (delayMs = 60) => {
      if (resyncTimer) {
        if (delayMs > 0) return;
        window.clearTimeout(resyncTimer);
      }
      resyncTimer = window.setTimeout(() => {
        resyncTimer = undefined;
        if (closed) return;
        api
          .bootstrap()
          .then((payload) => {
            resyncAttempts = 0;
            setServiceConnection("online");
            callbacksRef.current.onResync(payload);
          })
          .catch((nextError) => {
            if (nextError instanceof UnauthorizedError) callbacksRef.current.onAuthRequired();
            else {
              resyncAttempts += 1;
              setServiceConnection("offline");
              console.warn(`wmux: event resync failed; retrying: ${String(nextError)}`);
              scheduleResync(Math.min(15_000, 500 * (2 ** Math.min(resyncAttempts, 5))));
            }
          });
      }, delayMs);
    };
    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      setServiceConnection("connecting");
      const ws = new WebSocket(withTokenParam(`${protocol}//${window.location.host}/ws/events`));
      socket = ws;
      socketRef.current = ws;
      ws.onopen = () => {
        setServiceConnection("online");
        // Re-bootstrap on every (re)connect so state that changed while the
        // socket was down — including a full server restart — is picked up
        // instead of leaving the UI stale until the next incidental event.
        scheduleResync(0);
      };
      ws.onmessage = (event) => {
        let message: EventServerMessage;
        try {
          message = JSON.parse(String(event.data)) as EventServerMessage;
        } catch {
          return;
        }
        if (message.type === "notification") {
          showBrowserNotification(message.notification);
        }
        if (message.type === "media") {
          const media = message.media;
          setMediaItems((items) => [media, ...items.filter((item) => item.id !== media.id)].slice(0, 20));
        }
        if (message.type === "clipboard") {
          void writeBrowserClipboard(message.clipboard.text).catch(() => undefined);
        }
        if (message.type === "snapshot" && message.state) {
          callbacksRef.current.onResync(message.state);
        }
        if (message.type === "health") callbacksRef.current.onHealth(message);
        if (message.type === "state") {
          scheduleResync(0);
        }
      };
      ws.onclose = () => {
        if (socketRef.current === ws) socketRef.current = null;
        if (!closed) {
          setServiceConnection("offline");
          reconnectTimer = window.setTimeout(connect, 1500);
        }
      };
      ws.onerror = () => setServiceConnection("offline");
    };
    const resume = () => {
      if (document.visibilityState === "hidden") return;
      if (socket?.readyState === WebSocket.OPEN) {
        scheduleResync(0);
        return;
      }
      if (socket?.readyState === WebSocket.CONNECTING) return;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      connect();
    };
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    connect();
    return () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (resyncTimer) window.clearTimeout(resyncTimer);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
      if (socketRef.current === socket) socketRef.current = null;
      socket?.close();
    };
  }, [callbacks.enabled]);

  const sendEventSocketMessage = useCallback((message: EventClientMessage): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  const dismissMedia = useCallback((mediaId: string) => {
    setMediaItems((items) => items.filter((item) => item.id !== mediaId));
  }, []);

  return { serviceConnection, mediaItems, dismissMedia, sendEventSocketMessage };
}

const showBrowserNotification = (notification: TerminalNotification): void => {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const title = notification.subtitle ? `${notification.title}: ${notification.subtitle}` : notification.title;
  new Notification(title, {
    body: notification.body,
    tag: notification.id,
  });
};
