import { useCallback, useRef, useState } from "react";
import type { AppStore } from "./core";
import {
  applyOptimisticCreations,
  type OptimisticCreation,
} from "./optimistic-creation";

export const useOptimisticCreations = (store: AppStore) => {
  const creations = useRef(new Map<string, OptimisticCreation>());
  const [pendingPaneLabels, setPendingPaneLabels] = useState<Map<string, string>>(() => new Map());

  const begin = useCallback((creation: OptimisticCreation, label: string) => {
    creations.current.set(creation.key, creation);
    setPendingPaneLabels((current) => new Map(current).set(creation.paneId, label));
    store.update((current) => current ? applyOptimisticCreations(current, [creation]) : current);
  }, [store]);

  const finish = useCallback((creation: OptimisticCreation) => {
    creations.current.delete(creation.key);
    setPendingPaneLabels((current) => {
      if (!current.has(creation.paneId)) return current;
      const next = new Map(current);
      next.delete(creation.paneId);
      return next;
    });
  }, []);

  return {
    begin,
    creations,
    finish,
    pendingPaneLabels,
  };
};
