# Agent Orchestrator Desktop Implementation Plan

## Document Control

- Owner: Engineering
- Status: Draft for alignment
- Last updated: 2026-02-22
- Related roadmap: `work-items/desktop-plan/roadmap.md`

## 1. Implementation Objectives

1. Keep all primary operations inside desktop UI:
- task operations,
- chat-driven command execution,
- terminal interaction,
- change review and apply.
2. Reuse existing AO core logic where possible (avoid full rewrite).
3. Enforce safety and observability for command execution.

## 2. Architecture Decisions

## ADR-1: Tauri host + Node sidecar

- Decision: use Tauri for desktop shell, keep orchestration logic in Node sidecar.
- Rationale: fastest path to reuse `packages/core` and plugin ecosystem.
- Consequence: sidecar process lifecycle must be managed by desktop host.

## ADR-2: Split control-plane and stream-plane

- Control-plane: Tauri `invoke` commands for deterministic actions.
- Stream-plane: WebSocket for terminal/log/event streams.
- Consequence: reconnection and sequence IDs are required for consistency.

## ADR-3: Terminal transport standard

- Use `node-pty` on sidecar + xterm in desktop UI.
- No external terminal app for primary workflow.
- Consequence: OS-specific PTY compatibility tests are mandatory.

## ADR-4: Change visibility before mutation

- Every generated patch/change must be visible in `Changes` panel first.
- Risky file paths require explicit confirmation.
- Consequence: apply pipeline includes policy guard and audit event.

## ADR-5: Desktop mode policy profile

- Desktop mode disables external terminal plugin paths for run/attach actions.
- Consequence: policies differ from web/CLI mode and must be explicit.

## ADR-6: Shell abstraction layer is mandatory

- Decision: all command execution goes through a single shell adapter API, never direct ad-hoc shell calls from UI handlers.
- Rationale: quoting, encoding, signal handling, and cwd behavior differ heavily across `powershell.exe`, `cmd.exe`, `Git Bash`, `WSL`.
- Consequence: shell-specific logic is centralized, testable, and policy-enforced.

## 3. System Components

| Component | Responsibility |
| --- | --- |
| Tauri Host | App shell, native windowing, sidecar lifecycle, secure IPC bridge |
| Desktop UI (React) | Tasks, Chat, Terminal, Changes views; interaction state |
| Node Sidecar | Command handlers, session orchestration, streaming adapters |
| AO Core Services | Session manager, lifecycle manager, metadata, plugin registry |
| Policy Engine | Command allow/deny/risk scoring + approval gates |
| Shell Adapter | Shell capability detection, command template building, quoting, cwd/env normalization |
| Audit Service | Immutable local event log for command/action traceability |
| Local Store | Workspace/task/chat UI cache + recovery metadata |

## 4. Data and Command Contracts

## Control commands (invoke)

- `workspace.load({ path })`
- `task.create({ title, issueId, priority, projectId })`
- `task.start({ taskId })`
- `task.stop({ taskId })`
- `chat.send({ message, taskId?, sessionId? })`
- `terminal.run({ sessionId, command, profile? })`
- `terminal.kill({ sessionId, signal })`
- `terminal.listProfiles()`
- `terminal.setProfile({ sessionId, profileId })`
- `changes.list({ sessionId })`
- `changes.diff({ sessionId, path })`
- `changes.apply({ sessionId, hunks })`

## Stream events (WebSocket)

- `task.updated`
- `chat.message`
- `terminal.output`
- `terminal.exit`
- `changes.updated`
- `session.health`
- `policy.warning`
- `audit.appended`

## Contract requirements

- Every command returns `{ok, data?, error?, requestId}`.
- Every event carries `{eventId, timestamp, sessionId?, taskId?, payload}`.
- Sidecar must support idempotent retries using `requestId`.

## Shell profile contract (Windows host baseline)

| Profile ID | Binary | Startup template | Notes |
| --- | --- | --- | --- |
| `windows-powershell` | `powershell.exe` | `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command` | Default fallback if `pwsh` is unavailable |
| `cmd` | `cmd.exe` | `/d /s /c` | Must disable AutoRun by default with `/d` |
| `git-bash` | user-configured `bash.exe` | `-lc` | Binary path should be configurable and validated at startup |
| `wsl` | `wsl.exe` | `--distribution <name> --cd <dir> --exec <cmd> ...` | Requires installed distro and path normalization |

Implementation rule:
- For structured actions (buttons/presets), use `command + args[]` (no raw concatenation).
- For chat raw commands, pass through policy engine tiering and confirmation gates before shell execution.

## 5. UX Flows to Implement

## Flow A: Button-triggered task execution

1. User clicks `Run Task`.
2. UI calls `task.start`.
3. Sidecar prepares/attaches session.
4. Terminal stream opens automatically.
5. Changes stream updates as files mutate.

## Flow B: Chat-triggered command execution

1. User sends `/run pnpm test`.
2. Intent parser classifies as terminal command intent.
3. Policy engine evaluates risk.
4. If allowed, sidecar runs command and streams output.
5. Chat receives compact summary with exit status.

## Flow C: Review and apply changes

1. User opens `Changes`.
2. UI fetches file list and diff hunks.
3. User selects hunks.
4. UI calls `changes.apply`.
5. Audit event is appended with selected hunks and actor.

## Flow D: Restart and recovery

1. App relaunches.
2. Host reconnects to sidecar and restores state snapshot.
3. Active terminal sessions reattach.
4. Task states reconcile using sidecar truth.

## Environment capability audit (current workstation snapshot)

- `powershell.exe`: detected at `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`.
- `pwsh`: not detected (PowerShell 7 not installed in PATH).
- `wsl.exe`: available; distro list includes `Ubuntu`.
- `bash.exe`: available at `C:\Users\coder\AppData\Local\Microsoft\WindowsApps\bash.exe` (WSL launcher).
- `git-bash.exe`: not found via `where.exe`; Git Bash should remain optional with explicit binary setup.

## 6. Workstreams and Sequencing

## WS0 Architecture and Policy (M0)

- Finalize ADRs.
- Define command policy tiers.
- Lock MVP acceptance criteria.

## WS1 Desktop Host Foundation (M1)

- Scaffold Tauri app package.
- Implement host-side sidecar lifecycle manager.
- Secure invoke bridge and permission boundaries.

## WS2 Sidecar Integration Layer (M1-M2)

- Create desktop sidecar entrypoint.
- Implement command routing and event bus adapter.
- Add request correlation and idempotency.
- Build shell adapter core with profile registry and capability probes.

## WS3 Tasks Module (M2-M3)

- Task board and status pipeline.
- Task session linkage and timeline.
- Retry/block/unblock logic.

## WS4 Chat Module (M2-M3)

- Chat transport and persistence.
- Slash command parsing and intent routing.
- Safety confirmations for risky operations.

## WS5 Terminal Module (M2-M3)

- Embedded xterm tabs.
- PTY run/kill/resize/reconnect.
- Throughput controls and output truncation policies.
- Per-shell encoding normalization and exit/signal behavior parity.

## WS6 Changes Module (M2-M3)

- Changed files tree.
- Diff retrieval and rendering.
- Hunk-level apply/reject pipeline.

## WS7 Security and Audit (M3-M4)

- Policy engine enforcement.
- Secrets masking for logs and output.
- Audit trail viewer and export.
- Dangerous payload regression suite (command injection and quoting edge cases).

## WS8 Reliability and Release (M4-M5)

- Crash recovery and restart resilience.
- Cross-platform packaging/signing.
- GA runbook and rollback automation.

## 7. Technical Validation Plan

## Unit test focus

- intent parser correctness,
- policy engine decisions,
- task state machine transitions,
- diff apply validator.

## Integration test focus

- invoke command roundtrip with sidecar,
- terminal spawn/stream/kill lifecycle,
- session recovery after forced shutdown,
- policy gating for risky commands,
- shell adapter profile tests (`powershell.exe`, `cmd.exe`, `wsl`, configured `git-bash`),
- quoting and unicode output tests per shell.

## E2E test focus

- Journey 1: Issue -> Task -> Terminal -> Changes -> Done.
- Journey 2: Chat `/run` with safe and risky commands.
- Journey 3: Crash, restart, and resume.
- Journey 4: same command matrix executed across all enabled shell profiles.

## 8. Security Controls

- Path and identifier sanitization at API boundaries.
- No direct `exec(string)` for structured operations; prefer spawn/execFile with explicit args.
- Command policy tiers:
- Tier 0: read-only safe commands (auto-run),
- Tier 1: medium risk (inline confirmation),
- Tier 2: high risk (modal confirmation + reason + audit).
- Secrets masking regex + structured redaction before UI rendering.
- Workspace boundary enforcement (no command execution outside allowed roots).
- Shell adapter allowlist of binaries and startup flags; reject unknown shell executables by default.

## 9. Performance and Reliability Targets

- command start latency p50 <= 300 ms,
- terminal frame drop under stress <= 1%,
- diff open latency for 1k lines <= 600 ms,
- sidecar reconnect after host restart <= 2 sec,
- crash-free session rate >= 99.5% by GA.

## 10. Migration Strategy from Current Web/CLI

1. Reuse:
- `packages/core`,
- existing plugin packages,
- current session metadata model.
2. Extract shared UI logic where safe from `packages/web/src`.
3. Keep CLI/web operational during desktop build (no breaking parity changes).
4. Add desktop mode flags instead of invasive rewrites.

## 11. Release Readiness Checklist

- Core journeys green on Windows/macOS/Linux.
- No open P0/P1 defects.
- Security policy tests passing.
- Packaging and signing pipeline passing.
- Rollback script tested on latest release candidate.

## 12. Open Decisions for Final Alignment

1. Shared UI strategy:
- Reuse from `packages/web` directly, or
- create shared package first (`packages/ui-shared`).
2. Sidecar distribution mode:
- bundled Node runtime, or
- system Node prerequisite.
3. Risk policy default:
- strict-by-default, or
- configurable defaults per workspace.
