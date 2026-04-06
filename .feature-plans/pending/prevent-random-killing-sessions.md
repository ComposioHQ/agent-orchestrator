# Feature Plan: Prevent Random Killing of Sessions

**Issue:** prevent-random-killing-sessions
**Branch:** `feat/prevent-random-killing-sessions`
**Status:** Pending

---

## Problem

- Sessions still planning / waiting for user input get killed when runtime dies
- No auto-restore — session sits "killed" until manual `ao session restore`
- `cleanup()` destroys killed sessions even when work is intact and restorable

## Research: Kill Code Paths

### Path 1: `list()` → `enrichSessionWithRuntimeState()` — HIGH RISK

- **File:** `session-manager.ts:855-862`
- Every `list()` call checks `runtime.isAlive()` → if false, `session.status = "killed"` in memory
- Lifecycle manager persists this via `checkSession()`
- No grace period, no retry, no state check
- `isAlive()` = `tmux has-session` with 5s timeout — any error = dead

### Path 2: `determineStatus()` — runtime dead — MEDIUM RISK

- **File:** `lifecycle-manager.ts:358-364`
- `.catch(() => true)` — errors default alive (better than Path 1)
- Confirmed dead → immediate `return "killed"`, no grace period

### Path 3: `determineStatus()` — agent process dead — MEDIUM RISK

- **File:** `lifecycle-manager.ts:414-415`
- Fallback when `getActivityState` returns null
- `isProcessRunning() = false` → `return "killed"`

### Path 4: `cleanup()` — dead runtime — MEDIUM RISK

- **File:** `session-manager.ts:1738-1745`
- `ao session cleanup` kills any session where `isAlive() = false`
- No state check — "working" sessions killed same as "merged"
- `isCleanupProtectedSession()` only protects orchestrator sessions

### Path 5: stuck detection — LOW/INDIRECT

- **File:** `lifecycle-manager.ts:330-338, 536-537`
- Idle beyond threshold → "stuck" → cleanup can pick it up later

### Path 6: PR closed — LOW RISK

- **File:** `lifecycle-manager.ts:468, 500`
- Only affects sessions with PRs, not planning-stage

### Path 7: Recovery auto-cleanup — FUTURE RISK

- **File:** `recovery/validator.ts:116-146`
- Not wired to production yet

### No auto-restore exists today

- `restoreForDelivery()` in `send()` — only restores when delivering a message. Reactive, not proactive
- "killed" status IS restorable (`NON_RESTORABLE_STATUSES` only has `"merged"`)
- But nothing triggers restore automatically on runtime death
- Flow: `isAlive() = false → killed → notify → sits dead forever`

## Root Cause

- Dead runtime → instant "killed" status, but no auto-restore follows
- `cleanup()` destroys killed sessions without checking if work is intact
- `isAlive()` is fragile — single failure = permanent kill
- `list()` mutates status directly, bypassing lifecycle state machine

## Approach

No new statuses. Keep existing `"killed"` semantics (already reversible). Add auto-restore + protections.

### Fix 1: Auto-restore on runtime death (primary fix)

- In `checkSession()` (not `determineStatus()` — keep that read-only), when a non-terminal session transitions to "killed":
  1. Attempt `sessionManager.restore(sessionId)` automatically
  2. Success → session continues, status back to "working"
  3. Failure → keep "killed", increment `restoreAttempts` metadata
  4. Max 3 attempts (matches `maxRecoveryAttempts` default in recovery system)
  5. After max → stay "killed", emit `session.killed` event, notify user
- Track in metadata: `autoRestoreAttempts`, `lastAutoRestoreAt`
- Reset counters when session becomes active again (user manually restores or runtime comes back)

### Fix 2: Grace period before restore attempt

- First `isAlive() = false` in `determineStatus()` → record `runtimeDeadSince` timestamp, return current status (no transition yet)
- Next poll: still dead + 30s elapsed → return "killed" (triggers auto-restore in `checkSession()`)
- `isAlive()` returns true before grace period → clear timestamp
- Prevents transient tmux errors from triggering unnecessary restores

### Fix 3: `list()` stops mutating status to "killed"

- `enrichSessionWithRuntimeState()` → only set `activity = "exited"`, don't change `status`
- Let lifecycle manager handle all status transitions (it has grace period + auto-restore)

### Fix 4: Protect restorable sessions from `cleanup()`

- Skip sessions in `"working"` / `"spawning"` / `"needs_input"` / `"killed"` if:
  - `autoRestoreAttempts < 3` (still being auto-restored), OR
  - Session was killed < 1h ago (give user time to notice and restore)
- Configurable protection window

### Fix 5: `isAlive()` retry in runtime-tmux

- Single retry with 500ms delay before returning false
- Handles transient tmux server hiccups

## Files to Modify

| File | Change |
|------|--------|
| `packages/core/src/session-manager.ts` | `enrichSessionWithRuntimeState()` — stop overwriting status; `cleanup()` — state protection |
| `packages/core/src/lifecycle-manager.ts` | Grace period tracking in `determineStatus()`; auto-restore in `checkSession()`; restore attempt tracking |
| `packages/plugins/runtime-tmux/src/index.ts` | Retry in `isAlive()` |
| `packages/core/src/__tests__/lifecycle-manager.test.ts` | Grace period + auto-restore tests |
| `packages/core/src/__tests__/session-manager/lifecycle.test.ts` | Cleanup protection tests |

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | **Auto-restore loop?** | Max 3 attempts, tracked in metadata. Counter resets on successful activity |
| 2 | **Grace period duration?** | 30s default. Could reuse existing config thresholds |
| 3 | **`list()` callers expecting "killed"?** | `sessionsToCheck` filter skips "killed" — need to ensure lifecycle still processes sessions with `activity = "exited"` but non-killed status |
| 4 | **Restore during `checkSession()` — timing?** | Restore is async and potentially slow. May block the poll cycle. Consider: fire-and-forget restore, check result next cycle |
| 5 | **Cleanup protection window?** | 1h default. After that, `cleanup` can kill even recently-killed sessions |

## Validation

- Mock `isAlive() = false` once then true → no status change (grace period)
- Mock sustained `isAlive() = false` → auto-restore called after 30s
- Mock restore success → session back to "working"
- Mock restore failure x3 → session stays "killed", notification sent
- `cleanup()` skips recently-killed session with `autoRestoreAttempts < 3`
- `isAlive()` retry: mock tmux fail once then succeed → returns true
- Regression: terminal-state sessions still cleaned up normally

## Checklist

### Phase 1 — `list()` stops killing sessions

- [ ] **1.1** `enrichSessionWithRuntimeState()` → only set `activity = "exited"`, not `status = "killed"`
- [ ] **1.2** Ensure lifecycle `sessionsToCheck` handles sessions with exited activity but non-killed status
- [ ] **1.3** Tests

### Phase 2 — Grace period in `determineStatus()`

- [ ] **2.1** Track `runtimeDeadSince` in session metadata
- [ ] **2.2** First dead → record timestamp, return current status
- [ ] **2.3** Still dead after 30s → return `"killed"`
- [ ] **2.4** Alive again → clear `runtimeDeadSince`
- [ ] **2.5** Tests

### Phase 3 — Auto-restore in `checkSession()`

- [ ] **3.1** On transition to "killed" from non-terminal status → attempt `restore()`
- [ ] **3.2** Track `autoRestoreAttempts` + `lastAutoRestoreAt` in metadata
- [ ] **3.3** Max 3 attempts → after that, let "killed" stick + notify
- [ ] **3.4** Reset counters when session becomes active again
- [ ] **3.5** Tests for success, failure, max attempts

### Phase 4 — Protect from `cleanup()`

- [ ] **4.1** Skip killed sessions with `autoRestoreAttempts < 3` or killed < 1h ago
- [ ] **4.2** Tests

### Phase 5 — `isAlive()` retry

- [ ] **5.1** Single retry with 500ms delay in `runtime-tmux`
- [ ] **5.2** Tests

### Phase 6 — Final

- [ ] **6.1** `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
- [ ] **6.2** Manual: spawn, kill tmux, verify auto-restore kicks in
- [ ] **6.3** Manual: kill tmux 4 times → verify stays killed after 3 restores
- [ ] **6.4** Manual: `ao session cleanup` skips recently-killed sessions
- [ ] **6.5** PR against `gb-personal`
