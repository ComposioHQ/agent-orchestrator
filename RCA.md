# Root Cause Analysis: `ao start` Spawns New Orchestrator Sessions After `ao stop`

## Summary

`ao start` incorrectly spawns a new orchestrator session (e.g., `prefix-orchestrator-2`, `-3`, etc.) on every invocation following `ao stop`, instead of restoring the previously killed orchestrator. The root cause is a gap introduced by PR #1308 (commit `e45f34e`): the fix made `ao stop` correctly kill orchestrators for the first time, but `sm.kill()` **archives** the session metadata, and `ao start`'s restorable-session detection only reads **active** (non-archived) sessions via `sm.list()`.

## Regression Timeline

| Before `e45f34e` | After `e45f34e` |
|---|---|
| `ao stop` used phantom ID `${prefix}-orchestrator` (bare, unnumbered) | `ao stop` resolves the real numbered ID via `sm.list()` + `isOrchestratorSession` |
| `sm.get(phantomId)` returned `null` → `sm.kill()` never called | `sm.kill(realId)` is called → tmux destroyed, metadata archived |
| Orchestrator metadata stayed in active sessions dir | Orchestrator metadata moved to `archive/` subdirectory |
| Next `ao start` → `sm.list()` found the orchestrator → reused it | Next `ao start` → `sm.list()` returns empty → spawns fresh orchestrator |

Before `e45f34e`, `ao stop` was a silent no-op for the orchestrator (the phantom ID never matched a real numbered session). The orchestrator tmux session kept running, and on the next `ao start`, `sm.list()` found it alive and reused it. The fix made `ao stop` actually work — but exposed a gap in `ao start`'s restore logic.

## Exact Code Path

### 1. `ao stop` now correctly kills and archives the orchestrator

**File:** `packages/cli/src/commands/start.ts` (registerStop), lines ~1670-1710

Before `e45f34e`:
```typescript
const sessionId = `${project.sessionPrefix}-orchestrator`; // phantom bare ID
const existing = await sm.get(sessionId);          // always null for numbered sessions
if (existing) { await sm.kill(sessionId); }         // never reached
```

After `e45f34e`:
```typescript
const projectSessions = await sm.list(_projectId);
const orchestrators = projectSessions
  .filter(s => isOrchestratorSession(s, ...))
  .filter(s => !isTerminalSession(s));
const sorted = [...orchestrators].sort(byMostRecent);
orchestratorToKill = sorted[0] ?? null;
if (orchestratorToKill) { await sm.kill(orchestratorToKill.id); } // now works
```

### 2. `sm.kill()` archives the session metadata

**File:** `packages/core/src/session-manager.ts`, lines 1984-1989

```typescript
updateMetadata(sessionsDir, sessionId, {
  ...lifecycleMetadataUpdates(raw, terminatedLifecycle),
});
// Archive metadata — moves file from sessions/ to sessions/archive/
deleteMetadata(sessionsDir, sessionId, true);  // archive=true
```

`deleteMetadata(dir, id, true)` copies the metadata file to `{dir}/archive/{id}_{timestamp}` and then **removes** it from the active sessions directory.

### 3. `ao start` only reads active sessions, not archives

**File:** `packages/cli/src/commands/start.ts` (runStartup), lines ~1098-1150

```typescript
const sm = await getSessionManager(config);
const allSessions = await sm.list(projectId);  // only active sessions
const orchestrators = allSessions.filter(s =>
  isOrchestratorSession(s, project.sessionPrefix ?? projectId, allSessionPrefixes),
);

const live = orchestrators.filter(s => !isTerminalSession(s));
const restorable = orchestrators.filter(s => isRestorable(s));
// Both arrays are empty because the session was archived by ao stop
const candidates = live.length > 0 ? [...live] : [...restorable];
// candidates.length === 0 → spawns a fresh orchestrator
```

`sm.list()` calls `loadActiveSessionRecords()` which uses `listMetadata()`:

**File:** `packages/core/src/metadata.ts`, lines 360-370

```typescript
export function listMetadata(dataDir: string): SessionId[] {
  return readdirSync(dir).filter((name) => {
    if (name === "archive" || name.startsWith(".")) return false;  // skips archive dir
    // ...
  });
}
```

### 4. `sm.restore()` CAN read archives but is never called

**File:** `packages/core/src/session-manager.ts`, lines 2606-2618

```typescript
// Fall back to archived metadata (killed/cleaned sessions)
if (!raw) {
  for (const [key, proj] of Object.entries(config.projects)) {
    const dir = getProjectSessionsDir(proj);
    const archived = readArchivedMetadataRaw(dir, sessionId);
    if (archived) { raw = archived; fromArchive = true; break; }
  }
}
```

`sm.restore()` searches archives — but `start.ts` never reaches this code path because it doesn't know the archived session exists.

### 5. New orchestrator gets a new number (never reuses archived IDs)

**File:** `packages/core/src/session-manager.ts`, lines 866-876

```typescript
for (const sessionName of [
  ...listMetadata(sessionsDir),
  ...listArchivedSessionIds(sessionsDir),  // includes archived IDs
]) {
  // ... marks the number as used
}
// Picks next unused number → always increments
```

`reserveNextOrchestratorIdentity` checks both active AND archived IDs to avoid number collisions. So after `orchestrator-1` is archived, the next spawn creates `orchestrator-2`, not `orchestrator-1`.

## Reproduction Steps

1. Run `ao start` → creates `{prefix}-orchestrator-1`
2. Run `ao stop` → correctly kills and **archives** `orchestrator-1`
3. Run `ao start` → `sm.list()` finds no orchestrators → spawns `{prefix}-orchestrator-2`
4. Repeat: each `ao stop` + `ao start` cycle creates a new numbered orchestrator

## Impact

- Each `ao stop` + `ao start` cycle creates a new orchestrator session with a new numbered ID, new worktree, and new git branch (`orchestrator/{prefix}-orchestrator-N`)
- Previous orchestrator context (conversation history, session state) is lost
- Worktree and branch accumulation on disk over many cycles
- Dashboard URL changes on each restart (different session ID)

## Why This Wasn't Caught

The PR's test suite mocks `sm.list()` and `sm.restore()` — it fabricates session arrays with pre-set metadata and lifecycle states. The tests verify that `start.ts` correctly handles live/restorable bucketing given correctly-shaped session data. But they don't test the end-to-end flow where `sm.kill()` archives a session and the subsequent `sm.list()` doesn't find it.

Specifically, the "restores the latest restorable orchestrator when tmux is gone" test (line 964 of `start.test.ts`) sets up `mockSessionManager.list` to return sessions WITH terminal metadata — but in production, those sessions would have been archived by `sm.kill()` and wouldn't appear in `sm.list()` output at all.

## Suggested Fix

`ao start` should also search archived orchestrator sessions when the active session list yields no reusable candidates. Two approaches:

**Option A (minimal):** After finding `candidates.length === 0`, scan the archive directory for orchestrator sessions and attempt to restore the most recent one:
```typescript
if (candidates.length === 0) {
  // Check archives for restorable orchestrators
  const archivedOrchestrators = listArchivedSessionIds(sessionsDir)
    .filter(id => isOrchestratorSessionById(id, project.sessionPrefix));
  if (archivedOrchestrators.length > 0) {
    const mostRecent = archivedOrchestrators[archivedOrchestrators.length - 1];
    const restored = await sm.restore(mostRecent);
    // ... use restored session
  }
}
```

**Option B (structural):** Change `sm.kill()` for orchestrator sessions to NOT archive (keep metadata in active dir with terminated state), or add an `sm.listWithArchived()` variant that `start.ts` can use for orchestrator detection.
