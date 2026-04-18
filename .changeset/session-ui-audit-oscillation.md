---
"@aoagents/ao-core": patch
"@aoagents/ao-cli": patch
"@aoagents/ao-web": patch
---

Split orchestrator-only detail views from worker detail views, add an auditable history for `ao acknowledge` / `ao report`, and preserve canonical `needs_input` / `stuck` lifecycle states when polling only has weak or unchanged evidence.
