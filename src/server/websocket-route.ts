export type WebSocketClass =
  | "events"
  | "pane-output"
  | "pane-interactive";

export const classifyWebSocket = (
  pathname: string,
): WebSocketClass | undefined => {
  if (pathname === "/ws/events") return "events";
  if (/^\/ws\/panes\/[^/]+\/output$/.test(pathname)) return "pane-output";
  if (/^\/ws\/panes\/[^/]+$/.test(pathname)) return "pane-interactive";
  return undefined;
};
