---
"@aoagents/ao-core": patch
---

Keep lifecycle observability and batch diagnostic logs out of user-visible terminal stderr by routing them into AO's observability audit files instead, while preserving structured traces for debugging and regression coverage.
