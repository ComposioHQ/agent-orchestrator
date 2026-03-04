# Issue Lifecycle & PR Adoption Design

**Date:** 2026-03-04
**Branch:** `feature/refine-issue-lifecycle-flow`
**Status:** Approved

## Problem

The dashboard has zero visibility into issues. To assign work to an agent, a human must:
1. Open Linear, find an issue, copy the URL
2. Come back to the dashboard, paste it into the Spawn dialog

There's no way to see what's ready, no way to triage, and no automation between "issue is ready" and "agent is working." Additionally, when a human opens a PR (not from a spawned agent), the dashboard shows it but offers no actions — can't review it, can't run the pipeline on it.

## Solution

Three features that close the gap between issue tracker and agent orchestrator:

### 1. Issue Triage Queue

**Home page panel** showing all Linear issues in "Todo" (configurable) state that:
- Do NOT have the `agent-ready` label
- Do NOT have an active session
- Are not closed/cancelled

Each row shows: issue label, title, priority. An **"Assign"** button adds the `agent-ready` label and triggers immediate agent spawn.

A **"View All"** link goes to the full `/issues` page.

**Config:**
```yaml
issueQueue:
  readyState: "Todo"
  agentLabel: "agent-ready"
  failedLabel: "agent-failed"
  maxRetries: 1
```

### 2. Auto-Spawn on Label

When an issue gets the `agent-ready` label (from dashboard or Linear directly):

**From dashboard (immediate):**
- "Assign" button calls `PUT /api/issues/:id/assign`
- Adds `agent-ready` label via `tracker.updateIssue()`
- Immediately spawns agent via `sessionManager.spawn()`

**From Linear (webhook):**
- Linear webhook fires on label change
- Detects `agent-ready` label added
- Spawns agent

**Guards:**
- Skip if issue already has an active session (prevent double-spawn)
- Skip if issue is closed/cancelled
- Log event: `issue.auto_spawned`

### 3. Failure Guard (Anti-Respawn Loop)

When a session dies (stuck, errored, killed) for an `agent-ready` issue:
- Add `agent-failed` label to the issue
- Remove `agent-ready` label (prevents re-spawn)
- Notify via configured notifier
- Issue appears in "Failed" attention zone on dashboard
- Human can click "Retry" (re-adds `agent-ready`, removes `agent-failed`)

### 4. `/issues` Page

Full issue browser showing all issues across states with session linkage:
- Filter by state, priority, label
- Search by title
- Status indicators: ready (unassigned), working (has session), failed, done
- "Assign" button on ready issues, "Retry" on failed
- Click to expand: linked session, PR, timeline
- Bulk select + "Assign All" for batch triage

**API:** `GET /api/issues?state=open&project=myapp`
- Calls `tracker.listIssues()`
- Cross-references active sessions to show linkage

### 5. Adopt Human PR

Unlinked PRs in the PR table get an **"Adopt"** button:
1. Creates session with `role: "pipeline"` (no coder agent)
2. Links PR to session via metadata
3. Runs full pipeline: checks -> test agent -> review agent
4. Posts review comments on PR if issues found
5. Session tracks on the board like any other

If the PR links to a Linear issue (detected from branch name or PR body), the session also links to that issue.

**API:** `POST /api/prs/:id/adopt`

## Data Flow

```
Linear issue (Ready/Todo state)
  -> appears in dashboard Issue Queue
  -> human clicks "Assign" (or labels in Linear)
  -> agent-ready label added
  -> agent spawns immediately
  -> working -> pipeline -> PR -> review -> merge
  -> issue moves to Done

  (if agent fails)
  -> agent-failed label, notification sent
  -> appears in Failed zone
  -> human clicks Retry or handles manually

Human opens PR (no agent)
  -> appears in PR table as unlinked
  -> human clicks "Adopt"
  -> pipeline session created
  -> checks -> test agent -> review agent
  -> review posted on PR
```

## New API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `GET /api/issues` | GET | List issues with filters, cross-referenced with sessions |
| `PUT /api/issues/:id/assign` | PUT | Add agent-ready label + spawn agent |
| `PUT /api/issues/:id/retry` | PUT | Remove agent-failed, add agent-ready, re-spawn |
| `POST /api/prs/:id/adopt` | POST | Create pipeline session for unlinked PR |

## New Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `IssueQueue.tsx` | Home page panel | Compact ready-issues list with Assign buttons |
| `IssuesPage.tsx` | `/issues` route | Full issue browser with filters and bulk actions |
| `IssueRow.tsx` | Shared | Single issue row with status, linkage, actions |
| `AdoptButton.tsx` | PR table | "Adopt" action on unlinked PRs |

## Config Changes

Add to `agent-orchestrator.yaml`:
```yaml
issueQueue:
  readyState: "Todo"           # Linear state to pull from
  agentLabel: "agent-ready"    # Label that triggers auto-spawn
  failedLabel: "agent-failed"  # Applied on terminal failure
  maxRetries: 1                # Re-spawns before giving up
```

## Events

New event types:
- `issue.auto_spawned` — agent spawned from label
- `issue.failed` — agent failed, issue labeled agent-failed
- `issue.retried` — human retried a failed issue
- `pr.adopted` — human PR adopted into pipeline
