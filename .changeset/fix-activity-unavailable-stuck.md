---
"@aoagents/ao-core": patch
---

Stop carrying forward `stuck` / `probe_failure` session truth when the runtime is still confirmed alive and activity is merely unavailable, and degrade that combination to `detecting` until stronger evidence arrives.
