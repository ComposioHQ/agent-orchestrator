 # Real-agent AO end-to-end testing skill

 ## Goal

 Add a repository-local skill at `.agents/skills/ao-agent-e2e/` for testing AO with real agent harnesses. It has two layers:

 1. A repeatable live runner that produces machine-readable evidence and pass/fail results.
 2. A manual diagnostic playbook for inspecting failures that cannot be established from one CLI result.

 The default scenario is a real orchestrator delegating this task to a real worker:

 > Change the background color of the notification icon to red. Implement the change, run the relevant checks, open a PR, and wait for review.

 The caller supplies the harness and any required credentials/configuration. The skill must not silently substitute fake agents for the acceptance path.

 ## Scope and boundaries

 The runner exercises the existing AO CLI/daemon boundaries. It must use an explicitly verified AO binary and the project supplied by the caller, or a clearly named dedicated test project. It must not edit generated backend code, bypass the daemon with direct SQLite writes, or claim hidden provider state that AO cannot expose.

 Real SCM/tracker integrations are supported when configured. Live runs are opt-in and must make their target project, harness, branch/session names, timeout, and cleanup policy visible before spawning agents. Cleanup is limited to resources created by the run and is disabled by default unless explicitly requested.

 ## Runner contract

 `scripts/run_agent_e2e.mjs` accepts at least:

 - `--project <id>`: registered AO project to test.
 - `--harness <name>`: real harness passed to `ao spawn`.
 - `--task <text>`: task brief, defaulting to the notification-icon scenario.
 - `--orchestrator-harness <name>` and `--reviewer-harness <name>`: optional role-specific overrides.
 - `--report <path>`: JSON report destination.
 - bounded polling timeout options.
 - explicit `--cleanup` for test-created resources.

 The runner resolves the AO binary from `--ao`, `AO_BIN`, `/tmp/ao`, or `ao`, then verifies daemon health and records the version/endpoint. It invokes the thin CLI only; it does not open the database or call internal packages.

 Each stage records command, exit code, stdout/stderr, timestamps, session IDs, and relevant observed JSON. A run fails at the first unmet assertion while preserving later diagnostic evidence when available.

 ## End-to-end assertions

 The runner performs these bounded stages:

 1. **Preflight:** AO binary, daemon, project, harness availability, and target configuration are valid.
 2. **Orchestrator:** an orchestrator session starts and remains inspectable.
 3. **Prompt delivery:** the orchestrator’s observable session/conversation evidence contains the supplied task and the expected AO role/system-prompt markers. If the API does not expose the complete system prompt, report that limitation as `unobservable`, never as success.
 4. **Delegation:** a worker is spawned or delegated with the task; its session is associated with the intended project/section/worktree and receives the task in observable evidence.
 5. **Work execution:** the worker produces the requested notification-icon change in its own worktree and shows activity consistent with working, then checking, then waiting for review. File and git evidence are read from the worker worktree, not the controller checkout.
 6. **Kanban alignment:** tracker status and AO-derived activity state are sampled at transitions. The runner verifies allowed mappings and reports stale, contradictory, or unobservable states separately from hard failures.
 7. **PR handoff:** a PR is detected or claimed for the worker branch, with the expected worker/session ownership and changed file evidence.
 8. **Reviewer:** a reviewer session is spawned or claims the PR, receives the PR context, performs a review, and submits an observable review result through the supported AO route.
 9. **Final report:** all IDs, transitions, evidence paths, failed stage, reason, and cleanup outcome are emitted as JSON plus a concise terminal summary.

 The runner must use bounded polling with actionable timeout messages. It must not infer that an agent is dead from a failed or unknown runtime probe alone, and it must not force-delete dirty registered worktrees.

 ## Manual diagnostic playbook

 `SKILL.md` documents how to:

 - confirm the correct AO binary reports the repository daemon endpoint;
 - inspect `ao status`, `ao session ls/get`, `ao orchestrator ls`, and the project configuration;
 - inspect conversations/prompts/task delivery and distinguish a missing prompt from an API that does not expose it;
 - inspect the worker worktree, branch, changed notification-icon file, tests, and PR ownership;
 - compare activity and tracker/Kanban transitions over time;
 - inspect reviewer session state, claimed PR, review comments/result, and handoff errors;
 - preserve the JSON report and command output when escalating a failure.

 The playbook explicitly labels claims as observed, failed, or unobservable and gives stage-specific recovery guidance. It does not auto-retry destructive or externally visible actions.

 ## Skill packaging

 The skill contains only:

 - `SKILL.md` with trigger metadata, live-run workflow, assertion semantics, manual diagnosis, and cleanup rules;
 - `scripts/run_agent_e2e.mjs` for deterministic CLI orchestration and JSON reporting;
 - `agents/openai.yaml` for skill-picker metadata.

 It follows the existing `test-agent-restore` and `bug-triage` conventions, keeps the body concise, and uses repository-local paths. The runner is tested with syntax/help validation and a dry preflight that does not spawn agents; a real live run is performed only when a harness/project/credentials are supplied.

 ## Success criteria

 - The skill is discoverable from `.agents/skills/ao-agent-e2e/`.
 - A caller can select a real harness and run the canonical task with a JSON report.
 - Every requested assertion has an explicit observed/pass, failed, or unobservable outcome.
 - Failures identify the lifecycle stage and preserve enough evidence for manual diagnosis.
 - No credentials, local run state, generated outputs, or user worktrees are committed.
