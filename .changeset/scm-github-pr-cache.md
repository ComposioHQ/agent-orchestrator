---
"@aoagents/ao-plugin-scm-github": patch
---

scm-github: cache 5 `gh pr view` callsites with per-method TTLs

The lifecycle worker repeatedly polls each PR for state, summary, reviews,
and review decision. Trace data showed `gh pr view` was the single largest
AO-side endpoint at 1,280 calls per 5-session tier-5 run with >97% duplicate
rate (e.g. PR #184 polled 86× for `--json state` alone in 11.5 minutes).

Adds an in-process per-instance cache inside `createGitHubSCM()`, keyed by
`${owner}/${repo}#${prKey}:${method}` so different field-sets stay isolated.
Per-method TTLs balance reduction against staleness on decision-influencing
fields:

- `resolvePR`: 60s (identity metadata only — number, url, title, branch refs, isDraft)
- `getPRState`: 5s
- `getPRSummary`: 5s
- `getReviews`: 5s
- `getReviewDecision`: 5s

`assignPRToCurrentUser`, `mergePR`, and `closePR` each invalidate the entire
PR cache for that PR after the mutation, so AO never sees stale state from
its own writes. Failures are not cached.

`getCIChecksFromStatusRollup` and `getMergeability` are intentionally NOT
cached here — those need ETag-based revalidation, not blind TTL, and will
land in a follow-up change.

Expected reduction: ~1,165 of ~1,280 `gh pr view` calls per tier-5 run.

Tests: 73 existing + 12 new cache tests, all passing.
