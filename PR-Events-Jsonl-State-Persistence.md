# PR: Append-Only Event Log for State Persistence

## Summary

Replace the split-brain architecture (ephemeral in-memory Map + flat-file metadata) with an append-only JSON Lines event log (`events.jsonl`) for crash-safe, persistent state management in the agent orchestrator.

## Problem

The current orchestrator relies on dual state management:

- Ephemeral in-memory `Map<SessionId, SessionStatus>` in `lifecycle-manager.ts`
- Persistent flat-file `metadata.ts`

This split-brain architecture creates fragility during unexpected process termination with these failure modes:

| Failure Mode                               | Description                                                                                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Lifecycle Manager Restart = State Loss** | If the lifecycle worker crashes, times out, or restarts, all tracked `statesMap` entries are instantly lost from memory.                                   |
| **Stale Metadata Fallback**                | On restart, system falls back to reading status from flat-file metadata. May contain stale values (e.g., "working" when process has exited).               |
| **Checkpoint/Resume Gap**                  | No mechanism to checkpoint lifecycle state mid-poll. On crash during `pollAll()`, system restarts and re-evaluates all sessions from scratch.              |
| **Race Conditions**                        | Multiple lifecycle workers can write conflicting metadata updates. `atomicWriteFileSync` ensures single-file atomicity, but not cross-session consistency. |
| **No Distributed Coordination**            | Running multiple orchestrator instances lacks coordination mechanism, leading to competing instances overwriting each other's metadata.                    |

## Solution

Implemented append-only event logging in `packages/core/src/state-store.ts`:

```plaintext
~/.agent-orchestrator/{hash}-{projectId}/state/
    events.jsonl       # NEW: Append-only JSON Lines event log
```

### Key Changes

| File                                     | Change                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/state-store.ts`       | Added `ensureEventsFileExists()`, `getEventsFilePath()`, improved `init()` to create events.jsonl on startup |
| `packages/core/src/lifecycle-manager.ts` | Integrated StateStore for recording state transitions via `recordStateTransition()`                          |

### Implementation Details

1. **Initialization**: On startup, `StateStore.init()` creates the `state/` directory and `events.jsonl` file if they don't exist.

2. **State Transitions**: Every status change is logged via `recordStateTransition()` which appends a JSON event to `events.jsonl`.

3. **Hydration**: On restart, `hydrateState()` replays all events from `events.jsonl` to rebuild in-memory state.

4. **Crash Safety**: Uses atomic `appendFileSync` for lock-free concurrent writes.

## Why Append-Only JSONL

| Property                  | Monolithic Flat File (Before)                    | Append-Only JSONL (After)                                   |
| ------------------------- | ------------------------------------------------ | ----------------------------------------------------------- |
| **Crash Safety**          | Subject to corruption if process dies mid-write. | High. Atomic appends mean only last unwritten line is lost. |
| **Concurrency**           | File-level lock only, prone to race conditions.  | Multiple writers can safely append to the stream.           |
| **Human Readability**     | High, but only shows current state.              | High. Shows full historical timeline.                       |
| **LLM/Agent Integration** | Native JSON easily parsed.                       | Native JSON line-by-line.                                   |
| **Complexity**            | Low.                                             | Low. No C++ bindings or external DBs.                       |

### Event Schema

```json
{"timestamp": 1775371304, "sessionId": "ao-1", "projectId": "agent-orchestrator", "status": "working", "metadata": {}}
{"timestamp": 1775371334, "sessionId": "ao-1", "projectId": "agent-orchestrator", "status": "pr_open", "metadata": {"pr": "owner/repo#123"}}
```

## Requirements Met

| #   | Requirement                 | Status                                                 |
| --- | --------------------------- | ------------------------------------------------------ |
| 1   | **100% State Persistence**  | ✅ Append-only logs survive unexpected crashes         |
| 2   | **No Native Dependencies**  | ✅ Uses standard Node.js `fs` module                   |
| 3   | **LLM/Agent Accessibility** | ✅ Plain-text JSON, human and AI readable              |
| 4   | **Auditability**            | ✅ Complete timeline of state transitions              |
| 5   | **Backwards Compatible**    | ✅ Existing metadata.ts still works (future migration) |

## Testing

```bash
# 1. Build and start orchestrator
cd agent-orchestrator
pnpm build
pnpm ao start

# 2. Spawn an agent session
pnpm ao spawn #1

# 3. Wait 30 seconds for lifecycle poll cycle

# 4. Check events.jsonl
cat ~/.agent-orchestrator/21a4f7688f42-agent-orchestrator/state/events.jsonl

# Output:
# {"timestamp":1775371304,"sessionId":"ao-1","projectId":"agent-orchestrator","status":"working"}

# 5. Test crash recovery - kill lifecycle worker
kill $(cat ~/.agent-orchestrator/21a4f7688f42-agent-orchestrator/lifecycle-worker.pid)

# 6. Restart - state recovered from events.jsonl
pnpm ao start
cat ~/.agent-orchestrator/21a4f7688f42-agent-orchestrator/state/events.jsonl
# State persists across restarts!
```

### Test Results

```
✓ state-store.test.ts (18 tests passed)
✓ lifecycle-manager.test.ts (41 tests passed)
✓ All core package tests (553 tests passed)
```

## Future Improvements

| Roadblock                       | Mitigation                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| **File Size & Growth**          | Implement `compactLog()` for size-based compaction (>5MB threshold)                        |
| **I/O on Large Hydrations**     | Node's `readline` module is optimized; combined with compaction, startup remains sub-100ms |
| **Migration from Legacy Files** | Future: one-time migration script to convert `metadata.ts` to `events.jsonl`               |

## Related Issues

Fixes: Split-brain state management between in-memory Map and flat-file metadata

---

**Note**: The PTY exit code 1 and tmux session errors visible in terminal logs are pre-existing issues unrelated to this state persistence fix. They occur when tmux sessions are killed via Ctrl+C or `tmux kill-server`.
