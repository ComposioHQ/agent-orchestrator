# Feature Plan: Main Catchup with Selective Cherry-Pick Strategy

**Updated**: 2026-03-29 (catch-up applied on `feat/main-catchup`; CP column reflects completion)

## Problem Summary

The `main` branch has **110 commits** ahead of `gb-personal`. Goal: selectively bring valuable changes into `gb-personal` while **preserving its UI/UX identity** (VSCode-style workspace IDE, custom mobile UX, touch scroll, sidebar UX).

### Non-negotiable: gb-personal is authoritative

**Do not revert, replace, or overwrite existing `gb-personal` behavior with `main`'s versions** when resolving conflicts or choosing what to cherry-pick. The UI, layout, workspace IDE, sidebar/session flows, mobile/touch behavior, and every other customization that exists only on `gb-personal` are **the reason this branch exists**. Main is a source of *additive* fixes (core, CLI, tests, plugins, CI, docs, and carefully vetted web bug fixes), not a template to realign the product toward upstream’s UI.

If a cherry-pick would remove or dilute gb-personal’s UX, **skip that commit**, **abort that pick**, or **resolve conflicts by keeping gb-personal** (then re-apply only the minimal non-UI logic from main by hand if still needed). When in doubt, **gb-personal wins** for anything user-facing in `packages/web/` and related assets.

---

## Branch States (Updated)

### gb-personal (30+ commits ahead of merge-base `4741ba24`)
Recent additions since last review:
- **Sidebar session UX** — filters, labels, hash stripping, toggles (PR #12)
- **Killed sessions toggle** — sidebar UX, restore on detail, labels
- **Pending plans** feature (PR #11)
- **Sub-session remember** fix
- **Agent override & shared workspace** restoration
- **Git diff viewer** and workspace file-tree improvements
- VSCode-style workspace IDE (FileTree, QuickOpen, WorkspaceLayout)
- Compact top bar, touch scroll, xterm v6, Cursor/Amp agents

### main (110 commits ahead of gb-personal)
Key changes grouped by risk level:

---

## Commit Categorization

**CP column (for agents):** `no` = not cherry-picked yet; `yes` = cherry-picked onto the catch-up branch (or equivalent fix landed); `skip` = do not CP per plan; `n/a` = not one commit, **or** not applicable on gb-personal (e.g. legacy `sessions/[id]` page removed — see `e1867d0b`).

### Batch 1: SAFE — Core/CLI Bug Fixes (cherry-pick)

| Hash | Description | CP |
|------|-------------|-----|
| `d0c0b9b0` | fix: don't burn error retry budget on Discord 429 Retry-After waits | yes |
| `28bb9aa6` | fix: apply minimum wait for Discord 429 without Retry-After header | yes |
| `ecf4848e` | fix: prevent Discord retry counter compounding on persistent 429s | yes |
| `b6194614` | fix: assign 429 error to lastError so exhausted rate-limit throws | yes |
| `8896187b` | fix: preserve existing notifiers when creating default notificationRouting | yes |
| `c8ba03bb` | fix: fail hard when --test-notify is set but config load fails | yes |
| `c975f952` | fix(core): mandate ao send and ban raw tmux | yes |
| `b65cc702` | fix: correct ao send --no-wait wording per review | yes |
| `e1867d0b` | Preserve orchestrator ID when session project changes | n/a |

### Batch 2: SAFE — CLI Setup & Preflight (cherry-pick)

| Hash | Description | CP |
|------|-------------|-----|
| `90ee21c3` | fix: repair npm global install — walk-up dep resolution, spawn-helper chmod | yes |
| `76117345` | fix: true two-step setup — tmux auto-install, process fallback | yes |
| `f5463002` | fix: block with clear tmux install instructions | yes |
| `eee9d773` | fix: interactive tmux install with user consent | yes |
| `9d15ce5d` | fix(start): enforce tmux preflight across all start paths | yes |
| `c5cc0620` | fix(cli): disable tmux auto-install in spawn preflight | yes |
| `c19aaf69` | fix(cli): disable non-interactive auto-install for required tools | yes |
| `b976c36c` | fix(cli): remove required git/tmux auto-install attempts | yes |
| `d4ff10b5` | fix(cli): restore interactive installs for ao start prerequisites | yes |
| `07028ba6` | perf(cli): avoid redundant agent detection scan in start | yes |
| `aa7e3608` | refactor(cli): centralize agent runtime selection logic | yes |
| `32591c2a` | fix(cli): use pipx for aider install option | yes |
| `f0d63494` | fix: derive skip option from AGENT_INSTALL_OPTIONS.length | yes |

### Batch 3: SAFE — Test Improvements (cherry-pick)

| Hash | Description | CP |
|------|-------------|-----|
| `0d4ddcc8` | feat(core): extract shared test utilities and migrate lifecycle-manager tests | yes |
| `532fdd22` | Remove unused imports from lifecycle-manager test | yes |
| `5449acd0` | Add mock implementation for workspace list function | yes |
| `2eedb613` | refactor(core): decompose session-manager.test.ts into modular test files | yes |
| `373654f4` | fix yaml test | yes |
| `2a7c4a3f` | phase3-done (test refactor continuation) | yes |
| `5f7a3d50` | fix: comments fixed | yes |

### Batch 4: SAFE — New Features (cherry-pick)

| Hash | Description | CP |
|------|-------------|-----|
| `36d354e0` | feat: OpenClaw plugin, AO skill, Discord notifier, and setup wizard | yes |
| `3716fc75` | fix: address Cursor Bugbot review comments on PR #631 | yes |
| `8bc2a5bf` | fix: address PR #631 review comments | yes |
| `4495e11b` | fix: address Cursor Bugbot review comments on PR #631 | yes |
| `38c35cd6` | feat: harden plugin, rewrite skill for ClawHub | yes |
| `570f3b58` | fix: address CodeRabbit review comments | yes |
| `8b491d44` | fix: address Cursor Bugbot review comments | yes |
| `62ecad06` | fix: address final CodeRabbit PR review findings | yes |
| `8a353846` | fix: resolve lint errors in openclaw-plugin and notifier-openclaw | yes |
| `1bc25622` | fix: minor name update | yes |

New top-level files:
- `openclaw-plugin/` (index.ts, index.test.ts, package.json, plugin.json)
- `skills/agent-orchestrator/SKILL.md`
- `docs/openclaw-plugin-setup.md`
- `docs/design-npm-global-install-fixes.html`

### Batch 5: SAFE — CI/Security (cherry-pick)

| Hash | Description | CP |
|------|-------------|-----|
| `f0bcb7b7` | fix: replace gitleaks-action v2 with free CLI | yes |
| `70fe5369` | fix: use correct gitleaks --log-opts syntax | yes |
| `c762fa14` | ci: add gitleaks checksum verification and optimize fetch-depth | yes |
| `91117f9e` | ci: fix gitleaks checksum filename, install dir, fetch-depth | yes |
| `b49c69ba` | fix: last 10 commits for secrets check | yes |
| `47fa76c0` | fix: latest issue | yes |

### Batch 6: SAFE — Docs/Config (cherry-pick)

| Hash | Description | CP |
|------|-------------|-----|
| `cbdf2d2d` | docs: sync install-flow design doc with current start/preflight | yes |
| `fafe76c4` | docs: upgrade flow diagrams to visual CSS flowcharts | yes |
| `fea320e9` | docs: add prerequisite matrix and install behavior details | yes |
| `ac625c34` | chore: add changeset for onboarding/install fixes | yes |
| `540dad77` | fix: comments from #720 fixed | yes |

### Batch 7: EVALUATE — Web Bug Fixes (useful but may conflict)

These touch `packages/web/` but fix real bugs. Need case-by-case evaluation:

| Hash | Description | Risk | CP |
|------|-------------|------|-----|
| `c32fb6a0` | Fix session polling and BottomSheet freshness | Medium | yes |
| `ada46955` | Fix session detail project polling and orchestrator response | Medium | yes |
| `128c9101` | Handle dashboard send failures and optimize session polling | Medium | yes |
| `24a293d8` | Handle send errors and stabilize script tests | Medium | yes |
| `5b1f3625` | Reset mobile view-all state and surface send errors | Low | yes |
| `b69cb9aa` | Guard alert action sends and reset on failure | Low | yes |
| `16c2bf23` | Fix quick reply success state on send failures | Low | yes |
| `82a93a0a` | Fix metadata loading and refresh orchestrator session links | Low | yes |
| `4a842d47` | Fix ao launcher linking and mobile toast offset | Low | yes |

### Batch 8: SKIP — Mobile UX Redesign (conflicts with gb-personal)

Main rewrote the mobile UX from scratch with accordion layout, action strips, quick replies, bottom sheets, PWA support. gb-personal has its own mobile UX direction. These would conflict heavily:

| Hash | Description | Reason to Skip | CP |
|------|-------------|----------------|-----|
| `8fc778cf` | Mobile-responsive layout for dashboard/session | Conflicts with gb-personal layout | skip |
| `ffef8d4a` | Mobile accordion layout — urgency-first kanban | Different UX paradigm | skip |
| `3845bd58` | Mobile action strip — tappable urgency pills | gb-personal uses different approach | skip |
| `3e678f7f` | Quick-reply section on respond cards | gb-personal has its own UX | skip |
| `c3613926` | Toast/Snackbar system and BottomSheet | Could evaluate separately later | skip |
| `fc9edb8a` | SSE connection status indicator | Could evaluate separately later | skip |
| `b74a2120` | useMediaQuery hook | gb-personal has its own hook / removed | skip |
| `4622be19` | PWA support and mobile fixes | Large, many conflicts | skip |
| `a4a86594` | Mobile backdrop to collapsed sidebar | gb-personal has own sidebar | skip |
| Various | 15+ mobile polish/fix commits | All depend on the above features | n/a |

### SKIP — Merge Commits & Changesets

All `Merge pull request` commits and `chore: version packages` / `chore: trigger CI` — skip these, cherry-pick the actual content commits instead. **No CP column here:** never cherry-pick these as rows; track progress only via the content-commit tables above (update **CP** to `yes` when that commit’s changes are on the branch, including if squashed with others).

---

## Implementation Strategy

### Order of Operations

1. **Branch**: Already on `feat/main-catchup` rebased on latest `gb-personal`
2. **Batch 1-2**: Core/CLI fixes first (least conflict risk)
3. **Batch 3**: Test improvements (may need conflict resolution for test-utils)
4. **Batch 4**: OpenClaw plugin (mostly new files, low conflict)
5. **Batch 5-6**: CI/Security and Docs
6. **Batch 7**: Evaluate web bug fixes individually
7. **Skip Batch 8**: Mobile UX redesign
8. **Regenerate** `pnpm-lock.yaml` with `pnpm install` after all picks
9. **Full validation**: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
10. **Create PR** to `gb-personal`

### Conflict Resolution Rules

These rules implement the non-negotiable above: **never trade away gb-personal’s UI/customizations for main’s.**

- **`packages/web/` (and web-adjacent CSS, hooks, routes)**: Always keep **gb-personal’s** version. Do not overwrite gb-personal UI with main to “match upstream.” Port bug fixes from main only as small, isolated patches that preserve gb-personal layout and behavior.
- **Core/CLI**: Prefer main's fixes (they're newer bug fixes), as long as they do not force regressions in behaviors gb-personal depends on.
- **Tests**: Merge both — gb-personal's test additions + main's test refactoring
- **Config/types**: Merge carefully, ensure both feature sets work; do not drop gb-personal-only options or semantics.
- **pnpm-lock.yaml**: Never cherry-pick — regenerate from scratch

### Cherry-Pick Technique

For batches with many small commits, consider using:
```bash
# Cherry-pick a range (oldest..newest) for a PR's commits
git cherry-pick <oldest>^..<newest>

# Or for individual safe commits
git cherry-pick --no-commit <hash1> <hash2> ...
git commit -m "feat: cherry-pick core bug fixes from main"
```

Group related commits into single logical commits for cleaner history.

---

## Estimated Scope

| Category | Commits | Risk |
|----------|---------|------|
| Core/CLI fixes | ~22 | Low |
| Test improvements | ~7 | Low-Medium |
| OpenClaw plugin | ~10 | Low |
| CI/Security | ~6 | Low |
| Docs/Config | ~5 | Low |
| Web bug fixes | ~9 | Medium |
| **Total to include** | **~59** | |
| Mobile UX (skip) | ~25 | N/A |
| Merge commits (skip) | ~26 | N/A |

---

## Risks

1. **Test imports**: Phase 3 refactor moved test files around — may need to reconcile with gb-personal's lifecycle-manager test additions
2. **Core types**: `packages/core/src/types.ts` changed in both branches — merge carefully
3. **session-manager.ts**: 326 lines changed in main — need to check against gb-personal's changes
4. **prompt-builder.ts**: 62 lines changed — may interact with gb-personal's plan-first worker prompt

---

## Validation Strategy

```bash
# After each batch
pnpm typecheck && pnpm lint

# After all batches
pnpm build && pnpm typecheck && pnpm lint && pnpm test
```

### Manual Testing
- [ ] Dashboard loads without errors
- [ ] Workspace IDE (file tree, quick open) works
- [ ] Session sidebar with filters/labels/killed toggle works
- [ ] Terminal touch scroll on mobile works
- [ ] Cursor/Amp agent integration works
- [ ] OpenClaw plugin loads (if included)

---

## PR Template

```
## Summary
Selective cherry-pick of improvements from main into gb-personal.

### Included (~59 commits)
- Core bug fixes: Discord 429 handling, notification routing, session management
- CLI improvements: setup flow, preflight checks, agent runtime
- Test refactoring: modular test files, shared utilities
- OpenClaw plugin integration
- CI/Security: gitleaks workflow
- Documentation updates

### Skipped (~25 commits)
- Mobile UX redesign (accordion, action strips, quick replies, bottom sheets)
  - gb-personal has its own mobile UX direction
- Workspace component removal
  - gb-personal preserves VSCode-style IDE

### Conflict Resolution
- No existing gb-personal UI/customizations were reverted or overwritten by main; gb-personal remained authoritative for all user-facing web behavior
- Web: kept gb-personal's versions; any main fixes were applied only where they did not replace gb-personal UX
- Core/CLI: adopted main's bug fixes where safe for gb-personal behavior
- Tests: merged both additions

Closes #main-catchup
```
