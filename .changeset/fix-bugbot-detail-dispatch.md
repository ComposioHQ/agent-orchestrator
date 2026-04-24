---
"@aoagents/ao-core": patch
---

Fix review-check logic missing new bugbot comments from the latest push (#895). The `bugbot-comments` reaction now dispatches a detailed message listing every already-fetched automated comment (severity, path:line, excerpt, URL) plus explicit correct-API guidance (`/reviews` → paginated `/reviews/{id}/comments` → paginated `/pulls/{pr}/comments` with `in_reply_to_id`), so the agent never has to rediscover comments with a first-page-only scan.

**Safe by design:**
- Only replaces the message when it matches the built-in sentinel `DEFAULT_BUGBOT_COMMENTS_MESSAGE` — projects that customized `reactions.bugbot-comments.message` in their YAML are untouched.
- Bot comment bodies are sanitized (backticks stripped) and wrapped in a code span, with an "untrusted data" preamble instructing the agent not to treat excerpts as instructions.
