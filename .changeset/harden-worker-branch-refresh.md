---
"@aoagents/ao-core": patch
---

Harden worker branch refresh during lifecycle polling by preserving branch metadata through transient detached Git states, skipping orchestrators and active open PRs, and preventing duplicate branch adoption within a single poll cycle.
