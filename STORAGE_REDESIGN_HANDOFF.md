# Storage Redesign Handoff

## Current State

**Branch:** `storage-redesign` (PR #1466 against `upstream/main` at ComposioHQ/agent-orchestrator)
**Simulation branch:** `simulate-pr-1466-merged` (storage-redesign + upstream/main merged locally, for testing)
**Fork remote:** `origin` → harshitsinghbhandari/agent-orchestrator
**Upstream remote:** `upstream` → ComposioHQ/agent-orchestrator

### What's Done

1. **Storage V2 layout** — `~/.agent-orchestrator/projects/{projectId}/` replacing `~/.agent-orchestrator/{12-hex-hash}-{name}/`
   - New path functions in `packages/core/src/paths.ts`: `getProjectDir`, `getProjectSessionsDir`, `getProjectArchiveDir`, `getProjectWorktreesDir`, `getOrchestratorPath`, `getSessionPath`
   - JSON metadata replacing key-value format in `packages/core/src/metadata.ts`
   - `SessionMetadata` in `types.ts` restructured with typed fields (lifecycle object, dashboard object, RuntimeHandle object instead of strings)

2. **Hashed project identity** — `generateExternalId(path, originUrl?)` in `global-config.ts`
   - Format: `{sanitized_basename}_{SHA256(path+originUrl)[0:10]}` (e.g. `agent-orchestrator_a1b2c3d4e5`)
   - Deterministic — same path+origin always produces same ID
   - Collision throws (doesn't degrade)
   - Spec: `PROJECT_IDENTITY_SPEC.md`, Plan: `PROJECT_IDENTITY_PLAN.md`

3. **Migration command** — `ao migrate-storage` in `packages/core/src/migration/storage-v2.ts` (~1360 lines)
   - Inventory hash dirs, convert KV→JSON, migrate sessions/archives/worktrees
   - `--dry-run`, `--rollback`, `--force` flags
   - Crash-safety markers, stray worktree detection
   - 54 tests in `migration-storage-v2.test.ts`

4. **Worktree routing fix** — worktrees now route to V2 layout via `WorkspaceCreateConfig.worktreeDir`
   - `packages/core/src/types.ts` — added `worktreeDir?: string` to `WorkspaceCreateConfig`
   - `packages/plugins/workspace-worktree/src/index.ts` — uses per-call `cfg.worktreeDir` override
   - `packages/core/src/session-manager.ts` — passes `worktreeDir: getProjectWorktreesDir(projectId)` at 3 call sites

5. **storageKey system removed** from `global-config.ts`
   - Removed: `ensureProjectStorageIdentity`, `relinkProjectInGlobalConfig`, `deriveProjectStorageIdentity`, `findStorageKeyOwner`, `StorageKeyCollisionError`
   - `storageKey` kept as optional field in `GlobalProjectEntrySchema` (preserved until `ao migrate-storage` strips it)
   - `registerProjectInGlobalConfig` now returns `string` (effective project ID from hashed ID generation)

6. **Merge conflicts resolved** — upstream/main merged into storage-redesign (4 files resolved)
   - Additional fixes: `getProjectBaseDir(project.storageKey)` → `getProjectDir(projectId)` in session-manager.ts, missing `createHash` import in config.ts, missing `getGlobalConfigPath` import in start.ts

7. **Migration review fixes** (from `~/.ao/agent-orchestrator/reviews/pr-1466-migrate-storage-review.md`)
   - `atomicWriteFileSync` for all session JSON writes (crash safety)
   - `withFileLockSync` on `stripStorageKeysFromConfig` (concurrency safety)
   - Case-insensitive projectId collision detection (macOS HFS+/APFS)
   - `repairGitWorktrees()` in rollback path
   - Skip stray worktree moves for failed projects

8. **Orchestrator tmux double-prefix fix** — `session-manager.ts:887` changed from `${project.sessionPrefix}-${sessionId}` to `sessionId` (sessionId already includes prefix)

### What's NOT Done

1. **Archiving** — Removed. Killed sessions now stay in `sessions/` with `lifecycle.state: "terminated"`. Archive functions (`getProjectArchiveDir`, `getArchiveFilePath`, `compactTimestamp`, `readArchivedMetadataRaw`, `updateArchivedMetadata`, `listArchivedSessionIds`, `markArchivedOpenCodeCleanup`), archive directories, and migration archive logic all removed. Migration flattens V1 archives into `sessions/` as terminated records.

2. **Identity implementation by Codex session** — A task was sent to a Codex session (tmux session `32`) to implement the hashed identity spec. Status unknown — check if it completed and whether changes need to be integrated.

3. **Dead code removal** (Phase 7 of plan) — Old path functions (`getProjectBaseDir`, `getSessionsDir`, etc.) still exist in `paths.ts` marked deprecated. `storage-key.ts` still exists. To be cleaned up after migration ships.

4. **Review items not yet addressed:**
   - `detectActiveSessions` only checks tmux, not process runtime (moderate)
   - `--force` flag doesn't warn about specific active sessions (moderate)
   - Re-run creates duplicate archive entries (moderate — may be moot if archiving is removed)
   - `crossDeviceMove` orphan on crash (moderate)

### Key Files

| File | What changed |
|------|-------------|
| `packages/core/src/paths.ts` | New V2 path functions |
| `packages/core/src/metadata.ts` | JSON serialization |
| `packages/core/src/types.ts` | `SessionMetadata` restructured, `WorkspaceCreateConfig.worktreeDir` |
| `packages/core/src/global-config.ts` | `generateExternalId`, storageKey removal, `registerProjectInGlobalConfig` returns string |
| `packages/core/src/session-manager.ts` | V2 paths, worktreeDir, tmux name fix |
| `packages/core/src/migration/storage-v2.ts` | Full migration logic |
| `packages/plugins/workspace-worktree/src/index.ts` | Per-call worktreeDir override |
| `PROJECT_IDENTITY_SPEC.md` | Hashed identity spec (reviewed by Prateek) |
| `PROJECT_IDENTITY_PLAN.md` | Implementation plan |
| `STORAGE_REDESIGN.md` | Original storage redesign spec |

### CI Status

All checks pass: typecheck (27/27 packages), tests (976 core + all others), lint clean.

### Commits (recent, on storage-redesign)

```
3aaef7d8 fix(core): address migration review findings and orchestrator tmux double-prefix
49817974 fix(cli): prefix unused addCwdOption variable to satisfy lint
8311a3e4 fix(core,cli): resolve merge conflicts with upstream/main
```
