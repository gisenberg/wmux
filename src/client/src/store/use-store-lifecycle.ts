import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { api, UnauthorizedError } from "../api";
import { useEventStream } from "../useEventStream";
import type { BootstrapPayload } from "../types";
import type { AppStore } from "./core";
import {
  applyHealthDelta,
  bootstrapSatisfiesHealthDelta,
  healthDeltaRequiresResync,
  isIncomingRevisionNewer,
  reconcileIncomingRevision,
} from "./reconcile";

interface StoreLifecycleOptions {
  store: AppStore;
  rebaseIncomingState: (payload: BootstrapPayload) => BootstrapPayload;
  activateRouteTarget: (payload: BootstrapPayload) => BootstrapPayload;
  describeError: (error: unknown) => string;
}

export const useStoreLifecycle = ({
  store,
  rebaseIncomingState,
  activateRouteTarget,
  describeError,
}: StoreLifecycleOptions) => {
  const [loadError, setLoadError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const retryTimer = useRef<number | undefined>(undefined);
  const retryAttempt = useRef(0);
  const requestId = useRef(0);
  const loadRef = useRef<() => Promise<void>>(async () => undefined);
  const refreshRef = useRef<(payload?: BootstrapPayload) => Promise<void>>(async () => undefined);
  const pendingHealthResync = useRef<Pick<BootstrapPayload, "revision" | "healthEpoch"> | null>(null);

  const load = useCallback(async () => {
    const currentRequestId = ++requestId.current;
    if (retryTimer.current) window.clearTimeout(retryTimer.current);
    retryTimer.current = undefined;
    try {
      const payload = await api.bootstrap();
      const routed = rebaseIncomingState(activateRouteTarget(payload));
      if (currentRequestId !== requestId.current) return;
      if (!bootstrapSatisfiesHealthDelta(pendingHealthResync.current, routed)) {
        void loadRef.current();
        return;
      }
      pendingHealthResync.current = null;
      retryAttempt.current = 0;
      setLoadError(null);
      setAuthRequired(false);
      const current = store.get();
      const next = reconcileIncomingRevision(current, routed);
      if (next !== current) store.set(next);
    } catch (error) {
      if (currentRequestId !== requestId.current) return;
      if (error instanceof UnauthorizedError) {
        retryAttempt.current = 0;
        setLoadError(null);
        setAuthRequired(true);
        return;
      }
      retryAttempt.current += 1;
      if (!store.get()) setLoadError(describeError(error));
      const delay = Math.min(15_000, 500 * (2 ** Math.min(retryAttempt.current, 5)));
      retryTimer.current = window.setTimeout(() => void loadRef.current(), delay);
    }
  }, [activateRouteTarget, describeError, rebaseIncomingState, store]);
  loadRef.current = load;

  useEffect(() => {
    void load();
    const resume = () => {
      if (document.visibilityState === "hidden" || store.get()) return;
      void loadRef.current();
    };
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      requestId.current += 1;
      if (retryTimer.current) window.clearTimeout(retryTimer.current);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [load, store]);

  const eventStream = useEventStream({
    enabled: !authRequired,
    onResync: (payload) => {
      if (!bootstrapSatisfiesHealthDelta(pendingHealthResync.current, payload)) return;
      pendingHealthResync.current = null;
      void refreshRef.current(payload);
    },
    onHealth: (delta) => {
      const current = store.get();
      if (healthDeltaRequiresResync(current, delta)) {
        const pending = pendingHealthResync.current;
        if (!pending || isIncomingRevisionNewer(pending, delta)) {
          pendingHealthResync.current = delta;
          void loadRef.current();
        }
        return;
      }
      store.update((snapshot) => applyHealthDelta(snapshot, delta) ?? null);
    },
    onAuthRequired: () => setAuthRequired(true),
  });

  return {
    ...eventStream,
    authRequired,
    load,
    loadError,
    loadRef,
    refreshRef: refreshRef as MutableRefObject<(payload?: BootstrapPayload) => Promise<void>>,
  };
};
