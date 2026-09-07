// These specs inspect server-side files, execute checkout-relative fixtures,
// validate rendering against fixture modules, or require a loopback secure
// context for browser APIs such as the Clipboard API.
export const serverCoupledE2eSpecs = [
  "agent-follow-up.spec.ts",
  "command-palette.spec.ts",
  "docs-screenshots.spec.ts",
  "fonts-and-keybindings.spec.ts",
  "shell-command-tracking.spec.ts",
  "sidebar-host-grouping.spec.ts",
  "codex-durable-reconnect.spec.ts",
  "terminal-prediction.spec.ts",
];

// These specs use only browser and HTTP/WebSocket contracts, so their
// Playwright driver may run on a different operating system from the server.
export const browserOnlyE2eSpecs = [
  "agent-fleet.spec.ts",
  "agent-input-questions.spec.ts",
  "agent-notifications.spec.ts",
  "canvas-chrome.spec.ts",
  "direct-links.spec.ts",
  "machine-management.spec.ts",
  "prime-agent-sidebar.spec.ts",
  "codex-sidebar-lifecycle.spec.ts",
  "smoke.spec.ts",
  "terminal-graphics.spec.ts",
  "workspace-navigation.spec.ts",
  "workspace-ordering.spec.ts",
];
