---
"@aoagents/ao-core": patch
"@aoagents/ao-web": patch
---

Model activity evidence explicitly across lifecycle inference and dashboard rendering so missing or failed probes cannot spuriously produce idle or stuck interpretations. This also stabilizes repeated polls by preserving stronger prior lifecycle states when the only new evidence is weak or unavailable.
