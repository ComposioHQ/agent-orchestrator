# Autonomy Gaps Roadmap

**Audit date:** 2026-03-15
**Implementation date:** 2026-03-15
**Branch:** feat/autonomy-gaps
**Beads:** jleechan-514o, jleechan-8p0s, jleechan-ylqd, jleechan-4xzz
**Status:** ✅ IMPLEMENTED

---

## Summary

All 4 autonomy gaps have been implemented:

| Bead | Priority | Status |
|------|----------|--------|
| jleechan-514o | P1 | ✅ Complete - `request-merge` reaction (human approval required) |
| jleechan-8p0s | P2 | ✅ Complete - `merge-conflicts` lifecycle event |
| jleechan-ylqd | P2 | ✅ Complete - context injection in repair prompts |
| jleechan-4xzz | P3 | ✅ Complete - hook documentation fixed |

**Files changed:** 9 files, +790/-23 lines

## Context

A code audit against the stated autonomy capabilities of Agent Orchestrator identified four gaps between the documented behavior and the actual implementation. This doc tracks the plan to close them.

The honest current state:

> AO can autonomously drive work to merge-ready, and can usually keep looping through CI and review fixes without human intervention. **Final merge is still effectively human-gated in core today.**

---

## Gaps and Implementation Plan

### 1. `jleechan-514o` — Auto-merge stub (P1) ✅ IMPLEMENTED

**Problem:** The `auto-merge` case in `executeReaction()` only calls `notifyHuman()`. The GitHub SCM plugin already has a fully implemented `mergePR()` method that is never called.

**Implementation:** Per user request, auto-merge is **disabled by default** and requires human approval:
- Added new `request-merge` reaction type that notifies human and waits for approval
- Added `mergeMethod` config (merge, squash, rebase) defaulting to squash
- Guarded with `mergeability` check before attempting merge
- Default config: `autoMergeEnabled: false` (human must approve)

**Files changed:**
- `packages/core/src/lifecycle-manager.ts` (+73 lines)
- `packages/core/src/types.ts` (added `RequestMergeConfig`)
- `packages/core/src/config.ts` (default config)

---

### 2. `jleechan-8p0s` — Merge conflicts missing lifecycle event (P2) ✅ IMPLEMENTED

**Problem:** `getMergeability()` returns merge conflicts as a blocker, but the lifecycle manager never emits a `merge-conflicts` event. There is no way to configure a `send-to-agent` reaction for conflicts — the agent only learns about them if it polls independently.

**Implementation:**
1. Added `"merge-conflicts"` to the lifecycle event enum and reaction key types.
2. In the polling loop (alongside the `ci_failed` check), detect when `mergeReady.noConflicts` is false and emit `"merge-conflicts"` event.
3. Added default reaction entry in `agent-orchestrator.yaml.example` for `merge-conflicts`.

**Acceptance:** A PR with merge conflicts triggers a `send-to-agent` reaction that prompts the agent to rebase or resolve conflicts.

---

### 3. `jleechan-ylqd` — Repair prompts lack context (P2) ✅ IMPLEMENTED

**Problem:** The `send-to-agent` reaction sends `reactionConfig.message` verbatim — a static config string (e.g. `"Fix CI"`). No context is injected: no failing check names, no log excerpts, no changed files. Agents must re-derive everything from scratch.

**Implementation:**
- Added `{{context}}` placeholder in message templates
- For `ci-failed`: appends failing check names and status URLs from `scm.getCISummary()`
- For `changes-requested`: appends unresolved review thread summaries from `scm.getPendingComments()`
- For `merge-conflicts`: appends merge blockers from PR mergeability detail (`blockers: string[]`)

**Acceptance:** Agent receives a message like: _"Fix CI. Failing checks: typecheck (https://...), lint (https://...). Affected files: packages/core/src/lifecycle-manager.ts"_

---

### 4. `jleechan-4xzz` — Agent wrapper hooks are PostToolUse, not true interception (P3) ✅ IMPLEMENTED

**Problem:** The Claude Code and Codex plugin hooks fire **after** `gh pr create` / `gh pr merge` complete (PostToolUse). This correctly updates AO session metadata but cannot modify command behavior. Documentation implies these are "interceptors."

**Implementation:** Updated docs/comments to accurately describe hooks as "observers" that sync AO metadata post-command (Option A). Added `TODO(interception)` comment in hook scripts for potential future pre-command interception.

**Acceptance:** No documentation claims AO "intercepts" `gh` commands. Hook code comments accurately describe the PostToolUse observer pattern.

---

## Sequencing

```text
514o (auto-merge wire-up)     ← highest leverage, closes the loop
  └─ depends on: nothing (mergePR() already exists)

8p0s (merge-conflicts event)  ← enables reaction to a common failure mode
  └─ depends on: nothing

ylqd (context injection)      ← improves repair loop quality
  └─ depends on: 8p0s (merge-conflicts context uses same injection path)

4xzz (docs fix)               ← lowest risk, can land anytime
  └─ depends on: nothing
```

Suggested order: **514o → 8p0s + 4xzz (parallel) → ylqd**

---

## Files Changed

| File | Changes |
|------|---------|
| `packages/core/src/lifecycle-manager.ts` | +171 lines - request-merge, merge-conflicts, context injection |
| `packages/core/src/types.ts` | +9 lines - new event types and config |
| `packages/core/src/config.ts` | +3 lines - default merge config |
| `packages/core/src/__tests__/lifecycle-manager.test.ts` | +547 lines - TDD tests |
| `packages/plugins/agent-claude-code/src/index.ts` | +17 lines - docs fix |
| `packages/plugins/agent-claude-code/src/index.test.ts` | +29 lines - observer pattern test |
| `packages/plugins/agent-codex/src/index.ts` | +29 lines - docs fix |
| `packages/plugins/agent-codex/src/index.test.ts` | +1 line |
| `agent-orchestrator.yaml.example` | +7 lines - merge-conflicts reaction |

**Total:** 9 files, +790/-23 lines
