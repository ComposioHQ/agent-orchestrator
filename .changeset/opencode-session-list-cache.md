---
"@aoagents/ao-plugin-agent-opencode": patch
---

Cache opencode session list results for 250ms and dedupe concurrent requests during lifecycle polling to avoid repeated CLI invocations.
