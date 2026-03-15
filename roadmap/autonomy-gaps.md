# Autonomy Gaps Roadmap

**Audit date:** 2026-03-15
**Branch:** feat/autonomy-gaps
**Beads:** jleechan-514o, jleechan-8p0s, jleechan-ylqd, jleechan-4xzz

## Context

A code audit against the stated autonomy capabilities of Agent Orchestrator identified four gaps between the documented behavior and the actual implementation. This doc tracks the plan to close them.

The honest current state:

> AO can autonomously drive work to merge-ready, and can usually keep looping through CI and review fixes without human intervention. **Final merge is still effectively human-gated in core today.**

---

## Gaps and Implementation Plan

### 1. `jleechan-514o` — Auto-merge stub (P1)

**Problem:** The `auto-merge` case in `executeReaction()` (`packages/core/src/lifecycle-manager.ts:467`) only calls `notifyHuman()`. The GitHub SCM plugin already has a fully implemented `mergePR()` method (line 631 of `packages/plugins/scm-github/src/index.ts`) that is never called.

**Fix:** Wire `lifecycle-manager.ts` `auto-merge` case to call `await scm.mergePR(session.pr, project)`. Add configuration for merge method (merge, squash, rebase) defaulting to squash. Guard with a `mergeability` check before attempting.

**Acceptance:** An AO session configured with `auto-merge` reaction should merge a PR without human action after the session reaches `mergeable` state.

---

### 2. `jleechan-8p0s` — Merge conflicts missing lifecycle event (P2)

**Problem:** `getMergeability()` returns merge conflicts as a blocker, but the lifecycle manager never emits a `merge-conflicts` event. There is no way to configure a `send-to-agent` reaction for conflicts — the agent only learns about them if it polls independently.

**Fix:**
1. Add `"merge-conflicts"` to the lifecycle event enum and reaction key types.
2. In the polling loop (alongside the `ci_failed` check), detect `CONFLICTED` mergeability and emit `"merge-conflicts"` event.
3. Add a default reaction entry in `agent-orchestrator.yaml.example` for `merge-conflicts`.

**Acceptance:** A PR with merge conflicts triggers a `send-to-agent` reaction that prompts the agent to rebase or resolve conflicts.

---

### 3. `jleechan-ylqd` — Repair prompts lack context (P2)

**Problem:** The `send-to-agent` reaction (`lifecycle-manager.ts:426`) sends `reactionConfig.message` verbatim — a static config string (e.g. `"Fix CI"`). No context is injected: no failing check names, no log excerpts, no changed files. Agents must re-derive everything from scratch.

**Fix:** Before sending, fetch and append structured context to the message:
- For `ci-failed`: failing check names and status URLs from `scm.getCISummary()` detail.
- For `changes-requested`: unresolved review thread summaries from `scm.getPendingComments()`.
- For `merge-conflicts`: conflicting file list from PR mergeability detail.

Template the message with a `{{context}}` placeholder that lifecycle fills before dispatch, keeping raw config strings as the base.

**Acceptance:** Agent receives a message like: _"Fix CI. Failing checks: typecheck (https://...), lint (https://...). Affected files: packages/core/src/lifecycle-manager.ts"_

---

### 4. `jleechan-4xzz` — Agent wrapper hooks are PostToolUse, not true interception (P3)

**Problem:** The Claude Code and Codex plugin hooks fire **after** `gh pr create` / `gh pr merge` complete (PostToolUse). This correctly updates AO session metadata but cannot modify command behavior. Documentation implies these are "interceptors."

**Fix:** This is mostly a documentation correctness issue. Options:
- A: Update docs/comments to accurately describe hooks as "observers" that sync AO metadata post-command.
- B: Evaluate whether true pre-command interception is needed (e.g., injecting `--squash` flags) and implement only if there is a concrete use case.

For now, implement option A. Leave a `TODO(interception)` comment in the hook script if B is ever needed.

**Acceptance:** No documentation claims AO "intercepts" `gh` commands. Hook code comments accurately describe the PostToolUse observer pattern.

---

## Sequencing

```
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

## Files Likely Touched

| File | Gaps |
|------|------|
| `packages/core/src/lifecycle-manager.ts` | 514o, 8p0s, ylqd |
| `packages/core/src/types.ts` | 8p0s |
| `packages/plugins/scm-github/src/index.ts` | ylqd (expose richer CI detail) |
| `packages/plugins/agent-claude-code/src/index.ts` | 4xzz (comment fix) |
| `packages/plugins/agent-codex/src/index.ts` | 4xzz (comment fix) |
| `agent-orchestrator.yaml.example` | 8p0s (add merge-conflicts example) |
| `packages/core/src/__tests__/lifecycle-manager.test.ts` | 514o, 8p0s, ylqd |
