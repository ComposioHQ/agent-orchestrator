# AO UI Enhancements Plan

## Problems to Solve

1. **Sidebar disappears on session detail** — selecting a session navigates to `/sessions/[id]` which loses the project sidebar context.
2. **Mobile terminal not scrollable** — touch scrolling doesn't work reliably on iOS/Android.
3. **Missing terminal keys on mobile** — soft keyboards lack Esc, Tab, arrows, Ctrl, Alt, PgUp/PgDn.

## Goals

- Sidebar always visible when viewing session details (new route `/s/[id]` with shared layout).
- Mobile terminal scrolling works on iOS Safari and Android Chrome.
- Mobile virtual key bar appears above IME with: Esc, Tab, Ctrl, Alt, arrows, PgUp/PgDn.
- Original `/sessions/[id]` route remains untouched (fork-friendly, no merge conflicts).

## Modularity Note

This is a forked repo. Prefer additive changes (new files) over editing existing files to ease future rebases from upstream.

## Virtual Key Bar Layout

```
[ Esc ] [ Ctrl ]              [ ↑ ] [ PgUp ]
[ Tab ] [ Alt  ]        [ ← ][ ↓ ][ → ] [ PgDn ]
```

- **Visibility**: Only shown on mobile when IME (keyboard) is open.
- **Positioning**: Use `visualViewport` API to anchor above IME.
- **Ctrl/Alt**: Sticky modifiers — tap to arm, next key sends chord.

---

## Implementation Checklist

### Milestone A — Persistent Sidebar Shell

- [ ] **Create** `packages/web/src/app/(with-sidebar)/layout.tsx`
  - Flex shell with `ProjectSidebar` + `children`.
  - Fetch projects list for sidebar.
  - Handle collapsed state (localStorage).

- [ ] **Move** `packages/web/src/app/page.tsx` → `packages/web/src/app/(with-sidebar)/page.tsx`
  - Remove sidebar rendering from `Dashboard.tsx` (layout handles it).

- [ ] **Create** `packages/web/src/app/(with-sidebar)/s/[id]/page.tsx`
  - New route with sidebar shell.
  - Reuse `SessionDetail` component.
  - Fetch session data same as original.

- [ ] **Edit** `packages/web/src/components/ProjectSidebar.tsx`
  - Derive `activeSessionId` from route param when on `/s/[id]`.
  - Session clicks navigate to `/s/<id>`.

- [ ] **Edit** `packages/web/src/components/Dashboard.tsx`
  - Remove `ProjectSidebar` render (now in layout).

- [ ] **Keep** `packages/web/src/app/sessions/[id]/page.tsx` unchanged.

---

### Milestone B — Mobile Terminal Usability

- [ ] **Edit** `packages/web/src/components/DirectTerminal.tsx`
  - Add `touch-action: pan-y` to xterm viewport for mobile scroll.
  - Add `followOutput` state: auto-scroll on write, disable on user scroll up.
  - Show "Jump to latest ↓" button when not following.
  - Increase tap targets on mobile (≥44px).

- [ ] **Edit** `packages/web/src/app/globals.css`
  - Mobile touch-scroll overrides for `.xterm .xterm-viewport`.

- [ ] **Create** `packages/web/src/lib/terminal-keys.ts`
  - Export: `escSeq()`, `tabSeq()`, `arrowSeq(dir)`, `pgUpSeq()`, `pgDnSeq()`, `ctrlChar(char)`.

- [ ] **Create** `packages/web/src/lib/__tests__/terminal-keys.test.ts`
  - Test each helper returns correct escape sequences.

- [ ] **Create** `packages/web/src/components/MobileTerminalKeys.tsx`
  - Two-row grid: Esc, Tab, Ctrl, Alt, arrows, PgUp, PgDn.
  - Props: `onSend: (data: string) => void`.
  - Sticky modifier state for Ctrl/Alt.
  - Use `visualViewport` to position above IME; hidden when IME closed.

- [ ] **Edit** `packages/web/src/components/DirectTerminal.tsx`
  - Import and render `MobileTerminalKeys` on narrow viewports.
  - Wire `onSend` to WebSocket send.

---

### Milestone C — Polish (Optional)

- [ ] Keyboard navigation in sidebar (arrow keys + Enter).
- [ ] Loading skeleton while fetching session.
- [ ] Error fallback with retry button.
- [ ] Next/previous session buttons in detail header.

---

## File Summary

| Action | Path |
|--------|------|
| Create | `app/(with-sidebar)/layout.tsx` |
| Move   | `app/page.tsx` → `app/(with-sidebar)/page.tsx` |
| Create | `app/(with-sidebar)/s/[id]/page.tsx` |
| Keep   | `app/sessions/[id]/page.tsx` *(unchanged)* |
| Edit   | `components/ProjectSidebar.tsx` |
| Edit   | `components/Dashboard.tsx` |
| Edit   | `components/DirectTerminal.tsx` |
| Edit   | `app/globals.css` |
| Create | `components/MobileTerminalKeys.tsx` |
| Create | `lib/terminal-keys.ts` |
| Create | `lib/__tests__/terminal-keys.test.ts` |

*(All paths relative to `packages/web/src/`)*

---

## Ready for Implementation?

**Yes.** The checklist is concrete enough for cursor auto to execute:

- Clear file paths for create/move/edit actions.
- Specific component names and props.
- Defined behavior (visualViewport, sticky modifiers, escape sequences).
- Existing code patterns to follow (see current `DirectTerminal.tsx`, `ProjectSidebar.tsx`).

Recommend executing **Milestone A first**, then B, then C. Each milestone is independently shippable.

---

## Local UI Testing (ao-85 worktree with existing AO runtime)

Use this to run only the UI from this worktree on port `3100`, while reusing your already-running AO backend/terminal services:

```bash
cd /home/gb/.worktrees/agent-orchestrator/ao-85

AO_CONFIG_PATH="/absolute/path/to/your/agent-orchestrator.yaml" \
PORT=3100 \
NEXT_PUBLIC_TERMINAL_PORT=14800 \
NEXT_PUBLIC_DIRECT_TERMINAL_PORT=14801 \
pnpm --filter @composio/ao-web dev:next
```

Then open:

- `http://localhost:3100/`
- `http://localhost:3100/s/<session-id>`
