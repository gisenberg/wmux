import { api } from "./wmux-binding.mjs";

export const MAX_TITLE_UTF16_LENGTH = 4096;
export const MAX_TITLE_GRAPHEME_COUNT = 512;
const graphemeCount = value => Array.from(new Intl.Segmenter().segment(value)).length;

export function validTitle(value) {
  if (typeof value !== "string" || value.length > MAX_TITLE_UTF16_LENGTH || graphemeCount(value) > MAX_TITLE_GRAPHEME_COUNT || /[\x00-\x1f\x7f-\x9f]/.test(value) || !value.trim()) {
    throw new Error("title must be non-empty, printable, and at most 512 graphemes / 4096 UTF-16 code units.");
  }
  return value;
}

export async function mirrorTitle(record, name, mode = "auto") {
  const title = validTitle(name);
  if (mode !== "auto") throw new Error("The Codex naming plugin supports auto mode only.");
  const result = await api("/api/codex-bindings/title", { sessionId: record.sessionId, receipt: record.receipt, title, mode });
  if (!result || result.sessionId !== record.sessionId || result.workspace?.id !== result.workspaceId ||
      !result.workspace?.tabs?.some(tab => tab.id === result.tabId && tab.panes?.some(pane => pane.id === result.paneId))) {
    throw new Error("wmux returned an invalid bound title result.");
  }
  const tab = result.workspace.tabs.find(tab => tab.id === result.tabId);
  return {
    workspaceId: result.workspaceId, tabId: result.tabId, paneId: result.paneId,
    sessionId: record.sessionId, workspaceTitle: result.workspace.name,
    workspaceTitleSource: result.workspace.nameSource, tabTitle: tab.title,
    tabTitleSource: tab.titleSource, workspaceApplied: result.workspaceApplied,
    tabApplied: result.tabApplied, mode,
  };
}
