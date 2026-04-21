"@aoagents/ao-core": patch
"@aoagents/ao-cli": patch
"@aoagents/ao-web": patch
---

Move orchestrator uniqueness into core and begin the migration to a canonical per-project orchestrator session.

- add `ensureOrchestrator()` in core so orchestrator create/reuse/restore behavior is owned by one deterministic code path
- make fresh projects create a canonical `{sessionPrefix}-orchestrator` session without allocating an orchestrator worktree
- keep backward compatibility with historical numbered orchestrators like `{sessionPrefix}-orchestrator-1` during the migration window
- switch CLI and web callers to the core ensure path, including migration-safe stop behavior for legacy orchestrators
- harden web orchestrator/session flows with safer event-stream cleanup, explicit session-detail error states, and restore UX fixes
