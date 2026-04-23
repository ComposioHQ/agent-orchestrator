---
"@aoagents/ao-core": minor
---

Sessions whose PRs are detected as merged now auto-terminate (tmux kill + worktree remove + metadata archive) instead of lingering in the active `sessions/` directory with a `merged` status. `ao status` and `ao session ls` stay clean without an external watchdog.

Enabled by default. Guarded by an idleness check so in-flight agents are not killed mid-task; deferred cleanups retry on each lifecycle poll until the agent idles or a 5-minute grace window elapses.

Opt out or tune via the new top-level `lifecycle` config in `agent-orchestrator.yaml`:

```yaml
lifecycle:
  autoCleanupOnMerge: false         # preserve merged worktrees for inspection
  mergeCleanupIdleGraceMs: 300000   # grace window before forcing cleanup
```

`sessionManager.kill()` now takes an optional `reason` (`"manually_killed" | "pr_merged" | "auto_cleanup"`) and returns `KillResult` (`{ cleaned, alreadyTerminated }`) instead of `void`. All existing call sites ignore the return value so this is backward-compatible in practice.

Closes #1309. Part of #536.
