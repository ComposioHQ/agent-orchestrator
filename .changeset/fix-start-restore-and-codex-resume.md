"@aoagents/ao-cli": patch
"@aoagents/ao-web": patch
"@aoagents/ao-plugin-agent-codex": patch
---

Fix restore behavior across AO session recovery flows.

- restore the latest dead-but-restorable orchestrator on `ao start` instead of silently spawning a new orchestrator when tmux is gone
- make worker session orchestrator navigation prefer the most recently active live orchestrator for the project
- make permissionless Codex restores preserve dangerous bypass semantics so resumed workers behave like fresh permissionless launches
