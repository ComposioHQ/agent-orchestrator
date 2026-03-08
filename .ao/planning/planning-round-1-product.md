# Product Analysis — Round 1

_Date: 2026-03-03_
_Role: Product Planner_

## Executive Summary

Agent Orchestrator is a mature, well-architected system at ~90% implementation. All 17 plugins, core services, CLI, and web dashboard are functional. The product now needs to shift from "build the features" to "make it ship-ready" — polish, reliability, user experience, and distribution.

The core value proposition ("spawn agents, walk away, get notified when judgment is needed") is architecturally sound but has several gaps between the vision (architecture-design.md) and the current implementation that need to be closed before v1.0.

## Current State Assessment

### What Works Well (Strengths)

1. **Plugin architecture** — 8 swappable slots, 17 plugins, clean interfaces. This is the product's architectural moat.
2. **Core pipeline** — `ao spawn` → workspace → runtime → agent launch → lifecycle polling → state machine → reactions. Full loop works.
3. **Claude Code integration** — Rich activity detection, JSONL parsing, session info extraction, metadata hooks. Best-in-class agent integration.
4. **SCM/GitHub** — Full PR lifecycle: detection, CI checks, review comments, automated comments, merge readiness, merge/close.
5. **CLI** — All 9 commands functional: spawn, start, status, send, session, open, dashboard, init, review-check.
6. **Web dashboard** — Session list, session detail, terminal (xterm.js), PR management.
7. **`ao start <url>`** — One-command onboarding that clones, configures, and launches. A strong adoption lever.
8. **Test coverage** — 3,288 test cases across core and plugins.

### Critical Gaps (Product Perspective)

#### Gap 1: Real-Time Dashboard Updates
**Architecture vision**: SSE stream from event bus to dashboard for live updates.
**Current state**: Dashboard uses polling via API routes. No SSE endpoint wired.
**Impact**: Users must refresh to see state changes. Breaks the "push not pull" philosophy for the dashboard drill-down experience.

#### Gap 2: Event Bus / JSONL Persistence
**Architecture vision**: In-process pub/sub + JSONL event log for audit trail and SSE feed.
**Current state**: Event bus referenced in architecture but not fully implemented as a formal system. Lifecycle manager emits events but they don't persist to JSONL or feed an SSE stream.
**Impact**: No audit trail. No event replay. No SSE. Dashboard can't show real-time event history.

#### Gap 3: Notification Priority Routing
**Architecture vision**: Different priorities route to different channels (urgent→desktop+slack, action→desktop+slack, warning→slack, info→slack).
**Current state**: Notifiers work individually but there's no priority-based routing layer that dispatches to multiple notifiers based on event priority.
**Impact**: Users can't configure "desktop for urgent, Slack for everything" — the core UX of the "push not pull" philosophy.

#### Gap 4: `ao batch-spawn`
**Architecture vision**: Batch spawn with duplicate detection from implementation plan.
**Current state**: Not implemented. Only `ao spawn` for single issues.
**Impact**: Power users who want to `ao batch-spawn my-project 100 101 102 103` (the flagship use case from the README: "spawn 20 agents") must script it themselves.

#### Gap 5: Cost Tracking
**Architecture vision**: Token usage estimation per agent, cost tracking system.
**Current state**: Claude Code pricing hardcoded to Sonnet 4.5. Other agents return null for cost info.
**Impact**: Users running 20+ agents in parallel have no visibility into spend. This is a key concern for adoption.

#### Gap 6: Session Restore Robustness
**Architecture vision**: Crash recovery, workspace recovery.
**Current state**: `restore()` exists in session-manager but edge cases (orphaned worktrees, dead tmux sessions, corrupted metadata) may not be fully handled.
**Impact**: If a machine reboots or an agent crashes, recovery should be seamless. Currently may require manual cleanup.

#### Gap 7: npm Package Distribution
**Architecture vision**: `npx agent-orchestrator` works everywhere.
**Current state**: Setup requires cloning the repo + running scripts/setup.sh.
**Impact**: Huge friction for adoption. The difference between "try it in 30 seconds" and "set up a development environment."

### Secondary Gaps

- **Auto-merge** — Reaction exists but needs testing for edge cases (merge conflicts, branch protection rules)
- **Escalation timers** — Configurable `escalate-after` in reactions may not be fully wired (time-based escalation)
- **Agent stuck detection** — Threshold-based idle detection may need tuning
- **Dashboard attention zones** — Architecture describes Red/Orange/Yellow/Green/Grey priority zones; current UI may not fully implement this
- **Mobile app** — packages/mobile exists (React Native/Expo) but unclear completion state
- **Integration tests** — packages/integration-tests exists but unclear what's covered

## Competitive Positioning

Based on competitive research (artifacts/competitive-research.md):

**Our differentiators** (must protect and polish):
1. **Agent-agnostic** — 4 agents (Claude, Codex, Aider, OpenCode). No competitor except agent-team has this.
2. **Runtime-agnostic** — tmux + process today, Docker/K8s/cloud pluggable. Par is tmux-only. CAO is tmux-only.
3. **Full PR lifecycle** — CI checks, reviews, auto-reactions. Nobody else does this end-to-end.
4. **Beautiful dashboard** — Most competitors are CLI-only or have minimal UI.
5. **Push notifications** — The "walk away" model. Gas Town optimizes for autonomous, not human-in-the-loop.

**Competitive threats to monitor**:
1. **Gas Town** — Most architecturally ambitious competitor. Git-backed state, role-based agents. But Go-only, no dashboard, $100/hr burn rate.
2. **CAO (AWS Labs)** — AWS backing gives credibility. Clean supervisor/worker model. But AWS-centric.
3. **Par** — Closest to our approach. Simple, clean. But no plugins, no dashboard, no lifecycle management.

## User Personas & Key Flows

### Persona 1: Solo Developer (Primary)
- Runs 3-10 agents on personal projects
- Uses Claude Code + GitHub
- Wants: "spawn and forget, get notified"
- Critical path: `ao init` → `ao spawn` → notifications → merge PRs

### Persona 2: Team Lead (Secondary)
- Manages 10-30 agents across team projects
- Uses Linear + Slack
- Wants: team visibility, cost tracking, review routing
- Critical path: YAML config → batch spawn → Slack notifications → dashboard oversight

### Persona 3: Enterprise/Platform (Future)
- Runs 50+ agents with auth, audit, and RBAC
- Wants: Docker/K8s runtime, webhook integration, audit trail
- Not in scope for v1.0 but architecture should support it

## Recommended Priority Stack for Next Iteration

### P0 — Must Have (blocks v1.0 launch)

1. **npm package distribution** — `npx agent-orchestrator` or `npm i -g agent-orchestrator`
2. **Event bus + JSONL persistence** — Foundation for SSE, audit trail, event history
3. **SSE real-time dashboard** — Dashboard must update live when session states change
4. **Batch spawn** — `ao batch-spawn <project> <issue1> <issue2> ...`
5. **Notification priority routing** — Multi-notifier dispatch based on event priority

### P1 — Should Have (high-value polish)

6. **Cost tracking** — Per-session and aggregate token/cost visibility
7. **Dashboard attention zones** — Red/Orange/Yellow/Green/Grey priority layout
8. **Escalation timers** — Time-based escalation from auto-handle to notify
9. **Session restore hardening** — Reliable recovery after crash/reboot
10. **Auto-merge testing** — End-to-end validation of the approved+green→merge flow

### P2 — Nice to Have (post-launch)

11. **Docker runtime plugin** — For isolation and reproducibility
12. **Webhook-triggered spawning** — GitHub webhook → auto-spawn agent
13. **Cost budgets** — Kill agents when budget exceeded
14. **Dashboard auth** — Basic auth for shared deployments
15. **Mobile app** — Push notifications on iOS/Android

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Event bus adds complexity | Medium | High | Keep simple: in-process EventEmitter + JSONL append. No external broker. |
| SSE connection management | Medium | Medium | Use built-in Next.js streaming. Auto-reconnect on client. |
| npm publishing issues | Low | High | Test with local `npm link` first. Use `@composio/agent-orchestrator` scoped package. |
| Batch spawn race conditions | Medium | Medium | Sequential spawn with configurable delay. Dedup by issue ID. |
| Cost tracking inaccuracy | High | Low | Label as "estimated" in UI. Use pricing from model providers. |

## Key Metrics (for v1.0 success)

1. **Time to first agent spawn** — Target: <5 minutes from `npm install` to first `ao spawn`
2. **Notification latency** — Target: <30 seconds from state change to push notification
3. **Session restore success rate** — Target: >95% of crashed sessions recoverable
4. **Dashboard load time** — Target: <2 seconds for session list with 50 sessions
5. **Zero manual cleanup needed** — Users should never need to manually kill tmux sessions or remove worktrees

## Architecture Recommendations

### Event System Design
```
LifecycleManager detects state change
  → emits event to EventBus
    → EventBus persists to JSONL
    → EventBus dispatches to subscribers:
       ├── NotificationRouter → Notifier plugins (by priority)
       ├── SSE endpoint → connected dashboard clients
       └── ReactionEngine → auto-handle or escalate
```

This unifies three currently-separate concerns (notifications, SSE, reactions) into a single event-driven flow.

### Batch Spawn Design
```
ao batch-spawn my-project 100 101 102 103
  → validate all issues exist (parallel)
  → check for existing sessions (dedup)
  → spawn sequentially with 2s delay (avoid tmux race conditions)
  → report: "Spawned 4 sessions: app-1, app-2, app-3, app-4"
```

### Distribution Strategy
```
npm package: @composio/agent-orchestrator
  → contains: cli + core + all plugins (single install)
  → bin: { "ao": "./bin/ao.js" }
  → postinstall: validate prerequisites (node, git, tmux, gh)
  → npx agent-orchestrator init → interactive setup
```
