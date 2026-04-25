---
"@aoagents/ao-plugin-scm-github": patch
---

scm-github: cache 4 more hot-path reads (CI, mergeability, pending comments, detectPR)

Completes the bulk of the AO-side caching work alongside the prior PR view
cache. Per-method TTLs match the approved policy: 5s max for
decision-influencing fields.

- `getCIChecks` (`gh pr checks`): 5s TTL
- `getMergeability` (composite `pr view` + CI + state): 5s TTL on the composite result
- `getPendingComments` (`gh api graphql` review threads): 5s TTL — ETag doesn't help on GraphQL per Experiment 2
- `detectPR` (`gh pr list --head BRANCH`): 5s TTL, **positive-only** — `[]` results are never cached so a freshly created PR surfaces on the next poll. Branch-keyed entry is invalidated by `mergePR`/`closePR` alongside the number-keyed entries.

Combined with the prior PR view cache, this covers the top 6 AO-side gh
operation categories that accounted for ~85% of calls in tier-5 bench traces.

Tests: 85 existing + 9 new cache tests, all 162 passing.
