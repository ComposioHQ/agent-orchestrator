# Agent Orchestrator Desktop Roadmap (Tauri)

## Document Control

- Owner: Product + Engineering
- Status: Draft for alignment
- Last updated: 2026-02-22
- Planning horizon: 12 weeks (2026-02-23 to 2026-05-17)

## 1. Objective

Deliver a desktop-first Agent Orchestrator where Tasks, Chat, Terminal, and Code Changes workflows are fully operable inside one app without opening external terminal apps for primary usage.

## 2. Scope Boundaries

### In scope for MVP

- Embedded terminal execution (chat-triggered and button-triggered).
- Cross-shell execution inside desktop app: `powershell.exe`, `cmd.exe`, `Git Bash`, `WSL`.
- Task lifecycle management with session linkage.
- Chat intent routing to orchestrator actions.
- Live change visibility (changed files + diff preview + apply selected hunks).
- Recovery on app restart (sessions and terminal reconnection).
- Safety controls for risky commands and sensitive file edits.

### Out of scope for MVP

- Full in-app IDE parity with VS Code extensions marketplace.
- Cloud multi-user real-time collaboration.
- Mobile client.

## 3. Milestone Timeline

| Milestone | Date Range | Outcome | Exit Gate |
| --- | --- | --- | --- |
| M0 Discovery Lock | 2026-02-23 to 2026-03-01 | UX, architecture, and security policies locked | Signed ADR set + approved scope |
| M1 Platform Foundation | 2026-03-02 to 2026-03-15 | Tauri shell + Node sidecar + IPC baseline | Desktop app boots and health checks pass |
| M2 Vertical Slice | 2026-03-16 to 2026-04-05 | End-to-end: Task -> Chat `/run` -> Terminal -> Diff | Demoable flow with no external terminal |
| M3 Core Completion | 2026-04-06 to 2026-04-26 | Full MVP modules integrated | E2E pass on critical journeys |
| M4 Hardening Beta | 2026-04-27 to 2026-05-10 | Reliability, performance, packaging | Beta builds for Windows/macOS/Linux |
| M5 GA Readiness | 2026-05-11 to 2026-05-17 | Documentation, release operations, support runbooks | GA checklist complete and signed |

## 4. Milestone Deliverables

## M0 Discovery Lock

- UX flow and user journey specifications.
- Desktop architecture decision records (ADRs).
- Security policy for command execution via chat.
- Acceptance criteria catalog for MVP.

## M1 Platform Foundation

- `packages/desktop` scaffold (Tauri v2 + React).
- Sidecar daemon process lifecycle from desktop host.
- IPC contracts and event transport.
- Local state bootstrapping and workspace loader.
- Shell adapter baseline with runtime detection + fallback order.

## M2 Vertical Slice

- Task creation/start/stop with persisted status.
- Chat command `/run` to execute terminal command.
- Live stdout/stderr stream in embedded terminal.
- Changes panel showing modified files and diff.
- First compatibility slice across `powershell.exe`, `cmd.exe`, `WSL` on Windows host.

## M3 Core Completion

- Full task board filters and timeline.
- Chat intent parser with safe confirmations.
- Multi-tab terminal and process controls.
- Hunk-level apply/reject in changes view.
- Session recovery and crash-safe reconnect.
- Full shell matrix support including `Git Bash` with user-configurable binary path.

## M4 Hardening Beta

- Backpressure and high-output terminal stress handling.
- Security hardening and secrets masking.
- Cross-platform packaging and smoke tests.
- Telemetry and audit trail stability.

## M5 GA Readiness

- GA documentation and support handbook.
- Release runbook and rollback playbook.
- Final regression pass and sign-off.

## 5. Success Metrics

| Metric | Target by Beta (2026-05-10) | Target by GA (2026-05-17) |
| --- | --- | --- |
| Primary workflow without external terminal | >= 90% | >= 98% |
| Task action success rate (start/stop/retry) | >= 95% | >= 98% |
| Terminal stream reconnect success after restart | >= 90% | >= 97% |
| Crash-free desktop sessions | >= 99.0% | >= 99.5% |
| Median command start latency | <= 500 ms | <= 300 ms |
| Diff render latency for 1k-line file | <= 900 ms | <= 600 ms |
| Shell matrix pass rate (Windows host) | >= 90% | >= 98% |
| Ctrl+C interruption reliability in active shell | >= 90% | >= 97% |

## 6. Release Strategy

### Alpha (internal)

- Date window: after M2 (from 2026-04-06).
- Audience: internal engineering and QA only.
- Goal: validate vertical slice under daily usage.

### Beta (limited external)

- Date window: after M4 (from 2026-05-11).
- Audience: selected advanced users.
- Goal: cross-platform stabilization and feedback.

### GA

- Planned target date: 2026-05-17.
- Audience: all supported users.
- Requirement: all P0/P1 bugs closed and rollback tested.

## 7. Team Model and Ownership

| Track | Primary Owner | Support |
| --- | --- | --- |
| UX and Product | Product Designer | FE Lead |
| Desktop Host (Tauri) | Desktop Engineer | Platform Engineer |
| Sidecar and Core Integration | Backend Engineer | Core Maintainer |
| Tasks/Chat UI | Frontend Engineer | Product Designer |
| Terminal and Diff UX | Frontend Engineer | Backend Engineer |
| Security and Policy | Security Engineer | Backend Engineer |
| QA and Release | QA Engineer | DevOps/Release Engineer |

## 8. Risk Register (Roadmap Level)

| Risk | Probability | Impact | Mitigation |
| --- | --- | --- | --- |
| PTY behavior mismatch across OS | Medium | High | Compatibility abstraction + OS-specific E2E matrix from M2 |
| Shell quoting/escaping regression (`cmd` vs PowerShell vs bash) | High | High | Central shell adapter + parser tests + known-bad payload tests |
| Missing shell binary on user machine (e.g. `pwsh`, Git Bash) | High | Medium | Capability detection, fallback order, explicit setup wizard diagnostics |
| Stream overload freezes UI | Medium | High | Chunked transport + terminal ring buffer + frame throttling |
| Unsafe chat command execution | Medium | High | Policy engine + risk tiers + explicit confirmation |
| Packaging/signing delays | Medium | Medium | Set up CI signing pipeline by M1, not at release end |
| Scope creep into full IDE | High | Medium | Maintain strict MVP boundaries and non-goals |

## 9. Go/No-Go Gates

### Gate to enter Beta (2026-05-10)

- All critical journeys pass E2E on 3 OS targets.
- Shell matrix tests pass on Windows host (`powershell.exe`, `cmd.exe`, `WSL`, configured Git Bash).
- No unresolved P0 bugs.
- Recovery flow validated on crash/restart scenario.
- Security checks pass for command and secrets handling.

### Gate to ship GA (2026-05-17)

- P0 and P1 defects resolved.
- Performance targets met or approved exception documented.
- Rollback dry-run completed.
- Release documentation finalized.
