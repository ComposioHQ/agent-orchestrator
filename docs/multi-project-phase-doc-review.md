# Multi-Project Phase Docs Review

Review target:

- `~/Desktop/ao-multiproject-phases/README.md`
- `~/Desktop/ao-multiproject-phases/phase-0-foundations.md`
- `~/Desktop/ao-multiproject-phases/phase-1a-storage-identity.md`
- `~/Desktop/ao-multiproject-phases/phase-1b-per-project-resolution.md`
- `~/Desktop/ao-multiproject-phases/phase-1c-web-api-hot-reload.md`
- `~/Desktop/ao-multiproject-phases/phase-2-portfolio-routing.md`
- `~/Desktop/ao-multiproject-phases/phase-3-cleanup-and-extensions.md`

Cross-check sources:

- Design gist: [https://gist.github.com/ashish921998/9553440f3c146b407607ec6de12b7268](https://gist.github.com/ashish921998/9553440f3c146b407607ec6de12b7268)
- Branch: `ashish/feat/multi-project`

This doc is patch-ready: each section lists the problem, why it is wrong, and the concrete doc change to make.

## Highest-priority corrections

### 1. Stop claiming `resolveError` is already the branch-wide degraded-project model

Problem:

- `README.md`, Phases 1b, 2, and 3 treat `resolveError` as the core invariant.
- The branch does not currently expose degraded projects that way in `config.projects`.
- The actual shipped degraded model is portfolio-level `degraded` / `degradedReason`.

Evidence:

- `packages/core/src/config.ts` still fully validates `config.projects` and throws on invalid global config.
- `packages/core/src/types.ts` defines `PortfolioProject.degraded` and `PortfolioProject.degradedReason`.
- `packages/web/src/lib/portfolio-page-data.ts` consumes `degraded` / `degradedReason`, not `resolveError`.

Recommended edits:

- In `README.md`, replace:
  - "`resolveError` is a first-class field. A broken project must surface as a degraded entry, never a daemon crash."
- With:
  - "Per-project degradation is only partially implemented on this branch. The shipped UI surface uses portfolio-level `degraded` / `degradedReason`; the core `resolveError` model described in later phases is still planned work."
- In `phase-1b-per-project-resolution.md`, keep `resolveError` as the target design, but add:
  - "This is not yet the branch's runtime model. Today, degraded state exists only in the portfolio projection layer."
- In `phase-2-portfolio-routing.md`, replace references to "already shipped degraded-project (`resolveError`) UX" with wording that distinguishes:
  - shipped: portfolio degraded cards/badges
  - not shipped: core `config.projects`-level degraded resolution
- In `phase-3-cleanup-and-extensions.md`, replace:
  - "Broken projects surface as `resolveError` entries; they never crash the daemon."
- With:
  - "The target end-state is per-project degraded resolution. On the current branch, degraded state is only partially surfaced via the portfolio layer."

### 2. Reconcile the identity invariant across Phase 0 and Phase 1a

Problem:

- Phase 0 says identity is append-only and never rewritten.
- Phase 1a says rename updates `entry.path` while preserving `storageKey`.
- These cannot both be true.

Evidence:

- `packages/core/src/global-config.ts` now preserves `storageKey` while updating `path` on re-registration.

Recommended edits:

- In `phase-0-foundations.md`, replace:
  - "`registerProjectInGlobalConfig` may add a new identity entry; it never rewrites an existing one's identity."
- With:
  - "`storageKey` is immutable once assigned. Other identity fields may be updated by later phases where needed, especially `path` during rename/relink flows."
- In `README.md`, add a note under key architectural choices:
  - "`projectId` and `storageKey` are stable identity anchors. `path` is expected to move in rename/relink workflows."

### 3. Fix the phase-status table for landed CLI capabilities

Problem:

- The docs say `ao spawn --project` and remove-project are not landed.
- Both capabilities already exist on the branch, though the exact UX may differ from the original plan.

Evidence:

- `packages/cli/src/commands/spawn.ts` supports `--project <id>`.
- `packages/cli/src/commands/project.ts` supports `ao project rm <id>`.

Recommended edits:

- In `README.md`, Phase 1b status row, replace:
  - "`ao spawn --project`, `ao remove-project`, fingerprint not yet"
- With:
  - "`ao spawn --project` and soft-remove via `ao project rm` are landed; repo fingerprinting and the full per-project degraded-resolution model are not yet."
- In `phase-1b-per-project-resolution.md`, replace:
  - "CLI auto-register on `ao start` and most registry fields are in the branch. `ao spawn --project`, `ao remove-project`, and repo fingerprinting are not yet landed."
- With:
  - "CLI auto-register on `ao start` and most registry plumbing are in the branch. `ao spawn --project` is landed, and soft-remove exists today as `ao project rm`. Repo fingerprinting and the full resolver model are not yet landed."

## Missing dependencies to call out explicitly

### 4. Phase 2 depends on a Phase 1b core refactor that is not done yet

Problem:

- Phase 2 assumes every `config.projects` consumer can skip degraded entries.
- That requires the Phase 1b per-project degraded-resolution model to exist first.
- The current branch still has global config validation, not isolated project resolution in `loadConfig()`.

Recommended edits:

- In `phase-2-portfolio-routing.md`, add to Context or Goals:
  - "Important dependency: the full consumer audit in this phase only makes sense after Phase 1b lands a core degraded-project resolution model. Until then, degraded handling is limited to the portfolio projection layer."
- In `README.md`, expand "Known gaps":
  - "Core degraded resolution is not yet the branch runtime model; Phase 2's consumer audit is blocked on that Phase 1b refactor."

### 5. Phase 2's Add Project flow depends on unlanded Phase 1c reload plumbing

Problem:

- Phase 2 describes add/register/reload UX as if it is close to complete.
- The branch still lacks `POST /api/projects/reload`, `reloadServices()`, and `GET /api/filesystem/browse`.

Evidence:

- No `reloadServices` in `packages/web/src/lib/services.ts`
- No `/api/projects/reload`
- No `/api/filesystem/browse`

Recommended edits:

- In `phase-2-portfolio-routing.md`, change:
  - "Add Project modal ... lands the user on `/projects/[newId]`"
- To:
  - "Add Project modal UI exists, but the full no-restart/no-refresh workflow still depends on Phase 1c reload and filesystem-browse endpoints."
- In `phase-1c-web-api-hot-reload.md`, add:
  - "This phase is a hard prerequisite for the intended seamless Add Project UX in Phase 2."

### 6. The docs should call out the still-missing uniqueness rewrite

Problem:

- The gist correctly identifies that `validateProjectUniqueness()` still keys identity off `basename(project.path)`.
- The phase docs mention this only indirectly, but it is still a real dependency for collision-safe multi-project support.

Evidence:

- `packages/core/src/config.ts` still derives project identity from `basename(project.path)`.

Recommended edits:

- In `phase-1b-per-project-resolution.md`, add a dedicated dependency note:
  - "Before collision-safe registry-first project identity is complete, `validateProjectUniqueness()` must stop deriving IDs from `basename(project.path)` and instead respect canonical project IDs."
- In `README.md` Known gaps, add:
  - "Uniqueness validation still keys off `basename(project.path)` in core validation. This remains a prerequisite for full registry-authoritative identity."

## Branch-status mismatches

### 7. Phase 0 overstates the shipped global-config schema

Problem:

- The doc presents a versioned global config schema with multiple identity fields as already shipped.
- The actual schema is much smaller and uses passthrough for future fields.

Evidence:

- `packages/core/src/global-config.ts` has no top-level `version`.
- `GlobalProjectEntrySchema` formally defines only `name`, `path`, `storageKey`, `_shadowSyncedAt`.

Recommended edits:

- In `phase-0-foundations.md`, replace the sample schema intro:
  - "Schema (simplified):"
- With:
  - "Target schema direction (not all fields are formally modeled yet):"
- Add a clarification:
  - "On the current branch, the formal Zod schema is intentionally narrow and uses passthrough for future/project-specific fields. The richer identity fields listed below are roadmap-facing, not all fully typed today."

### 8. Phase 1a overstates rename-safe behavior as shipped

Problem:

- The doc says rename-path preservation is already shipped and verified.
- That behavior was not actually reliable in the branch state the docs describe; it required a later fix.

Recommended edits:

- In `phase-1a-storage-identity.md`, soften the status section:
  - replace "SHIPPED" with "SHIPPED, with follow-up fixes required for path-preserving re-registration behavior"
- In Verification, replace:
  - "Rename the project directory → session directory still reachable"
- With:
  - "Rename-path preservation is the intended invariant; verify against the current branch head rather than assuming the original storageKey commit alone was sufficient."

### 9. Phase 1c should stop claiming a filesystem-browse route and hot-reload layer are "basic follow-ups"

Problem:

- The phase status is directionally right, but it underplays how much Phase 2 UX depends on those missing pieces.

Recommended edits:

- In `phase-1c-web-api-hot-reload.md`, replace the first status sentence with:
  - "Project CRUD is partially present, but the two pieces that make the multi-project UX feel live — service reload and filesystem browse — are still missing."

### 10. Phase 1c should describe the actual current security helper accurately

Problem:

- The docs say "`path-security.ts` already exists on branch" in a way that implies the browse endpoint groundwork is basically done.
- The branch does have `packages/web/src/lib/path-security.ts`, but the actual project registration route currently uses `filesystem-access.ts`, and there is still no browse route.

Recommended edits:

- In `phase-1c-web-api-hot-reload.md`, replace:
  - "`path-security.ts` — already exists on branch. Reuse for filesystem-browse."
- With:
  - "`path-security.ts` exists and can provide the base containment checks, but the browse endpoint itself still needs explicit symlink, sensitive-path, and listing-policy logic."

## Gist coverage gaps

### 11. Registry-only projects are not really phased

Problem:

- The gist treats registry-only projects as a legitimate second-class mode.
- The phase docs mention `localConfigPath: string | null`, but no phase really owns implementing or testing registry-only projects end to end.

Recommended edits:

- In `phase-1b-per-project-resolution.md`, add a goal:
  - "Registry-only projects (`localConfigPath: null`) must be resolvable with defaults-only behavior, and must have explicit tests."
- In `phase-3-cleanup-and-extensions.md`, if Phase 1b does not fully take it on, add a backlog item:
  - "Finish registry-only project mode: creation flow, validation rules, UI affordances, and docs."

### 12. Per-project defaults from the gist are not assigned to a phase

Problem:

- The gist includes lightweight per-project defaults for registry-only projects.
- The phase set never clearly assigns that work.

Recommended edits:

- In `phase-1b-per-project-resolution.md`, extend the richer registry schema section to include:
  - "`defaults?: { agent?: string; permissions?: string; model?: string }` for registry-only projects"

### 13. The gist's no-YAML / synthesized-default-config mode is not reflected in the current phase set

Problem:

- The gist's `configPath: null` / `registryPath` split is a real architectural choice.
- The current branch chose a different direction: global config plus optional flat locals.
- The docs should say that explicitly, or they read like an incomplete implementation rather than an intentional divergence.

Recommended edits:

- In `README.md`, add a short "intentional divergences from the gist" section:
  - "The branch uses `~/.agent-orchestrator/config.yaml` as the canonical registry/shadow store instead of the gist's standalone `registry.json` plus synthesized base config model."

## Suggested exact replacements

### README.md

Replace the Key architectural choices list with:

```md
1. **`projectId` and `storageKey` are the stable identity anchors.** `path` may change during rename/relink workflows; `storageKey` must not.
2. **`storageKey` is 12 hex chars, write-once.** The 12-hex constraint is what lets tmux naming use it directly without breaking `parseTmuxName`'s regex.
3. **Global config is the registry on this branch.** `~/.agent-orchestrator/config.yaml` holds identity + shadow behavior. This intentionally differs from the gist's standalone `registry.json` model.
4. **File lock on every registry mutation.** Read-modify-write is always inside `withFileLockSync`.
5. **Soft-delete is the only kind of remove.** Storage directories and local YAMLs are preserved across registry removals.
6. **Per-project degraded resolution is a target invariant, not a fully landed branch-wide runtime model yet.** Today the shipped degraded surface is portfolio-level `degraded` / `degradedReason`.
7. **Identity fields are frozen where possible, but not all layers are fully aligned yet.**
```

### phase-0-foundations.md

Replace Invariant 2 with:

```md
2. **`storageKey` is append-only.** Once assigned, it is never rewritten. Other identity fields may evolve in later phases where needed, especially `path` during rename/relink flows.
```

### phase-1b-per-project-resolution.md

Replace the status line with:

```md
**Status on `ashish/feat/multi-project`:** PARTIAL. Flat-local + global-registry merge exists in limited form, and `ao spawn --project` is already landed. Soft-remove exists today as `ao project rm`. Repo fingerprinting, registry-only defaults, and the full per-project degraded-resolution model described below are not yet landed.
```

Add after the Failure isolation section:

```md
**Important reality check:** this is the target resolver model, not the branch's current core runtime behavior. Today, degraded state is surfaced primarily through the portfolio projection layer (`degraded` / `degradedReason`), while `loadConfig()` still validates the loaded config as a whole.
```

### phase-2-portfolio-routing.md

Replace the status line with:

```md
**Status on `ashish/feat/multi-project`:** SUBSTANTIALLY SHIPPED at the UI/routing layer. Portfolio landing, `/projects/[id]` routing, feature gating, and portfolio services exist. The unfinished parts are: (a) the full Phase 1c no-restart add-project flow, and (b) the Phase 1b core degraded-resolution model that this phase assumes for true failure isolation.
```

Replace `resolveError`-centric copy in Goal 5 with:

```md
5. **Degraded-project UX.** The target end-state is a per-project resolver that returns degraded entries without crashing the daemon. On the current branch, the shipped surface is portfolio-level `degraded` / `degradedReason`; the deeper `resolveError` core model is still planned work.
```

## Bottom line

If you only make three edits, make these:

- stop claiming `resolveError` is already the branch-wide runtime model
- fix the identity invariant so `path` mutability and `storageKey` immutability are both explicit
- update Phase 1b status to acknowledge that `ao spawn --project` and project removal are already landed

