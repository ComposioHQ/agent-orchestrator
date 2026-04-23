---
"@aoagents/ao-core": patch
"@aoagents/ao-web": patch
---

Decouple canonical session state from PR state so workers stay idle while waiting on reviews or merged/closed PR decisions, stop cleanup from auto-killing merged PR sessions, and make the dashboard/rendered labels follow canonical PR truth instead of inferring it from legacy lifecycle aliases.
