---
"@aoagents/ao-core": minor
"@aoagents/ao-cli": minor
---

Allow workers to report non-terminal PR workflow events like `pr-created`, `draft-pr-created`, and `ready-for-review` with optional PR URL/number metadata, while keeping merged and closed PR state SCM-owned.

**Migration:** `Session` now carries canonical lifecycle truth in `session.lifecycle`
and explicit activity-evidence metadata in `session.activitySignal`. Third-party
callers that construct `Session` objects directly must populate those fields or
route through the core session helpers that synthesize them.
