# Feature Plan: Fix new session not receiving intro prompt

**Issue:** new-session-bug
**Branch:** `feat/new-session-bug`
**Status:** Pending

---

## Problem

- When `ao spawn` creates a new session for a project (no existing sessions, no orchestrator), the agent (Claude Code) doesn't receive the intro prompt
- The session launches but sits idle — user must manually send instructions via `ao send`
- Affects all post-launch prompt delivery agents (Claude Code) when spawned standalone

## Research

### Post-launch prompt delivery in `spawn()`

- **File:** `packages/core/src/session-manager.ts:1269-1303`
- **Trigger:** `plugins.agent.promptDelivery === "post-launch"` (Claude Code)
- **Risk:** HIGH — prompt delivery uses naive fixed-delay retries (3s, 6s, 9s) without checking if the agent is interactive
- The `runtime.sendMessage()` (tmux `paste-buffer` + `send-keys Enter`) succeeds from tmux's perspective even if Claude Code hasn't finished initializing
- `promptDelivered` is set to `true` because tmux commands don't fail — the text is pasted into the pane but Claude Code may not be reading stdin yet
- No CLI warning is shown because `promptDelivered === "true"` in metadata

### Readiness check in `send()`

- **File:** `packages/core/src/session-manager.ts:2001-2052` (`waitForInteractiveReadiness`)
- **File:** `packages/core/src/session-manager.ts:2103-2148` (`prepareSession`)
- These functions are used by the `send()` method (used by lifecycle manager / `ao send` CLI)
- `waitForInteractiveReadiness` polls every 500ms for up to 20s, checking:
  - Runtime is alive
  - Agent process is running
  - Foreground command matches agent's `processName`
  - Terminal output is stable (same content for 2 consecutive polls)
- `prepareSession` specifically checks `status === "spawning"` and calls `waitForInteractiveReadiness` in that case
- This readiness check is NOT used by `spawn()`'s post-launch delivery

### `sendMessage` in tmux runtime

- **File:** `packages/plugins/runtime-tmux/src/index.ts:123-159`
- Sends `C-u` (clear line), then pastes text via `load-buffer`/`paste-buffer`, then `Enter`
- Succeeds as long as tmux session exists — does NOT verify foreground process readiness
- Text pasted before Claude Code is interactive gets lost or garbled when Claude Code enters raw mode

### `waitForInteractiveReadiness` dependencies

- **File:** `packages/core/src/session-manager.ts:2001-2052`
- Uses: `runtimePlugin.isAlive()`, `agentPlugin.isProcessRunning()`, `runtimePlugin.getOutput()`, `getTmuxForegroundCommand()`, `agentPlugin.processName`
- `getTmuxForegroundCommand` is a module-level function (`session-manager.ts:233`)
- Constants: `SEND_BOOTSTRAP_READY_TIMEOUT_MS` (20s), `SEND_BOOTSTRAP_STABLE_POLLS` (2), `SEND_RESTORE_READY_POLL_MS` (500ms)
- Currently defined as closure inside `send()` — needs extraction to be reusable

## Root Cause

- `spawn()` post-launch delivery at `session-manager.ts:1274-1303` uses simple `setTimeout` delays before calling `runtime.sendMessage()`
- No readiness check verifies Claude Code has finished initializing and is interactive
- tmux `paste-buffer` succeeds silently even when Claude Code isn't ready — `promptDelivered` is set to `true`
- The `send()` function has a proper readiness check (`waitForInteractiveReadiness`) but `spawn()` doesn't use it
  - The readiness checker is scoped inside the `send()` closure and not accessible from `spawn()`

## Approach

### Fix 1: Extract readiness checker and use it in `spawn()` post-launch delivery

- Extract `waitForInteractiveReadiness` logic into a standalone helper function at module level in `session-manager.ts`
  - Takes: `runtime`, `agent`, `handle`, `timeoutMs` as parameters (instead of closing over them)
- Replace the naive delay loop in `spawn()` (lines 1273-1303) with:
  1. Call the extracted readiness checker (up to 20s timeout)
  2. Then send the prompt once via `runtime.sendMessage()`
  3. Keep the fallback: if readiness times out, still attempt send (agent might be ready but output not detected)
  4. Keep `promptDelivered` metadata tracking
- Update `send()`'s inline `waitForInteractiveReadiness` to delegate to the extracted helper
- No changes to tmux runtime or agent plugins needed

### Fix 2: Add delivery confirmation to `spawn()`

- After sending prompt, poll output (like `sendWithConfirmation` in `send()`) to verify the agent received it
- If not confirmed, retry once
- This is optional / follow-up — readiness check alone should fix the primary issue

## Files to Modify

| File | Change |
|------|--------|
| `packages/core/src/session-manager.ts` | Extract `waitForInteractiveReadiness` to module-level helper; use in `spawn()` post-launch delivery; update `send()` to use same helper |

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | **Does the 20s timeout cover slow Claude Code startups?** | Current `SEND_BOOTSTRAP_READY_TIMEOUT_MS` is 20s — same as `send()` uses. Should be sufficient. |
| 2 | **Can we break `send()` by extracting the helper?** | Low risk — function signature change is internal, same logic. Needs test coverage. |
| 3 | **What if readiness check passes but send still fails?** | Keep the try/catch and `promptDelivered=false` path. User can still `ao send` manually. |
| 4 | **Does `spawn()` have access to runtime/agent plugins for readiness check?** | Yes — `plugins.runtime` and `plugins.agent` are available in `spawn()` scope. |

## Validation

- Unit test: `spawn()` waits for agent readiness before sending prompt (mock `isProcessRunning`, `getOutput`, `isAlive`)
- Unit test: `spawn()` still sets `promptDelivered=false` if send fails after readiness
- Unit test: `send()` still works after extracting readiness helper (existing tests should pass)
- Regression: `ao spawn <issue>` with Claude Code agent actually receives the prompt
- Regression: `ao send` still delivers messages correctly

## Checklist

### Phase 1 — Extract readiness helper

- [ ] **1.1** Create module-level `waitForAgentReadiness()` helper in `session-manager.ts` taking `{runtime, agent, handle, timeoutMs}` params
- [ ] **1.2** Refactor `send()`'s `waitForInteractiveReadiness` to delegate to the new helper
- [ ] **1.3** Verify existing `send()` tests still pass

### Phase 2 — Fix `spawn()` post-launch delivery

- [ ] **2.1** Replace fixed-delay retry loop in `spawn()` (lines 1273-1303) with call to `waitForAgentReadiness()`
- [ ] **2.2** After readiness check, single `runtime.sendMessage()` attempt with fallback
- [ ] **2.3** Keep `promptDelivered` metadata tracking

### Phase 3 — Tests

- [ ] **3.1** Add spawn test: prompt delivery waits for agent readiness
- [ ] **3.2** Add spawn test: prompt delivery falls back gracefully on timeout
- [ ] **3.3** Run full test suite: `pnpm build && pnpm typecheck && pnpm test`
