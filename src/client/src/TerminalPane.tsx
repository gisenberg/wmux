import { memo } from "react";
import {
  TerminalPaneRuntime,
  type TerminalPaneProps,
} from "./TerminalPaneRuntime";

export const TerminalPane = memo(function TerminalPane(props: TerminalPaneProps) {
  return <TerminalPaneRuntime {...props} />;
});
