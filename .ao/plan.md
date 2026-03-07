# Agent Orchestrator — v1.0 Plan

_Created: 2026-03-03_
_Status: Draft (Round 1)_

## Goal

Ship a production-ready v1.0 of Agent Orchestrator that delivers on the core promise: **spawn agents, walk away, get notified when your judgment is needed.**

The system is ~90% implemented. This plan focuses on closing the remaining gaps between the architecture vision and the current implementation, hardening reliability, and enabling easy distribution.

---

## Task Breakdown

### Epic 1: Event System & Real-Time Updates

The event bus is the backbone for SSE, notifications, and audit trail. Currently, the lifecycle manager detects state changes but there's no unified event system that persists events, feeds SSE, and routes notifications.

#### Task 1.1: Event Bus with JSONL Persistence

Implement a formal event bus (in-process EventEmitter pattern) that:
- Accepts typed events from LifecycleManager and SessionManager
- Persists events to a JSONL file per project (`events.jsonl`)
- Supports subscribing to event streams (for SSE and notification routing)
- Provides `getEvents(since?, filter?)` for historical queries

**Files**: `packages/core/src/event-bus.ts` (new or expand existing)

**Acceptance criteria**:
- [ ] Events are appended to `{dataDir}/{hash}-{project}/events.jsonl` on every state change
- [ ] Each event has: timestamp, sessionId, type, priority, payload
- [ ] `subscribe(filter?)` returns an async iterator of events
- [ ] `getEvents(since?, limit?, filter?)` reads from JSONL with proper pagination
- [ ] Events survive process restart (JSONL is the source of truth)
- [ ] JSONL rotation: when file exceeds 10MB, rotate to `events.jsonl.1`
- [ ] Unit tests for event emission, persistence, and querying

#### Task 1.2: SSE Endpoint for Dashboard

Wire the event bus to an SSE endpoint so the dashboard updates in real-time.

**Files**: `packages/web/src/app/api/events/route.ts`

**Acceptance criteria**:
- [ ] `GET /api/events` returns an SSE stream (Content-Type: text/event-stream)
- [ ] Stream emits session state changes, PR updates, CI status changes
- [ ] Supports `Last-Event-ID` header for reconnection (no missed events)
- [ ] Client auto-reconnects on disconnect (EventSource default behavior)
- [ ] Multiple simultaneous clients supported
- [ ] Connection cleanup when client disconnects
- [ ] Dashboard session list updates live without manual refresh

#### Task 1.3: Dashboard Real-Time Integration

Update dashboard components to consume SSE instead of polling.

**Files**: `packages/web/src/components/`, `packages/web/src/lib/`

**Acceptance criteria**:
- [ ] Session list auto-updates when sessions change state
- [ ] Session detail page shows live status changes
- [ ] No full-page refresh needed for any state transition
- [ ] Fallback to polling if SSE connection fails
- [ ] Visual indicator showing "live" connection status

---

### Epic 2: Notification Priority Routing

The architecture defines priority-based routing (urgent→desktop+slack, action→desktop+slack, warning→slack, info→slack) but this isn't implemented as a routing layer.

#### Task 2.1: Notification Router

Create a notification routing layer that dispatches events to the right notifiers based on priority.

**Files**: `packages/core/src/notification-router.ts` (new)

**Acceptance criteria**:
- [ ] Reads routing config from `agent-orchestrator.yaml`:
  ```yaml
  notifications:
    routing:
      urgent: [desktop, slack]
      action: [desktop, slack]
      warning: [slack]
      info: [slack]
  ```
- [ ] Falls back to `defaults.notifiers` if no routing config
- [ ] Dispatches to multiple notifiers in parallel
- [ ] Failed notifier doesn't block other notifiers (fire-and-forget with error logging)
- [ ] Integrates with event bus (subscribes to events and routes)
- [ ] Unit tests for routing logic and error handling

#### Task 2.2: Escalation Timers

Implement time-based escalation from auto-handle to human notification.

**Files**: `packages/core/src/lifecycle-manager.ts`

**Acceptance criteria**:
- [ ] `escalateAfter` config is respected for CI failures and review comments
- [ ] Timer starts when auto-reaction is sent to agent
- [ ] If issue not resolved within escalation window → notify human
- [ ] Timer is canceled if issue is resolved before expiry
- [ ] State is persisted in metadata so timers survive restart
- [ ] Unit tests for timer behavior (start, cancel, fire)

---

### Epic 3: Batch Spawn

Enable spawning multiple agents in a single command — the flagship workflow from the README.

#### Task 3.1: `ao batch-spawn` Command

**Files**: `packages/cli/src/commands/batch-spawn.ts` (new)

**Acceptance criteria**:
- [ ] `ao batch-spawn <project> <issue1> [issue2] [issue3] ...` spawns agents for each issue
- [ ] Validates all issues exist before spawning any (fail-fast)
- [ ] Deduplicates: skips issues that already have an active session
- [ ] Sequential spawn with configurable delay (default 2s) to avoid tmux race conditions
- [ ] Reports progress: "Spawning 4 sessions... [1/4] app-1 ✓ [2/4] app-2 ✓ ..."
- [ ] Returns summary: "Spawned 4 sessions. Skipped 1 (already active)."
- [ ] Supports `--dry-run` flag to preview what would be spawned
- [ ] Supports issue ranges for numeric trackers: `ao batch-spawn my-project 100-110`

---

### Epic 4: Cost Tracking

Give users visibility into token usage and estimated cost across sessions.

#### Task 4.1: Cost Data Model & Collection

**Files**: `packages/core/src/types.ts`, `packages/core/src/session-manager.ts`, agent plugins

**Acceptance criteria**:
- [ ] `Session` type includes optional `cost: { inputTokens, outputTokens, estimatedCost, currency }` field
- [ ] Agent plugins that support cost extraction (claude-code, codex) populate this field
- [ ] Cost is updated on each lifecycle poll (when session info is refreshed)
- [ ] Cost is persisted in session metadata
- [ ] Pricing table is configurable (not hardcoded to Sonnet 4.5)

#### Task 4.2: Cost Display in CLI & Dashboard

**Files**: `packages/cli/src/commands/status.ts`, `packages/web/src/components/`

**Acceptance criteria**:
- [ ] `ao status` shows per-session cost estimate in a new column
- [ ] `ao status` shows aggregate cost across all active sessions
- [ ] Dashboard session card shows cost estimate
- [ ] Dashboard has an aggregate cost indicator (e.g., "Total estimated: $4.72")
- [ ] Cost shows "N/A" for agents that don't report cost (not an error)

---

### Epic 5: npm Package Distribution

Make installation a one-liner: `npm i -g @composio/agent-orchestrator`.

#### Task 5.1: Package Structure for npm Publishing

**Files**: `packages/agent-orchestrator/package.json`, build scripts

**Acceptance criteria**:
- [ ] Single npm package `@composio/agent-orchestrator` bundles CLI + core + all plugins
- [ ] `npm i -g @composio/agent-orchestrator` makes `ao` command available
- [ ] `npx @composio/agent-orchestrator init` works without global install
- [ ] Postinstall script validates prerequisites (node >=20, git >=2.25, tmux, gh)
- [ ] Prerequisite check is non-blocking (warns, doesn't fail install)
- [ ] README includes npm installation instructions
- [ ] Package size is reasonable (<10MB tarball)

#### Task 5.2: Setup Wizard Polish

**Files**: `packages/cli/src/commands/init.ts`

**Acceptance criteria**:
- [ ] `ao init` works from npm-installed package (not just git clone)
- [ ] Auto-detects project settings (repo URL, default branch, package manager)
- [ ] Generates valid `agent-orchestrator.yaml` with sensible defaults
- [ ] Offers to install missing prerequisites (tmux via brew, gh via brew)
- [ ] Validates generated config before writing
- [ ] Prints clear "next steps" after init

---

### Epic 6: Session Restore & Reliability

Ensure crash recovery is seamless.

#### Task 6.1: Startup Recovery Sweep

**Files**: `packages/core/src/session-manager.ts`

**Acceptance criteria**:
- [ ] On orchestrator startup, scan all sessions and detect orphaned state:
  - Metadata says "working" but tmux session is dead → mark as "errored" or auto-restore
  - Worktree exists but no metadata → clean up or adopt
  - Metadata says "spawning" (interrupted spawn) → clean up
- [ ] `ao session restore <id>` recreates runtime + relaunches agent in existing worktree
- [ ] Restore preserves the agent's conversation context (if agent supports `--resume`)
- [ ] `ao session restore --all` restores all restorable sessions
- [ ] Recovery actions are logged to event bus

#### Task 6.2: Graceful Shutdown

**Files**: `packages/core/src/session-manager.ts`, `packages/web/`

**Acceptance criteria**:
- [ ] SIGINT/SIGTERM to orchestrator process triggers graceful shutdown
- [ ] Sessions are NOT killed on orchestrator shutdown (agents continue in tmux)
- [ ] Metadata reflects orchestrator disconnection
- [ ] On restart, orchestrator re-adopts running sessions
- [ ] SSE connections are cleanly closed on shutdown

---

### Epic 7: Dashboard Attention Zones

Implement the attention-prioritized layout from the architecture design.

#### Task 7.1: Attention Zone Layout

**Files**: `packages/web/src/components/`, `packages/web/src/app/page.tsx`

**Acceptance criteria**:
- [ ] Sessions grouped by attention priority:
  - **Red zone** (top): URGENT — needs_input, stuck, errored
  - **Orange zone**: ACTION — mergeable (PR ready to merge)
  - **Yellow zone**: WARNING — ci_failed (after auto-fix exhausted), changes_requested (after auto-fix exhausted)
  - **Green zone**: HEALTHY — working, pr_open, review_pending, approved (collapsed by default)
  - **Grey zone**: DONE — merged, killed, done (collapsed by default)
- [ ] Zones collapse/expand with click
- [ ] Zone headers show count: "Needs Attention (3)"
- [ ] Empty zones are hidden
- [ ] Sessions within a zone are sorted by last activity (newest first)

---

### Epic 8: End-to-End Testing

Validate the full spawn→work→PR→merge lifecycle.

#### Task 8.1: Integration Test Suite

**Files**: `packages/integration-tests/`

**Acceptance criteria**:
- [ ] Test: spawn session → agent creates PR → lifecycle detects PR → status transitions to pr_open
- [ ] Test: CI fails → reaction sends fix message → agent pushes fix → CI passes
- [ ] Test: review comments → reaction sends address message → agent pushes fix
- [ ] Test: approved + green CI → status transitions to mergeable → merge works
- [ ] Test: session kill → runtime destroyed → workspace cleaned up
- [ ] Test: session restore → agent relaunched in existing worktree
- [ ] Tests can run in CI (mock or use test repo)
- [ ] Tests complete in <5 minutes

---

## Dependency Graph

```
                    Epic 1.1 (Event Bus)
                   /         |          \
          Epic 1.2          Epic 2.1     Epic 6.1
         (SSE)          (Notification   (Recovery
           |             Router)         Sweep)
          Epic 1.3          |
         (Dashboard        Epic 2.2
          RT)            (Escalation)

    Epic 3 (Batch Spawn)     — independent
    Epic 4 (Cost Tracking)   — independent
    Epic 5 (npm Dist)        — independent
    Epic 6.2 (Shutdown)      — after 1.1
    Epic 7 (Attention Zones) — independent (can use SSE if available)
    Epic 8 (E2E Tests)       — after all other epics
```

**Parallelizable streams**:
- Stream A: Epic 1 (Event System) → Epic 2 (Notifications) → Epic 6 (Reliability)
- Stream B: Epic 3 (Batch Spawn) — fully independent
- Stream C: Epic 4 (Cost Tracking) — fully independent
- Stream D: Epic 5 (npm Distribution) — fully independent
- Stream E: Epic 7 (Dashboard Zones) — fully independent
- Stream F: Epic 8 (E2E Tests) — last, after everything else

## Estimated Effort

| Epic | Size | Agent-Hours | Priority |
|------|------|-------------|----------|
| 1. Event System + RT Dashboard | Large | 8-12h | P0 |
| 2. Notification Routing | Medium | 4-6h | P0 |
| 3. Batch Spawn | Small | 2-4h | P0 |
| 4. Cost Tracking | Medium | 4-6h | P1 |
| 5. npm Distribution | Medium | 4-6h | P0 |
| 6. Session Restore | Medium | 4-6h | P1 |
| 7. Dashboard Attention Zones | Medium | 3-5h | P1 |
| 8. E2E Tests | Large | 6-8h | P1 |

**Total**: ~35-53 agent-hours across 8 epics, 15 tasks.

## Open Questions

1. **npm scope**: `@composio/agent-orchestrator` or just `agent-orchestrator`? Need to check npm name availability.
2. **Event bus complexity**: Should we use a simple EventEmitter + JSONL, or something more structured? Recommendation: keep simple.
3. **Dashboard framework**: Current dashboard uses polling. Should SSE be the only path, or keep polling as fallback?
4. **Mobile app**: packages/mobile exists but unclear priority. Should it be in v1.0 scope?
5. **Auto-merge**: Should auto-merge be enabled by default or require explicit opt-in? Recommendation: opt-in (current behavior).
