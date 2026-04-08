# Terminal Exit: Auto-remove Dead Sub-Session Tabs

## Problem
- Users can spawn extra terminals per session via the `+` button in `SessionTerminalTabs`
- When the underlying tmux session for a terminal sub-session dies (user types `exit`, process crashes, host reboot), the tab lingers in the UI with an "alive: false" dimmed state
- Desired: dead terminal tabs disappear automatically; user re-creates via `+` (reusing the same tmux name is acceptable since current create flow assigns sequential `-tN` ids)

## Scope
- Only `type === "terminal"` sub-sessions are auto-removed
- `type === "primary"` (the Agent / main session) is **never** auto-removed — it already has auto-restore support and represents the session itself
- Applies to every terminal tab a user creates via `+`, including the first one

## Research Findings
- `packages/web/src/components/SessionTerminalTabs.tsx:33` — renders tabs from `/api/sessions/:id/sub-sessions`; currently keeps dead terminals and offers restore-on-click
- `packages/web/src/app/api/sessions/[id]/sub-sessions/route.ts` — GET lists subs with `alive` flag; POST creates new
- `packages/web/src/app/api/sessions/[id]/sub-sessions/[subId]/restore/route.ts` — restore endpoint (will no longer be needed for terminals once auto-remove lands; keep for now)
- `alive` is computed server-side from tmux `has-session` — already the source of truth
- Polling: `loadSubs()` runs only on mount + after create/restore. No interval refresh → dead terminals are only detected on next user action

## Proposed Approach
- **Server**: add DELETE endpoint `/api/sessions/:id/sub-sessions/:subId` that removes a sub-session metadata entry. Guard: `type === "terminal"` AND `alive === false` — reject primary, reject live terminals.
- **Client (`SessionTerminalTabs.tsx`)**:
  1. After each `loadSubs()` result, filter out `type === "terminal" && !alive` entries from the rendered tab row AND fire-and-forget DELETE to clean server metadata. Primary is passed through untouched.
  2. Add a lightweight poll: re-run `loadSubs()` every 5s while the component is mounted (align with existing SSE 5s cadence constraint C-14)
  3. If the active tab was a terminal that just died, fall back to primary via the existing `activeId` effect
  4. Remove the dead-terminal restore branches in `selectTab` and the initial-load path (dead terminals no longer appear, so restore-on-click becomes dead code for terminals — primary auto-restore path stays untouched)
- **Sub-session id reuse**: confirm create path assigns next available `-tN` — if it currently monotonically increments past deleted ids, that's fine (user only cares that `+` works). No change needed unless tests reveal collision.

## Files to Modify
- `packages/web/src/app/api/sessions/[id]/sub-sessions/[subId]/route.ts` *(new)* — DELETE handler
- `packages/web/src/components/SessionTerminalTabs.tsx` — filter + poll + prune
- `packages/web/src/components/__tests__/SessionTerminalTabs.test.tsx` — add tests (create if missing)
- Possibly `packages/core/src/session-manager.ts` — expose `deleteSubSession` if not already present

## Risks / Open Questions
- Race: poll fires while user is mid-create → new sub briefly missing. Mitigate by skipping prune while `creating === true`
- `tmuxName` reuse: if new `-tN` reuses a name of a recently-deleted-but-not-yet-reaped tmux session, attach could hit stale PTY. Verify create path calls `tmux kill-session` defensively or uses unique names
- Grace period: require two consecutive `alive: false` readings before deletion to avoid flicker on transient tmux query failures

## Validation
- Manual: spawn session → add 2 terminals → `exit` in one → within ~10s the tab disappears; primary remains; `+` creates a fresh terminal
- Unit: mock `/sub-sessions` responses, assert dead terminals are filtered + DELETE called, primary never deleted
- `pnpm --filter @composio/ao-web test`, `pnpm typecheck`, `pnpm lint`

## Implementation Checklist
- [ ] Add DELETE route handler (guard: terminal-only)
- [ ] Add `deleteSubSession` to session-manager if missing
- [ ] Add 5s poll in `SessionTerminalTabs` (cleared on unmount)
- [ ] Track "seen-dead-once" map to require 2 consecutive dead readings
- [ ] Filter dead terminals from rendered `rows`; fire DELETE for confirmed-dead
- [ ] Skip prune while `creating === true`
- [ ] Drop dead-terminal restore code paths in `selectTab` + initial load
- [ ] Tests for filter, poll, DELETE, primary protection
- [ ] `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
