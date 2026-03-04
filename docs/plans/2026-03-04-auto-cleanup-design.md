# Auto-Cleanup & Backpressure Design

**Date:** 2026-03-04
**Status:** Approved

## Problem

Agent-orchestrator creates branches and worktrees for each session but never cleans them up after PRs merge. The `kill()` method intentionally skips branch deletion to avoid removing human-created branches. Result: 300+ stale branches and orphaned worktrees accumulate over time.

Additionally, AO's research/scanning features can generate new issues and sessions even when existing work hasn't been reviewed or merged, creating noise and redundant work.

## Solution

Two features:

1. **Auto-cleanup** — Automatically clean up branches, worktrees, and session metadata after PRs merge
2. **Backpressure** — Pause spawning and research when open PRs or issues exist on the repo

## Branch Naming Convention

Change branch creation from `feat/issue-{id}` to `feat/agent-{id}`.

- `feat/agent-*` prefix is the ownership marker for cleanup
- Cleanup ONLY deletes branches matching this prefix
- Human-created branches (any other pattern) are never touched
- Existing `feat/issue-*` branches from before this change require manual cleanup
- Change lives in workspace-worktree plugin's `create()` method

## Auto-Cleanup

### Reactive (Immediate)

When the lifecycle manager detects a session's PR status becomes `merged`:

1. Kill the runtime (tmux session)
2. Remove the worktree (`git worktree remove --force`)
3. Delete the local `feat/agent-{id}` branch (`git branch -D`)
4. Archive session metadata (move to `sessions/archive/`)
5. Run `git worktree prune`

This hooks into the existing lifecycle polling loop (every 30 seconds). On `merged` detection, call a new `cleanupSession()` method that extends the existing `kill()` with branch deletion.

### Sweep (Safety Net)

Every 10 poll cycles (~5 minutes), scan for `feat/agent-*` branches where:

- The branch's PR is merged (checked via SCM plugin)
- OR the branch has no associated session metadata (orphaned)

Delete any matches. This catches anything the reactive cleanup missed (e.g., AO crashed between merge detection and cleanup).

### Scope

- **Local only** — delete local branches and worktrees
- Remote branch cleanup is left to GitHub's "auto-delete head branches" repo setting
- Run `git fetch --prune` during sweep to clean stale remote-tracking refs

## Backpressure

Before spawning new sessions or running research/scanning:

1. Check open PRs on the repo (all PRs, not just agent-created)
2. Check open issues on the repo

If **either count > 0**, AO pauses:

- No new session spawning
- No deep research or codebase scanning
- No new issue creation

Log message: `Paused: {n} open PRs and {m} open issues. Resolve before spawning new work.`

Resume: When open PRs = 0 AND open issues = 0, next poll cycle resumes normal operation.

### Where the Check Lives

- Gate in `sessionManager.spawn()` — check before creating a new session
- Gate in research/scanner entry points — check before running analysis
- Uses existing SCM and Tracker plugins to query PR/issue state

## Configuration

Always-on by default. Overrides in `agent-orchestrator.yaml`:

```yaml
cleanup:
  enabled: true                    # default: true
  branch_prefix: "feat/agent-"    # only delete branches matching this
  sweep_interval: 10              # poll cycles between sweeps (~5 min)

backpressure:
  enabled: true                    # default: true
  pause_on_open_prs: true          # any open PR on the repo -> pause
  pause_on_open_issues: true       # any open issue -> pause
```

## Key Files to Modify

| File | Change |
|------|--------|
| `packages/plugins/workspace-worktree/src/index.ts` | Change branch naming to `feat/agent-{id}` |
| `packages/core/src/lifecycle-manager.ts` | Add reactive cleanup on `merged` detection |
| `packages/core/src/session-manager.ts` | Add `cleanupSession()` with branch deletion; add backpressure gate to `spawn()` |
| `packages/core/src/types.ts` | Add cleanup and backpressure config types |
| `packages/core/src/config.ts` | Parse new config sections with Zod, set defaults |
| `agent-orchestrator.yaml.example` | Document new config options |

## What This Does NOT Do

- Does not delete human-created branches (only `feat/agent-*`)
- Does not push-delete remote branches (local only)
- Does not retroactively clean old `feat/issue-*` branches
- Does not add a new CLI command (uses existing `ao session cleanup` as manual fallback)
