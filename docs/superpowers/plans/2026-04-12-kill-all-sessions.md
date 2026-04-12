# Implementation Plan: Kill All Sessions

**Spec:** `docs/specs/2026-04-12-kill-all-sessions.md`
**Branch:** `feat/kill-all-sessions`

## Steps

### Step 1: Core types — Add `killAll` to `SessionManager` interface

**File:** `packages/core/src/types.ts`

Add `killAll` method to the `SessionManager` interface (around line 1396, after the existing `cleanup` method):

```typescript
killAll(
  projectId?: string,
  options?: { purgeOpenCode?: boolean; includeOrchestrators?: boolean },
): Promise<CleanupResult>;
```

No new types needed — reuses existing `CleanupResult` (line 1431).

**Verification:** `pnpm --filter @aoagents/ao-core typecheck` — will fail until Step 2 implements it.

---

### Step 2: Core implementation — Implement `killAll()` in session-manager

**File:** `packages/core/src/session-manager.ts`

Add a `killAll` function near the existing `cleanup` function (after line ~1870). Implementation:

```typescript
async function killAll(
  projectId?: string,
  options?: { purgeOpenCode?: boolean; includeOrchestrators?: boolean },
): Promise<CleanupResult> {
  const result: CleanupResult = { killed: [], skipped: [], errors: [] };
  const sessions = await list(projectId);

  if (sessions.length === 0) return result;

  const includeOrchestrators = options?.includeOrchestrators === true;
  const purgeOpenCode = options?.purgeOpenCode === true;

  // Partition into workers and orchestrators
  const workers: Session[] = [];
  const orchestrators: Session[] = [];

  for (const session of sessions) {
    const project = config.projects[session.projectId];
    if (!project) {
      result.skipped.push(session.id);
      continue;
    }
    if (isCleanupProtectedSession(project, session.id, session.metadata)) {
      if (includeOrchestrators) {
        orchestrators.push(session);
      } else {
        result.skipped.push(session.id);
      }
    } else {
      workers.push(session);
    }
  }

  // Kill workers first (parallel)
  const killSession = async (session: Session): Promise<void> => {
    try {
      await kill(session.id, { purgeOpenCode });
      result.killed.push(session.id);
    } catch (err) {
      result.errors.push({
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  await Promise.allSettled(workers.map(killSession));

  // Kill orchestrators after workers
  if (includeOrchestrators) {
    await Promise.allSettled(orchestrators.map(killSession));
  }

  return result;
}
```

Add `killAll` to the return object on line 2531:

```typescript
return { spawn, spawnOrchestrator, restore, list, get, kill, killAll, cleanup, send, claimPR, remap };
```

**Verification:** `pnpm --filter @aoagents/ao-core typecheck` should pass.

---

### Step 3: Core tests — Test `killAll()`

**File:** `packages/core/src/__tests__/session-manager.test.ts` (or create if not exists — check first)

Test cases:

1. **Kills all worker sessions** — mock `list()` returning 3 workers, verify `kill()` called 3 times, result has 3 killed.
2. **Skips orchestrator sessions by default** — mock `list()` returning 2 workers + 1 orchestrator, verify orchestrator in `skipped`, not killed.
3. **Includes orchestrators when flag set** — same setup but `includeOrchestrators: true`, verify all 3 killed, orchestrator killed after workers.
4. **Handles partial failures** — mock one `kill()` to throw, verify it appears in `errors` and other sessions still killed.
5. **Returns empty result when no sessions** — mock `list()` returning `[]`, verify `{ killed: [], skipped: [], errors: [] }`.
6. **Passes purgeOpenCode to kill** — verify the option is forwarded.

**Verification:** `pnpm --filter @aoagents/ao-core test`

---

### Step 4: CLI — Extend `ao session kill` with `--all` flag

**File:** `packages/cli/src/commands/session.ts`

Modify the `kill` command (line 192-207):

1. Change argument from `<session>` (required) to `[session]` (optional).
2. Add options: `--all`, `--project <id>`, `--include-orchestrators`, `--purge-session`, `--yes`.
3. In the action handler, validate mutual exclusivity: exactly one of `session` argument or `--all` must be provided.
4. For `--all` path:
   - Call `sm.list(opts.project)` to get count for confirmation prompt.
   - Print "About to kill N sessions." (filtered by orchestrator logic).
   - Prompt confirmation via `readline` unless `--yes`.
   - Call `sm.killAll(opts.project, { purgeOpenCode, includeOrchestrators })`.
   - Print results.
5. For single session path: existing behavior unchanged.

Needs `import readline from "node:readline"` (or use existing prompt pattern if one exists in CLI).

**Verification:** Build CLI, run `ao session kill --all --yes` manually against a test config.

---

### Step 5: Web API route — `POST /api/sessions/kill-all`

**File:** `packages/web/src/app/api/sessions/kill-all/route.ts` (new file)

Follow the exact pattern of the existing kill route (`packages/web/src/app/api/sessions/[id]/kill/route.ts`):

```typescript
import { type NextRequest } from "next/server";
import { getServices } from "@/lib/services";
import {
  getCorrelationId,
  jsonWithCorrelation,
  recordApiObservation,
} from "@/lib/observability";

export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  const startedAt = Date.now();

  try {
    const body = await request.json().catch(() => ({}));
    const projectId = typeof body.projectId === "string" ? body.projectId : undefined;

    const { config, sessionManager } = await getServices();
    const result = await sessionManager.killAll(projectId);

    recordApiObservation({
      config,
      method: "POST",
      path: "/api/sessions/kill-all",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 200,
      projectId,
    });

    return jsonWithCorrelation(result, { status: 200 }, correlationId);
  } catch (err) {
    // ... error handling with observability, same pattern as existing kill route
  }
}
```

**Verification:** `pnpm --filter @aoagents/ao-web typecheck`

---

### Step 6: Dashboard component — `StopAllButton.tsx`

**File:** `packages/web/src/components/StopAllButton.tsx` (new file)

A self-contained component that:

1. Receives `sessionCount` (number of active sessions) as prop.
2. Renders a destructive-style button labeled "Stop All".
3. Disabled when `sessionCount === 0`.
4. On click: shows inline confirmation ("Stop all N sessions? [Confirm] [Cancel]").
5. On confirm: calls `POST /api/sessions/kill-all`, shows result.
6. Uses CSS custom properties from `globals.css` for destructive styling (e.g., `var(--color-danger)`).

Check `DESIGN.md` and `globals.css` for exact token names before implementing.

**Integration in Dashboard.tsx:** Import `StopAllButton` and render it in the header area, passing the session count. This is a ~3 line change to Dashboard.tsx.

**Verification:** `pnpm --filter @aoagents/ao-web typecheck` + visual check in browser.

---

### Step 7: Dashboard tests — `StopAllButton.test.tsx`

**File:** `packages/web/src/components/__tests__/StopAllButton.test.tsx` (new file)

Test cases:

1. Renders disabled when sessionCount is 0.
2. Renders enabled when sessionCount > 0.
3. Shows confirmation on click.
4. Calls API on confirm.
5. Hides confirmation on cancel.
6. Shows error state on API failure.

**Verification:** `pnpm --filter @aoagents/ao-web test`

---

### Step 8: Build and integration verification

1. `pnpm build` — full monorepo build.
2. `pnpm typecheck` — all packages.
3. `pnpm test` — all tests pass.
4. `pnpm lint` — no lint errors.
5. Manual test: `pnpm dev`, open dashboard, verify Stop All button appears and works.

## Dependency Order

```
Step 1 (types) → Step 2 (implementation) → Step 3 (core tests)
                                          → Step 4 (CLI) [parallel with 3]
                                          → Step 5 (web API) → Step 6 (component) → Step 7 (component tests)
Step 8 (verification) — after all above
```

Steps 3, 4, and 5 can be worked on in parallel after Step 2 is complete.
