# Windows terminal model

Windows session-agent panes run on ConPTY, and ConPTY is itself a terminal emulator.
Its output is not a self-describing stream: it is a sequence of edits to ConPTY's own screen buffer, including absolute cursor moves such as PSReadLine's `ESC[37;24H`.
Every consumer of that output must therefore hold the same screen model as ConPTY, or those edits land on the wrong rows.
wmux keeps two consumers in lockstep with ConPTY: the server's headless Ghostty checkpoint and each browser's Ghostty terminal.
This document describes how they stay aligned and how drift is detected and repaired.

## What ConPTY does

These facts were verified against OpenConsole 1.24 on Windows 11 by reading ConPTY's screen buffer after each operation, and against the microsoft/terminal source.

- ConPTY keeps no scrollback: its buffer is exactly the viewport.
  A top row that continues a line whose start scrolled away becomes the start of a line of its own.
- A resize emits no output at all, and the host has no supported way to request a repaint.
- Width changes reflow soft-wrapped lines, moving a wide glyph that no longer fits to the next row.
- Height growth keeps the content anchored at the top and adds blank rows below it.
- Height shrinks keep the cursor row and any content below it, discarding the oldest top rows.
- Reflow depends on every step: shrinking and then restoring the height with no output in between leaves the content one row higher than never resizing.
- ConPTY measures text with grapheme clustering by default and never changes that in response to its client application.

Ghostty matches ConPTY's text reflow, but it differs in three ways that matter:

- It keeps scrollback and pulls it back into view when rows grow or when a widened line needs fewer rows.
- It rejoins a top row with the start of its line from scrollback, and can push more rows into history than ConPTY discards.
- It can misplace a cursor that sits past the end of a rewrapped line, which is the normal state of a shell prompt.
- A full reset (RIS) returns it to its power-on modes, which disables the grapheme clustering (DEC 2027) that ghostty-web enables for every terminal it creates.

## Sequenced geometry

A session-agent pane changes size only at the exact output position where the agent resized ConPTY.

- The agent records every applied resize with a sequence number shared with its screen events, including several resizes at one byte position.
- The server polls with `eventSeq`, applies each resize to its checkpoint between the bytes before and after it, and announces it to browsers with an ordered `size` message.
- Browsers render the applied geometry, not their container's proposal.
  The resize owner still proposes its size, but its grid follows only the server's `size` messages, which are applied between the surrounding output, after any held synchronized-output frame and queued graphics work.
- Agents without event sequences still report resizes by byte range, and the server falls back to that.

Resizing early would render bytes produced for the old geometry into the new grid, which is how a prompt drifted onto the next line before this model existed.

## Reproducing ConPTY's reflow

`src/shared/conpty-resize.ts` holds the one algorithm that both the server checkpoint and the browser use for `conpty` panes.
It computes ConPTY's resulting viewport and cursor from the pre-resize cells, lets Ghostty reflow, finds where the expected viewport landed by content, returns any rows Ghostty pulled down to history, and places the cursor where ConPTY put it.
When Ghostty's viewport cannot be aligned with ConPTY's, the model paints ConPTY's viewport over it with its own graphemes and styles, reproducing soft wraps.
History then keeps Ghostty's reflow, so rows near the viewport boundary can differ from what scrolled away; this boundary is inherent to a terminal that has scrollback while ConPTY does not.
A cursor in the final column may be a pending wrap, which Ghostty does not expose, so it is left to Ghostty.
POSIX session agents and every other backend keep Ghostty's native reflow, because their applications redraw after a resize.

## Verifying against ConPTY's own screen

Emulation can still disagree with ConPTY, so the agent reports ConPTY's actual screen and the server converges on it.

- A detached helper process attaches to the pane's console and reads its buffer with `ReadConsoleOutputW`; the agent itself never attaches to a pane console.
- A read is reported only when it is exact: output must be quiet, no bytes may arrive during the read, and the console must have the session's geometry.
- The agent reads the screen after every resize, and the server requests a read after output settles, backing off while the model keeps agreeing and resetting on input, a resize, or a repair.
- The server compares text, glyph widths, and the cursor.
  When they disagree it repaints only the disagreeing rows into its checkpoint and sends the same repaint to browsers at that stream position.
- The console API reduces colors to the 16-color console palette and reports graphemes wider than one UTF-16 unit as U+FFFD.
  Cells whose text agrees keep the model's exact style and grapheme; only disagreeing cells use the console's attributes.
- The server logs each repair, so a repair in ordinary use points at an emulation gap worth a regression test.

## Measurement

Every reset wmux issues restores grapheme clustering, and for ConPTY panes the server re-enables it after any reset an application sends.
Checkpoint snapshots serialize whole graphemes and soft wraps, so a restored screen measures and reflows like the original.

## Console geometry

The PowerShell bootstrap seeds ConPTY's color table with `SetConsoleScreenBufferInfoEx`.
That call reads the window rectangle one cell smaller than `GetConsoleScreenBufferInfoEx` reports it, so writing the structure back shrank the console by a row.
The bootstrap now restores the exact window afterward; without that, every themed pane ran one row shorter than the terminal rendering it.

## Conformance on Windows

`test/windows-conpty-model.test.ts` drives a themed ConPTY session through the Windows agent, resizes it through phone and desktop geometries with wide glyphs and emoji on screen, and requires every console screen ConPTY reports to agree with the model without a repair.
It runs in the Windows test lane with pywinpty and skips elsewhere.
Set `WMUX_CONPTY_TRACE_OUT` to save its trace for `npm run trace:agent -- replay`.

## Diagnosing a rendering defect

Capture the pane's agent trace and replay it offline:

```bash
npm run trace:agent -- capture --url http://100.64.0.30:3481 --pane pane_example --out trace.json
npm run trace:agent -- replay trace.json --screen
```

The capture holds the agent's retained output with every resize and console screen event.
Replay runs it through the server's terminal model and reports each console screen the model disagreed with.
Traces contain terminal output, so keep them private.
Set `WMUX_AGENT_TOKEN` for an agent that requires a bearer token.

## Limits

The native Windows host path, where the wmux server itself runs on Windows with a local node-pty ConPTY, does not use the session agent and keeps Ghostty's native reflow.
Console reads and their repair are available only from agents that advertise `console-screen-v1`.
Older agent generations report resizes by byte range alone, so their geometry is still sequenced but several resizes at one byte position are seen as one.
Scrollback seeded on attach keeps whole graphemes for non-ASCII base characters, but combining marks after an ASCII base character are not recovered from scrollback.
