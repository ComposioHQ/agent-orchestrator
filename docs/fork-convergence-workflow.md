# Fork Convergence Workflow (v1)

This workflow documents how to operate the `fork.sync_upstream` primitive introduced for issue #401.

## Goal

Keep fork branches converged with upstream while avoiding unmanaged drift.

## Primitive

- Name: `fork.sync_upstream`
- Behavior: fetch upstream and perform a **fast-forward-only** sync when safe.
- Non-goals in v1: no federation protocol, no implicit conflict resolution merge.

## Sync State Model

`fork.sync_upstream` computes and returns:

- `ahead`: local-only commits
- `behind`: upstream-only commits
- `diverged`: `ahead > 0 && behind > 0`
- `relation`: `up_to_date | ahead | behind | diverged`

## Operator Decision Guide

1. `up_to_date`
- No action needed.

2. `behind`
- Run `fork.sync_upstream`.
- Expected result: `action=fast_forward`, `relation=up_to_date`.

3. `ahead`
- Do not sync from upstream (nothing to fast-forward).
- Use upstreamable patch flow (open PR from fork branch).

4. `diverged`
- Primitive returns `action=blocked` with drift alert suggestions.
- Perform manual convergence (rebase/merge strategy per team policy), then re-run sync state.

## Convergence Suggestions

The primitive emits deterministic hints:

- `sync_upstream`: behind upstream; run sync.
- `upstreamable_patch`: ahead upstream; propose patch/PR upstream.
- `drift_alert`: branch diverged; manual convergence required.

## Expected Failure Path

If fast-forward is expected but `git merge --ff-only` fails, result is:

- `action=blocked`
- `synced=false`
- state remains unchanged
- suggestions keep the sync hint for operator follow-up
