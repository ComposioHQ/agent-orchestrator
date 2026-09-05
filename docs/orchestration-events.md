# Orchestration events

AO starts project-orchestrator turns from normalized worker and SCM facts. The
daemon owns the outbox, timers, destination lookup, safety checks, and
acknowledgement. Electron, SSE clients, shell loops, cron, and agent-side
extensions are not schedulers.

## Semantics

- `worker_turn_settled` means the harness has no queued automatic continuation.
  It never means task completion.
- `worker_blocked`, `worker_ready_to_merge`, `worker_terminated`, and
  `pr_merged` are separate normalized facts.
- Repeated observations deduplicate by project, worker, kind, and durable source
  revision. SCM sources use a persisted generation so an exit and recurrence
  re-arms delivery.

The machine prompt contains only AO event IDs, enums, worker IDs, and source
revisions. It excludes PR titles, comments, logs, branches, issue bodies,
transcripts, environment values, and credentials. It identifies itself as
automation, grants no permission, requests one fresh AO reconciliation, and
then tells the orchestrator to end the turn.

## Delivery policy

AO resolves the current non-terminated orchestrator at every attempt. Blocked,
waiting-input, exited, startup-pending, and input-gated sessions receive no
write. A busy Chat orchestrator receives a durable queued follow-up using the
batch ID as its client-message ID. A busy TUI orchestrator waits until idle.

One turn carries at most 50 events or 32 KiB. Chat provider admission is an
acknowledgement. A TUI pane write is only `submitted`; the exact matching
prompt-submit lifecycle hook changes it to `acknowledged`.

Transport calls have a five-second deadline. Failures use persisted exponential
backoff with bounded jitter and a 60-second maximum. Eight attempts or fifteen
minutes results in `dead_letter`. An ambiguous TUI submission is retried
physically at most once. Missing destinations consume no transport attempts and
set `attentionRequiredAt` after fifteen minutes.

Pending rows are capped at 30 days and 10,000 per project. Overflow is retained
as visible dead-letter state rather than deleted. Inspect state with:

```text
GET /api/v1/projects/{id}/orchestration-events?limit=100
```

Explicitly re-arm a dead letter with:

```text
POST /api/v1/projects/{id}/orchestration-events/{eventId}/retry
```

There is no endless automatic retry after dead-lettering.

## Configuration

The dispatcher is daemon-owned and enabled with lifecycle processing. There is
no repository hook, polling script, or desktop-client setting. Existing session
mode, lifecycle hooks, provider configuration, and the sessionguard input lease
determine whether a destination can safely accept a turn.

## Upgrade and rollback

Migration 0127 adds orchestration tables without changing projects, sessions,
notifications, or conversations. Startup reclaims expired leases and scans due
work independently of UI clients. Existing installations do not infer historic
idle rows as completed tasks.

For rollback, stop the newer daemon before installing an older build. Older
builds ignore the additive tables. They do not dispatch pending events or damage
them; reinstalling the newer build resumes recovery. Do not manually edit or
drop the outbox. Back up the normal AO data directory before manual database
maintenance.
