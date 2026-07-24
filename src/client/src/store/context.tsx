import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { BootstrapPayload } from "../types";
import { createAppStore, type AppStore } from "./core";

const AppStoreContext = createContext<AppStore | null>(null);

export const AppStoreProvider = ({ children }: { children: ReactNode }) => {
  const store = useMemo(createAppStore, []);
  return <AppStoreContext.Provider value={store}>{children}</AppStoreContext.Provider>;
};

export const useAppStore = (): AppStore => {
  const store = useContext(AppStoreContext);
  if (!store) throw new Error("useAppStore must be used inside AppStoreProvider");
  return store;
};

export const useAppSelector = <T,>(
  selector: (state: BootstrapPayload | null) => T,
): T => {
  const store = useAppStore();
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.get()),
    () => selector(store.get()),
  );
};

export const useAppState = (): BootstrapPayload | null =>
  useAppSelector((state) => state);
