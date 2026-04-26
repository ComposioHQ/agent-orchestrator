---
"@aoagents/ao-plugin-tracker-github": patch
---

tracker-github: cache `gh issue view` responses in-process (5 min TTL, bounded LRU)

The lifecycle worker polls `getIssue` and `isCompleted` repeatedly for the same
issue across a session. In a 5-session tier-5 bench run (10 min), trace data
showed the same `(repo, issue)` pair fetched 64+ times with >97% duplicate rate.

This change caches the full `Issue` object per `(repo, identifier)` for 5
minutes inside each `createGitHubTracker()` instance. `isCompleted` now routes
through `getIssue` to share the cache. `updateIssue` invalidates the cache
entry on any mutation. Failures are not cached.

Expected reduction: ~744 `gh issue view` calls per tier-5 run → ~15 calls.
