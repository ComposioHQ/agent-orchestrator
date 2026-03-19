# Design: Absorb jleechanclaw Orchestration Patterns into AO Core

> **FORK-ONLY:** This file is for the jleechanorg/agent-orchestrator fork. Do not include in ComposioHQ/agent-orchestrator PRs — exclude from upstream PRs per repo policy. Excluded paths: `docs/design/*.md`, `CLAUDE.md`, `AGENTS.md`, `roadmap/`, `.beads/`.

**Date:** 2026-03-17
**Beads:** bd-uxs (epic), bd-uxs.1–8
**Status:** Done — all bd-uxs.1–8 tasks closed (PRs #19 and #21 pending merge)
**Branch:** feat/merge-gate-and-ignore-list (primary), chore/decouple-fork-docs

---

## Background

`jleechanclaw` (`~/.openclaw`) is a Python-based orchestration system that runs on top of agent-orchestrator (AO). It was built organically starting 2026-03-01 — before AO was set up for that repo — to automate PR workflows for the jleechanclaw project.

A code audit revealed that:
- The **core CI fix loop** in jleechanclaw is live and working
- Several modules implement capabilities that are **genuinely missing from AO**
- Some modules are **redundant** with AO (lifecycle polling, webhook routing)
- jleechanclaw uses `ao spawn`/`ao send`/`ao kill` as its execution layer

This doc captures what should become AO code changes vs what stays as a project-specific layer.

---

## What jleechanclaw Does That AO Doesn't

### Gap 1: No autonomous PR initiation (bd-uxs.2)

AO's lifecycle-worker monitors existing sessions but has no mechanism to scan open PRs and spawn sessions for ones that need work. A human (or the orchestrator LLM session) must run `ao spawn` manually.

**jleechanclaw solution:** `ao-pr-poller.sh` — polls GitHub every 5 minutes, spawns sessions for non-green PRs with no active worktree, rate-limits to 10 respawns per PR per 12h.

**AO solution:** New plugin slot or config-driven polling reaction. Proposed: `reactions["pr-needs-work"]` with a new `poll-and-spawn` action type, configured with polling interval and spawn conditions.

---

### Gap 2: Failure budgets + deterministic escalation routing (bd-uxs.3)

AO's `lifecycle-manager.ts` has `retries` and `escalateAfter` per reaction, but no cross-session failure budget, no strategy-change tracking, and no deterministic policy layer. Every retry sends the same message.

**jleechanclaw solution:** `escalation_router.py` — `EscalationPolicy` config, `FailureBudget` per subtask, deterministic routing to retry/kill-and-respawn/parallel-retry/wait/notify. LLM judgment only when no rule matches.

**AO solution:** Extend `ReactionConfig` in `types.ts`:

```typescript
interface ReactionConfig {
  // existing
  action: ReactionAction;
  retries?: number;
  escalateAfter?: string | number;

  // new
  failureBudget?: {
    maxRetries: number;
    maxStrategyChanges: number;
    ciGracePeriodMs?: number;
    sessionTimeoutMs?: number;
  };
  onBudgetExhausted?: 'kill-and-respawn' | 'notify' | 'parallel-retry';
}
```

Implement `FailureBudgetTracker` in `lifecycle-manager.ts` alongside existing `reactionTrackers`.

---

### Gap 3: Parallel speculative CI fixes (bd-uxs.4)

When CI fails, AO retries serially with the same message. jleechanclaw generates multiple fix strategies and spawns parallel sessions — first to go green wins, losers killed.

**jleechanclaw solution:** `parallel_retry.py` — `FixStrategy` templates + optional LLM, parallel `ao spawn`, CI polling, kill losers.

**AO solution:** New `action: "parallel-retry"` in `ReactionConfig`. Requires:
- Strategy template system (config-driven prompts per error class)
- Parallel session spawning with unique branch names (`fix/ci-approach-001`, `fix/ci-approach-002`)
- CI outcome polling across sessions
- Winner promotion, loser cleanup

This is the highest-complexity change. Implement after failure budgets are solid.

---

### Gap 4: Closed-loop outcome learning (bd-uxs.5)

AO has no memory of what fix strategies worked. jleechanclaw records winning strategies per error class and synthesizes high-confidence patterns for future use.

**jleechanclaw solution:**
- `outcome_recorder.py` → `~/.openclaw/state/outcomes.jsonl`
- `pattern_synthesizer.py` → `~/.openclaw/state/patterns.json` (cron, every 4h)

**AO solution:**
- New `observability` hook: on `parallel-retry` completion, append to `outcomes.jsonl` in the sessions dir
- New cron plugin: `pattern-synthesizer` reads outcomes, writes `patterns.json`
- `parallel-retry` action reads `patterns.json` to bias strategy selection

Keeps AO stateless by default — opt-in via config:
```yaml
learning:
  enabled: true
  outcomesFile: .ao/outcomes.jsonl
  patternsFile: .ao/patterns.json
  synthesisIntervalMs: 14400000  # 4h
```

---

### Gap 5: Session exit reconciliation (bd-uxs.6)

When an AO session exits, the lifecycle-manager marks it `killed`. It doesn't validate whether the session actually pushed commits, has an open PR, or completed its task.

**jleechanclaw solution:** `reconciliation.py` — on session exit, checks `git log origin..HEAD`, verifies remote push, emits `task_finished` (with PR URL + commit SHA) or `task_needs_human`.

**AO solution:** Extend `lifecycle-manager.ts`'s `killed` transition handling:
- On `killed`: check if session branch has unpushed commits
- If unpushed commits exist → emit `session.abandoned` event (new)
- If commits pushed but no PR → emit `session.work_unpublished` event (new)
- Add reactions for these events (`create-pr`, `notify`)

---

### Gap 6: Workspace dirty bug (bd-uxs.1)

AO fails to spawn sessions on repos where the working directory is also the live config dir (e.g., `~/.openclaw`). During spawn setup, AO writes `.claude/settings.json` with absolute worktree paths, then its own cleanliness check detects this write as a dirty workspace and fails. Circular.

**Root cause:** `workspace-worktree` plugin checks `git status --porcelain` before creating the worktree, but AO's own setup code (settings.json rewrite) runs before that check.

**Fix:** Move the `.claude/settings.json` write to after workspace creation, or add `.claude/settings.json` to the list of ignored paths in the cleanliness check.

**Files to investigate:**
- `packages/plugins/workspace-worktree/src/index.ts`
- `packages/plugins/agent-claude-code/src/index.ts` (settings.json write)

---

## What Stays in jleechanclaw (Not AO Changes)

| Module | Why it stays |
|---|---|
| 6-green gating logic | Project-specific merge conditions (CodeRabbit, Bugbot, evidence review) — too opinionated for core |
| Slack dispatch / openclaw notifier | Project-specific notification routing |
| `ao-pr-poller.sh` (interim) | Until bd-uxs.2 is implemented in AO |
| Evidence review integration | jleechanclaw-specific quality gate |

---

## What Gets Retired After AO Changes Land

| jleechanclaw module | Replaced by |
|---|---|
| Python heartbeat/lifecycle polling | AO lifecycle-worker (already running) |
| `webhook_daemon.py` / `webhook_ingress.py` | AO SCM webhook plugin |
| `dispatch_task.py` | `ao spawn` directly |
| `reconciliation.py` (session monitoring part) | AO lifecycle-manager with bd-uxs.6 |

---

## Implementation Order (initial proposal)

```
bd-uxs.1  Fix workspace dirty bug           ← unblocks AO on jleechanclaw
  │
bd-uxs.6  Session exit reconciliation       ← foundational: know when work is done
  │
bd-uxs.3  Failure budgets + escalation      ← smarter retry logic
  │
bd-uxs.2  PR poller plugin                  ← autonomous initiation loop
  │
bd-uxs.5  Outcome recorder + synthesizer    ← prerequisite for parallel retry
  │
bd-uxs.4  Parallel retry action             ← highest complexity, highest leverage
```

---

## Implementation Order (confirmed 2026-03-17)

**bd-uxs.1 → bd-uxs.6 → bd-uxs.2 → bd-uxs.3 → bd-uxs.4 → bd-uxs.5 → bd-uxs.7 → bd-uxs.8**

Rationale (from jclaw review):
- bd-uxs.6 before bd-uxs.2: the poller needs to distinguish "session killed because done" from "session killed because stuck" — exit reconciliation is foundational
- bd-uxs.3 can land after bd-uxs.2: existing `retries` + `escalateAfter` is good enough for v1 poller
- bd-uxs.7 and bd-uxs.8 are low-urgency polish

## Architectural Decisions (jclaw review 2026-03-17)

### bd-uxs.2 — PR Poller
- **Separate plugin**, not a lifecycle-worker extension (different polling interval ~5min vs 30s, different concern)
- Must include **respawn cap**: max 10 spawns per PR per 12h window (from ao-pr-poller.sh experience)
- Config via `reactions["pr-needs-work"]` with a `poll-and-spawn` action type

### bd-uxs.3 — Failure Budgets
- **Core change** (not plugin): `failureBudget` + `onBudgetExhausted` as optional fields on `ReactionConfig` in `types.ts`
- `FailureBudgetTracker` alongside existing `reactionTrackers` in `lifecycle-manager.ts` — same pattern
- Backwards-compatible: optional fields, existing reactions unaffected

### bd-uxs.7 — Porcelain Ignore List
- jclaw note: bd-uxs.1 fixes the known symptom, but any future setup step that writes a new file will re-introduce the bug
- Solution: `.ao-managed` annotation or ignore list in the worktree cleanliness check

---

## Upstream vs Fork

| Change | Upstream (ComposioHQ) | Fork only |
|---|---|---|
| bd-uxs.1 Workspace dirty fix | ✅ Yes — general bug | |
| bd-uxs.2 PR poller | ✅ Yes — general capability | |
| bd-uxs.3 Failure budgets | ✅ Yes — general improvement | |
| bd-uxs.4 Parallel retry | ✅ Yes — general capability | |
| bd-uxs.5 Outcome learning | ✅ Yes — opt-in via config | |
| bd-uxs.6 Exit reconciliation | ✅ Yes — general improvement | |
| bd-uxs.7 .ao-managed ignore list | ✅ Yes — porcelain regression guard | |
| bd-uxs.8 Merge-gate hook | ✅ Yes — opt-in via config | |

All are general enough to upstream to ComposioHQ. None depend on jleechanclaw-specific infrastructure.
