import { useCallback, useEffect, useRef, useState } from "react";

export type ToastTone = "error" | "info";

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
  status: string;
  action?: ToastAction;
  dismissible: boolean;
}

const TOAST_TTL_MS = 6000;

export interface ToastAction {
  label: string;
  accessibleLabel: string;
  run: () => void;
}

export interface ToastOptions {
  action?: ToastAction;
  dismissible?: boolean;
  durationMs?: number;
  status?: string;
}

export interface ToastController {
  toasts: Toast[];
  pushToast: (message: string, tone?: ToastTone, options?: ToastOptions) => number;
  dismissToast: (id: number) => void;
}

/**
 * Transient, non-fatal notifications. Unlike the fatal load-error overlay, these
 * report a failed action (a split/close/save that didn't apply) without tearing
 * down the app, so user actions never fail silently.
 */
export const useToasts = (): ToastController => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismissToast = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback(
    (message: string, tone: ToastTone = "error", options: ToastOptions = {}) => {
      const id = nextId.current++;
      const toast: Toast = {
        id,
        message,
        tone,
        status: (options.status ?? tone).toUpperCase(),
        action: options.action,
        dismissible: options.dismissible ?? true,
      };
      setToasts((current) => [...current, toast].slice(-4));
      const durationMs = options.durationMs ?? TOAST_TTL_MS;
      if (durationMs > 0) {
        timers.current.set(id, window.setTimeout(() => dismissToast(id), durationMs));
      }
      return id;
    },
    [dismissToast],
  );

  useEffect(() => () => {
    for (const timer of timers.current.values()) window.clearTimeout(timer);
    timers.current.clear();
  }, []);

  return { toasts, pushToast, dismissToast };
};

export const Toasts = ({ toasts, dismissToast }: Pick<ToastController, "toasts" | "dismissToast">) => {
  if (toasts.length === 0) return null;
  return (
    <div className="wmux-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`wmux-toast wmux-toast-${toast.tone}`}>
          <span className="wmux-toast-status">[{toast.status}]</span>
          <span className="wmux-toast-message">{toast.message}</span>
          {toast.action ? (
            <button
              type="button"
              className="wmux-toast-action"
              aria-label={toast.action.accessibleLabel}
              onClick={() => {
                toast.action?.run();
                dismissToast(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          ) : null}
          {toast.dismissible ? (
            <button
              type="button"
              className="wmux-toast-dismiss"
              aria-label="Dismiss notification"
              onClick={() => dismissToast(toast.id)}
            >
              [X]
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
};
