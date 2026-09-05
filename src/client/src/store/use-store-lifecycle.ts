import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { api, UnauthorizedError } from "../api";
import { BootstrapRecovery } from "../bootstrap-recovery";
import { useEventStream } from "../useEventStream";
import type { BootstrapPayload, EventServerMessage } from "../types";
import type { AppStore } from "./core";
import {
  applyEventDelta,
  applyHealthDelta,
  bootstrapSatisfiesEventDelta,
  bootstrapSatisfiesHealthDelta,
  eventDeltaRequiresResync,
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
  const recoveryRef = useRef<BootstrapRecovery<BootstrapPayload> | undefined>(undefined);
  const loadRef = useRef<() => Promise<void>>(async () => undefined);
  const refreshRef = useRef<(payload?: BootstrapPayload) => Promise<void>>(async () => undefined);
  const pendingHealthResync = useRef<Pick<BootstrapPayload, "revision" | "healthEpoch"> | null>(null);
  const pendingEventResync = useRef<Pick<
    Extract<EventServerMessage, { type: "delta" }>,
    "eventRevision" | "healthEpoch"
  > | null>(null);

  const load = useCallback(async () => { await recoveryRef.current?.request(); }, []);
  loadRef.current = load;

  useEffect(() => {
    const recovery = new BootstrapRecovery<BootstrapPayload>({
      fetch: () => api.bootstrap(),
      apply: (payload) => {
        const routed = rebaseIncomingState(activateRouteTarget(payload));
        if (!bootstrapSatisfiesEventDelta(pendingEventResync.current, routed)) return false;
        if (!bootstrapSatisfiesHealthDelta(pendingHealthResync.current, routed)) return false;
        pendingHealthResync.current = null;
        pendingEventResync.current = null;
        setLoadError(null);
        setAuthRequired(false);
        const current = store.get();
        const next = reconcileIncomingRevision(current, routed);
        if (next !== current) store.set(next);
        return true;
      },
      failed: (error) => {
        if (error instanceof UnauthorizedError) {
          setLoadError(null);
          setAuthRequired(true);
          return false;
        }
        if (!store.get()) setLoadError(describeError(error));
        return true;
      },
    });
    recoveryRef.current = recovery;
    void recovery.request();
    const resume = () => {
      if (document.visibilityState === "hidden" || store.get()) return;
      void loadRef.current();
    };
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      recovery.stop();
      if (recoveryRef.current === recovery) recoveryRef.current = undefined;
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [activateRouteTarget, describeError, rebaseIncomingState, store]);

  useEffect(() => {
    const requireAuthentication = () => setAuthRequired(true);
    window.addEventListener("wmux-auth-required", requireAuthentication);
    return () => window.removeEventListener("wmux-auth-required", requireAuthentication);
  }, []);

  const eventStream = useEventStream({
    enabled: !authRequired,
    onRecoveryRequested: () => { void loadRef.current(); },
    onResync: (payload) => {
      if (!bootstrapSatisfiesEventDelta(pendingEventResync.current, payload)) return;
      if (!bootstrapSatisfiesHealthDelta(pendingHealthResync.current, payload)) return;
      pendingEventResync.current = null;
      pendingHealthResync.current = null;
      void refreshRef.current(payload);
    },
    onDelta: (delta) => {
      const current = store.get();
      if (eventDeltaRequiresResync(current, delta)) {
        const pending = pendingEventResync.current;
        if (
          !pending
          || delta.healthEpoch > pending.healthEpoch
          || (
            delta.healthEpoch === pending.healthEpoch
            && delta.eventRevision > pending.eventRevision
          )
        ) {
          pendingEventResync.current = delta;
        }
        void loadRef.current();
        return;
      }
      store.update((snapshot) => {
        const applied = applyEventDelta(snapshot, delta);
        return applied
          ? rebaseIncomingState(activateRouteTarget(applied))
          : null;
      });
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
