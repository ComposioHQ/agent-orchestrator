# Pre-PR Quality Pipeline — Design Document

**Date**: 2026-03-03
**Status**: Design approved

## Problem

Agents open PRs with no quality gate. Code may not compile, tests may be missing, obvious issues go unreviewed. Humans have to manually review every agent PR — or depend on GitHub Actions/external review bots. This defeats the "push, not pull" principle.

## Solution

A 4-stage pre-PR pipeline that runs **locally** before any PR is created. The pipeline ensures that by the time a PR opens, the code compiles, has tests, passes all checks, and has been reviewed by a separate Claude Code session.

PRs become a signal of "ready to merge", not "please start reviewing."

## Pipeline

```
Agent finishes coding (has commits, idle on branch, no PR)
        │
        ▼
    ┌─────────────────────────────────┐
    │  ① AUTOMATED CHECKS             │
    │  typecheck · lint · existing     │
    │  tests                           │
    │  (no agent session needed)       │
    └──────────┬──────────────────────┘
               │
          FAIL │──── send errors to coder ──→ coder fixes ──→ retry ①
               │
          PASS ▼
    ┌─────────────────────────────────┐
    │  ② TEST AGENT                    │
    │  Separate Claude Code session    │
    │  Reads diff · writes unit tests  │
    │  Writes e2e tests · runs all     │
    └──────────┬──────────────────────┘
               │
     BUGS FOUND│──── send failures to coder ──→ coder fixes ──→ retry ①
               │
      ALL PASS ▼
    ┌─────────────────────────────────┐
    │  ③ REVIEW AGENT                  │
    │  Separate Claude Code session    │
    │  Reviews code + tests together   │
    │  Quality · patterns · security   │
    │  Edge cases · test adequacy      │
    └──────────┬──────────────────────┘
               │
          FAIL │──── send feedback to coder ──→ coder iterates ──→ retry ①
               │
       APPROVE ▼
    ┌─────────────────────────────────┐
    │  ④ OPEN PR                       │
    │  Agent opens PR with clean code  │
    │  + tests, already reviewed       │
    └─────────────────────────────────┘
```

## Lifecycle State Machine

New states in the pre-PR loop:

```
working → checking → testing → reviewing → pr_open → ...existing flow...
             ▲          │          │
             └──────────┴──────────┘  (any failure loops back through working → checking)
```

| State | Meaning | Transition |
|-------|---------|------------|
| `working` | Agent is coding | → `checking` when agent idle with commits |
| `checking` | Running typecheck/lint/tests | → `testing` on pass, → `working` on fail |
| `testing` | Test agent writing + running tests | → `reviewing` on pass, → `working` on fail |
| `reviewing` | Review agent examining code + tests | → `pr_open` on approve, → `working` on fail |
| `pr_open` | PR created, entering existing flow | (existing states from here) |

## Stage Details

### Stage 1: Automated Checks

**Trigger**: Lifecycle manager detects agent is idle with new commits on branch, no PR.

**Mechanism**: Run shell commands directly — no agent session needed:
```bash
pnpm typecheck 2>&1
pnpm lint 2>&1
pnpm test 2>&1
```

**On failure**: Send the error output to the original agent via `sessionManager.send()`:
```
Typecheck failed. Fix these errors before proceeding:

<error output>
```

**On success**: Advance to stage 2.

**Config**: Commands are per-project in `agent-orchestrator.yaml`:
```yaml
projects:
  dashboard:
    checks:
      - pnpm typecheck
      - pnpm lint
      - pnpm test
```

### Stage 2: Test Agent

**Trigger**: Stage 1 passes.

**Mechanism**: Spawn a new Claude Code session with a test-writing prompt. Uses the same project config and checks out the same branch.

**Prompt template** (configurable):
```
You are a test engineer. Write tests for the changes on this branch.

1. Read the diff against main:
   git diff origin/main...HEAD

2. Identify what changed — new functions, modified behavior, new endpoints.

3. Write unit tests for:
   - New functions and methods
   - Edge cases and error paths
   - Boundary conditions

4. Write e2e/integration tests for:
   - New user-facing behavior
   - API endpoint changes
   - Workflow changes

5. Run all tests: pnpm test

6. If tests reveal bugs in the implementation, document them clearly.

7. Commit your tests and exit.
```

**On test failures that reveal bugs**: Send bug details to the original agent. Agent fixes, loop back to stage 1.

**On all tests passing**: Test agent commits tests to the branch, exits. Advance to stage 3.

**Workspace**: The test agent gets its own worktree on the same branch. After it commits tests, the original agent's workspace needs to pull those commits (or the orchestrator handles the merge).

### Stage 3: Review Agent

**Trigger**: Stage 2 passes (test agent committed tests, all pass).

**Mechanism**: Spawn another Claude Code session with a review prompt.

**Prompt template** (configurable):
```
You are a senior code reviewer. Review the changes on this branch.

1. Read the full diff: git diff origin/main...HEAD
2. Review for:
   - Correctness and edge cases
   - Security (injection, auth, input validation, OWASP top 10)
   - Error handling (are errors caught? do they propagate correctly?)
   - Code style and project conventions (see CLAUDE.md)
   - Test quality — do the tests verify the right behavior?
   - Performance — any obvious N+1 queries, memory leaks, etc.
3. Write a structured review with:
   - APPROVE if the code is ready
   - REQUEST_CHANGES with specific, actionable feedback per file

Write your verdict to /tmp/review-<session-id>.json:
{
  "verdict": "approve" | "request_changes",
  "comments": [
    { "file": "path/to/file.ts", "line": 42, "comment": "..." }
  ],
  "summary": "Overall assessment"
}

Then exit.
```

**On request_changes**: Send the review comments to the original agent:
```
Code review feedback — address these before opening a PR:

<formatted comments>
```
Agent iterates, loop back to stage 1.

**On approve**: Advance to stage 4. Send approval message to original agent.

**Workspace**: Reviewer gets a read-only worktree (or clone) of the branch. Doesn't need write access.

### Stage 4: Open PR

**Trigger**: Review agent approved.

**Mechanism**: Send message to original agent:
```
Your code has been reviewed and approved. Open a PR now.

Summary from reviewer: <review summary>
```

The agent runs `gh pr create`, which triggers the existing webhook flow for post-PR lifecycle (CI, human review if configured, merge).

## Communication Between Agents

All inter-agent communication goes through the orchestrator — agents never talk directly:

```
┌──────────┐                    ┌──────────────┐
│  Coder   │◄──── feedback ─────│              │
│  Agent   │                    │ Orchestrator │
└──────────┘                    │ (lifecycle   │
                                │  manager)    │
┌──────────┐                    │              │
│  Test    │──── results ──────►│              │
│  Agent   │                    │              │
└──────────┘                    │              │
                                │              │
┌──────────┐                    │              │
│  Review  │──── verdict ──────►│              │
│  Agent   │                    │              │
└──────────┘                    └──────────────┘
```

- Coder → Orchestrator: metadata (branch, commits, idle status)
- Orchestrator → Coder: error output, test failures, review feedback
- Orchestrator → Test Agent: spawn with prompt
- Test Agent → Orchestrator: test results (committed tests + exit status)
- Orchestrator → Review Agent: spawn with prompt
- Review Agent → Orchestrator: verdict file + exit status

## Output Mechanism

Test agent and review agent write structured output to a known location:
- Test results: committed to branch (tests are code, they belong in the repo)
- Review verdict: written to `/tmp/review-<session-id>.json` or session metadata

The lifecycle manager reads these after the agent exits and routes accordingly.

## Configuration

```yaml
# agent-orchestrator.yaml
pipeline:
  # Enable/disable stages
  checks: true          # Stage 1: automated checks
  testing: true         # Stage 2: test agent
  review: true          # Stage 3: review agent

  # Per-project check commands
  checkCommands:
    - pnpm typecheck
    - pnpm lint
    - pnpm test

  # Test agent config
  testAgent:
    agent: claude-code
    model: opus                    # Opus for all agents
    promptFile: .ao/test-prompt.md # Custom prompt (optional)
    maxIterations: 3               # Max test→fix loops

  # Review agent config
  reviewAgent:
    agent: claude-code
    model: opus                    # Opus for all agents
    promptFile: .ao/review-prompt.md
    maxIterations: 2               # Max review→fix loops

  # Max total pipeline iterations before escalating to human
  maxPipelineIterations: 5
```

## Session Metadata

Review and test sessions need to be distinguishable from working sessions:

```
# Original coder session
role=coder
branch=feat/DSH-123-add-auth
status=working

# Test agent session
role=tester
parentSession=<coder-session-id>
branch=feat/DSH-123-add-auth
status=working

# Review agent session
role=reviewer
parentSession=<coder-session-id>
branch=feat/DSH-123-add-auth
status=working
```

The `parentSession` field links test/review sessions back to the original. Correlation logic in webhook-github should prefer `role=coder` sessions when routing events.

## Iteration Limits

To prevent infinite loops:
- Each stage has a `maxIterations` config (default: 3 for tests, 2 for review)
- A global `maxPipelineIterations` caps total cycles (default: 5)
- When limits are hit → escalate to human via notifier:
  ```
  Pipeline for DSH-123 stuck after 5 iterations.
  Last failure: review agent requested changes (security concern in auth.ts:42)
  ```

## What Changes

### New files
```
packages/core/src/pipeline-manager.ts         — orchestrates the 4-stage pipeline
packages/web/src/app/api/internal/review/route.ts  — spawn review session API
```

### Modified files
```
packages/core/src/types.ts                    — new SessionStatus values, pipeline config types
packages/core/src/lifecycle-manager.ts        — detect "ready for checking" transition, wire pipeline
packages/core/src/session-manager.ts          — support role metadata, parentSession linking
agent-orchestrator.yaml                       — pipeline config section
```

### Unchanged
- Agent plugins (claude-code, etc.) — we use existing spawn with different prompts
- SCM/webhook plugins — no GitHub review API needed
- Runtime/workspace plugins — standard spawn flow

## Design Decisions

1. **Workspace sharing**: Test agent commits directly to the coder's branch. Coder pulls before continuing. Simpler than temp branches.

2. **Model**: Opus for all agents (coder, tester, reviewer). Quality over cost.

3. **Parallelism**: Sequential — reviewer sees tests. Test agent runs first, reviewer second.

4. **Human override**: `ao spawn --skip-pipeline` or per-stage flags (`--skip-review`, `--skip-tests`) for quick fixes. Pipeline config also supports disabling stages globally.
