# Adversarial Review

Optional multi-agent plan/code review within a single session. A primary agent drafts and implements; a critic agent reviews at checkpoints.

## Configuration

```yaml
projects:
  my-app:
    agent: claude-code
    adversarialReview:
      enabled: true
      critic:
        agent: codex
        agentConfig:           # optional overrides for critic
          model: "o3"
          permissions: "permissionless"
      plan:
        enabled: true          # run plan-review loop (default: true)
        maxRounds: 2           # plan/critique cycles (default: 2)
      code:
        enabled: true          # run code-review before PR (default: true)
        maxRounds: 1           # code/critique cycles (default: 1)
```

## How It Works

When `adversarialReview.enabled` is true, sessions follow this lifecycle:

```
spawning -> planning -> reviewing (plan_review) -> planning (revised) -> ... -> working -> reviewing (code_review) -> working (refine) -> pr_open -> ...
```

1. **Planning:** Primary agent writes `.ao/adversarial/plan.md`
2. **Plan Review:** Critic agent writes `.ao/adversarial/plan.critique.md`
3. **Refine:** Primary revises plan (repeats for `plan.maxRounds`)
4. **Implementation:** Primary implements the plan
5. **Code Review:** Critic reviews the diff, writes `.ao/adversarial/code.critique.md`
6. **Fix:** Primary addresses critique (repeats for `code.maxRounds`)
7. Normal PR flow continues

### Phase transitions

The lifecycle manager detects when an agent goes idle with the expected artifact file present, then swaps agents automatically. The AO session ID, workspace, and branch are preserved across swaps.

### File layout

All adversarial artifacts live in `.ao/adversarial/` (gitignored):

```
.ao/adversarial/
  plan.md              # primary writes during planning
  plan.critique.md     # critic writes during plan review
  code.critique.md     # critic writes during code review
  progress.md          # cumulative log, updated by all phases
  round.json           # orchestrator-managed state (JSON)
```

## Constraints

- Primary must be `claude-code` in v1 (resume support required)
- Critic can be any agent (codex recommended: stateless, fast)
- `maxRounds` caps cost: rounds are fixed, not verdict-driven
- When disabled (default), sessions behave identically to before
