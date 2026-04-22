"@aoagents/ao-core": minor
"@aoagents/ao-cli": minor
"@aoagents/ao-web": minor
---

Move orchestrator uniqueness into core with a single canonical per-project orchestrator session.

- add `ensureOrchestrator()` in core so orchestrator create/reuse/restore behavior is owned by one deterministic code path
- make fresh projects create a canonical `{sessionPrefix}-orchestrator` session without allocating an orchestrator worktree
- remove support for historical numbered orchestrators so callers only operate on the canonical session id
- switch CLI and web callers to the core ensure path and canonical orchestrator id
- harden web orchestrator/session flows with safer event-stream cleanup, explicit session-detail error states, and restore UX fixes

If you still have legacy numbered orchestrators like `{sessionPrefix}-orchestrator-1`, clean them up after upgrading:

- run `ao session ls -p <project>`
- kill any legacy numbered orchestrator sessions with `ao session kill <session-id>`
- restart with `ao stop && ao start` so AO recreates or reuses the canonical `{sessionPrefix}-orchestrator` session
