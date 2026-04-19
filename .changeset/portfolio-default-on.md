---
"@aoagents/ao-core": minor
"@aoagents/ao-cli": patch
"@aoagents/ao-web": patch
---

Multi-project portfolio is now on by default. `AO_ENABLE_PORTFOLIO` no longer needs to be set to `1` to use `ao project`, `ao spawn --project`, or the settings UI. To opt out and keep the single-project redirect, set `AO_ENABLE_PORTFOLIO=0` (or `false`). Error messages and the multi-project guide updated to match.
