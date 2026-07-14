import { useCallback } from "react";
import { api } from "./api";
import type { BootstrapPayload, SplitDirection } from "./types";

interface UsePaneActionsOptions {
  activeTabId?: string;
  refresh: (state?: BootstrapPayload) => Promise<void>;
  activatePane: (tabId: string, paneId: string) => void | Promise<void>;
  runPending: (
    key: string,
    label: string,
    action: () => Promise<void>,
  ) => Promise<void | undefined>;
}

export const usePaneActions = ({ activeTabId, refresh, activatePane, runPending }: UsePaneActionsOptions) => {
  const splitPaneInTab = useCallback(async (
    tabId: string,
    paneId: string,
    direction: SplitDirection,
    machineId?: string,
  ) => {
    await runPending(`pane:${paneId}:split`, "Splitting pane...", async () => {
      const response = await api.splitPane(tabId, paneId, direction, machineId);
      await refresh(response.state);
      await activatePane(response.tab.id, response.tab.activePaneId);
    });
  }, [activatePane, refresh, runPending]);

  const resizeSplitInTab = useCallback(async (tabId: string, path: string, ratio: number) => {
    await runPending(`tab:${tabId}:resize:${path}`, "Saving pane layout...", async () => {
      await refresh((await api.updateSplitRatio(tabId, path, ratio)).state);
    });
  }, [refresh, runPending]);

  const closePaneInTab = useCallback(async (tabId: string, paneId: string) => {
    await runPending(`pane:${paneId}:close`, "Closing pane...", async () => {
      await refresh((await api.closePane(tabId, paneId)).state);
    });
  }, [refresh, runPending]);

  const splitPane = useCallback(async (paneId: string, direction: SplitDirection, machineId?: string) => {
    if (!activeTabId) return;
    await splitPaneInTab(activeTabId, paneId, direction, machineId);
  }, [activeTabId, splitPaneInTab]);

  const resizeSplit = useCallback(async (path: string, ratio: number) => {
    if (!activeTabId) return;
    await resizeSplitInTab(activeTabId, path, ratio);
  }, [activeTabId, resizeSplitInTab]);

  const closePane = useCallback(async (paneId: string) => {
    if (!activeTabId) return;
    await closePaneInTab(activeTabId, paneId);
  }, [activeTabId, closePaneInTab]);

  return { splitPaneInTab, resizeSplitInTab, closePaneInTab, splitPane, resizeSplit, closePane };
};
