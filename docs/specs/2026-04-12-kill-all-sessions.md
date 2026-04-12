# Kill All Sessions

**Date:** 2026-04-12
**Status:** Draft

## Problem

When AO is force-killed and reopened, tmux sessions survive (tmux runs as a separate server process). Agents inside those sessions keep running. There is no way to stop all work at once — users must `ao session kill <id>` each session individually, or resort to `tmux kill-server` which nukes all tmux sessions system-wide (including non-AO ones) and leaves orphaned worktrees and metadata.

The `ao session cleanup` command is conservative: it only kills sessions whose PR is merged, issue is closed, or runtime is dead. Live, working sessions are intentionally skipped.

## Solution

Add a `killAll` operation across all layers: core API, CLI, web API, and dashboard UI.

## Design

### Core: `SessionManager.killAll()`

Reuse the existing `CleanupResult` type (which already has `killed`, `skipped`, and `errors` fields) rather than introducing a new type. For `killAll`, the `skipped` field will contain orchestrator session IDs when `includeOrchestrators` is false.

```typescript
interface SessionManager {
  // ... existing methods
  killAll(projectId?: string, options?: {
    purgeOpenCode?: boolean;
    includeOrchestrators?: boolean;
  }): Promise<CleanupResult>;
}
```

Add `killAll` to both the return object of `createSessionManager()` (line 2531) and the `SessionManager` interface in `types.ts`.

**Implementation:**

1. Call `list(projectId)` to get all sessions.
2. Partition into worker sessions and orchestrator sessions using the internal `isOrchestratorSessionRecord` closure (consistent with how `cleanup()` partitions sessions, not the exported `isOrchestratorSession` helper which lacks prefix-anchored regex).
3. If `includeOrchestrators` is false (default), add orchestrator sessions to `skipped`.
4. Kill worker sessions first (parallel via `Promise.allSettled`), calling existing `kill()` per session.
5. If `includeOrchestrators` is true, kill orchestrator sessions after workers are done (they supervise workers — killing them first could leave orphaned sub-sessions).
6. Collect results into `CleanupResult`.

Each `kill()` call already handles: runtime destroy (tmux kill-session), workspace destroy (worktree removal), metadata archival, and OpenCode session purge.

### CLI: `ao session kill --all`

Extend the existing `ao session kill` command:

```
ao session kill --all [--project <id>] [--include-orchestrators] [--yes]
```

| Flag | Purpose |
|------|---------|
| `--all` | Required for mass kill (prevents accidental invocation) |
| `--project <id>` | Optional: only kill sessions in this project |
| `--include-orchestrators` | Include orchestrator sessions (excluded by default) |
| `--purge-session` | Delete mapped OpenCode sessions during kill (matches existing single-session flag) |
| `--yes` | Skip confirmation prompt |

**Behavior:**

1. List sessions that will be killed.
2. Print summary: "About to kill N sessions (M workers, K orchestrators)".
3. Prompt for confirmation unless `--yes` is passed.
4. Execute `killAll()`.
5. Print results: killed count, any errors.

**Constraint:** `--all` and `<session>` argument are mutually exclusive. Commander handles this via the existing `argument("<session>")` being optional when `--all` is provided. Make `<session>` optional (`[session]`) and validate: exactly one of `<session>` or `--all` must be provided.

### Web API: `POST /api/sessions/kill-all`

```
POST /api/sessions/kill-all
Content-Type: application/json

{
  "projectId": "optional-project-id"
}
```

**Response:**

```json
{
  "killed": ["app-1", "app-2"],
  "errors": [{ "sessionId": "app-3", "error": "Workspace busy" }]
}
```

Uses the same `killAll()` from `SessionManager`. No orchestrator filtering on the API (the dashboard decides what to send).

The route must follow the existing observability pattern: use `getCorrelationId`, `jsonWithCorrelation`, and `recordApiObservation` from `@/lib/observability`, consistent with the existing `POST /api/sessions/:id/kill` route.

### Dashboard: "Stop All" Button

Add a "Stop All" button to the dashboard header area (near the existing spawn/session controls).

**Behavior:**

- Disabled when no active sessions exist.
- On click: shows confirmation dialog ("Stop all N sessions?").
- Calls `POST /api/sessions/kill-all`.
- Shows result toast: "Killed N sessions" or error details.
- SSE refresh picks up the updated session states automatically.

**Styling:** Destructive action button — uses existing destructive color tokens from the design system. No new UI component libraries (constraint C-01).

**Component isolation:** Extract into a standalone `StopAllButton.tsx` component rather than adding to `Dashboard.tsx` (which already exceeds the 400-line C-04 constraint). Dashboard imports and renders the component.

## Files to Create/Modify

| File | Change |
|------|--------|
| `packages/core/src/types.ts` | Add `killAll` to `SessionManager` interface (reuse existing `CleanupResult`) |
| `packages/core/src/session-manager.ts` | Implement `killAll()` function, add to return object (line 2531) |
| `packages/cli/src/commands/session.ts` | Extend `kill` command with `--all`, `--project`, `--include-orchestrators`, `--purge-session`, `--yes` flags |
| `packages/web/src/app/api/sessions/kill-all/route.ts` | New API route (with observability instrumentation) |
| `packages/web/src/components/StopAllButton.tsx` | New component: "Stop All" button + confirmation dialog (Dashboard.tsx is already over the 400-line C-04 limit) |
| `packages/core/src/__tests__/session-manager.test.ts` | Tests for `killAll()` |
| `packages/web/src/components/__tests__/StopAllButton.test.tsx` | Tests for Stop All button (follows project pattern of feature-scoped test files) |

## Edge Cases

- **No sessions:** `killAll()` returns `{ killed: [], errors: [] }`. CLI prints "No sessions to kill." and exits cleanly.
- **Partial failures:** Some sessions may fail to kill (e.g., workspace locked). Continue killing the rest, report errors in result.
- **Concurrent spawn:** A session spawned during killAll execution won't be caught. This is acceptable — the user can run it again.
- **Already-dead sessions:** `kill()` handles dead runtimes gracefully (best-effort destroy).

## Out of Scope

- Graceful shutdown (sending SIGTERM to agents before killing tmux) — future enhancement.
- Scheduled/automatic kill-all — not needed, this is a manual operation.
- Kill-all from the lifecycle worker — the lifecycle worker manages individual session states, not bulk operations.
