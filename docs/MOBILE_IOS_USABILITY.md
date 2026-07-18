# iOS mobile usability

This document tracks the mobile interaction problems reproduced against the
live private wmux deployment and the corresponding acceptance criteria. It is
intended to remain the regression checklist for future mobile chrome and
terminal changes.

## Reproduction baseline

- Date: 2026-07-18
- Device: iPhone 17 Simulator, iOS 26.5
- Surface: pinned/standalone browser at
  `https://wmux.tail2fcc57.ts.net:3478/`
- Orientations: portrait and both landscape directions
- Input paths: Chat composer, command search, and the `ghostty-web` hidden
  textarea reached through **Focus terminal**

The pass used the on-screen keyboard directly, including individual key taps,
send, the keyboard dismissal control, and rotation while the keyboard was
visible.

## Findings

### 1. Chat falls away from the latest message when the keyboard closes

The thread is pinned to its bottom while it has the keyboard-reduced height.
After send dismisses the keyboard, the thread becomes taller without receiving
new thread content. The existing content-change effect does not run, so the
surface incorrectly shows **Latest** and leaves the just-sent message out of
view.

### 2. Sending a message dismisses the software keyboard

Tapping the send button transfers focus away from the composer. iOS then closes
the keyboard and expands all mobile chrome. Sending several short follow-ups
requires repeating the focus and keyboard transition for every message.

### 3. Keyboard-open state can flap during focus transitions

Keyboard detection requires the currently focused element to be editable.
That is a good guard for initially classifying a reduced viewport, but it makes
an already-open keyboard disappear from application state as soon as focus
briefly moves to a button. iOS viewport resize events and focus changes do not
arrive atomically, so the full chrome can flash into the still-reduced visual
viewport.

### 4. Terminal sizing has no final iOS viewport-settle pass

The terminal's element `ResizeObserver` catches ordinary layout changes, but
iOS keyboard and orientation transitions report several intermediate visual
viewport shapes. Rotating with the keyboard open reproduced stale-width
terminal rows and repeated tmux status-line redraws before the next stable fit.
The final visual viewport geometry should explicitly drive a fit/resize pass.

### 5. The keyboard-open Chat composer spends scarce height on decoration

In portrait, the composer handle, generous gaps, 52px input row, and labeled
secondary actions consume roughly a quarter of the usable area above the
keyboard. Landscape is more constrained. The controls remain reachable, but
the transcript has less useful space than necessary.

### 6. Workspace routes leave the installed app

Selecting a workspace from either the navigation drawer or command palette
opens the direct workspace route in iOS's modal Safari sheet. The underlying
installed app stays on the previous workspace. The page advertises a status-bar
style, but does not declare standalone capability or publish a web app manifest
whose scope includes direct workspace and tab routes.

## Implemented fix set

1. Preserve an already-detected keyboard-open state while the visual viewport
   remains occluded, even through a transient non-editable focus target. Listen
   to focus changes as well as viewport events so state settles promptly.
2. Observe the Chat thread's size and re-pin it to the bottom whenever it grows
   or shrinks while the user has not intentionally scrolled away.
3. Restore composer focus synchronously from the send gesture so iOS keeps the
   software keyboard open for consecutive messages.
4. Re-fit the active terminal on visual viewport resize/scroll and after a
   short settling delay, with the same treatment on orientation changes.
5. Compact the keyboard-open composer without shrinking any interactive target
   below 44px or removing Focus terminal and Actions.
6. Publish standalone install metadata and a web app manifest with `/` as both
   its start URL and scope so direct workspace routes remain inside the pinned
   app.

## Acceptance criteria

- Sending from a focused Chat composer keeps the software keyboard open and
  leaves the composer ready for the next message.
- If Chat was at the bottom before a keyboard or orientation resize, it remains
  at the bottom afterward. If the user deliberately scrolled upward, their
  position is not overridden and **Latest** remains available.
- A temporary focus move to the send button cannot expand mobile chrome while
  the visual viewport is still keyboard-sized.
- Terminal columns and rows converge to the final portrait or landscape size
  after keyboard and rotation transitions, and the final dimensions are sent
  to the pane backend.
- The keyboard-open composer retains 44px touch targets while giving more
  height back to the thread.
- Workspace and tab navigation remains in the installed app instead of opening
  the modal Safari browser.
- Desktop behavior and the `?legacy=1` fallback remain unchanged.
