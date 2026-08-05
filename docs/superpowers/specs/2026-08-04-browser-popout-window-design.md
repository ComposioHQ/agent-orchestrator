# Browser panel pop-out into a native OS window

## Problem

The browser preview panel's current "fullscreen" is a CSS overlay: `SessionView.tsx`
portals `BrowserPanel` to `document.body` and hides the sidebar/topbar
(`frontend/src/renderer/components/SessionView.tsx:477-496`), but the content still
renders inside the single Electron app window. Users working across multiple
monitors can't move the browser preview to a second screen while keeping the rest
of AO (or another app) visible — it's stuck inside the main app window's bounds.

## Goal

Replace the maximize/fullscreen control on `BrowserPanel` with one that pops the
entire browser panel — tab bar, all open tabs, toolbar, annotation UI, and the
agent-awareness indicator — into a genuine, separate, movable OS window, while
preserving every feature that works in the docked view today (element annotation,
agent activity display, per-session tab state).

## Current architecture (relevant pieces)

- Browser page content renders via native Electron `WebContentsView` instances
  (not a `<webview>` tag or iframe), created and owned by
  `frontend/src/main/browser-view-host.ts` and attached to the single `mainWindow`'s
  `contentView` (`frontend/src/main.ts:327-338`).
- `useBrowserView.ts` (renderer) drives that native view: measures a DOM "slot"
  rect inside the docked panel and sends bounds to the main process, tracks
  fullscreen via `document.fullscreenElement`, and locates its panel container via
  `closest('[data-panel]')`.
- Element annotation is a preload script (`frontend/src/annotate-preload.ts`)
  injected into each tab's own `WebContents` — it is independent of whichever
  window that `WebContentsView` is parented under.
- Agent-awareness ("agent clicking...", etc.) flows main → renderer via the
  `browser:agentActivity` IPC event (`browser-view-host.ts:309-324`), keyed by
  `viewId`/`sessionId`, not by window.
- Session/agent data reaches the renderer via React Query + a shared `apiClient`
  hitting the local daemon over HTTP (`frontend/src/renderer/lib/api-client.ts`);
  each renderer process makes its own independent connection — there is no
  single-window assumption baked into data fetching.
- The main app window's chrome: hidden titlebar + Window Controls Overlay on
  Windows, `hiddenInset` with a fixed traffic-light position on macOS/Linux
  (`frontend/src/main.ts:253-278`), with a renderer-painted `WindowTitlebar` filling
  in the custom chrome.

Because page content is a native view (not tied to a specific renderer's DOM) and
annotation/agent-activity are already keyed by session/view rather than window,
reparenting a session's browser views into a second `BrowserWindow` is
architecturally sound. The renderer's toolbar/tab UI, however, is React state that
lives inside the main window's renderer process — Electron doesn't allow relocating
an existing renderer's rendered output into a different OS window, so the pop-out
needs its own renderer process running the same UI.

## Design

### Trigger and scope

The existing maximize/fullscreen button on `BrowserPanel` is repurposed. Clicking
it no longer toggles the CSS-portal fullscreen; instead it asks the main process to
open a native window for that session's entire browser panel — all currently open
tabs move together, not just the active one. The old CSS-overlay fullscreen path
(`SessionView.tsx` portal, `browser-popout-overlay--mac-windowed` handling) is
removed.

### Window lifecycle

- **Open:** main process creates a new `BrowserWindow`, chromed identically to the
  main window for the current platform (same hidden/hiddenInset titlebar
  treatment), at a default size/position (not persisted). It loads the same
  renderer bundle with a mode flag identifying it as a browser pop-out for a given
  session (see Renderer, below). The main process then reparents that session's
  `WebContentsView`(s) from `mainWindow.contentView` to the new window's
  `contentView`.
- **Ctrl/Cmd+W:** closes the active tab only — standard browser tab-close behavior.
  If other tabs remain open, the pop-out window stays open showing them.
- **Closing the last tab, or clicking the native window close button directly:**
  the panel — including any tabs still open — reparents back into the main
  window's inspector rail Browser tab, in the same state it was in before popping
  out. There is no separate "pop back in" control; closing the window (by any
  route that ends with zero tabs, or the window's own close button) is the only
  way back, and it always preserves remaining tab state rather than discarding it.
- **Main window closes/quits:** any open pop-out windows belonging to its sessions
  close as part of app shutdown.

### Multi-session support

Pop-out windows are tracked per session (`Map<sessionId, BrowserWindow>`) rather
than as a single global. Switching the active session in the main window while
another session's browser panel is popped out works normally: the main window
shows the current session's own docked panel (or its empty state if it has no open
tabs), while the popped-out session keeps running independently in its own OS
window.

### Renderer changes

- Same bundle, mode-aware: the renderer entry (`frontend/src/renderer/main.tsx`)
  branches on a mode parameter identifying "browser pop-out for session X" and
  mounts only `<BrowserPanel>` for that session, instead of the full app shell.
  This means any future change to `BrowserPanel` — styling, new toolbar controls,
  annotation behavior — applies identically to the docked and popped-out views,
  since it is the same component tree.
- `useBrowserView.ts`'s DOM-coupled assumptions (slot-rect measurement via
  `closest('[data-panel]')`, `document.fullscreenElement` checks, mutation
  observer on `document.body`) are replaced with an explicit docked-vs-popout
  context, so bounds in the pop-out window come from that window's own content
  area rather than a slot inside the main window's layout.

### Main process changes

- `browser-view-host.ts`'s view-ownership tracking (currently assumes a single
  host window) is extended to support reparenting a session's views between the
  main window and a per-session pop-out `BrowserWindow`.
- `main.ts` gains pop-out window creation/redock logic alongside the existing
  `createWindow()`, including matching the platform-specific titlebar
  configuration used for the main window.
- Preload (`window.ao.browser` bridge) is reused as-is for pop-out windows — it's
  attached per-`BrowserWindow`, not a singleton. `annotate-preload.ts` needs no
  changes since it's injected per-tab `WebContents` and survives reparenting
  automatically.

### Non-goals

- No persisted pop-out window position/size across sessions or app restarts —
  always opens at a default size.
- No manual in-window "pop back in" button — closing the window is the only way
  to redock.
- No popping out a single tab independently of the rest of the panel — the whole
  panel (all open tabs) moves together.

## Alternatives considered

- **Separate, dedicated minimal entry point/UI for the pop-out window** (its own
  small React tree for toolbar/tabs) — rejected because it duplicates UI that must
  be kept in sync with `BrowserPanel` by hand (annotation styling, agent-awareness
  display), which will drift over time. The chosen approach shares the exact same
  component tree instead.
- **Non-React native chrome** (main process paints its own toolbar/tab bar,
  independent of any renderer) — rejected: would require reimplementing
  annotation controls and the agent-awareness indicator natively, losing fidelity
  with the docked view and duplicating significant UI work for no benefit over
  reusing the existing renderer bundle.
