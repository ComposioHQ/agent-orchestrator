# Feature Plan: Cherry-pick main → gb-personal (post-PR #887)

**Issue:** single-socket-gb-personal
**Branch:** `feat/single-socket-gb-personal`
**Status:** Pending

---

## Problem

- `gb-personal` is ~200+ commits behind `main` after PR #887 (single-socket) merged
- Key features missing: single-socket mux, multi-orchestrator, external plugins, CLI improvements, various core/lifecycle fixes
- Shared components (`Dashboard.tsx`, `SessionCard.tsx`, `DirectTerminal.tsx`) diverged — causes CP conflicts and blocks future main↔gb-personal portability

## Strategy

**Two-phase approach:**
1. **Cleanup PR** — fork gb-personal's diverged components into GB-specific versions, rewire `(with-sidebar)` imports
2. **Cherry-pick PR(s)** — CP groups A–G from main; shared components land untouched since gb-personal no longer imports them

After cleanup, every future CP from main is conflict-free on UI files.

---

## Phase 0: Component Cleanup (prerequisite PR)

### Goal
- Fork 3 shared components into GB-specific versions
- Rewire `(with-sidebar)` route group to use GB versions
- Main's versions become dead code in gb-personal (untouched, ready for CPs)

### Components to fork

| Current shared file | New GB file | Why |
|---|---|---|
| `components/Dashboard.tsx` (749 lines in gb) | `components/DashboardGB.tsx` | gb has simpler layout (no mobile accordion, no built-in sidebar — sidebar lives in layout). Main's is 1066 lines with mux, media queries |
| `components/SessionCard.tsx` (708 lines in gb) | `components/SessionCardGB.tsx` | gb has custom styling. Main added quick-reply, mobile action strip (858 lines) |
| `components/DirectTerminal.tsx` | `components/DirectTerminalGB.tsx` | gb has reconnect pill, pane toggle, touch scroll. Main migrated to mux WebSocket |

### What's already decoupled (no work needed)

- `SessionDetail.tsx` — gb-personal's session page uses `WorkspaceLayout` + `SessionTerminalTabs`, does NOT import `SessionDetail.tsx`
- `ProjectSidebar.tsx` — used by both but gb-personal's layout passes different props; can stay shared for now (low divergence)
- All `workspace/` components — gb-personal only, no conflict
- `(with-sidebar)/layout.tsx` — gb-personal only

### Files to modify

| File | Change |
|---|---|
| `components/DashboardGB.tsx` | **New** — copy from current `Dashboard.tsx` |
| `components/SessionCardGB.tsx` | **New** — copy from current `SessionCard.tsx` |
| `components/DirectTerminalGB.tsx` | **New** — copy from current `DirectTerminal.tsx` |
| `app/(with-sidebar)/page.tsx` | Import `DashboardGB` instead of `Dashboard` |
| `components/DashboardGB.tsx` | Import `SessionCardGB` instead of `SessionCard` |
| `components/SessionTerminalTabs.tsx` | Import `DirectTerminalGB` instead of `DirectTerminal` |
| `components/Dashboard.tsx` | Revert to main's version (or leave as-is — CP will overwrite) |
| `components/SessionCard.tsx` | Same — revert or let CP overwrite |
| `components/DirectTerminal.tsx` | Same — revert or let CP overwrite |

### Tests

- Existing tests for `Dashboard`, `SessionCard`, `DirectTerminal` stay as-is (they test main's versions)
- Add thin smoke tests for GB variants (render without crash)
- `(with-sidebar)` pages verified via `pnpm build` + `pnpm typecheck`

### Cleanup checklist

- [ ] **0.1** Create `DashboardGB.tsx` — copy current gb-personal `Dashboard.tsx`
- [ ] **0.2** Create `SessionCardGB.tsx` — copy current gb-personal `SessionCard.tsx`
- [ ] **0.3** Create `DirectTerminalGB.tsx` — copy current gb-personal `DirectTerminal.tsx`
- [ ] **0.4** Update `DashboardGB.tsx` to import `SessionCardGB`
- [ ] **0.5** Update `(with-sidebar)/page.tsx` to import `DashboardGB`
- [ ] **0.6** Update `SessionTerminalTabs.tsx` to import `DirectTerminalGB`
- [ ] **0.7** Reset `Dashboard.tsx`, `SessionCard.tsx`, `DirectTerminal.tsx` to match `origin/main` versions
- [ ] **0.8** Add smoke tests for GB variants
- [ ] **0.9** `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
- [ ] **0.10** Commit + push cleanup PR against `gb-personal`

---

## Phase 1: Cherry-pick Groups (after cleanup merges)

### CP approach
- Cherry-pick squashed or individual commits by group
- Order: D (core fixes) → F (external plugins) → G (version fixes) → B (multi-orch) → C (CLI) → A (single-socket mux) → E (dashboard UX)
- Core/CLI first because web groups depend on core types
- Group A last because it's the largest and touches web plumbing

### Group D: Core Fixes (15 commits, LOW-MEDIUM risk)

| Commit | Description |
|---|---|
| `20247a62` | fix(agent-claude-code): idle state for freshly spawned sessions |
| `b4c10833` | fix(core): allow external notifier with manifest name matching built-in |
| `1531a914` | fix(core): forward allSessionPrefixes in resolveSessionRole |
| `f65e7d95` | fix(lifecycle): reduce GitHub API rate limiting from batch enrichment bypass |
| `649fc67f` | revert: remove model rate-limit pause functionality (PR #367) |
| `41c967a3` | fix: use TERMINAL_STATUSES in lifecycle poll accounting |
| `86251377` | feat: event-driven live tab titles and favicons via SSE (#848) |
| `1bb80ef6` | feat: stable session titles via pinnedSummary metadata (#946) |
| `f07aedfa` | fix: resolve prompt delivery persistence and false warnings |
| `3d1913e6` | fix: robust prompt delivery with retries and CLI warnings |
| `95ca1c1e` | fix: return 400 for invalid verify API payloads |
| `53ef7783` | feat: add CI failure detail notifications in lifecycle manager (#850) |
| `3a108e9b` | fix: add @composio/core to serverExternalPackages |

- **Conflicts expected:** `lifecycle-manager.ts` (restore tracking in gb), `core/src/index.ts` (global-pause removal)
- **Deps:** none

### Group F: External Plugin Support (10 commits, LOW risk)

| Commit | Description |
|---|---|
| `ebe64085` | feat(core): support external tracker, scm, and notifier plugins from config |
| `3e6d2f97` | feat(core): unify plugin config cleaning, reserved fields for tracker/scm |
| `4645f657` | feat(core): enforce reserved fields in notifier configs |
| `ff47d363` | add error handling for path in config |
| `e799c010` | fix(core): ensure consistent temp plugin name generation |
| `986c499a` | fix: ensure notifier config is passed when manifest name differs |
| `1396d079` | fix: prevent one project's bad config from breaking shared plugin |
| `b936114e` | fix: preserve multi-word plugin names from package specifiers |
| `f9d991d4` | fix: handle optional plugin field in CLI and web packages |
| `23cb1ee7` | fix load builtin error |

- **Conflicts expected:** `config.ts`, `plugin-registry.ts` (gb already has some plugin work)
- **Deps:** none

### Group G: Version/AO Package Fixes (3 commits, LOW risk)

| Commit | Description |
|---|---|
| `a4e64835` | Fixed ao's version mismatch problem |
| `482368d1` | Reverted to createRequire for node < v20.10.0 compat |
| `7e3199f3` | added shield badge for current version |

- **Conflicts expected:** none
- **Deps:** none

### Group B: Multi-Orchestrator (#870) (10 commits, MEDIUM risk)

| Commit | Description |
|---|---|
| `7e53542f` | feat: support multiple concurrent orchestrators with isolated worktrees |
| `9d4d3412` | fix: prevent ao start from spawning duplicate orchestrators |
| `95b6c542` | fix: auto-select orchestrator when --no-dashboard |
| `9c0245a3` | fix: correct tmux target fallback and deduplicate orchestrator listing |
| `63a79627` | refactor: deduplicate Orchestrator interface |
| `672f2ad6` | fix: remove unused projects prop from OrchestratorSelector |
| `81258468` | fix: handle invalid and future dates in formatRelativeTime |
| `1116363a` | fix: clean up OrchestratorSelector tests and spawn resilience |
| `62d9aa5b` + `6778c280` + `10163f0e` + `dcdafb01` | test fixes |

- **Conflicts expected:** `session-manager.ts` (sub-session support in gb), `types.ts`, `start.ts`
- **Deps:** Group D (lifecycle fixes)

### Group C: CLI Output Cleanup (#947) (8 commits, LOW risk)

| Commit | Description |
|---|---|
| `fe6fb4f7` | fix(cli): print session URL instead of tmux attach |
| `5ad370e8` | fix(cli): simplify spawn success message |
| `5322220f` | fix(cli): consolidate spawn output |
| `24ecfc29` | fix(cli): replace all tmux attach output with dashboard URLs |
| `48a6f94f` | fix(cli): use ao session attach fallback |
| `98547a9f` | fix(cli): clear spinner mock calls between tests |
| `2f4968c4` | refactor(cli): extract DEFAULT_PORT constant |
| `6ecaabe3` | fix(cli): remove 'Next step' hint |

- **Conflicts expected:** `start.ts` (already modified by Group B)
- **Deps:** Group B (multi-orch changes to start.ts)

### Group A: Single-Socket Mux (PR #887) (~30 commits, HIGH risk → LOW after cleanup)

| Commit | Description |
|---|---|
| `2e5ee30f` | feat(web): add multiplexed WebSocket protocol and mux server |
| `9458c838` | feat(web): add MuxProvider React context |
| `82581fa0` | refactor(web): migrate DirectTerminal to use mux WebSocket |
| `4684b75d` | feat(web): single-socket — multiplex terminals + sessions |
| `f2986bf8`–`b04137f6` | ~15 bugbot fix passes |
| `2da6906b` | fix(web): prevent SSE re-run on mux snapshot |
| `87c66133` | fix(web): restore local type defs in mux-websocket |
| `44acb6d1` | fix(web): re-send terminal dimensions on mux reconnect |
| `469382cc` | fix(web): remove muxStatus from fullscreen-resize deps |
| `3ae8c9d2` | fix(web): cap PTY re-attach attempts |
| `faa1bfa8` | fix(web): isolate subscriber callbacks in pty.onData |
| `78e57125` | fix(web): prevent duplicate buffer replay on reconnect |
| `6f3aec70` | fix(web): wrap session broadcast callbacks in try-catch |
| `5cb17c08` + `1fa88cdf` | mux refresh tests + cli version fix |
| `a25db105` + `a95f0ca8` | SessionBroadcaster + Providers tests |
| `11103f0e` + `04788043` | CI OOM fixes for mux tests |

- **After cleanup, risk drops significantly:**
  - `DirectTerminal.tsx` — main's mux version lands cleanly (gb uses `DirectTerminalGB.tsx`)
  - `Dashboard.tsx` — main's mux-aware version lands cleanly (gb uses `DashboardGB.tsx`)
  - `useSessionEvents.ts` — still shared, may conflict (terminal connection store in gb)
  - New files (`mux-websocket.ts`, `MuxProvider.tsx`, `async-utils.ts`) — no conflicts
- **Deps:** Groups D, B (core types), Phase 0 cleanup
- **Post-CP work:** Wire `DirectTerminalGB.tsx` to use mux if desired (separate follow-up)

### Group E: Dashboard UX (20 commits, LOW after cleanup)

| Commit | Description |
|---|---|
| `0b49ff35` | fix(web): display PR details card above terminal |
| `7fff3b94` | fix(web): remove CLI instructions from empty state |
| `48d655d9` | fix: reduce dashboard JS bundle from 1.7MB to 170KB |
| `eeda4160` | feat(web): add dashboard error boundaries |
| `d956c52e` + `694332d7` | 404 handling pages |
| `fa73a9fb` + `6bfc239a` | loading spinner pages |
| `5a5624f1` | fix: restore done/terminated sessions column |
| `c1f6d00c` + `00045973` + `cc07cb02` | done bar styling + tests |
| `c4730883` | fix: prevent retry storms and stale refresh |
| `1825e6a8` + `27ce7d56` + `5cb66a9b` + `e38c7e94` | dashboard fast-path hydration |
| `074b7f2e` | fix: replicate terminal session filtering |
| `67371d2c` | fix: polish shimmer states, terminal PR inference |
| `a815fd11` | refactor: extract settlesWithin to async-utils |
| `d8b8645b` | fix(cli): ao start navigates to session page |
| `30ee327d` | fix(notifier): remove desktop notifications from default configs |
| `19deb059` + `c1feb90f` | guard polling 404, preserve session view |
| `fb11b60b` + `ab8250fe` | stabilize isolated workspace checks |

- **After cleanup:** These modify main's `Dashboard.tsx`, `SessionCard.tsx`, `SessionDetail.tsx` — all decoupled from gb-personal routes
- **New files land cleanly:** `error.tsx`, `not-found.tsx`, `loading.tsx`, `ErrorDisplay.tsx`, `OrchestratorSelector.tsx`, `orchestrators/page.tsx`
- **Deps:** Groups A (mux), D (core)

---

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | **`useSessionEvents.ts` conflict in Group A?** | Both branches modified — gb added terminal connection store, main added mux snapshots. Manual resolution needed |
| 2 | **`globals.css` accumulation?** | Both branches added CSS. CP should append cleanly but verify no selector conflicts |
| 3 | **`session-manager.ts` in Group B?** | gb has sub-session support, main has multi-orch. Both added methods — should merge additively |
| 4 | **Wire mux into `DirectTerminalGB`?** | After CP, main's `DirectTerminal` uses mux but `DirectTerminalGB` still uses direct WS. Follow-up PR to optionally migrate |
| 5 | **pnpm-lock.yaml?** | Regenerate with `pnpm install` after each CP group |

## Validation (after each CP group)

- `pnpm install`
- `pnpm build`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

## Checklist Summary

- [ ] **Phase 0** — Component cleanup PR (prerequisite)
- [ ] **Group D** — Core fixes CP
- [ ] **Group F** — External plugin support CP
- [ ] **Group G** — Version/AO fixes CP
- [ ] **Group B** — Multi-orchestrator CP
- [ ] **Group C** — CLI output cleanup CP
- [ ] **Group A** — Single-socket mux CP
- [ ] **Group E** — Dashboard UX CP
- [ ] **Follow-up** — Wire mux into `DirectTerminalGB` (optional, separate PR)
