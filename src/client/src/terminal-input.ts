import type { Terminal } from "ghostty-web";

export interface TerminalKeyModifiers {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export const isBareShiftEnter = (event: TerminalKeyModifiers): boolean =>
  event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;

export const configureTerminalInput = (terminal: Terminal): void => {
  const textarea = terminal.textarea;
  if (!textarea) return;
  textarea.setAttribute("autocomplete", "off");
  textarea.setAttribute("autocorrect", "off");
  textarea.setAttribute("autocapitalize", "off");
  textarea.setAttribute("spellcheck", "false");
  textarea.setAttribute("enterkeyhint", "enter");
  textarea.setAttribute("aria-autocomplete", "none");
  textarea.setAttribute("data-form-type", "other");
  textarea.setAttribute("data-lpignore", "true");
  textarea.setAttribute("data-gramm", "false");
  textarea.setAttribute("data-ms-editor", "false");
};
