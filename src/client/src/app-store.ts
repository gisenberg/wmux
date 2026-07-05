import { useSyncExternalStore } from "react";
import type { BootstrapPayload } from "./types";

// Single source of truth for the bootstrap state with synchronous reads.
// Event handlers call store.get()/store.update() and immediately observe the
// result — this replaces the old useState + stateRef mirror, whose eager ref
// writes existed only to give handlers a current snapshot.
export interface AppStore {
  get: () => BootstrapPayload | null;
  set: (next: BootstrapPayload | null) => void;
  update: (fn: (current: BootstrapPayload | null) => BootstrapPayload | null) => void;
  subscribe: (listener: () => void) => () => void;
}

export const createAppStore = (): AppStore => {
  let snapshot: BootstrapPayload | null = null;
  const listeners = new Set<() => void>();
  const set = (next: BootstrapPayload | null) => {
    if (next === snapshot) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };
  return {
    get: () => snapshot,
    set,
    update: (fn) => set(fn(snapshot)),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

export const useAppState = (store: AppStore): BootstrapPayload | null =>
  useSyncExternalStore(store.subscribe, store.get);
