Here is a draft plan to refine:

# Adversarial Validation Phases

## Context

Autonomous agents produce better work when a second, independent agent critiques them at
checkpoint boundaries. The literature on multi-agent coding consistently finds that a
"critic" pattern (different agent, different prompt, stateless review) catches
plan-level errors and subtle code defects that a single-agent loop misses.

Today, an AO session is single-agent end-to-end: the session's `metadata["agent"]` is
written once at spawn time in `session-manager.ts:1169` and never mutated. There is no
planning checkpoint, no handoff protocol, and the only review mechanism is human PR
review via the SCM plugin. The primitives we need already exist — we just have to wire
them into a new session lifecycle.

**Goal:** add an optional YAML-configurable feature where, within a single AO session, a
primary agent (e.g. claude-code) and a critic agent (e.g. codex) alternate across
phases: **plan → critique → refine → implement → critique → refine**. The primary
resumes its conversation across swaps; the critic is always fresh. Context crosses
swaps via files in `.ao/adversarial/`. Loops terminate after a fixed `maxRounds` (user's
chosen convergence model).

**Non-goals (v1):** parallel review sessions, verdict-driven convergence, automated PR
review, cross-agent conversation-history mirroring.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Plan artifact source | Add **explicit planning phase**, opt-in via YAML (user answer) | Existing plan-mode outputs are inconsistent across agents; a dedicated phase gives us a stable artifact on disk |
| Where critic runs | **Same session, agent swap** (user answer) | Single session to track; shared worktree; reuses activity/metadata infra |
| Convergence | **Fixed `maxRounds`, then proceed** (user answer) | Simple, predictable cost |
| Handoff medium | **Worktree artifacts + primary resume** (user answer) | Files are agent-agnostic; resume keeps primary's history |
| Agent swap mechanism | Destroy current `RuntimeHandle`, launch new one with same `workspacePath` | Reuses existing tmux `destroy()` + `launch()` — no new tmux respawn-pane code needed |
| New lifecycle states | Add `planning` + `reviewing` to `SessionStatus` | Makes phases visible in dashboard/kanban; lifecycle polling can hook off them |
| Phase progression within `reviewing` | Metadata key `adversarialPhase: "plan_review" \| "code_review"` | Keeps enum small; discriminated by metadata |
| Round tracking | Metadata keys `adversarialRound`, `adversarialMaxRounds` | Ephemeral counters don't belong in the type system |

## State Machine

```
spawning ──► planning ──┐
                        │  (primary writes .ao/adversarial/plan.md, goes idle)
                        ▼
                   reviewing (plan_review)
                        │  (critic writes plan.critique.md, goes idle)
                        ▼
              round < maxRounds ? planning : working
                        │  (primary implements, goes idle or opens PR)
                        ▼
                   reviewing (code_review)
                        │  (critic writes code.critique.md, goes idle)
                        ▼
              round < maxRounds ? working : pr_open
```

Phase transitions fire from the lifecycle polling loop on the existing
`ActivityState = ready|idle` signal — we do NOT invent a new "finished" detector.
When primary/critic goes ready/idle AND the expected artifact file exists, the
orchestrator swaps agents.

## File Layout (workspace, gitignored)

```
.ao/adversarial/
  plan.md                    # written by primary in `planning`
  plan.critique.md           # written by critic in `reviewing` (plan_review)
  code.critique.md           # written by critic in `reviewing` (code_review)
  progress.md                # agent-written cumulative progress log (all phases append)
  round.json                 # {phase, round, updatedAt} — orchestrator-managed (JSON = tamper-resistant)
```

Add `.ao/` to the workspace `.gitignore` if not already present (the existing
`.ao/activity.jsonl` convention already implies this).

## YAML Config Schema

Add to `ProjectConfigSchema` in `packages/core/src/config.ts`:

```yaml
projects:
  my-app:
    agent: claude-code
    adversarialReview:
      enabled: false              # opt-in, default off
      critic:
        agent: codex              # required when enabled
        agentConfig: { model: "...", permissions: "..." }   # optional overrides
      plan:
        enabled: true             # run plan-review loop
        maxRounds: 2
      code:
        enabled: true             # run code-review loop before opening PR
        maxRounds: 1
```

Zod shape:
```ts
adversarialReview: z.object({
  enabled: z.boolean().default(false),
  critic: z.object({
    agent: z.string(),
    agentConfig: AgentConfigSchema.optional(),
  }),
  plan: z.object({ enabled: z.boolean().default(true), maxRounds: z.number().int().min(1).default(2) }).optional(),
  code: z.object({ enabled: z.boolean().default(true), maxRounds: z.number().int().min(1).default(1) }).optional(),
}).optional(),
```

## Prompt Scaffolding

Add a new layer to `packages/core/src/prompt-builder.ts` — `buildPhasePrompt(phase, session)` — that returns the per-phase prompt appended on top of the existing 3 layers.

**Improvement (from Anthropic "Effective Harnesses" blog):** Critic prompts include explicit startup rituals — read git log, read prior artifacts, orient before critiquing. Working prompts include a test checkpoint before implementation. All phases write to `progress.md` for cumulative tracking.

| Phase / role | Prompt highlights |
|---|---|
| `planning` (primary, round 0) | "Draft an implementation plan for this task. Write it to `.ao/adversarial/plan.md`. Cover: approach, files to modify, edge cases, test strategy. Do not write any code yet. Update `.ao/adversarial/progress.md` with what you accomplished. Exit when the plan is complete." |
| `planning` (primary, round > 0) | Adds: "A critique of your previous plan has been written to `.ao/adversarial/plan.critique.md`. Read it and produce a revised `plan.md`. Update `progress.md` with what you changed and why." |
| `plan_review` (critic, always fresh) | **Startup ritual:** "1. Run `git log --oneline -20`. 2. Read `.ao/adversarial/plan.md` thoroughly. 3. Read the issue description for requirements context." **Then:** "Write a structured critique to `.ao/adversarial/plan.critique.md` — missing requirements, risky assumptions, simpler alternatives, test gaps. Be concrete — cite specific sections. Do not modify `plan.md`. Update `progress.md`. Exit." |
| `working` (primary, implement) | Existing working prompt + "Follow `.ao/adversarial/plan.md`." + **Test checkpoint:** "Before writing code, run the existing test suite to establish a baseline. Note any pre-existing failures." + "Update `progress.md` as you complete each section." |
| `code_review` (critic, always fresh) | **Startup ritual:** "1. Run `git log --oneline -20`. 2. Run `git diff main...HEAD`. 3. Read `.ao/adversarial/plan.md`. 4. Read `.ao/adversarial/progress.md`." **Then:** "Critique for bugs, security issues, test coverage, deviations from plan, performance. Write to `.ao/adversarial/code.critique.md`. Cite file paths and line numbers. Do not modify any source files. Update `progress.md`. Exit." |
| `working` (primary, refine after code review) | "A code review has been written to `.ao/adversarial/code.critique.md`. Read it and apply the fixes." + **Test checkpoint:** "Run tests before making changes to confirm current state." + "Update `progress.md` with what you fixed." |

## Agent Swap Mechanics

New function in `packages/core/src/session-manager.ts`:

```ts
async swapAgent(
  sessionId: SessionId,
  projectId: ProjectId,
  nextAgent: string,
  opts: { resume: boolean; phasePrompt: string },
): Promise<void>
```

Implementation:
1. Load session + metadata.
2. `runtime.destroy(session.runtimeHandle)` — tears down the tmux session.
3. Resolve next agent via `resolveAgentSelection({ spawnAgentOverride: nextAgent, ... })`.
4. If `opts.resume` and the next agent is the primary (`adversarialPrimary === nextAgent`) and the primary plugin exposes `getRestoreCommand`, use it with the stored native session id; else call `getLaunchCommand` fresh.
5. Assemble prompt via `buildPrompt(...) + opts.phasePrompt`.
6. `runtime.launch(command, workspacePath, env)` → new `RuntimeHandle`.
7. Persist `metadata["agent"] = nextAgent`, update `runtimeHandle` on the session record, bump `adversarialRound` / `adversarialPhase`.
8. Emit a `agent-swapped` session event for the dashboard SSE stream.

Critically: the AO `sessionId` is **unchanged**, the workspace is **unchanged**, the dashboard keeps the same session row. Only the in-tmux process identity changes.

## Lifecycle Manager Hook

In `packages/core/src/lifecycle-manager.ts` polling loop:

```ts
if (session.status === "planning" || session.status === "reviewing") {
  const activity = await agent.getActivityState(session, ...);
  if (activity?.state === "idle" || activity?.state === "ready") {
    await advanceAdversarialPhase(session);  // new helper — decides next phase + calls swapAgent
  }
}
```

`advanceAdversarialPhase` is the state-machine table:

| Current status | Current phase | Artifact present? | Round vs cap | Next action |
|---|---|---|---|---|
| planning | — | plan.md | round < maxRounds | → reviewing (plan_review), swap to critic |
| planning | — | plan.md | round == maxRounds | → working, swap to primary (resume), implement prompt |
| planning | — | plan.md missing | — | → stuck (primary didn't produce plan) |
| reviewing | plan_review | plan.critique.md | round < maxRounds | → planning, swap to primary (resume), refine prompt; bump round |
| reviewing | plan_review | plan.critique.md | round == maxRounds | → working, swap to primary (resume), implement prompt |
| working | — | detected PR push OR idle with commits | round < codeMaxRounds | → reviewing (code_review), swap to critic |
| working | — | idle, no commits, not at max | — | leave alone (existing stuck detection applies) |
| reviewing | code_review | code.critique.md | round < maxRounds | → working, swap to primary, refine prompt; bump round |
| reviewing | code_review | code.critique.md | round == maxRounds | → working, normal flow; PR open proceeds |

## Required Plugin Work

- **agent-codex** (`packages/plugins/agent-codex/src/index.ts`): add `getRestoreCommand` so codex can be primary too. Not a blocker for v1 if we document "primary must be claude-code in v1".
- **agent-claude-code**: no changes (already has resume).
- **runtime-tmux**: no changes — `destroy()` + `launch()` sequence is sufficient.

## Files to Modify

| File | Change |
|---|---|
| `packages/core/src/types.ts:28-45` | Add `"planning"` and `"reviewing"` to `SessionStatus`; add `adversarialPhase`, `adversarialRound`, `adversarialMaxRounds` to the metadata type |
| `packages/core/src/config.ts` | Add Zod `adversarialReview` block to `ProjectConfigSchema` |
| `packages/core/src/session-manager.ts` (~+180 LOC) | New `swapAgent()`; teach `spawn()` to start in `planning` when `adversarialReview.enabled && plan.enabled` |
| `packages/core/src/lifecycle-manager.ts` (~+120 LOC) | New `advanceAdversarialPhase()` helper + polling-loop hook; extend `executeReaction` is NOT needed |
| `packages/core/src/prompt-builder.ts` (~+100 LOC) | New `buildPhasePrompt()` with per-phase templates |
| `packages/core/src/index.ts` | Export new helpers + types |
| `packages/plugins/agent-codex/src/index.ts` | Optional: add `getRestoreCommand` |
| `packages/web/src/lib/types.ts` | Add `"planning"` and `"reviewing"` to `SessionStatus` |
| `packages/web/src/lib/phases.ts:12-37` | Place `planning` + `reviewing` into the `prePr` lane; add labels + colors in `PHASE_LABELS` and `getPhaseStatusColor` |
| `packages/web/src/components/SessionCard.tsx` | Render a small "round k/N" pill when `metadata.adversarialRound` is set |
| `packages/core/src/__tests__/adversarial.test.ts` (new) | Unit-test `advanceAdversarialPhase` transition table and `swapAgent` round bookkeeping with mocked runtime |
| `docs/config.md` or equivalent | Document the `adversarialReview` YAML block |

Reusable primitives to wire in (no new code needed):
- `resolveAgentSelection({ spawnAgentOverride })` — `packages/core/src/agent-selection.ts:32`
- `writeMetadata` / `readMetadata` in `session-manager.ts`
- `Runtime.destroy()` + `Runtime.launch()` from the tmux plugin
- `agent.getRestoreCommand()` on claude-code plugin — `packages/plugins/agent-claude-code/src/index.ts:803`
- `getActivityState()` idle detection — already the lifecycle loop's heartbeat

## Verification

1. **Unit tests** (`pnpm --filter @aoagents/ao-core test`)
   - `advanceAdversarialPhase` returns the correct next action for every row of the transition table
   - `swapAgent` persists new agent name and preserves `sessionId` + `workspacePath`
   - Config parser accepts/rejects the new YAML block correctly

2. **Type checking** (`pnpm typecheck`) — new `SessionStatus` values propagate everywhere (compiler will catch missed switch branches)

3. **End-to-end smoke test**, against a scratch repo:
   - Create `agent-orchestrator.yaml` with `adversarialReview.enabled: true`, claude-code as primary, codex as critic, plan.maxRounds=2, code.maxRounds=1
   - `pnpm dev`, spawn a session with a simple issue ("add a /health endpoint")
   - Observe: session enters `planning` → `.ao/adversarial/plan.md` appears → session enters `reviewing` → tmux shows codex running → `plan.critique.md` appears → session returns to `planning` (round 1) → revised plan → `reviewing` again → `working` → implementation → `reviewing` (code_review) → `code.critique.md` → back to `working` → PR opens
   - Dashboard `/phases` view shows the session in the `prePr` lane throughout and displays the round pill

4. **Disable-path test**: set `adversarialReview.enabled: false`, spawn a session, verify the session goes straight to `working` with zero regression vs today's behavior.

## Improvements Over Initial Design

Based on analysis of Anthropic's ["Effective Harnesses for Long-Running Agents"](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents):

| Blog Finding | Spec Improvement |
|---|---|
| Agents produce better output when explicitly told to read context before acting | Critic prompts now include **startup rituals**: `git log`, read plan, read issue — before critiquing |
| Agents should verify codebase works before starting new work | `working` phase prompts include a **test checkpoint**: "run existing tests to establish baseline" |
| Structured progress files prevent agents from losing context across sessions | Added `progress.md` — **agent-written cumulative log** updated every phase |
| JSON artifacts are harder for agents to inappropriately modify than Markdown | `round.json` remains **orchestrator-managed JSON** for machine state; `.md` only for prose agents should edit |
| "One-shotting" is the #1 failure mode — agents try to do everything at once | Phased structure with `maxRounds` caps naturally scopes each agent invocation |
| Blog is agnostic on multi-agent critic patterns (listed as "future research") | Critic pattern is justified by multi-agent coding literature, not the blog — blog validates our harness mechanics |

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Claude Code `--resume` fails after tmux tear-down | Capture the native session id BEFORE destroy (it's already in `metadata["claudeSessionId"]`); fall back to fresh launch with `plan.md` as context if resume errors |
| Primary writes `plan.md` and keeps working instead of exiting | Phase-prompt instructs "exit when done"; lifecycle polls for idle; if not idle within a `phaseTimeoutMs` we fall back to `stuck` using the existing stuck-detection path |
| Agent-swap races the activity-log (stale `.ao/activity.jsonl` entries leak across agents) | On swap, rotate the log: rename `activity.jsonl` to `activity.{previous-agent}.jsonl` so each agent starts fresh |
| Critic fabricates critique without reading plan | Prompt includes explicit read-file tool call; v1 accepts this risk since cost of a bad critique is only wasted rounds (capped) |
| Codex as primary requires resume support it doesn't have | v1: document that primary must be claude-code; file follow-up issue for codex `getRestoreCommand` |