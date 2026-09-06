# Canvas Chrome Parity

The Canvas 2D cell-grid chrome is wmux's only application chrome.
The former `?legacy=1` desktop React chrome has been removed.
Editable controls, accessible semantic overlays, mobile navigation, and browser-API surfaces remain DOM-backed where the interaction requires them.

## Retired fallback checklist

- [x] Nested workspace depth, collapse, expansion, and agent-created origin are exposed by the canvas sidebar and its semantic tree.
- [x] Workspace reordering, host filtering, direct links, active-pane session references, unread state, and host context are covered on the canvas sidebar.
- [x] Tab activation, workspace or tab creation, settings, activity, streaming, link copy, notifications, and command-palette entry are available from the canvas top bar.
- [x] The desktop command palette, activity panel, and default settings surface use the cell-grid renderer.
- [x] The mobile header exposes navigation, fleet, chat, terminal, and actions through the cell-grid renderer with semantic buttons.
- [x] The mobile drawer, editable settings controls, dialogs, and terminal textarea remain accessible DOM surfaces styled in the same console language.
- [x] Empty workspaces provide a keyboard-accessible host-aware console launcher without animated rendering.
- [x] Mobile safe-area colors and boot completion timing remain independent of the retired desktop fallback.
- [x] A `legacy` query parameter is removed from the address without changing the rendered interface.

## Verification

`e2e/canvas-chrome.spec.ts` owns the former fallback-only visual lifecycle checks.
`e2e/workspace-navigation.spec.ts`, `e2e/workspace-ordering.spec.ts`, `e2e/command-palette.spec.ts`, `e2e/fonts-and-keybindings.spec.ts`, and `e2e/direct-links.spec.ts` cover the interaction checklist.
