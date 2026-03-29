# Feature Plan: Restore Agent Override & Sub-Sessions

**Issue:** restore-agent-override-and-shared-workspace
**Branch:** `feat/restore-agent-override-and-shared-workspace`
**Status:** Pending

---

## Terminology

| Term | Definition | Example |
|------|-----------|---------|
| **AO Session** | A logical unit of work tracked by the orchestrator. Has an issue, branch, worktree, status, and lifecycle. Identified by a user-facing ID like `int-1`. | `ao spawn my-issue` → creates AO session `int-1` |
| **Sub-Session** | A single tmux session running inside an AO session. Every AO session has at least one sub-session (the primary agent). Additional sub-sessions are free-form terminals sharing the same worktree. | `int-1` has sub-sessions `int-1` (primary agent) and `int-1-t1`, `int-1-t2` (extra terminals) |
| **Primary Sub-Session** | The first sub-session, created automatically by `ao spawn`. Runs the agent (claude-code, codex, etc.). The AO session ID and the primary sub-session's tmux name are the same (backward-compatible). | tmux session `a3b4c5d6e7f8-int-1` |
| **Terminal Sub-Session** | An additional sub-session created by the user via the dashboard UI. Runs a plain shell in the same worktree. No agent — just a terminal. | tmux session `a3b4c5d6e7f8-int-1-t1` |

### Key Insight

Today, AO session = 1 tmux session. After this change, AO session = 1+ tmux sessions (sub-sessions) sharing the same worktree. The primary sub-session is the agent. All others are plain terminals. Killing the AO session kills all its sub-sessions.

---

## Feature 1: `ao session restore --agent <name>`

### Problem Summary

When restoring a crashed/killed session, users cannot switch the agent plugin. The restored session always uses the same agent it was originally spawned with (persisted in the `agent` metadata field). Users may want to switch agents — e.g., restore a `claude-code` session as `codex` — without re-creating everything.

### Proposed Approach

Add an `--agent <name>` option to `ao session restore`. When provided:
1. Validate the agent exists via `registry.get("agent", options.agent)`.
2. Merge into working metadata: `raw = { ...raw, agent: options.agent }` before `resolveSelectionForSession` — this reuses the full existing pipeline (e.g., OpenCode discovery only runs when the effective agent is `opencode`).
3. Persist the new agent name in the final `updateMetadata` call.
4. `getRestoreCommand` still runs (the new agent may support resuming if the conversation history is compatible). If it returns `null`, falls back to `getLaunchCommand` as normal.

### API Changes

#### CLI (`packages/cli/src/commands/session.ts`)

```
ao session restore <session> [--agent <name>]
```

#### HTTP API (`packages/web/src/app/api/sessions/[id]/restore/route.ts`)

```
POST /api/sessions/:id/restore
Body (optional): { "agent": "codex" }
```

#### Core — `SessionManager.restore()` (`packages/core/src/types.ts`)

```typescript
// Before
restore(sessionId: SessionId): Promise<Session>;

// After
restore(sessionId: SessionId, options?: RestoreOptions): Promise<Session>;

interface RestoreOptions {
  /** Override the agent plugin for this restore (persisted to metadata) */
  agent?: string;
}
```

#### Core — implementation detail

When `options.agent` is provided, merge into `raw` before `resolveSelectionForSession`:
```typescript
if (options?.agent) {
  // Validate agent exists
  if (!registry.get("agent", options.agent)) {
    throw new Error(`Agent plugin '${options.agent}' not found`);
  }
  raw = { ...raw, agent: options.agent };
}
const selection = resolveSelectionForSession(project, sessionId, raw);
```

Then in the final `updateMetadata`, ensure `agent` is persisted:
```typescript
updateMetadata(sessionsDir, sessionId, {
  status: "spawning",
  runtimeHandle: JSON.stringify(handle),
  restoredAt: now,
  agent: raw["agent"],  // persist (possibly overridden) agent
});
```

### Files to Modify

| File | Change |
|------|--------|
| `packages/core/src/types.ts` | Add `RestoreOptions` interface, update `SessionManager.restore` signature |
| `packages/core/src/session-manager.ts` | Accept `RestoreOptions` in `restore()`, merge agent into `raw`, persist to metadata |
| `packages/cli/src/commands/session.ts` | Add `--agent <name>` option to `restore` command, pass to `sm.restore()` |
| `packages/web/src/app/api/sessions/[id]/restore/route.ts` | Parse optional `{ agent }` from request body, pass to `sm.restore()` |
| `packages/core/src/__tests__/session-manager.test.ts` | Add tests for agent override on restore |

### Validation Strategy

- Unit test: restore with `{ agent: "other-agent" }` → metadata `agent` field updates, new agent plugin's `getLaunchCommand` is called.
- Unit test: restore without `--agent` → existing behavior unchanged, all existing tests pass.
- API test: `POST /api/sessions/:id/restore` with and without `{ agent }` body.

---

## Feature 2: Sub-Sessions (Multiple Terminals per AO Session)

### Problem Summary

Each AO session today is a single tmux session. Users want to open additional terminals within the same worktree — e.g., to run tests, check logs, or use a different tool alongside the agent. These extra terminals should:
- Share the same worktree as the primary agent session.
- Each have their own tmux session (for independent lifecycle).
- Be restorable when the user returns to the AO session.
- Appear in the dashboard UI as switchable terminal tabs.

### Proposed Approach

#### Tmux Session Naming

```
Primary (unchanged):    {hash}-{prefix}-{num}        e.g. a3b4c5d6e7f8-int-1
Terminal sub-sessions:  {hash}-{prefix}-{num}-t{n}    e.g. a3b4c5d6e7f8-int-1-t1
                                                           a3b4c5d6e7f8-int-1-t2
```

The primary sub-session name is identical to today's tmux session name — **fully backward-compatible**. Terminal sub-sessions append `-t{n}` where `n` is auto-incremented.

#### Metadata Storage

Sub-session metadata is stored alongside the AO session metadata using a prefix convention:

```
~/.agent-orchestrator/{hash}-{projectId}/sessions/
  int-1                    ← AO session metadata (primary sub-session, unchanged)
  int-1-t1                 ← Terminal sub-session 1 metadata
  int-1-t2                 ← Terminal sub-session 2 metadata
```

Each sub-session metadata file:

```
parent=int-1
type=terminal
tmuxName=a3b4c5d6e7f8-int-1-t1
worktree=/path/to/worktree    (same as parent)
status=working
createdAt=2026-03-28T10:00:00Z
```

The `parent` field links a sub-session to its AO session. The `type=terminal` field distinguishes sub-sessions from top-level AO sessions (which have no `parent` field).

#### How Sub-Sessions Are Excluded from `ao list`

`ao list` should only show AO sessions, not sub-sessions. The `list()` function will filter out entries where `metadata["parent"]` is set. Sub-sessions are an internal detail of their parent AO session.

### API Changes

#### Core — `SessionManager` (new methods)

```typescript
interface SessionManager {
  // ... existing methods ...

  /** Create a terminal sub-session within an AO session */
  createSubSession(sessionId: SessionId): Promise<SubSession>;

  /** List sub-sessions for an AO session (includes primary) */
  listSubSessions(sessionId: SessionId): Promise<SubSession[]>;

  /** Kill a specific sub-session (not the AO session) */
  killSubSession(sessionId: SessionId, subSessionId: string): Promise<void>;
}

interface SubSession {
  /** Sub-session ID, e.g. "int-1-t1" */
  id: string;
  /** Parent AO session ID */
  parentId: SessionId;
  /** "primary" for the agent sub-session, "terminal" for extras */
  type: "primary" | "terminal";
  /** Tmux session name */
  tmuxName: string;
  /** Workspace path (shared with parent) */
  workspacePath: string;
  /** Runtime handle */
  runtimeHandle: RuntimeHandle | null;
  /** Whether the tmux session is alive */
  alive: boolean;
}
```

#### CLI (future, not in initial scope)

```bash
ao session sub <session>              # Create a terminal sub-session in int-1
ao session sub --list <session>       # List sub-sessions
ao session sub --kill <session> <id>  # Kill a sub-session
```

#### Web Dashboard API (`/api/sessions/:id/sub-sessions`)

```
GET  /api/sessions/:id/sub-sessions          → SubSession[]
POST /api/sessions/:id/sub-sessions          → SubSession  (create)
DELETE /api/sessions/:id/sub-sessions/:subId → void        (kill)
```

### Cascade Kill

When `ao kill int-1` is called:
1. Scan metadata dir for files matching `int-1-t*` (or entries with `parent=int-1`).
2. For each sub-session: `runtime.destroy(handle)` → delete/archive metadata.
3. Then proceed with normal AO session kill (destroy primary tmux, clean workspace, archive metadata).

Same cascade applies in `cleanup()`.

### Implementation Detail: `createSubSession`

```typescript
// In session-manager.ts — new function
async function createSubSession(sessionId: SessionId): Promise<SubSession> {
  // 1. Find parent session
  const { raw, sessionsDir, project, projectId } = requireSessionRecord(sessionId);

  // 2. Reject if parent is a sub-session itself (no nesting)
  if (raw["parent"]) {
    throw new Error(`Cannot create sub-session of a sub-session (${sessionId})`);
  }

  // 3. Auto-increment: scan for existing int-1-t* files, find next number
  const existing = listSubSessionIds(sessionsDir, sessionId); // from metadata.ts
  let nextNum = 1;
  for (const id of existing) {
    const match = id.match(/-t(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num >= nextNum) nextNum = num + 1;
    }
  }
  const subSessionId = `${sessionId}-t${nextNum}`;

  // 4. Build tmux name: replace sessionId with subSessionId in parent's tmuxName
  //    Parent tmuxName: "a3b4c5d6e7f8-int-1" → sub: "a3b4c5d6e7f8-int-1-t1"
  const parentTmuxName = raw["tmuxName"] ?? sessionId;
  const subTmuxName = `${parentTmuxName}-t${nextNum}`;

  // 5. Create tmux session in parent's worktree (plain shell, no agent)
  const workspacePath = raw["worktree"] || project.path;
  const plugins = resolvePlugins(project);
  if (!plugins.runtime) throw new Error("Runtime plugin not found");

  const handle = await plugins.runtime.create({
    sessionId: subTmuxName,
    workspacePath,
    launchCommand: "", // empty = shell prompt
    environment: {
      AO_SESSION: sessionId,         // parent session ID
      AO_SUB_SESSION: subSessionId,  // this sub-session ID
      AO_DATA_DIR: sessionsDir,
    },
  });

  // 6. Write sub-session metadata
  writeMetadata(sessionsDir, subSessionId, {
    worktree: workspacePath,
    branch: raw["branch"] ?? "",
    status: "working",
    tmuxName: subTmuxName,
    project: projectId,
    createdAt: new Date().toISOString(),
    runtimeHandle: JSON.stringify(handle),
  });
  // Add parent link (not in SessionMetadata type — use updateMetadata for extra keys)
  updateMetadata(sessionsDir, subSessionId, {
    parent: sessionId,
    type: "terminal",
  });

  return {
    id: subSessionId,
    parentId: sessionId,
    type: "terminal",
    tmuxName: subTmuxName,
    workspacePath,
    runtimeHandle: handle,
    alive: true,
  };
}
```

### Implementation Detail: `listSubSessionIds` (metadata.ts)

```typescript
// In metadata.ts — new export
export function listSubSessionIds(dataDir: string, parentSessionId: SessionId): SessionId[] {
  if (!existsSync(dataDir)) return [];
  const prefix = `${parentSessionId}-t`;
  return readdirSync(dataDir).filter((name) => {
    if (!name.startsWith(prefix)) return false;
    if (!VALID_SESSION_ID.test(name)) return false;
    try {
      return statSync(join(dataDir, name)).isFile();
    } catch {
      return false;
    }
  });
}
```

### Implementation Detail: Cascade in `kill()`

Insert at the **top** of the existing `kill()` function in `session-manager.ts` (L1561), right after `requireSessionRecord`:

```typescript
async function kill(sessionId: SessionId, options?: { purgeOpenCode?: boolean }): Promise<void> {
  const { raw, sessionsDir, project, projectId } = requireSessionRecord(sessionId);

  // === NEW: Cascade kill sub-sessions ===
  if (!raw["parent"]) {
    // Only cascade for top-level AO sessions (not sub-sessions themselves)
    const subIds = listSubSessionIds(sessionsDir, sessionId);
    for (const subId of subIds) {
      const subRaw = readMetadataRaw(sessionsDir, subId);
      if (subRaw?.["runtimeHandle"]) {
        const subHandle = safeJsonParse<RuntimeHandle>(subRaw["runtimeHandle"]);
        if (subHandle) {
          const rt = registry.get<Runtime>("runtime",
            subHandle.runtimeName ?? project.runtime ?? config.defaults.runtime);
          if (rt) { try { await rt.destroy(subHandle); } catch { /* */ } }
        }
      }
      deleteMetadata(sessionsDir, subId, true);
    }
  }
  // === END cascade ===

  // ... existing kill logic unchanged ...
}
```

### Implementation Detail: Filter in `list()`

In `loadActiveSessionRecords()` (L516) or in the `list()` mapping (L1462), add a filter:

```typescript
// Option A: filter in loadActiveSessionRecords (affects all callers including cleanup)
// In the flatMap callback, skip entries with a "parent" field:
const records = listMetadata(sessionsDir).flatMap((sessionName) => {
  const raw = readMetadataRaw(sessionsDir, sessionName);
  if (!raw) return [];
  if (raw["parent"]) return []; // ← NEW: skip sub-sessions
  // ... rest unchanged
});
```

### Dashboard UI

- **Sidebar:** Each AO session appears once (unchanged). Sub-sessions are not shown in the sidebar.
- **Terminal area (inside a session):** A header row with:
  - A `+` button on the left of the header row to create a new terminal sub-session.
  - Small square buttons, one per sub-session (primary + terminals).
  - Each button shows a short label (e.g., `Agent`, `T1`, `T2`).
  - The active terminal's button is highlighted.
  - Clicking a button switches the terminal view to that sub-session's tmux output.

```
┌──────────────────────────────────────────────────┐
│  [+]  [Agent]  [T1]  [T2]                       │  ← sub-session tabs
├──────────────────────────────────────────────────┤
│                                                  │
│  (terminal output for selected sub-session)      │
│                                                  │
└──────────────────────────────────────────────────┘
```

### Lifecycle Behavior

| Event | Behavior |
|-------|----------|
| `ao spawn` | Creates AO session + primary sub-session (agent). Unchanged. |
| `+ button` in UI | Calls `createSubSession(sessionId)` → new tmux session in same worktree, shell only. |
| `ao kill int-1` | Kills the AO session AND all its sub-sessions (cascade kill). |
| `ao session restore int-1` | Restores the primary sub-session. Terminal sub-sessions are restored lazily (when user clicks their tab in the UI). |
| Sub-session tmux dies | Marked as exited. User can re-create via `+` button. Dead sub-session metadata is cleaned up with the parent. |
| `ao cleanup` | Cleans up AO sessions and their sub-sessions together (cascade). |

### Files to Modify

| File | Change |
|------|--------|
| `packages/core/src/types.ts` | Add `SubSession` interface, `createSubSession`/`listSubSessions`/`killSubSession` to `SessionManager` |
| `packages/core/src/session-manager.ts` | Implement `createSubSession` (creates tmux session + metadata), `listSubSessions` (reads `{sessionId}-t*` entries), `killSubSession`, update `kill()` to cascade, update `list()` to exclude sub-sessions |
| `packages/core/src/metadata.ts` | Add `listSubSessionIds(dataDir, parentSessionId)` helper |
| `packages/plugins/runtime-tmux/src/index.ts` | No changes needed (sub-sessions are just regular tmux sessions) |
| `packages/web/src/...` | Add API routes, update terminal component with tab UI |
| `packages/core/src/__tests__/session-manager.test.ts` | Tests for sub-session CRUD, cascade kill, list exclusion |

---

## Feature 3: Show Killed Sessions in Dashboard (from ao-94 plan)

### Problem Summary

Killed/terminated sessions have attention level `"done"`. The Kanban board only renders `KANBAN_LEVELS = ["working", "pending", "review", "respond", "merge"]` — no `"done"`. The sidebar also filters out `done` sessions. Users cannot see or restore killed sessions from the UI.

### Proposed Approach

1. **Dashboard Kanban** — Add `"done"` to `KANBAN_LEVELS` conditionally based on a "Show done" toggle. Store preference in `localStorage`.
2. **Sidebar** — Replace hard filter with conditional: show done sessions only when toggle is on. Default: hidden.

### Implementation Detail: Dashboard.tsx

Current code at L34:
```typescript
const KANBAN_LEVELS = ["working", "pending", "review", "respond", "merge"] as const;
```

Change to:
```typescript
const KANBAN_LEVELS_BASE = ["working", "pending", "review", "respond", "merge"] as const;
// "done" is appended conditionally based on toggle state
```

Add a `showDone` state (persisted in `localStorage`):
```typescript
const [showDone, setShowDone] = useState(() => {
  if (typeof window === "undefined") return false;
  return localStorage.getItem("ao-show-done") === "true";
});

const kanbanLevels = showDone
  ? [...KANBAN_LEVELS_BASE, "done" as const]
  : KANBAN_LEVELS_BASE;
```

Add a toggle button in the board header (near the top of the Kanban):
```tsx
<button onClick={() => {
  const next = !showDone;
  setShowDone(next);
  localStorage.setItem("ao-show-done", String(next));
}}>
  {showDone ? "Hide done" : "Show done"}
</button>
```

Then replace `KANBAN_LEVELS` references with `kanbanLevels` in the rendering loop (L226, L370).

### Implementation Detail: ProjectSidebar.tsx

Current filter at L175:
```typescript
const workerSessions = entry?.workers.filter((s) => getAttentionLevel(s) !== "done") ?? [];
```

And at L346:
```typescript
{workerSessions.filter((s) => getAttentionLevel(s) !== "done").map((session) => {
```

Change to conditionally include done sessions:
```typescript
const workerSessions = entry?.workers.filter((s) =>
  showDone || getAttentionLevel(s) !== "done"
) ?? [];
```

The `showDone` state can be shared via a simple React context or duplicated from `localStorage` (same key `"ao-show-done"`).

### Files to Modify

| File | Change |
|------|--------|
| `packages/web/src/components/Dashboard.tsx` | Add `showDone` state, toggle button, conditional `KANBAN_LEVELS` |
| `packages/web/src/components/ProjectSidebar.tsx` | Read `showDone` from localStorage, conditional filter |

---

## Feature 4: Spawn Session from Dashboard (from ao-94 plan)

### Problem Summary

Users must use the CLI (`ao spawn`) to create new agent sessions. The dashboard has no UI for spawning.

### Proposed Approach

Add a **"+" button** at the end of each project's session list in the sidebar. Opens a spawn modal with:
- **Issue ID** (text input, optional)
- **Agent** (dropdown, populated from `GET /api/agents`)
- **Spawn button** → calls `POST /api/spawn` with `{ projectId, issueId?, agent? }`

### API Changes

- `POST /api/spawn` — extend to accept `agent` field from body (already in `SessionSpawnConfig`, just not parsed from body yet).
- `GET /api/agents` — new endpoint returning available agents from `registry.list("agent")`.

### Implementation Detail: Extend spawn API

Current `POST /api/spawn` (route.ts L30-33) only passes `projectId` and `issueId`:
```typescript
const session = await sessionManager.spawn({
  projectId: body.projectId as string,
  issueId: (body.issueId as string) ?? undefined,
});
```

Change to also pass `agent`:
```typescript
const session = await sessionManager.spawn({
  projectId: body.projectId as string,
  issueId: (body.issueId as string) ?? undefined,
  agent: typeof body.agent === "string" ? body.agent : undefined,
});
```

### Implementation Detail: New agents endpoint

Create `packages/web/src/app/api/agents/route.ts`:
```typescript
import { getServices } from "@/lib/services";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import { type NextRequest } from "next/server";

/** GET /api/agents — List available agent plugins */
export async function GET(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  const { registry } = await getServices();
  const agents = registry.list("agent"); // returns PluginManifest[]
  return jsonWithCorrelation(
    { agents: agents.map((a) => ({ name: a.name, description: a.description })) },
    { status: 200 },
    correlationId,
  );
}
```

### Implementation Detail: SpawnSessionModal.tsx

```tsx
// Key props:
interface SpawnSessionModalProps {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onSpawned?: (sessionId: string) => void;
}

// State:
// - issueId: string
// - agent: string (default: first from agents list)
// - agents: { name: string; description: string }[] (fetched from GET /api/agents)
// - loading: boolean
// - error: string | null

// On mount: fetch GET /api/agents → populate dropdown
// On submit: POST /api/spawn { projectId, issueId, agent } → call onSpawned, close
// Modal: dismissible via Escape, click-outside, X button
// Must trap focus for accessibility
```

### Implementation Detail: Sidebar integration

In `ProjectSidebar.tsx`, add a "+" button after the last session row inside each expanded project. When clicked, opens `SpawnSessionModal` with `projectId` pre-filled:

```tsx
// After the session list map:
<button
  onClick={() => setSpawnModalProject(projectId)}
  title="Spawn new session"
>
  +
</button>

// At the component root level:
{spawnModalProject && (
  <SpawnSessionModal
    projectId={spawnModalProject}
    open={!!spawnModalProject}
    onClose={() => setSpawnModalProject(null)}
  />
)}
```

### Files to Modify

| File | Change |
|------|--------|
| `packages/web/src/components/SpawnSessionModal.tsx` | New modal component with issue/agent form |
| `packages/web/src/components/ProjectSidebar.tsx` | Add "+" button per project, modal trigger state |
| `packages/web/src/app/api/spawn/route.ts` | Parse `agent` from body, pass to `sessionManager.spawn()` |
| `packages/web/src/app/api/agents/route.ts` | New GET endpoint returning agent list from registry |

---

## Risks and Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | **Sub-session naming collision:** `int-1-t1` could collide with AO session `int-1-t1` if a project had prefix `int-1-t`. | Mitigated: the `parent` field is the canonical discriminator. |
| 2 | **Restore ordering:** Should terminal sub-sessions auto-restore, or only on-demand? | Proposed: lazy restore (on tab click). Avoids unnecessary tmux sessions. |
| 3 | **Max sub-sessions:** Should there be a limit? | Suggest: soft limit of 5 terminal sub-sessions per AO session. |
| 4 | **Agent sub-sessions:** Can a sub-session run a second agent? | Deferred: start with shell-only. Agent sub-sessions could be added later. |
| 5 | **Agent-specific metadata on override:** Switching from OpenCode leaves `opencodeSessionId` in metadata. | Harmless — ignored by non-OpenCode agents. Switching *to* OpenCode triggers discovery as normal. |
| 6 | **`restoreForDelivery` (internal auto-restore):** Should it support agent override? | No — automatic recovery should always use the persisted agent. Only explicit user action changes agent. |

---

## Implementation Checklist

### Phase 1 — Restore `--agent` override (small, self-contained)

- [ ] **1.1** Add `RestoreOptions` interface to `packages/core/src/types.ts`
- [ ] **1.2** Update `SessionManager.restore` signature in `packages/core/src/types.ts`
- [ ] **1.3** Update `restore()` in `packages/core/src/session-manager.ts`:
  - [ ] Accept `options?: RestoreOptions` parameter
  - [ ] Validate agent exists via `registry.get("agent", options.agent)`
  - [ ] Merge `options.agent` into `raw` before `resolveSelectionForSession`
  - [ ] Persist `agent` in final `updateMetadata` call
- [ ] **1.4** Add `--agent <name>` option to `restore` command in `packages/cli/src/commands/session.ts`
- [ ] **1.5** Update HTTP API in `packages/web/src/app/api/sessions/[id]/restore/route.ts` to parse optional `{ agent }` body
- [ ] **1.6** Add unit tests in `packages/core/src/__tests__/session-manager.test.ts`:
  - [ ] Restore with agent override → new agent persisted, new agent's plugin used
  - [ ] Restore without agent override → existing behavior unchanged
- [ ] **1.7** Run `pnpm build && pnpm typecheck && pnpm lint && pnpm test`

### Phase 2a — Sub-session core (backend)

- [ ] **2a.1** Add `SubSession` interface to `packages/core/src/types.ts`
- [ ] **2a.2** Add `createSubSession`, `listSubSessions`, `killSubSession` to `SessionManager` interface
- [ ] **2a.3** Add metadata helper in `packages/core/src/metadata.ts`:
  - [ ] `listSubSessionIds(dataDir, parentSessionId)` — returns IDs matching `{parentId}-t*`
- [ ] **2a.4** Implement `createSubSession` in `packages/core/src/session-manager.ts`:
  - [ ] Find parent session metadata (validate it exists and is active)
  - [ ] Auto-increment sub-session number (`-t1`, `-t2`, ...)
  - [ ] Create tmux session in parent's worktree (plain shell, no agent)
  - [ ] Write sub-session metadata file with `parent`, `type=terminal`
- [ ] **2a.5** Implement `listSubSessions`:
  - [ ] Return primary (type=primary) + all terminal sub-sessions
  - [ ] Enrich with `alive` status from runtime
- [ ] **2a.6** Implement `killSubSession`:
  - [ ] Destroy tmux session, delete/archive metadata
  - [ ] Reject attempts to kill the primary sub-session (use `ao kill` for that)
- [ ] **2a.7** Update `kill()` to cascade:
  - [ ] Before killing AO session, scan for sub-sessions → destroy each
- [ ] **2a.8** Update `cleanup()` to cascade
- [ ] **2a.9** Update `list()` to exclude entries with `parent` metadata field
- [ ] **2a.10** Update `restore()` to skip restoring terminal sub-sessions (lazy)
- [ ] **2a.11** Add unit tests:
  - [ ] Create sub-session → metadata written, tmux created
  - [ ] List sub-sessions → returns primary + terminals
  - [ ] Kill AO session → sub-sessions also killed
  - [ ] `ao list` → sub-sessions not shown
- [ ] **2a.12** Run `pnpm build && pnpm typecheck && pnpm lint && pnpm test`

### Phase 2b — Sub-session CLI (optional, can defer)

- [ ] **2b.1** Add `ao session sub <session>` command (create)
- [ ] **2b.2** Add `ao session sub --list <session>` (list)
- [ ] **2b.3** Add `ao session sub --kill <session> <id>` (kill individual)
- [ ] **2b.4** Run full test suite

### Phase 2c — Sub-session dashboard UI (frontend)

- [ ] **2c.1** Add API routes:
  - [ ] `GET /api/sessions/:id/sub-sessions`
  - [ ] `POST /api/sessions/:id/sub-sessions`
  - [ ] `DELETE /api/sessions/:id/sub-sessions/:subId`
- [ ] **2c.2** Add sub-session tab bar component to terminal view
- [ ] **2c.3** Add `+` button to create terminal sub-sessions
- [ ] **2c.4** Wire tab switching to change terminal target tmux session
- [ ] **2c.5** Restore integration — lazy restore on tab click

### Phase 3 — Show killed sessions in dashboard

- [ ] **3.1** Add "Show done" toggle to Dashboard Kanban
- [ ] **3.2** Conditionally include `"done"` in rendered levels
- [ ] **3.3** Update sidebar to conditionally show done sessions
- [ ] **3.4** Persist toggle state in `localStorage`

### Phase 4 — Spawn from dashboard

- [ ] **4.1** Create `GET /api/agents` endpoint
- [ ] **4.2** Extend `POST /api/spawn` to accept `agent` from body
- [ ] **4.3** Create `SpawnSessionModal.tsx` component
- [ ] **4.4** Add "+" button to sidebar project rows
- [ ] **4.5** Wire modal to API, handle success/error states

### Final

- [ ] Run `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
- [ ] Open PR against `main`, link issue in description
