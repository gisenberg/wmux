# ghostty-web PR 169

`ghostty-web-0.4.1-pr169-faf6fbd-wmux6.tgz` is a temporary, locally built npm package of [coder/ghostty-web pull request 169](https://github.com/coder/ghostty-web/pull/169).
It is not an official Coder release.

- Source repository: <https://github.com/diegosouzapw/ghostty-web>
- Source commit: `faf6fbd055f5768923b3df659f3968c2abbab4a1`
- Ghostty submodule: `6590196661f769dd8f2b3e85d6c98262c4ec5b3b`
- Base artifact: `ghostty-web-0.4.1-pr169-faf6fbd.tgz`
- Base artifact SHA-256: `8a926a5996d8db6c7438841a01878e0a4a44937873295641c6a1869da32ed8d4`
- Package version: `0.4.1-pr169.faf6fbd.wmux6`
- Artifact SHA-256: `07b82b2f1286a1aa5a1de5a1c7b65165d2b4007bb2892ebbd6ea56b69a99a356`
- License: MIT; the upstream license is included in the package archive.

wmux applies `wmux-single-viewport-render.patch`, `wmux-cell-paint-efficiency.patch`, `wmux-device-pixel-ratio.patch`, `wmux-block-elements.patch`, `wmux-inverse-default-colors.patch`, `wmux-paste-control-characters.patch`, `wmux-fractional-dpr-backing-store.patch`, `wmux-empty-write.patch`, and `wmux-fractional-viewport-rows.patch` in that order on top of the source commit.
The patches let the canvas renderer extract the active viewport once per render pass instead of calling the full-viewport `getLine()` compatibility path for every dirty row, cache parsed font strings, skip glyph draws for undecorated spaces, refresh measured metrics and canvas backing stores after browser scale changes, render the complete Unicode Block Elements range with exact cell geometry, swap default theme colors for inverse video, and carry the upstream fixes described below.

The base artifact was built with Bun 1.3.14 and Zig 0.15.2.
Its Zig archive matched the published SHA-256 checksum `02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239`.
The wmux6 artifact preserves that base artifact's `ghostty-vt.wasm` byte-for-byte (SHA-256 `ca95fbfc59133aa2ab76c03add4ea7e321a42fffe4d9127076279dae4372010e`).
Its patched library bundles were built locally with Node 22.22.2, TypeScript 5.9.3, and Vite 4.5.14.
The retained declaration rollup was amended with the optional bulk-viewport and device-scale interfaces.
npm 11.18.0 produced the package archive.

For a clean source rebuild, recursively clone the source at the commit above and apply the nine patches in the order above.
Place the reviewed base artifact's `ghostty-vt.wasm` at the source root before running `npm install` and `npm run build:lib` so Vite embeds the same WASM bytes.
Copy that WASM file into `dist/ghostty-vt.wasm`, then run `npm pack`.
Do not create a Git tag.
The checked-in hashes above identify the exact reviewed artifacts even when archive metadata differs between build hosts.

This pin can be removed once the changes are merged upstream and available as a published package.
At the time of pinning, the pull request has merge conflicts, its 612 KiB WASM artifact exceeds the pull request's stated 512 KiB CI budget, and its Bun test invocation also discovers Playwright specifications.
wmux's own unit, type, build, and browser tests pass against this artifact.

## Inverse video with default colors

The renderer previously skipped the inverse background whenever the swapped color was the theme default, and drew the text in the theme foreground.
Inverse cells with default colors, such as the Commodore directory header and Apple IIe CAPS LOCK reminder, therefore painted as normal text.
`wmux-inverse-default-colors.patch` paints the theme foreground behind such cells and draws their text in the theme background, leaving explicit RGB and palette colors unchanged.
`e2e/canvas-chrome.spec.ts` samples the Commodore 64 header's painted pixels; it fails against wmux4 and passes against wmux5.
Rebuilding the wmux4 patch stack with Node 22.22.2 reproduced its code byte-for-byte except for the name of Vite's externalized `fs/promises` browser stub chunk, so wmux5 ships `__vite-browser-external` stubs in place of `promises` stubs.
The patch only changes the color chosen for each painted inverse cell and adds no per-cell work for other cells.
Remove it when the adopted upstream package paints inverse default colors and the browser regression passes.

## Upstream fixes

wmux6 adds four fixes that upstream `coder/ghostty-web` has reported or proposed but not released.
Upstream `main` and the published 0.4.0 package predate this pin's Ghostty 1.3 WASM and lack APIs wmux uses, so the fixes are carried as patches rather than adopted by moving to upstream.

- `wmux-paste-control-characters.patch` ports [coder/ghostty-web#193](https://github.com/coder/ghostty-web/pull/193) for CVE-2026-26982.
  Pasted text previously reached the PTY unchanged inside the bracketed-paste markers, so clipboard text containing `ESC[201~` could end the paste early and run the remainder as typed input.
  Unsafe control bytes now become spaces, as in native Ghostty, while tabs, newlines and carriage returns are kept.
  Remove it when an adopted upstream package sanitizes pastes.
- `wmux-fractional-dpr-backing-store.patch` fixes [coder/ghostty-web#198](https://github.com/coder/ghostty-web/issues/198).
  `render()` compared the truncated integer canvas size with the unrounded product of columns, cell width and device scale, so at ratios such as 1.1 or 2.2 every frame resized and fully repainted the terminal.
  The backing store is now rounded once and compared with the same rounded value, and `Terminal.resize()` no longer overwrites the renderer's device-scaled backing store with an unscaled size.
  Remove it when an adopted upstream package rounds the backing-store size.
- `wmux-empty-write.patch` fixes [coder/ghostty-web#199](https://github.com/coder/ghostty-web/issues/199).
  `write('')` threw `RangeError: offset is out of bounds` from a zero-length WASM allocation, which also skipped the write callback; an empty write is now a no-op that still completes.
  Remove it when an adopted upstream package accepts empty writes.
- `wmux-fractional-viewport-rows.patch` ports [coder/ghostty-web#171](https://github.com/coder/ghostty-web/pull/171).
  During smooth scrolling the renderer compared rows with a fractional viewport offset but indexed with its floor, reading one row past scrollback and dropping the top screen row.
  Remove it when an adopted upstream package floors the viewport offset consistently.

Each patch includes Bun regression tests; the fractional-ratio, empty-write and viewport tests fail against wmux5 and pass against wmux6.
The fork's full Bun suite passes with all nine patches (454 tests, Bun 1.3.14).
Both WASM copies retain SHA-256 `ca95fbfc59133aa2ab76c03add4ea7e321a42fffe4d9127076279dae4372010e`, and the library bundles were built with Node 22.22.2, TypeScript 5.9.3 and Vite 4.5.14 and packed with npm 11.18.0.
