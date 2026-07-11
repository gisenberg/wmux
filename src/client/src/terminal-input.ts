import type { Terminal } from "ghostty-web";

export const configureTerminalInput = (terminal: Terminal): void => {
  const textarea = terminal.textarea;
  if (!textarea) return;
  textarea.setAttribute("autocomplete", "off");
  textarea.setAttribute("autocorrect", "off");
  textarea.setAttribute("autocapitalize", "none");
  textarea.setAttribute("spellcheck", "false");
  textarea.setAttribute("enterkeyhint", "enter");
  textarea.setAttribute("aria-autocomplete", "none");
  textarea.setAttribute("data-form-type", "other");
  textarea.setAttribute("data-lpignore", "true");
  textarea.setAttribute("data-gramm", "false");
  textarea.setAttribute("data-ms-editor", "false");
};
