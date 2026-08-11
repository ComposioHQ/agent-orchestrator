---
name: ao-agent-e2e
description: Run and diagnose live Agent Orchestrator end-to-end tests with real orchestrator, worker, and reviewer agents. Use when verifying system-prompt delivery, task delegation, worker placement/activity, Kanban alignment, PR handoff, or reviewer-agent behavior.
---

# AO real-agent E2E

Use this skill only with a real supplied harness. The canonical task is:

> Change the background color of the notification icon to red. Implement the change, run the relevant checks, open a PR, and wait for review.

The runner uses only the AO CLI and keeps a JSON evidence trail. It does not use fake agents, direct SQLite reads, or internal Go packages.

## Live run

Before spawning anything, state the project, orchestrator/worker/reviewer harnesses, timeout, report path, and cleanup policy. Verify the binary is this repository's AO build and that `ao status` reports the expected daemon endpoint (the local rewrite uses port 3001).

From the repository root:

```bash
node .agents/skills/ao-agent-e2e/scripts/run_agent_e2e.mjs \
  --project agent-orchestrator \
  --harness codex \
  --orchestrator-harness codex \
  --reviewer-harness claude-code \
  --report /tmp/ao-agent-e2e.json
```

Use `--ao /tmp/ao` or `AO_BIN` when a bare `ao` may resolve to another install. Use `--task` for a different brief. Use `--cleanup` only when it is safe to terminate sessions created by this run; it never force-deletes dirty worktrees.

The runner exits 0 only when no stage failed. Exit 1 means an observable assertion failed. Exit 2 means configuration or preflight could not start the test. `unobservable` is reported explicitly when the public CLI does not expose a fact; it is not a pass.

## What the runner checks

- Preflight: AO binary, daemon, project, and harness configuration.
- Orchestrator: real role spawn, live session, prompt/system-prompt byte evidence, and exact task visibility when exposed.
- Delegation: a new non-orchestrator worker appears in the target project after the orchestrator starts.
- Work/Kanban: session activity and status evidence; exact file and tracker checks are marked unobservable when session JSON does not expose a worktree/tracker fact.
- PR/reviewer: review records, latest review run, reviewer session ID, and review result when AO exposes them.

Keep the report. It records commands, exit codes, stdout/stderr, timestamps, IDs, observations, the first failed stage, and cleanup results.

## Manual diagnosis

Run these with the verified binary:

```bash
ao version
ao status
ao project get <project> --json
ao orchestrator ls --json
ao session ls --project <project> --all --json
ao session get <session-id> --json
ao review ls <worker-session-id> --json
```

Classify every finding:

- **Observed:** the command output or worker artifact directly proves it.
- **Failed:** an observable assertion contradicts the expected lifecycle.
- **Unobservable:** the current CLI/API does not expose the fact; do not infer it from spawn success.

For worker placement, inspect the worktree and branch recorded by AO, then verify the notification-icon diff and relevant frontend checks from that worktree. For Kanban alignment, capture tracker status and AO `activity.state` at each transition; do not treat a failed runtime probe as proof the worker is dead. For review, compare the worker PR owner, `ao review ls` latest run, reviewer session, submitted verdict, and any review comments.

## Failure interpretation

- `preflight`: wrong binary/daemon, missing project, missing credentials, or unsupported harness.
- `orchestrator`: role spawn, prompt construction, or session startup failure.
- `delegation-and-worker`: orchestrator did not produce an inspectable worker in the project before timeout.
- `work-and-kanban`: observable activity/status mismatch, or evidence is unavailable through the CLI.
- `pr-and-reviewer`: PR/review run/reviewer evidence missing or reviewer result not submitted.

Do not auto-retry externally visible actions. Do not kill or delete sessions unless the user explicitly selected cleanup. Escalate with the JSON report and the exact failed stage.
