# Real-agent AO E2E Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a repository-local skill that runs and diagnoses real AO orchestrator, worker, and reviewer agents against a notification-icon change task.

**Architecture:** A Node.js CLI runner will use only the verified `ao` CLI, bounded polling, and JSON evidence. `SKILL.md` will provide the live-run contract, manual diagnostics, and explicit observed/failed/unobservable semantics; picker metadata will expose the skill.

**Tech Stack:** Node.js ESM, AO CLI/daemon, shell commands, JSON reports, Markdown skill metadata.

## Global Constraints

- Use a real supplied harness for the acceptance path; do not silently substitute fakes.
- Use AO CLI/daemon boundaries only; do not read SQLite or call internal packages from the runner.
- Verify the AO binary/daemon before trusting output.
- Use bounded polling and never infer death from an unknown runtime probe alone.
- Cleanup is opt-in and limited to resources created by the run; never force-delete dirty registered worktrees.
- Do not commit credentials, local run state, reports, worktrees, or build outputs.

---

### Task 1: Build the live runner

**Files:**
- Create: `.agents/skills/ao-agent-e2e/scripts/run_agent_e2e.mjs`

**Interfaces:**
- Consumes: `--project`, `--harness`, optional role harnesses, `--task`, `--ao`, `--report`, polling timeout flags, and `--cleanup`.
- Produces: exit `0` for all observable assertions passing, exit `1` for a failed assertion, exit `2` for invalid preflight/configuration; JSON report with stage records, IDs, observed state, and failure reason.

- [ ] **Step 1: Write the runner’s command parser and report model**

Implement `parseArgs(argv)` with defaults for the canonical task, `/tmp/ao`/`AO_BIN` resolution, report path, and bounded polling. Reject missing project/harness and unknown flags with exit code 2. Define `stage(name, fn)` so every stage records timestamps, command metadata, stdout/stderr, and one of `passed`, `failed`, or `unobservable`.

- [ ] **Step 2: Implement safe CLI execution and polling**

Use `child_process.spawn` with argument arrays and captured output. Add `runAo(args)` and `poll(label, read, predicate, timeoutMs, intervalMs)`; timeout errors must include the last observed JSON/text. Never shell-interpolate task text or credentials.

- [ ] **Step 3: Implement preflight and lifecycle stages**

Run verified `ao version`, `ao status`, project inspection, and harness-aware spawn checks. Spawn the orchestrator and worker through `ao spawn`, record session IDs, poll `ao session get --json`/conversation endpoints exposed by the CLI, and preserve all command evidence. Use role-specific harness overrides when provided.

- [ ] **Step 4: Implement task, worktree, Kanban, PR, and reviewer assertions**

Inspect observable session JSON/conversation output for task text and AO role markers. Resolve the worker worktree/branch from session JSON, verify the requested notification-icon change and relevant checks with read-only git/filesystem commands, sample activity/tracker status, detect the worker PR, then spawn or claim the reviewer and verify review context/result. Mark inaccessible provider/system-prompt facts `unobservable` instead of passing them.

- [ ] **Step 5: Implement report output and opt-in cleanup**

Write the report atomically to the requested path, print a concise summary, and clean only recorded test-created resources when `--cleanup` is set. Do not kill or delete sessions/worktrees by default. Return the documented exit code.

- [ ] **Step 6: Validate the runner without live agent side effects**

Run `node --check .agents/skills/ao-agent-e2e/scripts/run_agent_e2e.mjs` and the runner’s `--help`/invalid-argument paths. Confirm no report, credentials, or worktree is created by validation.

### Task 2: Package the skill and diagnostics

**Files:**
- Create: `.agents/skills/ao-agent-e2e/SKILL.md`
- Create: `.agents/skills/ao-agent-e2e/agents/openai.yaml`

**Interfaces:**
- Consumes: the runner contract from Task 1 and existing AO CLI commands documented under `backend/internal/skillassets/using-ao/`.
- Produces: discoverable skill instructions for live execution and manual diagnosis.

- [ ] **Step 1: Write trigger metadata and live-run instructions**

Document that the skill is used for real-agent AO E2E testing, show the canonical notification-icon task, list required harness/project/configuration inputs, and provide the runner command with report and timeout examples.

- [ ] **Step 2: Document evidence and failure diagnosis**

Add stage-by-stage pass criteria for orchestrator startup, prompt/task delivery, worker placement/activity, Kanban alignment, PR handoff, and reviewer result. Provide commands for `ao status`, `ao session ls/get`, `ao orchestrator ls`, project/session inspection, worktree/git evidence, and review inspection. Explicitly distinguish observed, failed, and unobservable claims.

- [ ] **Step 3: Add picker metadata**

Create `agents/openai.yaml` with deterministic display name, short description, and default prompt matching the skill’s trigger and canonical scenario.

- [ ] **Step 4: Validate packaging and scope**

Run the skill creator validator if available, inspect YAML/Markdown frontmatter, run the runner syntax/help checks, and verify `git status` contains only the new skill files plus the already-existing unrelated user changes.

## Self-review checklist

- The runner task covers preflight, real spawning, observation limits, worktree/SCM evidence, Kanban sampling, reviewer handoff, reporting, and cleanup.
- The packaging task covers the manual playbook and skill-picker metadata.
- No task relies on an undefined helper or an unbounded wait.
- No credentials or external state are required for syntax/help validation.
