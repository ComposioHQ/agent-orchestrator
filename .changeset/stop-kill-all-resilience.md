---
"@aoagents/ao-cli": patch
---

Harden `ao stop` to continue killing remaining orchestrator sessions when one fails mid-loop, reporting partial failures instead of aborting. Also unify `allSessionPrefixes` derivation between start and stop commands, and restore fd-safety in the advisory lockfile `tryAcquire` function.
