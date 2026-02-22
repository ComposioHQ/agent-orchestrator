# Desktop Work Items Backlog

## Document Control

- Program: Agent Orchestrator Desktop (Tauri)
- Last updated: 2026-02-22
- Source roadmap: `work-items/desktop-plan/roadmap.md`
- Source implementation plan: `work-items/desktop-plan/implementation-plan.md`
- Planning window: 2026-02-23 to 2026-05-17

## Usage Rules

- Status values: `TODO`, `IN_PROGRESS`, `BLOCKED`, `DONE`.
- No task can move to `DONE` without its Definition of Done (DoD).
- Tasks on critical path cannot be parallelized if dependency is unresolved.
- Any scope change requires update in both roadmap and implementation plan.

## Critical Path

1. `DESK-006` -> `DESK-100` -> `DESK-102` -> `DESK-103` -> `DESK-200`.
2. `DESK-204` + `DESK-205` -> `DESK-208` -> `DESK-210`.
3. `DESK-110` -> `DESK-111` -> `DESK-113` -> `DESK-212` -> `DESK-403`.
4. `DESK-308` + `DESK-309` -> `DESK-409` -> `DESK-507`.

## Milestone Calendar

| Milestone | Date Range | Required Completion |
| --- | --- | --- |
| M0 Discovery Lock | 2026-02-23 to 2026-03-01 | `DESK-001` to `DESK-010` |
| M1 Foundation | 2026-03-02 to 2026-03-15 | `DESK-100` to `DESK-117` |
| M2 Vertical Slice | 2026-03-16 to 2026-04-05 | `DESK-200` to `DESK-212` |
| M3 Core Completion | 2026-04-06 to 2026-04-26 | `DESK-300` to `DESK-314` |
| M4 Hardening Beta | 2026-04-27 to 2026-05-10 | `DESK-400` to `DESK-410` |
| M5 GA | 2026-05-11 to 2026-05-17 | `DESK-500` to `DESK-507` |

## Backlog

| ID | Status | Phase | Workstream | Task | Depends On | Est. | DoD |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DESK-001 | TODO | M0 | Product | Freeze MVP scope and non-goals | - | 0.5d | Signed scope section in roadmap |
| DESK-002 | TODO | M0 | Product | Define user personas and success jobs | DESK-001 | 0.5d | Persona sheet approved |
| DESK-003 | TODO | M0 | UX | Finalize IA and navigation map | DESK-001 | 1d | IA diagram approved |
| DESK-004 | TODO | M0 | UX | Write end-to-end user journeys J1-J4 | DESK-002, DESK-003 | 1d | Journey specs approved |
| DESK-005 | TODO | M0 | Security | Define command risk tiers (0/1/2) | DESK-001 | 0.5d | Policy table approved |
| DESK-006 | TODO | M0 | Architecture | Finalize ADR set (host, sidecar, IPC, terminal) | DESK-003, DESK-005 | 1d | ADR document signed by FE+BE leads |
| DESK-007 | TODO | M0 | QA | Create acceptance criteria matrix by module | DESK-004 | 1d | Criteria matrix published |
| DESK-008 | TODO | M0 | Program | Create risk register and mitigation owners | DESK-006 | 0.5d | Risks ranked with owners |
| DESK-009 | TODO | M0 | QA | Define test strategy (unit/integration/E2E) | DESK-007 | 0.5d | Test plan approved |
| DESK-010 | TODO | M0 | Program | Discovery phase sign-off | DESK-006, DESK-007, DESK-008, DESK-009 | 0.5d | Go decision for M1 |
| DESK-100 | TODO | M1 | Desktop | Scaffold `packages/desktop` (Tauri v2 + React) | DESK-010 | 1d | App boots locally |
| DESK-101 | TODO | M1 | Desktop | Configure windowing, permissions, and app shell | DESK-100 | 1d | Shell opens with secured defaults |
| DESK-102 | TODO | M1 | Platform | Implement Node sidecar lifecycle manager | DESK-100, DESK-006 | 1.5d | Sidecar start/stop/restart reliable |
| DESK-103 | TODO | M1 | Platform | Implement invoke command bridge with schema checks | DESK-102 | 1.5d | Invalid payloads rejected safely |
| DESK-104 | TODO | M1 | Platform | Implement WebSocket stream channel | DESK-102 | 1d | Events stream with reconnect token |
| DESK-105 | TODO | M1 | Data | Add local state store bootstrap | DESK-100 | 1d | Workspace state restored on relaunch |
| DESK-106 | TODO | M1 | Platform | Add desktop mode flags and guardrails | DESK-006, DESK-103 | 0.5d | External terminal path blocked in desktop mode |
| DESK-107 | TODO | M1 | DevEx | Add dev/build scripts for desktop package | DESK-100 | 0.5d | One-command run documented |
| DESK-108 | TODO | M1 | CI | Add desktop smoke tests in CI | DESK-107 | 1d | CI job green on PR |
| DESK-109 | TODO | M1 | UX | Add diagnostics pane (host/sidecar/ws health) | DESK-104, DESK-105 | 1d | Health indicators visible in app |
| DESK-110 | TODO | M1 | Platform | Define shell profile spec + fallback order | DESK-006 | 0.5d | Spec approved for PowerShell/CMD/Git Bash/WSL |
| DESK-111 | TODO | M1 | Platform | Implement shell capability probe service | DESK-110 | 1d | Runtime detects installed shells at startup |
| DESK-112 | TODO | M1 | Platform | Implement `powershell.exe` + `cmd.exe` adapters | DESK-111, DESK-103 | 1d | Both shells run command/kill/cwd correctly |
| DESK-113 | TODO | M1 | Platform | Implement WSL adapter (`--distribution`, `--cd`, `--exec`) | DESK-111, DESK-103 | 1d | WSL command execution stable with distro select |
| DESK-114 | TODO | M1 | Platform | Implement optional Git Bash adapter with configured binary path | DESK-111, DESK-103 | 0.5d | Git Bash path validation + execution works |
| DESK-115 | TODO | M1 | Platform | Add per-shell quoting and encoding normalization layer | DESK-112, DESK-113, DESK-114 | 1d | Unicode/quotes/exit-code parity tests pass |
| DESK-116 | TODO | M1 | UX | Add shell diagnostics and profile selector in settings | DESK-111, DESK-109 | 0.5d | User sees shell availability + default profile |
| DESK-117 | TODO | M1 | Audit | Add shell fallback decision logging to audit trail | DESK-111, DESK-103 | 0.5d | Fallback events recorded with reason |
| DESK-200 | TODO | M2 | Tasks | Implement task create/start/stop commands | DESK-103 | 1d | Task command APIs operational |
| DESK-201 | TODO | M2 | Tasks UI | Build task list and detail panel | DESK-200 | 1.5d | User can manage tasks from UI |
| DESK-202 | TODO | M2 | Chat | Build chat panel with streaming messages | DESK-104 | 1d | Messages stream without refresh |
| DESK-203 | TODO | M2 | Chat | Implement slash commands `/run`, `/task`, `/diff` | DESK-202, DESK-200 | 1d | Commands parsed and routed |
| DESK-204 | TODO | M2 | Terminal | Implement embedded xterm panel | DESK-104 | 1d | Terminal renders and resizes |
| DESK-205 | TODO | M2 | Terminal | Implement run/kill execution handlers | DESK-204, DESK-103 | 1.5d | Commands execute and stop reliably |
| DESK-206 | TODO | M2 | Changes | Implement changed-files service | DESK-103 | 1d | Files list updates in session |
| DESK-207 | TODO | M2 | Changes UI | Implement basic unified diff viewer | DESK-206 | 1d | User can inspect file diffs |
| DESK-208 | TODO | M2 | Integration | Wire Task -> Chat -> Terminal -> Changes flow | DESK-201, DESK-203, DESK-205, DESK-207 | 1.5d | End-to-end vertical flow works |
| DESK-209 | TODO | M2 | Audit | Implement baseline audit append for commands | DESK-103 | 0.5d | Command actions logged |
| DESK-210 | TODO | M2 | QA | E2E test for vertical slice | DESK-208, DESK-209 | 1d | E2E green in CI |
| DESK-211 | TODO | M2 | Program | Vertical slice demo and gate review | DESK-210 | 0.5d | Stakeholder sign-off for M3 |
| DESK-212 | TODO | M2 | QA | Add shell matrix vertical tests (`powershell.exe`, `cmd.exe`, `wsl`) | DESK-112, DESK-113, DESK-208 | 1d | Same command suite passes across selected shells |
| DESK-300 | TODO | M3 | Tasks | Implement full task state machine | DESK-201 | 1d | All states transition correctly |
| DESK-301 | TODO | M3 | Tasks | Add retry/block/unblock actions | DESK-300 | 0.5d | Recovery actions functional |
| DESK-302 | TODO | M3 | Chat | Add natural language intent routing | DESK-203 | 1.5d | NL intents map to actions |
| DESK-303 | TODO | M3 | Security UX | Add risky action confirmation dialogs | DESK-005, DESK-302 | 0.5d | Tier1/2 actions require confirm |
| DESK-304 | TODO | M3 | Terminal | Add multi-tab terminal session management | DESK-205 | 1d | User can switch parallel sessions |
| DESK-305 | TODO | M3 | Terminal | Add reconnect/restore for terminal on restart | DESK-105, DESK-304 | 1d | Session reattach works after restart |
| DESK-306 | TODO | M3 | Changes | Add hunk-level select/apply/reject | DESK-207 | 1.5d | Fine-grained apply available |
| DESK-307 | TODO | M3 | Security | Implement risk scoring for file/command changes | DESK-005, DESK-306 | 1d | Risk badges and score available |
| DESK-308 | TODO | M3 | Security | Implement policy engine enforcement | DESK-307, DESK-303 | 1.5d | Blocked commands cannot execute |
| DESK-309 | TODO | M3 | Security | Implement secrets masking in outputs/logs | DESK-209 | 1d | Sensitive tokens redacted |
| DESK-310 | TODO | M3 | Reliability | Implement session recovery orchestrator | DESK-305 | 1d | Task/session state recovered safely |
| DESK-311 | TODO | M3 | UX | Build unified activity feed (task/chat/terminal/audit) | DESK-301, DESK-309, DESK-310 | 1d | Single timeline view shipped |
| DESK-313 | TODO | M3 | Security | Add command-injection and quoting regression suite per shell | DESK-308, DESK-115 | 1d | Known-bad payload corpus blocked or safely escaped |
| DESK-314 | TODO | M3 | QA | Validate Ctrl+C/terminate behavior per shell profile | DESK-304, DESK-115 | 0.5d | Interrupt behavior meets reliability target |
| DESK-400 | TODO | M4 | Performance | Implement stream backpressure + ring buffer | DESK-304 | 1d | No UI freeze under high output |
| DESK-401 | TODO | M4 | Performance | Run profiling on large repos and tune hotspots | DESK-400, DESK-311 | 1d | Performance budget report approved |
| DESK-402 | TODO | M4 | Reliability | Execute crash/chaos tests and fix regressions | DESK-310 | 1d | Recovery pass rate >= target |
| DESK-403 | TODO | M4 | QA | Build cross-platform PTY compatibility matrix | DESK-305, DESK-400 | 1d | Win/macOS/Linux matrix green |
| DESK-404 | TODO | M4 | Release | Packaging/signing pipeline for Windows | DESK-108 | 0.5d | Signed installer artifact generated |
| DESK-405 | TODO | M4 | Release | Packaging/signing pipeline for macOS | DESK-108 | 0.5d | Signed app bundle generated |
| DESK-406 | TODO | M4 | Release | Packaging/signing pipeline for Linux | DESK-108 | 0.5d | Installable package generated |
| DESK-407 | TODO | M4 | Observability | Add telemetry/error reporting for desktop app | DESK-402 | 0.5d | Error dashboards operational |
| DESK-408 | TODO | M4 | Program | Prepare beta docs and feedback loop | DESK-401, DESK-403 | 0.5d | Beta handbook published |
| DESK-409 | TODO | M4 | Program | Beta readiness gate review | DESK-403, DESK-404, DESK-405, DESK-406, DESK-407, DESK-408 | 0.5d | Beta Go decision recorded |
| DESK-410 | TODO | M4 | QA | Cross-shell soak tests (long output, unicode, large repo) | DESK-400, DESK-403, DESK-313 | 1d | 24h soak report within error budget |
| DESK-500 | TODO | M5 | QA | P0/P1 bug bash and closure | DESK-409 | 1d | No open P0/P1 bugs |
| DESK-501 | TODO | M5 | Docs | Final user docs and migration notes | DESK-500 | 0.5d | Docs approved by product + support |
| DESK-502 | TODO | M5 | Ops | Support runbook and incident response flow | DESK-500 | 0.5d | Support playbook ready |
| DESK-503 | TODO | M5 | Ops | Rollback drill on release candidate | DESK-404, DESK-405, DESK-406 | 0.5d | Rollback validated end-to-end |
| DESK-504 | TODO | M5 | Security | Final security review and sign-off | DESK-308, DESK-309, DESK-500 | 0.5d | Security checklist signed |
| DESK-505 | TODO | M5 | Performance | Final performance gate against targets | DESK-401, DESK-500 | 0.5d | Performance targets achieved |
| DESK-506 | TODO | M5 | Release | Build RC1 and execute regression sweep | DESK-501, DESK-502, DESK-503, DESK-504, DESK-505 | 0.5d | RC1 accepted for GA |
| DESK-507 | TODO | M5 | Release | GA release and 72h post-release monitoring | DESK-506 | 1d | GA shipped, monitoring stable |

## Journey Coverage Matrix

| Journey | Description | Covered by Tasks |
| --- | --- | --- |
| J1 | Issue -> Task -> Implementation -> Review | DESK-200, DESK-201, DESK-208, DESK-306 |
| J2 | Chat command -> terminal execution | DESK-202, DESK-203, DESK-205, DESK-302 |
| J3 | Safe apply with risky confirmation | DESK-303, DESK-307, DESK-308 |
| J4 | Crash/restart -> session recovery | DESK-305, DESK-310, DESK-402 |
| J5 | Same command across PowerShell/CMD/Git Bash/WSL | DESK-110, DESK-111, DESK-112, DESK-113, DESK-114, DESK-212, DESK-403 |

## MVP Gate Checklist

- No external terminal is needed for primary workflows.
- Task start/stop/retry works from UI and chat.
- Terminal output streams in real time and supports reconnect.
- User can review diffs and apply selected hunks.
- Risky commands require explicit confirmation.
- Session and audit history survive restart.
- Shell compatibility matrix is validated for enabled profiles on target OS.

## Execution Notes

- If schedule slips by more than 3 working days in M2, freeze M3 feature additions.
- If cross-platform PTY issues exceed threshold in M4, prioritize Windows-first GA and move multi-OS GA to follow-up release.
- Every completed task must include test evidence link in PR description.
- If a required shell binary is missing on beta tester machines, block GA until setup wizard + diagnostics remediation is complete.
