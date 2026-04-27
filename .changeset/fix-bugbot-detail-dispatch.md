---
"@aoagents/ao-core": minor
---

Enrich lifecycle events with PR/issue context for webhook consumers. All events now carry `context.pr` (url, title, number, branch) and `context.issueId`/`context.issueTitle` when available.

Additional changes:
- Persist `issueTitle` in session metadata during spawn for round-trip availability.
- Refactor `executeReaction()` to accept a full `Session` object instead of separate `sessionId`/`projectId` args.
- Fix review-check logic missing new bugbot comments from the latest push (#895) — the `bugbot-comments` reaction now dispatches a detailed message with all automated comments.
- Add `spawn-target` module for unified issue/PR target resolution.
- Add `format-automated-comments` utility for sanitized bot comment rendering.
