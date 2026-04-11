# Feature Plan: Dead tmux Session Recovery & UI Feedback

**Issue:** fix-dead-tmux-session-recovery
**Branch:** `fix/dead-tmux-session-recovery`
**Status:** WIP

---

## Problem

- After the tmux server is killed out-of-band (PC crash, `tmux kill-server`, OOM, etc.), AO session metadata on disk still exists but the underlying tmux sessions are gone.
- Opening a session from the sidebar shows the terminal chrome as **"Connected"** (green dot) with only a blinking cursor — no content, no error surfaced in the UI.
- The only signal is a browser-console log: `[MuxProvider] Terminal error for ch-2: Session not found: ch-2`.
- AO does **not** auto-recreate the tmux session even though the workspace/worktree on disk is intact and the agent could be resumed.
- User reports the same issue for `ao-*` sessions — clicking them shows "Connected" but never spawns a tmux session.

## Research

### 1. Server throws "Session not found" without client-visible UI effect

- **File:** `packages/web/server/mux-websocket.ts:245-248`
- **Trigger:** `terminalManager.open(id)` → `resolveTmuxSession()` returns `null` because `tmux has-session` and `tmux list-sessions` both miss.
- **Risk:** MEDIUM — the error is wrapped in a `ServerMessage` of type `"error"` and sent to the client (`mux-websocket.ts:548-557`), but the client never surfaces it.
- **File:** `packages/web/src/providers/MuxProvider.tsx:152-154`
- **Trigger:** `type === "error"` branch
- Only action today: `console.error(...)`. No subscriber callback, no state update, no per-terminal error context fans out.
- Result: `DirectTerminal` still reads `muxStatus === "connected"` (websocket is fine) and renders green "Connected" (`DirectTerminal.tsx:493-536`).

### 2. `resolveTmuxSession` has no fallback / recreation path

- **File:** `packages/web/server/tmux-utils.ts:68-102`
- **Trigger:** lookup of user-facing session id (e.g. `ch-2`) against live tmux server.
- Returns `null` if neither exact match nor hash-prefixed match is found. No knowledge of AO session metadata, workspacePath, or runtime plugin.
- **Risk:** MEDIUM — a reasonable place to recover would be to call the `runtime-tmux` plugin's `create()` for the persisted session record, but `mux-websocket` is a raw Next.js custom server and has no plugin-registry access. New wiring required.

### 3. Session list marks dead sessions "killed" — but not always in time

- **File:** `packages/core/src/session-manager.ts:925-951`
- **Trigger:** `enrichSessionWithRuntimeState()` calls `runtime.isAlive(handle)`; if false → `session.status = "killed"`.
- **Risk:** LOW — logic is correct, but several race conditions / gaps allow the sidebar to still show a clickable "not killed" row:
  - Liveness only runs when `handleFromMetadata` is true (`session-manager.ts:940`). Fabricated handles (external sessions without `runtimeHandle` in metadata) are skipped.
  - Result of `isAlive` is cached only for the current `list()` call — sidebar polls every few seconds via SSE, so briefly between server restart and first poll the row looks alive.
  - If the user has **"Show killed sessions"** toggled on (`ProjectSidebar.tsx:280`), killed rows remain clickable with no visual hint that the tmux backing store is gone.

### 4. runtime-tmux plugin already supports recreation, but there is no trigger

- **File:** `packages/plugins/runtime-tmux/src/index.ts:56-113` (`create()`)
- **Trigger:** called by `spawnSession` in `session-manager.ts` at new-session time only.
- **Risk:** LOW — calling `create()` again with the same `sessionId` and `workspacePath` would spin up a fresh tmux session pointing at the same worktree. The agent would re-run (e.g. `claude --resume`) from the workspace. No current code path does this.
- Note: the plugin fails if the session name already exists (tmux `new-session` without `-A`), which is actually fine for the "dead tmux" case.

### 5. `ch-*` sessions also missing — means the problem is the whole tmux server, not individual sessions

- `.ao-control/agent-orchestrator.yaml` shows `console-home.sessionPrefix: ch` and `agent-orchestrator.sessionPrefix: ao`.
- Both prefixes fail identically → `resolveTmuxSession` always returns `null` → consistent with a tmux-server-level kill (not a single stray session).
- `runtime.isAlive` will return `false` for **every** session → sidebar should cascade-mark everything killed on next list() — verify this actually happens.

## Root Cause

- **Primary:** when tmux sessions disappear, there is no recovery pathway (manual or automatic), and the UI silently reports "Connected" while nothing attaches.
- **Secondary:** the `mux-websocket` server forwards `error` messages but the client only logs them — per-terminal error state is never propagated to `DirectTerminal`.
- **Tertiary:** AO's lifecycle manager knows how to mark a session "killed" but does nothing proactive to re-spawn the tmux session for still-wanted work.

## Approach

Three layers, smallest → largest blast radius. Ship as separate commits.

### Fix 1: Surface "Session not found" errors in `DirectTerminal`

- **Where:** `packages/web/src/providers/MuxProvider.tsx:129-154`, `packages/web/src/components/DirectTerminal.tsx:490-536`
- Add a per-terminal error map to `MuxContextValue`: `terminalErrors: Map<string, string>`, plus a `subscribeTerminalError(id, cb)` or similar so `DirectTerminal` can observe.
- On `msg.type === "error"` for a terminal channel, store the error for `msg.id` and notify subscribers.
- In `DirectTerminal`, prefer the terminal-level error over `muxStatus` when rendering the chrome bar — show red dot + message like `"Session not found — tmux session may have died. Click 'Recreate' to respawn."`.
- Clear the error on next successful `opened` message (so manual recovery removes the banner).
- Key behavioral difference: the UI stops lying about "Connected" when the tmux session is gone.

### Fix 2: Auto-recreate tmux session on the `open` attempt

- **Where:** `packages/web/server/mux-websocket.ts:239-264` (`TerminalManager.open`)
- When `resolveTmuxSession(id, TMUX)` returns `null`, don't throw immediately. Instead call a new recovery helper `tryRecreateSession(id)` and retry `resolveTmuxSession` once. Only throw `Session not found` if the recreate also fails.
- Why auto and not a button: the user already expressed intent by clicking / navigating to the session. Recreate fires for exactly one session (the one being opened), not 20-at-a-time on sidebar load. No stampede.
- **Recovery helper** (new file `packages/web/server/session-recovery.ts`):
  - Load session metadata via `SessionManager.get(id)` — needs the session manager injected into the mux server at boot (currently only `broadcaster` is). Add `createMuxWebSocket({ tmuxPath?, sessionManager, registry })`.
  - Resolve the `runtime-tmux` plugin from the registry, call `runtime.create({ sessionId, workspacePath, environment, launchCommand })` using persisted metadata.
  - For `launchCommand`: prefer `agent.getRestoreCommand(session)` (Claude Code `--resume`, Codex equivalent); fall back to `agent.getLaunchCommand(session)`; fall back to empty shell.
  - Flip `session.status` from `"killed"` → appropriate non-terminal state and persist.
  - Return `{ ok: true }` or `{ ok: false, reason }`.
- **Concurrency:** per-session in-flight map in `TerminalManager` so two near-simultaneous `open` messages (multi-tab, React StrictMode double-mount) share one recreate promise instead of racing `tmux new-session`.
- **Rate-limit / guard:** don't auto-recreate more than once per session per N minutes — if the recreate itself crashed the tmux session, we'd loop. Use `terminal.reattachAttempts` style counter keyed by session id.
- **Preconditions that must fail loudly (not auto-recreate):**
  - Workspace path no longer exists on disk → surface error via Fix 1.
  - Stale `.git/index.lock` in workspace → surface with clear message, don't blindly delete.
  - Runtime plugin unavailable / not `runtime-tmux` → surface error.
  - Session metadata marked as genuinely terminated by user (`"cleanup"` / `"merged"`) → do not recreate.
- **UI:** no button needed for the happy path. The user clicks the session and content appears. Fix 1's error surfacing kicks in only when auto-recreate fails — in that case, DirectTerminal shows the red chrome with the real reason ("workspace missing", "git lock held", etc.) and a **"Retry"** button that simply re-issues the mux `open` message (which re-triggers auto-recreate).
- Key behavioral difference: clicking a dead session just works. Failure is the exceptional, explained path — not the default.

### Fix 3: Cascade-mark sessions killed on tmux server death

- **Where:** `packages/core/src/session-manager.ts:925-951`
- When `runtime.isAlive` throws or returns false AND the `runtime` plugin itself reports no live sessions at all (add `Runtime.hasAnySessions?()` optional method, implement in `runtime-tmux` as `tmux list-sessions || return false`), mark all live sessions in one pass and emit a single "tmux server unavailable" event via the broadcaster.
- `packages/web/server/mux-websocket.ts`: subscribe to this event, broadcast an `errors.global` frame so `MuxProvider` can show a top-level banner: *"tmux server died — sessions need to be recreated"*.
- **Risk:** MEDIUM — global banner must not be sticky; clear as soon as `hasAnySessions()` returns true again.
- Key behavioral difference: a PC crash turns into one global banner + many killed rows, not a sidebar full of lies.

## Files to Modify

| File | Change |
|------|--------|
| `packages/web/src/providers/MuxProvider.tsx` | Add per-terminal error state + subscribe API; clear on `opened` |
| `packages/web/src/components/DirectTerminal.tsx` | Render terminal error over mux status; add "Recreate" button |
| `packages/web/server/session-recovery.ts` | New helper: load session, resolve runtime/agent plugins, respawn tmux |
| `packages/web/server/mux-websocket.ts` | Inject `sessionManager` + `registry`; call recovery helper on `open` miss; per-session in-flight map |
| `packages/core/src/session-manager.ts` | Cascade-mark killed; emit tmux-server-down event |
| `packages/core/src/types.ts` | Optional `Runtime.hasAnySessions?()` |
| `packages/plugins/runtime-tmux/src/index.ts` | Implement `hasAnySessions()` via `tmux list-sessions` |
| `packages/web/server/mux-websocket.ts` | Broadcast `errors.global` for tmux-server-down |
| `packages/web/src/lib/mux-protocol.ts` | New message types: `errors.global`, `terminal.error` already exists — audit |

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | **Does `claude --resume` reliably work from a cold workspace?** | Needs validation per agent plugin — Codex/OpenCode/Aider differ. Fall back to plain launch command if resume fails. |
| 2 | **Auto-recreate vs. manual button?** | Auto on `open` message. User click = intent signal → no stampede (only the clicked session fires). Manual "Retry" button appears only in the failure path via Fix 1. |
| 2a | **Cost of auto-resume (API tokens for `claude --resume`)?** | Only fires on user click, so equivalent to opening a dead session today — the user expected work to resume. Guard with per-session 1-per-N-min rate limit to prevent loops. |
| 3 | **Who owns the "tmux-server-down" banner state?** | `MuxProvider` top-level state; cleared on next successful snapshot. |
| 4 | **Concurrency of recreate calls** | Guard the recreate route with a per-session lock (same pattern as existing session-manager writes) so double-click doesn't spawn two tmux sessions. |
| 5 | **Worktree state on disk after crash** | `.git/index.lock` may be stale — recreate flow should detect and surface it rather than swallowing the error. |

## Validation

- Unit: `MuxProvider` routes `terminal.error` to a specific subscriber and clears on `opened`.
- Unit: `session-manager.ensureHandleAndEnrich` marks session killed and fires tmux-down event when `hasAnySessions()` is false.
- Unit: `runtime-tmux.hasAnySessions` returns false when tmux server is not running (mocked `execFile`).
- Integration: manual — kill `tmux kill-server`, load dashboard, verify:
  - Sidebar rows flip to "killed" within one poll cycle.
  - Global banner appears.
  - Clicking a session shows red "Session not found" chrome instead of green "Connected".
  - "Recreate" button respawns tmux and terminal reattaches.
- Regression: spawning a brand-new session still works (no double create); existing reconnect flow for a *live* terminal is unchanged.

## Checklist

### Phase 1 — Surface the error

- [ ] **1.1** Extend `ClientMessage`/`ServerMessage` typings if needed in `packages/web/src/lib/mux-protocol.ts`
- [ ] **1.2** Add `terminalErrors` + `subscribeTerminalError` to `MuxProvider.tsx`
- [ ] **1.3** Consume terminal error in `DirectTerminal.tsx` — prefer over `muxStatus`
- [ ] **1.4** Clear terminal error on `opened`
- [ ] **1.5** Unit tests for MuxProvider error routing

### Phase 2 — Auto-recreate on open

- [ ] **2.1** Inject `sessionManager` + plugin `registry` into `createMuxWebSocket` at server boot
- [ ] **2.2** New helper `server/session-recovery.ts`: `recreateTmuxForSession(id, { sessionManager, registry })` → returns `{ ok } | { ok:false, reason }`
- [ ] **2.3** Hook into `TerminalManager.open`: on `resolveTmuxSession == null` call helper, retry, then throw
- [ ] **2.4** Per-session in-flight promise map (shared across tabs/StrictMode double-open)
- [ ] **2.5** Rate limit: max 1 auto-recreate per session per N minutes; counter lives on `ManagedTerminal`
- [ ] **2.6** Preconditions: workspace exists, no stale git lock, not terminal-status, runtime is tmux
- [ ] **2.7** "Retry" button on the Fix-1 error chrome (re-sends mux `open`)
- [ ] **2.8** Unit tests for `session-recovery`: happy path, missing workspace, stale lock, concurrent open, rate-limit
- [ ] **2.9** Manual: kill tmux, click session, verify agent auto-resumes with no user action

### Phase 3 — Cascade + global banner

- [ ] **3.1** Optional `Runtime.hasAnySessions?()` in `packages/core/src/types.ts`
- [ ] **3.2** Implement in `packages/plugins/runtime-tmux/src/index.ts`
- [ ] **3.3** Cascade-kill branch in `session-manager.enrichSessionWithRuntimeState`
- [ ] **3.4** Emit `errors.global` via mux broadcaster
- [ ] **3.5** Top-level banner in `MuxProvider` / layout
- [ ] **3.6** Unit tests for cascade behavior
- [ ] **3.7** Manual: `tmux kill-server` → banner appears → `tmux new -d` → banner clears

## Notes

- Root cause of the user's original symptom (blinking cursor + "Connected"): Fix 1 alone resolves the misleading status. Fixes 2 and 3 turn the fix into a real recovery workflow instead of just honest error reporting.
- The existing reconnect/retry loop in `mux-websocket.ts:335-360` (`pty.onExit` → `open()` retry with `MAX_REATTACH_ATTEMPTS=3`) does **not** help here because `open()` still fails at `resolveTmuxSession` — there's nothing to re-attach to.
- Keep the `AO` control file `/home/gb/.ao-control/agent-orchestrator.yaml` untouched — this is purely a code fix.
