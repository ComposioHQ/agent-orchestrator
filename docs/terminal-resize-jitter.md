# Terminal resize: jitter, blanking, and "reloading" — design notes

Branch: `fix/terminal-resize-jitter` · August 2026 · Windows 11 primary target

This document explains why resizing the AO terminal used to jitter, blank, and
look like it was "reloading"; what VS Code and Superset actually do; what we
changed; and what behavior is inherent to terminals and cannot be removed.

## The symptom

Dragging the inspector separator (or the OS window edge) with a full-screen
agent TUI (claude / codex) in the terminal produced, depending on drag speed:

- continuous shimmering/churn of the text while dragging slowly;
- blank flashes — the pane cleared, then content "reloaded";
- a big late repaint after releasing the drag;
- at one point, the terminal *looking different* (text rendering changed).

## Root causes found (there were six, stacked)

Each of these was independently sufficient to produce visible artifacts, which
is why single fixes kept "not working". They were found via unit-level
reasoning, a browser harness driving the real renderer against the real
daemon, and finally live event tracing from the running app (`lib/diag.ts`).

1. **Per-frame column reflow.** The `ResizeObserver` fitted xterm on every
   animation frame of a drag. A column change makes `term.resize()` rewrap the
   entire buffer — dozens of full-buffer reflows per second.

2. **DOM renderer experiments.** With xterm's DOM renderer, every repaint
   rebuilds/relayouts one `<span>` row per line. During per-frame fits this is
   maximal layout churn — and its text rendering is visibly different from the
   GPU renderers (this was the "terminal UI changed" report; see §Renderer).

3. **xterm 5.5 blank-frame on canvas resize** (upstream
   [xterm.js#4922](https://github.com/xtermjs/xterm.js/issues/4922)). Resizing
   the WebGL canvas clears it synchronously but repaints through an
   animation-frame debouncer — so every resize composited one blank frame
   before content reappeared. Fixed upstream only in the 6.1 line
   ([xterm.js#5529](https://github.com/xtermjs/xterm.js/pull/5529), "force a
   sync render after resize").

4. **ConPTY full repaints (Windows-only).** On Windows, *every* PTY resize
   makes ConPTY emit a full clear-and-rewrite of the viewport into the output
   stream. Unix PTYs (macOS/Linux — where Superset is usually demoed) only
   deliver `SIGWINCH` and let the app redraw what it wants. Sending several
   debounced grids per drag meant several full clear+repaint cycles —
   the literal "terminal keeps reloading".

5. **Split repaint bursts.** ConPTY's clear frame and its content frames
   arrive as separate transport chunks. If the renderer painted between them,
   the user saw the cleared grid alone — blank, then content.

6. **Two geometry owners.** A convergence stabilizer (`onRender` refit loop)
   could commit a reflow mid-drag that the debouncer was deliberately holding.

## What VS Code and Superset actually do

We read the source rather than guessing:

- **VS Code** (`terminalResizeDebouncer.ts`): does *not* freeze the terminal
  during drags. It resizes **live, every frame** — with one exception: when the
  normal buffer holds ≥ 200 lines, the expensive *column* reflow is debounced
  100ms while *rows* still apply immediately ("vertical resize is cheap and
  horizontal resize is expensive due to reflow"). Agent TUIs run in the alt
  screen, so their normal buffer stays tiny → VS Code tracks those drags fully
  live. VS Code renders via its own pipeline, which paints synchronously after
  resize (no blank frame).

- **Superset**: retains terminal instances in a cache (like AO), runs FitAddon
  from a `ResizeObserver`, forwards PTY resizes only on real grid changes —
  and, crucially, **ships the xterm 6.1 beta**, which contains the upstream
  sync-render-after-resize fix (#5529). That is a large part of why its
  resizes look clean.

- Neither has a magic answer for ConPTY: on Windows every published grid still
  costs a full viewport repaint. The only levers are *how often* you publish
  and *how atomically* you paint the response.

## What we changed

All renderer-side, in `frontend/src/renderer`:

1. **One geometry owner** (`components/XtermTerminal.tsx`). The observer path
   owns fitting; the `onRender` stabilizer yields while a fit is scheduled.

2. **VS Code's exact resize semantics.** Normal buffer < 200 lines → fit fully
   live per observed frame (agent TUIs always; drags track smoothly). ≥ 200
   lines → rows live, columns after a 100ms quiet window, flushed immediately
   on `pointerup`/`pointercancel`.

3. **Sync-render backport of xterm#5529.** `forceSyncRender()` calls the
   private `_core._renderService._renderRows(0, rows-1)` right after every
   fit/resize, inside the pre-paint `ResizeObserver` callback — the resized
   canvas is repainted in the same frame, so the blank frame never reaches the
   screen. Guarded so an xterm upgrade degrades to the debounced repaint.

4. **Gesture-paced PTY resizes** (`hooks/useTerminalSession.ts`).
   `useResizable` marks separator drags with `body.is-resizing-x`; OS
   window-edge drags are detected by their `resize` event stream
   (250ms quiet). While a gesture is active, PTY resizes are published at most
   every 350ms (`GESTURE_PUBLISH_INTERVAL_MS`) — so a slow drag refreshes real
   TUI content at each pause, a fast drag produces a single final publish, and
   ConPTY never storms. The final grid always lands right after release.

5. **Atomic repaint transactions.** From each published resize, incoming
   output is held until the burst goes quiet (80ms, 300ms cap, 1MB ceiling)
   and written as **one** `terminal.write` — ConPTY's clear can never paint
   alone. Steady-state output is *never* buffered (keystroke echo latency).

6. **Layout reserves width in one update** (`components/SessionView.tsx`).
   The inspector gap no longer animates its width; the panel slides on
   `transform`. One terminal relayout per open/close instead of one per spring
   frame. (The old `data-terminal-live-resize` marker became
   `data-inspector-transition` and now only locks label modes.)

### Renderer decision (and a reverted experiment)

The WebGL renderer (canvas 2D fallback) is loaded once per terminal at mount
and kept for its lifetime — the same as before this branch. A visibility-scoped
variant (release the GPU context while parked, to stay under Chromium's
~16-per-process WebGL context cap) was tried and **reverted**: any window where
an on-screen pane reported "not visible" (activation phases do) left it on the
DOM renderer, which users immediately notice as different text rendering. If
context-cap pressure resurfaces with many cached terminals, fix it in the
cache (evict/limit retained xterms), not by swapping renderers under a visible
pane.

### What is inherent and will not go away

A terminal is a character grid. Changing its width changes the column count,
and the program inside **must** redraw its screen for the new grid — text
rewraps, boxes redraw. Every terminal does this (VS Code, Superset, Windows
Terminal, iTerm). On Windows, ConPTY additionally repaints the whole viewport
per resize. What this branch guarantees is that each such repaint is a single
clean atomic paint at a paced moment — not a storm, not a blank flash.

Tuning knob: `GESTURE_PUBLISH_INTERVAL_MS` (350ms). Raise it for calmer
mid-drag panes with staler content; publish-on-release-only was tried and
rejected (long-mangled frame, one big late snap).

### Temporary instrumentation

`lib/diag.ts` + the `ao-diag-logger` middleware in `vite.renderer.config.ts`
POST renderer-side terminal events (fits, PTY publishes, repaint flushes,
context loss) into the dev-server terminal. Dev-only (`import.meta.env.DEV`
and `configureServer`). Remove both together once this settles.

`lib/bridge.ts` also gained a debugging affordance: the browser-preview stub
reports the daemon "ready" when `VITE_AO_API_BASE_URL` is set, which lets the
real renderer run against a real daemon from a plain browser (with the
existing `/api` + `/mux` proxy) for instrumented reproduction.

## Could we use a different terminal entirely (Ghostty etc.)?

Short answer: **no drop-in exists; the practical path is xterm.js 6.1.**

- **Ghostty / libghostty**: superb GPU-native terminal, and `libghostty` is
  designed for embedding — but it renders to a native surface (Metal/OpenGL),
  not the DOM, so embedding into an Electron renderer means compositing a
  native view over the web content (like AO's browser panel does) plus a
  custom IPC for scrollback/selection/links. As of early 2026 libghostty is
  not a stable public API and Ghostty has no shipped Windows support — a
  blocker for AO's primary platform here.
- **alacritty_terminal / Zed's approach**: Zed embeds the `alacritty_terminal`
  Rust crate as the VT state machine with its own GPU renderer. Same
  native-surface problem inside Electron; it's an architecture for native
  apps.
- **hterm** (ChromeOS): DOM-based, dated, weaker TUI fidelity than xterm.js.
- **xterm.js 6.1 beta** — what Superset ships. Gets the real #5529 fix (our
  backport becomes unnecessary), years of renderer work, and DEC 2026
  synchronized-output support (would make repaint transactions protocol-level
  instead of heuristic). Migration note: AO's
  `removeHiddenScrollbarReservation` touches `_core.viewport.scrollBarWidth`,
  which changed in the 6.x viewport rewrite — that workaround must be
  re-validated. This is the recommended follow-up.
