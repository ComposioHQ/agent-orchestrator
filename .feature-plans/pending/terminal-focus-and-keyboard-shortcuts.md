# Feature Plan: Terminal Auto-Focus & Keyboard Shortcuts

**Issue:** terminal-focus-and-keyboard-shortcuts
**Branch:** `feat/terminal-focus-and-keyboard-shortcuts`
**Status:** Pending

---

## Problem Summary

Three related UX improvements:

1. **Terminal auto-focus** — When you open a session from the sidebar, create/switch to a sub-session, or open a global terminal, you have to manually click into the terminal before you can type. The terminal should steal focus automatically.

2. **Sidebar + sub-session navigation shortcuts** — No keyboard way to navigate between sessions or sub-session tabs. Forces mouse use.

3. **Workspace panel toggles** — Files, preview, terminal, and layout orientation (H/V) can only be toggled via the mouse. No keyboard shortcuts exist for these.

---

## Research Findings

### Terminal Rendering

- **`DirectTerminal.tsx`** is the core terminal component. The xterm.js `Terminal` instance is stored in `terminalInstance` ref (line 209). After `terminal.open(element)` (line 399) is called, xterm.js exposes `terminal.focus()` — this is the method we need.
- The terminal component receives its key from `terminalTarget` in `SessionTerminalTabs`, which causes a full remount when switching tabs — so an `autoFocus` prop will naturally fire on every tab switch.

### Where to Add Focus

| Trigger | Component | What to do |
|---------|-----------|------------|
| New sub-session created | `SessionTerminalTabs.tsx:195-208` (create handler) | `selectTab(newSub.id)` already called; DirectTerminal remounts → `autoFocus` fires |
| Sub-session tab clicked | `SessionTerminalTabs.tsx:140-162` (`selectTab`) | DirectTerminal remounts → `autoFocus` fires |
| Session opened from sidebar | `sessions/[id]/page.tsx` | Pass `autoFocus` to DirectTerminal/SessionTerminalTabs |
| Global terminal opened | `terminals/[name]/page.tsx` | Pass `autoFocus` to DirectTerminal |

### Existing Shortcuts

Only two shortcuts exist today:
- `Cmd+P` / `Ctrl+P` — Quick file open (WorkspaceLayout.tsx:131)
- `Cmd+C` / `Ctrl+Shift+C` inside terminal — Copy selection (DirectTerminal.tsx:468)

### Workspace Pane State

`usePaneSizes.ts` manages:
- `collapsed[0/1/2]` → file tree / preview / terminal visibility
- `verticalLayout` → horizontal vs vertical split
- `toggleCollapsed(idx)` + `setVerticalLayout(v)` are the mutation functions
These are available inside `WorkspaceLayout.tsx` already.

---

## Feature 1: Terminal Auto-Focus

### Approach

Add an `autoFocus?: boolean` prop to `DirectTerminal`. When true, call `terminal.focus()` immediately after `terminal.open()` (line 399 in DirectTerminal.tsx). This is the natural insertion point because the terminal element is mounted and ready.

xterm.js `terminal.focus()` sets focus to the hidden textarea that xterm uses for keyboard input — the standard and correct way.

```tsx
// DirectTerminal.tsx — after terminal.open(terminalRef.current) line ~399
if (props.autoFocus) {
  terminal.focus();
}
```

Then, thread `autoFocus` down from each entry point:

- **`SessionTerminalTabs.tsx`** → always pass `autoFocus={true}` to the DirectTerminal it renders (since switching tabs should always grab focus)
- **`sessions/[id]/page.tsx`** → pass `autoFocus={true}` to `SessionTerminalTabs`
- **`terminals/[name]/page.tsx`** → pass `autoFocus={true}` to the DirectTerminal directly

`SessionTerminalTabs` already uses `key={activeId}` on DirectTerminal, so every tab switch causes a fresh mount — `autoFocus` fires automatically without additional logic.

### Files to Modify

| File | Change |
|------|--------|
| `packages/web/src/components/DirectTerminal.tsx` | Add `autoFocus?: boolean` to props type; call `terminal.focus()` after `terminal.open()` when true |
| `packages/web/src/components/SessionTerminalTabs.tsx` | Thread `autoFocus` prop through; pass `autoFocus={true}` to inner DirectTerminal |
| `packages/web/src/app/(with-sidebar)/sessions/[id]/page.tsx` | Pass `autoFocus={true}` to SessionTerminalTabs |
| `packages/web/src/app/(with-sidebar)/terminals/[name]/page.tsx` | Pass `autoFocus={true}` to DirectTerminal |

---

## Feature 2: Sidebar & Sub-Session Navigation Shortcuts

### Shortcut Rationale — No Chrome Conflicts

Chrome on Mac uses: `Cmd+*`, `Cmd+Shift+*`, some `Ctrl+*` (Ctrl+Tab, Ctrl+Shift+Tab).
Chrome on Windows uses: `Ctrl+*`, `Ctrl+Shift+*`, `Alt+Left/Right` (history back/forward), `Alt+F4`.

**`Alt+Up/Down/Left/Right` are safe on both platforms** — Chrome doesn't bind these (Alt+Left/Right navigate browser history only in Windows native window chrome, not inside the page content; we capture at `keydown` before that fires in our SPA context where Next.js handles routing anyway).

### Proposed Shortcuts

#### Sidebar Session Navigation
| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+↓` | Move to the next session in the sidebar |
| `Cmd+Shift+↑` | Move to the previous session in the sidebar |

#### Sub-Session Tab Navigation
| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+→` | Switch to next sub-session tab |
| `Cmd+Shift+←` | Switch to previous sub-session tab |

**Consistent strategy**: `Cmd+Shift+Arrow` throughout — Up/Down for the vertical session list, Left/Right for horizontal tab navigation. Creating new sub-sessions remains mouse-only for now.

> **Note**: `Cmd+Shift+↑/↓` are page-level shortcuts in Chrome (select text to top/bottom of document), not browser-chrome-level, so `e.preventDefault()` suppresses them successfully. Verified safe.

#### Global Terminal Navigation

`Cmd+Shift+↑/↓` applies here too — global terminals appear in the sidebar list below sessions, so the same up/down navigation cycles through them seamlessly.

### Approach

Register a `window` keydown listener in:
- `layout.tsx` for `Cmd+Shift+↑/↓` → sidebar session navigation
- `SessionTerminalTabs.tsx` for `Cmd+Shift+←/→`, `Alt+1..9`, `Alt+T`

Each listener checks `e.metaKey && e.shiftKey && e.key === "ArrowDown"` etc., calls `e.preventDefault()`, then does `router.push()` or `selectTab()`.

### Files to Modify

| File | Change |
|------|--------|
| `packages/web/src/app/(with-sidebar)/layout.tsx` | Add `Cmd+Shift+↑/↓` listener for sidebar session navigation |
| `packages/web/src/components/SessionTerminalTabs.tsx` | Add `Cmd+Shift+←/→`, `Alt+1..9`, `Alt+T` listeners |

---

## Feature 3: Workspace Panel Toggle Shortcuts

### Shortcut Rationale

Inspired by Cursor / VSCode, but adapted for Chrome safety:

| VSCode/Cursor | Our equivalent | Why different |
|---------------|---------------|---------------|
| `Cmd+B` → sidebar | — | `Cmd+B` is Bookmarks bar in Chrome on Mac |
| `Ctrl+`` ` `` ` → terminal | `Ctrl+`` ` `` ` → terminal | **Same** — safe in Chrome on both platforms |
| `Cmd+Shift+E` → explorer | `Cmd+Shift+E` / `Ctrl+Shift+E` → file tree | Safe — Chrome doesn't use this |
| (no direct preview toggle) | `Cmd+Shift+D` / `Ctrl+Shift+D` → preview | D for "diff/document preview"; Chrome Ctrl+Shift+D = Bookmark in Chrome but only on some platforms — use `Ctrl+Shift+I` instead? |

Let me land on a cleaner set:

### Proposed Shortcuts

| Shortcut (Mac) | Shortcut (Win/Linux) | Action |
|----------------|---------------------|--------|
| `Ctrl+`` ` `` ` | `Ctrl+`` ` `` ` | Toggle terminal panel |
| `Cmd+Shift+F` | `Ctrl+Shift+F` | Toggle file tree (F for Files) |
| `Cmd+Shift+P` | `Ctrl+Shift+P` | Toggle preview pane (P for Preview) |
| `Cmd+Shift+L` | `Ctrl+Shift+L` | Toggle layout orientation (horizontal ↔ vertical) |

**Conflict check:**
- `Ctrl+`` ` `` `: Not a Chrome shortcut on any platform. ✅ (Same as VSCode/Cursor)
- `Cmd+Shift+F` / `Ctrl+Shift+F`: Chrome uses `Ctrl+Shift+F` for fullscreen on some platforms but that's `F11` universally — this shortcut is free. ✅ (Note: `Ctrl+Shift+E` was confirmed taken — shows "please select text to highlight" in Chrome, so switched to F.)
- `Cmd+Shift+P` / `Ctrl+Shift+P`: Not a Chrome shortcut. xterm doesn't bind this. ✅
- `Cmd+Shift+L` / `Ctrl+Shift+L`: Not a Chrome shortcut. ✅

### Approach

Add all four shortcuts to the existing keydown handler in `WorkspaceLayout.tsx` (lines 131-141), which already has access to `toggleCollapsed`, `setVerticalLayout`, and `verticalLayout`:

```tsx
// WorkspaceLayout.tsx — extend the existing useEffect keydown handler
const handler = (e: KeyboardEvent) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === "p") { e.preventDefault(); setQuickOpenVisible(v => !v); }
  if (mod && e.shiftKey && e.key === "E") { e.preventDefault(); toggleCollapsed(0); }
  if (mod && e.shiftKey && e.key === "V") { e.preventDefault(); toggleCollapsed(1); }
  if (mod && e.shiftKey && e.key === "L") { e.preventDefault(); setVerticalLayout(!verticalLayout); }
  if (e.ctrlKey && e.key === "`") { e.preventDefault(); toggleCollapsed(2); }
};
```

Note: `Ctrl+`` ` `` `` should be checked separately from `metaKey || ctrlKey` because on Mac `metaKey` is Cmd and we want `Ctrl+`` ` `` `` (not `Cmd+`` ` `` ``).

### Files to Modify

| File | Change |
|------|--------|
| `packages/web/src/components/workspace/WorkspaceLayout.tsx` | Extend existing keydown handler with 4 new shortcuts |

---

## Risks and Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | `Alt+ArrowLeft/Right` inside terminal — do they send escape sequences before we can intercept? | We capture at `window` level with `e.preventDefault()`. xterm.js is a DOM element inside `window`, so window listener fires first. Verified pattern works for `Cmd+P` already. |
| 2 | `Alt+1..9` — will `e.preventDefault()` suppress them inside terminal? | Yes. Same interception pattern. |
| 3 | `Ctrl+`` ` `` `` on Windows — some keyboard layouts may not produce this easily | Acceptable — same limitation as VSCode/Cursor. Document the shortcut in a tooltip. |
| 4 | Does `terminal.focus()` work before WebSocket connects? | We call it right after `terminal.open()` which doesn't require WS. xterm.js focuses its internal textarea regardless of connection state. ✅ |
| 5 | Mobile — no keyboard shortcuts needed, but `autoFocus` should still work | Touch doesn't trigger keyboard focus the same way. The `autoFocus` prop may be a no-op on mobile (fine). |
| 6 | `Cmd+Shift+V` on Mac: "Paste and Match Style" in some native Mac apps | We're in a browser — not applicable. Chrome doesn't have this shortcut. ✅ |

---

## Validation Strategy

- **Auto-focus**: Open a session, verify cursor appears in terminal immediately without clicking. Create a sub-session tab, verify new tab gets focus. Open a global terminal, verify focus.
- **Sidebar nav**: Press `Alt+Down/Up` and verify the route changes to the next/previous session.
- **Sub-session nav**: Press `Alt+Right/Left` inside a session page, verify tab switches. Press `Alt+1`, `Alt+2`, verify direct jump. Press `Alt+T`, verify new terminal created with focus.
- **Panel toggles**: Press `Ctrl+`` ` `` ``, verify terminal hides/shows. Press `Cmd+Shift+E`, verify file tree hides/shows. Press `Cmd+Shift+V`, verify preview hides/shows. Press `Cmd+Shift+L`, verify layout orientation flips.
- Run `pnpm build && pnpm typecheck && pnpm lint && pnpm test`.

---

## Implementation Checklist

### Phase 1 — Auto-focus terminal

- [ ] **1.1** Add `autoFocus?: boolean` to `DirectTerminalProps` in `DirectTerminal.tsx`
- [ ] **1.2** After `terminal.open(terminalRef.current)` call `terminal.focus()` when `autoFocus` is true
- [ ] **1.3** Add `autoFocus` prop thread-through in `SessionTerminalTabs.tsx`; pass `autoFocus={true}` to inner DirectTerminal
- [ ] **1.4** Add `autoFocus` prop to `SessionTerminalTabs` component signature in `sessions/[id]/page.tsx`; pass `autoFocus={true}`
- [ ] **1.5** Pass `autoFocus={true}` to DirectTerminal in `terminals/[name]/page.tsx`
- [ ] **1.6** Manual test: session open, sub-session create/switch, global terminal open — all focus terminal

### Phase 2 — Sidebar navigation shortcuts

- [ ] **2.1** In `layout.tsx`, add `window` keydown listener for `Cmd+Shift+↑/↓` that iterates the sessions array and calls `router.push(nextSession.url)`
- [ ] **2.2** Track "focused sidebar session index" in layout state; highlight it visually in ProjectSidebar (optional: `aria-selected`)
- [ ] **2.3** In `SessionTerminalTabs.tsx`, add `window` keydown listener for:
  - [ ] `Cmd+Shift+→` → `selectTab(nextTab)`
  - [ ] `Cmd+Shift+←` → `selectTab(prevTab)`

### Phase 3 — Workspace panel shortcuts

- [ ] **3.1** Extend existing keydown handler in `WorkspaceLayout.tsx` to add:
  - [ ] `Cmd/Ctrl+Shift+F` → `toggleCollapsed(0)` (file tree)
  - [ ] `Cmd/Ctrl+Shift+P` → `toggleCollapsed(1)` (preview)
  - [ ] `Ctrl+`` ` `` `` → `toggleCollapsed(2)` (terminal) — use `e.ctrlKey && e.key === "`` ` `` "`, not `metaKey`
  - [ ] `Cmd/Ctrl+Shift+L` → `setVerticalLayout(!verticalLayout)` (layout orientation)
- [ ] **3.2** Add keyboard shortcut hints to CompactTopBar button tooltips (e.g. "Toggle terminal (Ctrl+\`)")

### Final

- [ ] Run `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
- [ ] Open PR against `gb-personal`, link issue
