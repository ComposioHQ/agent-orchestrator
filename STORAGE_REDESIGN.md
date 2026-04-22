# Storage Redesign

## Current state

```
~/.agent-orchestrator/
  66c66786e971-agent-orchestrator/     # hash-first, unreadable
    sessions/
      ao-84                            # workers and orchestrators mixed together
      ao-orchestrator-8
      sessions/archive/
        ao-83_2026-04-20T...
    worktrees/
      ao-84/
  a1b2c3d4e5f6-agent-orchestrator/     # duplicate from different hash method
    sessions/
      (empty or partial)
  config.yaml                           # global config (projects: {})
```

Problems: 4 hash methods, ~8000 dirs (~5850 empty), worktrees sometimes at ~/.worktrees/ instead, no cleanup, workers and orchestrators mixed in one flat directory, multiple orchestrator sessions per project, dual truth (legacy `status` + canonical `statePayload`), `statePayload` is stringified JSON inside key=value — parse-within-parse.

---

## Proposed layout

```
~/.agent-orchestrator/
  config.yaml
  projects/
    agent-orchestrator/
      orchestrator.json                 # single orchestrator metadata (one per project)
      sessions/
        ao-84.json                      # worker session metadata
        ao-85.json
        archive/
          ao-83_20260420T143052Z.json  # archived worker sessions
      worktrees/
        ao-84/                          # git worktree (code checkout)
        ao-85/
    my-saas-app/
      orchestrator.json
      sessions/
        archive/
      worktrees/
```

### What changed

1. **`projects/` subdirectory** — separates project storage from global files.
2. **No hash in directory name** — just `agent-orchestrator/`, not `66c66786e971-agent-orchestrator/`. Project names are unique in the config already. If two repos share a name, that's a config error, not a storage problem.
3. **Single orchestrator file** — `orchestrator.json` at the project root. One per project, always. No numbered IDs. Runs from the project directory itself (no worktree).
4. **`sessions/` is workers only** — no orchestrator sessions mixed in.
5. **Worktrees colocated** — no more `~/.worktrees/` split. Workers only — orchestrator doesn't get one.
6. **`archive/` inside `sessions/`** — `sessions/archive/` keeps archives colocated with active session metadata. Workers only.
7. **JSON format** — metadata files are `.json`. No more key=value with stringified JSON payloads inside.
8. **`status` derived from lifecycle** — status is still persisted for now (100+ call sites), but `readMetadata` derives it from lifecycle when absent. Full computed-only deferred to a follow-up PR.
9. **Relative worktree paths** — stored relative to project dir, not absolute.

### Global files

```
~/.agent-orchestrator/
  config.yaml          # project registry, default plugin selections, global settings
  projects/            # all project-specific storage
```

config.yaml is the only global file today. If we need more later (plugin cache, credential store), they go at this level alongside `projects/`.

### Metadata format: JSON

Metadata files switch from key=value to JSON.

Why:
- Eliminates the parse-within-parse problem (`statePayload` was stringified JSON inside key=value — two serialization formats in one file)
- Proper types: numbers as numbers, booleans as booleans, `null` as `null` — no more `"3000"` for ports
- Structured nesting: lifecycle state is a proper object, not a JSON blob stuffed into a string
- Atomic writes are unchanged (write temp file, rename)
- `cat` still works for quick inspection; `jq` for structured queries

What stays JSONL: `activity.jsonl` in worktrees (append-only activity log). That's a different use case — JSONL is right for append-only streams. Session metadata is atomic read/write, so single JSON object per file.

### Dual truth elimination

Currently every session file stores both:
- `status=working` (legacy single string)
- `statePayload={"version":2,"session":{...},...}` (canonical lifecycle v2)

These are kept in sync by `deriveLegacyStatus()`, but two sources of truth is fragile and has caused bugs.

**Post-migration rule (target):** `status` should be computed on read from `lifecycle`, not stored. The current implementation still persists `status` on every write (100+ call sites to update), but `readMetadata` derives it from lifecycle when absent — so migrated files that had `status` stripped will still work correctly:

```typescript
function readSessionMetadata(path: string): SessionMetadata {
  const json = JSON.parse(readFileSync(path, "utf-8"));
  return {
    ...json,
    status: json.status ?? deriveLegacyStatus(json.lifecycle),  // fallback to lifecycle
  };
}
```

Making status fully computed-only (removing persistence) is deferred to a follow-up PR.

### Config changes

The global `config.yaml` currently stores a `storageKey` per project entry — a 12-char hash used to construct paths like `~/.agent-orchestrator/{storageKey}/sessions/`. Post-migration:

- **`storageKey` field removed** from project entries. Storage path is `projects/{projectId}/` — derived directly from the project ID.
- **No structural changes** to `config.yaml` format. The `projects:` map still uses project names as keys. Local `agent-orchestrator.yaml` files unchanged.
- `getProjectBaseDir()` changes from `join(aoBase, storageKey)` to `join(aoBase, "projects", projectId)`.
- `getSessionsDir()` follows from `getProjectBaseDir()` as before.
- All storageKey derivation code (`deriveStorageKey`, `legacyProjectHash`, `generateLegacyWrappedStorageKey`, `deriveProjectStorageIdentity`) becomes dead code. Remove after migration.

---

## Orchestrator (e.g. `projects/agent-orchestrator/orchestrator.json`)

A single JSON metadata file. One per project, never archived.

The orchestrator runs from the project directory — no worktree, no branch. It manages workers via `ao spawn`/`ao send`/`ao session ls`. Resume is always `claude --resume` or equivalent.

```json
{
  "project": "agent-orchestrator",
  "agent": "claude-code",
  "createdAt": "2026-04-21T12:19:44.695Z",

  "runtimeHandle": {"id": "ao-orchestrator", "runtimeName": "tmux", "data": {}},
  "tmuxName": "ao-orchestrator",

  "lifecycle": {
    "version": 2,
    "session": {
      "kind": "orchestrator",
      "state": "working",
      "reason": "task_in_progress",
      "startedAt": "2026-04-21T12:19:44.695Z",
      "lastTransitionAt": "2026-04-21T12:19:44.695Z"
    },
    "runtime": {
      "state": "alive",
      "reason": "process_running",
      "lastObservedAt": "2026-04-21T12:30:00.000Z"
    }
  },

  "role": "orchestrator",
  "promptDelivered": true
}
```

No worktree, no branch, no PR, no issue, no archive. The orchestrator is a long-lived singleton — first `ao start` creates it, every subsequent `ao start` resumes it.

**Branch handling:** The orchestrator is branch-agnostic. It manages workers via CLI commands — it doesn't read or write code in the repo. Whatever branch the main checkout happens to be on is irrelevant to the orchestrator's function. Workers get their own worktrees on their own branches; the orchestrator just dispatches work and monitors status.

---

## Worker session file (e.g. `sessions/ao-84.json`)

```json
{
  "project": "agent-orchestrator",
  "agent": "claude-code",
  "createdAt": "2026-04-21T12:19:44.695Z",

  "worktree": "./worktrees/ao-84",
  "branch": "session/ao-84",

  "runtimeHandle": {"id": "ao-84", "runtimeName": "tmux", "data": {}},
  "tmuxName": "ao-84",

  "issue": "https://github.com/ComposioHQ/agent-orchestrator/issues/42",
  "userPrompt": "Fix the login bug on the settings page",

  "pr": "https://github.com/ComposioHQ/agent-orchestrator/pull/85",
  "prAutoDetect": true,

  "lifecycle": {
    "version": 2,
    "session": {
      "kind": "worker",
      "state": "working",
      "reason": "task_in_progress",
      "startedAt": "2026-04-21T12:19:44.695Z",
      "completedAt": null,
      "terminatedAt": null,
      "lastTransitionAt": "2026-04-21T12:19:44.695Z"
    },
    "pr": {
      "state": "open",
      "reason": "review_pending",
      "number": 85,
      "url": "https://github.com/ComposioHQ/agent-orchestrator/pull/85",
      "lastObservedAt": "2026-04-21T12:30:00.000Z"
    },
    "runtime": {
      "state": "alive",
      "reason": "process_running",
      "lastObservedAt": "2026-04-21T12:30:00.000Z"
    },
    "detecting": {
      "evidence": "review_pending",
      "attempts": 0,
      "startedAt": null,
      "evidenceHash": null
    }
  },

  "agentReport": {
    "state": "addressing_reviews",
    "at": "2026-04-21T12:35:05.200Z",
    "note": "Fixed 2 test regressions"
  },

  "reportWatcher": {
    "lastAuditedAt": "2026-04-21T16:50:09.934Z",
    "activeTrigger": "stale_report",
    "triggerActivatedAt": "2026-04-21T13:12:39.670Z",
    "triggerCount": 133
  },

  "dashboard": {
    "port": 3000,
    "terminalWsPort": 3001,
    "directTerminalWsPort": 3002
  }
}
```

Note: `worktree` is relative to the project dir (`./worktrees/ao-84`), not absolute. Resolved to full path on read. No `status` field — computed from `lifecycle.session.state` + `lifecycle.pr.state` via `deriveLegacyStatus()`.

## Archive file (e.g. `archive/ao-83_20260420T143052Z.json`)

Exact same content as the worker session file at the moment it was killed/archived. It's a snapshot — the JSON file is copied here verbatim, then the original is deleted.

The filename format is `{sessionId}_{compact-timestamp}.json` (e.g. `ao-83_20260420T143052Z`). Compact ISO without colons — colons break on some filesystems and in URLs. Multiple archives of the same session (restored then killed again) don't collide.

Archive files are used for:
- ID reservation (don't reuse `ao-83` if it was previously used)
- Kill idempotency (if already archived, return no-op)
- OpenCode session cleanup (post-archive purge)

Archive files are NOT used for:
- Dashboard display (only active sessions are shown)
- Lifecycle polling (only active sessions are polled)

No TTL or max count — archives don't grow fast enough to matter.

---

## Worker worktree directory (e.g. `worktrees/ao-84/`)

A full git worktree — an isolated checkout of the repo on its own branch.

```
worktrees/ao-84/
  (full repo checkout on branch session/ao-84)
  .ao/                                  # AO-specific files (gitignored)
    activity.jsonl                      # terminal-derived activity log (JSONL, append-only)
    AGENTS.md                           # session context for PATH wrappers
    bin/                                # gh/git wrapper scripts
  .claude/                              # agent-specific hooks (claude-code)
    settings.json
```

---

## Migration: `ao migrate-storage`

One-time CLI command. No lazy migration — lazy creates two code paths that both need testing and maintenance forever.

### Pre-flight checks

1. **Detect active sessions.** Scan for live tmux sessions matching AO patterns. If any are alive:
   - Default: abort with `"Kill active sessions first (ao kill --all) or use --force to migrate anyway."`
   - `--force`: migrate metadata anyway. Active runtimes will have stale paths — next lifecycle poll detects and self-corrects (runtime handle has tmux name, which is stable across path changes).

2. **Inventory hash directories.** Scan `~/.agent-orchestrator/` for `{12-hex-chars}-{name}` directories. All 4 hash methods produce the same naming pattern — the hash is always 12 hex chars, the project name follows after the first hyphen.

### Hash detection and project mapping

All 4 hash methods (`generateLegacyWrappedStorageKey`, `legacyProjectHash`, `deriveStorageKey` with origin, `deriveStorageKey` with path) produce directories named `{12-char-hex}-{projectId}`. To map old → new:

```
Pattern: /^([0-9a-f]{12})-(.+)$/
Group 1: hash (discarded)
Group 2: projectId → becomes projects/{projectId}/
```

Multiple hash directories with the same `projectId` = **merge**. This happens when the hash method changed between versions. Merge strategy:
- Sessions with conflicting IDs: keep the one with more recent `createdAt`, archive the older.
- Sessions with unique IDs: merge into one `sessions/` directory.
- Worktrees: merge into one `worktrees/` directory (no conflicts possible — worktree names = session IDs).

### Migration steps

For each unique `projectId`:

**Step 1: Create project structure**
```
projects/{projectId}/
  sessions/
  archive/
  worktrees/
```

**Step 2: Identify and extract orchestrator**

Find orchestrator sessions across all hash dirs for this project:
- Primary signal: `role=orchestrator` in metadata
- Fallback signal: session name matches `*-orchestrator-*` pattern

Selection: most recent non-terminal orchestrator (by `createdAt`) → write as `projects/{projectId}/orchestrator.json`. All others → archive.

**Step 3: Migrate worker sessions**

Copy remaining session files to `projects/{projectId}/sessions/{id}.json`.

**Step 4: Migrate archives**

Move old `{hash}-{projectId}/sessions/archive/*` → `projects/{projectId}/archive/`. Fix filenames: replace `:` and `.` in timestamps with compact format (`ao-83_2026-04-20T14:30:52.000Z` → `ao-83_20260420T143052Z`).

**Step 5: Migrate worktrees**

Move `{hash}-{projectId}/worktrees/*` → `projects/{projectId}/worktrees/`.

Also scan `~/.worktrees/` for strays:
- Match worktree branch names to session IDs (pattern: `session/{sessionId}`)
- Matched → move to correct `projects/{projectId}/worktrees/`
- Unmatched → log warning, leave in place

**Step 6: Convert metadata format**

For every migrated metadata file (orchestrator, sessions, archives):

```
key=value file → JSON:
1. Parse key=value pairs
2. Parse statePayload JSON → inline as "lifecycle" object
3. Drop "status" field (computed on read)
4. Drop "stateVersion" (version lives inside lifecycle object)
5. Convert worktree path from absolute → relative (./worktrees/{id})
6. Convert port strings to numbers
7. Convert prAutoDetect "on"/"off" → true/false
8. Group related fields:
   - detectingAttempts/detectingStartedAt/detectingEvidenceHash/lifecycleEvidence → lifecycle.detecting
   - agentReportedState/agentReportedAt/agentReportedNote → "agentReport": {}
   - reportWatcher* → "reportWatcher": {}
   - dashboardPort/terminalWsPort/directTerminalWsPort → "dashboard": {}
9. Write as formatted JSON (2-space indent)
```

**Step 7: Update config**

Remove `storageKey` field from each project entry in global `config.yaml`. No other config changes needed — project names and paths are unchanged.

**Step 8: Cleanup**

- Rename old hash directories to `{hash}-{projectId}.migrated` (don't delete — user verifies, then `rm -rf` manually).
- Delete empty hash directories immediately (no `.migrated` rename for empties).
- Print summary:
  ```
  Migrated 3 projects, 12 sessions, 45 archives, 8 worktrees.
  Moved 2 stray worktrees from ~/.worktrees/.
  Deleted 5,850 empty directories.
  Old directories renamed to *.migrated — verify and rm -rf when ready.
  ```

### Rollback

`ao migrate-storage --rollback`:
- Renames `*.migrated` dirs back to original names (e.g. `66c66786e971-agent-orchestrator.migrated` → `66c66786e971-agent-orchestrator`)
- Deletes `projects/` directory
- Re-adds `storageKey` to config entries — extracted from the `.migrated` dir name via regex `/^([0-9a-f]{12})-(.+)\.migrated$/` (group 1 = storageKey, group 2 = projectId). No backup file needed.
- Only works if `*.migrated` dirs still exist

### Implementation note: hash detection is regex-only

The migration command must NOT import `deriveStorageKey`, `legacyProjectHash`, `generateLegacyWrappedStorageKey`, or `deriveProjectStorageIdentity`. Those are the dead code this migration eliminates. Instead, migration uses a single regex (`/^([0-9a-f]{12})-(.+)$/`) to detect and parse old directory names. The migration is self-contained — it reads the filesystem, not the code that created it.

### Edge cases

| Scenario | Handling |
|----------|----------|
| Active sessions during migration | Warn + require `--force`. Runtime handles use tmux names (stable), not file paths. |
| Duplicate session IDs across hash dirs | Keep most recent by `createdAt`, archive older. |
| Worktree with no matching session file | Leave in place, log warning. May be from a crashed spawn. |
| Hash dir with no sessions at all | Skip entirely (5,850 empty dirs). |
| Session file with no `statePayload` | Synthesize lifecycle from legacy fields via `synthesizeCanonicalLifecycle()`, then convert. |
| `statePayload` exists but `status` disagrees | Trust `statePayload`. Drop `status`. Log discrepancy. |
| Project in config but no storage dir | No-op for that project. |
| Storage dir with no matching config entry | Create config entry with path auto-detected from worktree git remote, or skip with warning. |

---

## Decisions

1. **Archive TTL:** No. Archives don't grow fast enough to need cleanup.
2. **Metadata format:** JSON. Eliminates dual-serialization and the `statePayload`-as-string problem.
3. **Worktree paths:** Relative to project dir (e.g. `./worktrees/ao-84`).
4. **Dual truth:** Eliminated. `status` computed on read from `lifecycle` object, never stored.
5. **Detecting fields:** Inside `lifecycle.detecting`. They're lifecycle state, consumed by lifecycle decisions, meaningless outside that context. Top-level was a key=value artifact.
6. **`runtimeHandle` stays separate from `lifecycle.runtime`.** Handle is connection info (write-once at spawn). `lifecycle.runtime` is liveness state (updates every 30s poll). Different cadences, different concerns. Keeps lifecycle as pure state machine data with no implementation details leaking in.
7. **`.json` extension:** Yes. One-time path reference update (~20-30 strings). Payoff is permanent: self-documenting filenames, editor syntax highlighting, `jq` works directly.
