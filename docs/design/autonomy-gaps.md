# Autonomy Gaps — Design Reference

**PR:** jleechanorg#8
**Branch:** feat/autonomy-gaps
**Audit date:** 2026-03-15
**Beads:** jleechan-514o (P1), jleechan-8p0s (P2), jleechan-ylqd (P2), jleechan-4xzz (P3)
**Delta:** +844 / −54 lines across 10 files

---

## Gap overview

| Bead | Priority | Problem | Status |
|------|----------|---------|--------|
| jleechan-514o | P1 | `auto-merge` reaction only notified; `scm.mergePR()` never called | Done |
| jleechan-8p0s | P2 | Merge conflicts appeared in blockers but fired no lifecycle event | Done |
| jleechan-ylqd | P2 | `send-to-agent` sent static config strings with no CI context | Done |
| jleechan-4xzz | P3 | Agent plugin hooks described as "interceptors"; they are PostToolUse observers | Done |

---

## 514o — Auto-merge wiring

### Before

```typescript
case "auto-merge": {
  // For now, just notify
  await notifyHuman(event, "action");
  return { action: "auto-merge", success: true };
}
```

`scm.mergePR()` was implemented in `packages/plugins/scm-github/src/index.ts` but not called from the lifecycle-manager's `auto-merge` reaction.

### After

```typescript
// request-merge: check mergeability, notify human — merge happens externally after approval
case "request-merge": {
  const mergeReadiness = await scm.getMergeability(session.pr);
  if (!mergeReadiness.mergeable) { await notifyHuman(blockerEvent, "action"); return { success: false }; }
  await notifyHuman(approvalEvent, "action");
  return { action, success: true };
}

// auto-merge: check mergeability, then merge immediately
case "auto-merge": {
  const mergeReadiness = await scm.getMergeability(session.pr);
  if (!mergeReadiness.mergeable) { await notifyHuman(blockerEvent, "action"); return { success: false }; }
  await scm.mergePR(session.pr, mergeMethod);
  return { action, mergeMethod, success: true };
}
```

- **`auto-merge`** — merges directly when session reaches `mergeable`
- **`request-merge`** — notifies human that PR is ready; human approves and merges externally
- **`mergeMethod`** config: `merge | squash | rebase` (default: `squash`)

---

## 8p0s — Merge-conflicts lifecycle event

```typescript
// types.ts
export type SessionStatus =
  | "mergeable"
  | "merge_conflicts"  // new
  | "merged" | ...

// lifecycle-manager.ts — polling loop
if (!mergeReady.noConflicts) return "merge_conflicts";

// event map
case "merge_conflicts": return "merge.conflicts";
```

### Example config

```yaml
reactions:
  merge-conflicts:
    auto: true
    action: send-to-agent
    message: >
      Your PR has merge conflicts.
      Run: git fetch origin && git rebase origin/main
      Resolve conflicts, then push.
    retries: 2
```

---

## ylqd — Context injection in repair prompts

New `buildReactionContext()` in `lifecycle-manager.ts` fetches real context before dispatch:

| Reaction | Context appended |
|----------|-----------------|
| `ci-failed` | Failing check names + status URLs via `scm.getCIChecks()` |
| `changes-requested` | Unresolved review thread bodies via `scm.getPendingComments()` |
| `merge-conflicts` | Merge blockers from mergeability detail (`blockers: string[]`) |

**Before:** `Fix CI`

**After:**
```
Fix CI

Failing checks:
- typecheck https://github.com/.../runs/123
- lint      https://github.com/.../runs/124

Affected files: packages/core/src/lifecycle-manager.ts
```

---

## 4xzz — Hook observer documentation

Hooks fire **after** command completion. They cannot modify command behavior.

**Flow:** `gh pr create` runs → completes → PostToolUse hook fires → AO metadata updated

| Before | After |
|--------|-------|
| "intercepts gh pr create" | "observes gh pr create output" |
| "Metadata Updater Hook Script" | "Metadata Updater Hook Script (Observer Pattern)" |
| "wrappers intercept commands" | "wrappers observe commands post-execution" |

`TODO(interception)` stubs left in both plugin files for future pre-command needs.

---

## Autonomy claim — post-fix

```
agent works → PR opens
  → CI fails → context-rich send-to-agent
  → merge conflicts → send-to-agent (new)
  → review comments → send-to-agent
  → mergeable → auto-merge calls scm.mergePR()
```

AO can now complete the full loop through merge autonomously when `auto-merge` is configured.
Human approval path available via `request-merge`.

---

## Files changed

| File | Gaps |
|------|------|
| `packages/core/src/lifecycle-manager.ts` | 514o, 8p0s, ylqd |
| `packages/core/src/types.ts` | 514o, 8p0s |
| `packages/core/src/config.ts` | 514o |
| `packages/core/src/__tests__/lifecycle-manager.test.ts` | 514o, 8p0s, ylqd |
| `packages/plugins/agent-claude-code/src/index.ts` | 4xzz |
| `packages/plugins/agent-claude-code/src/index.test.ts` | 4xzz |
| `packages/plugins/agent-codex/src/index.ts` | 4xzz |
| `packages/plugins/agent-codex/src/index.test.ts` | 4xzz |
| `agent-orchestrator.yaml.example` | 8p0s |
