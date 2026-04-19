---
"@aoagents/ao-plugin-agent-codex": patch
"@aoagents/ao-plugin-agent-claude-code": patch
"@aoagents/ao-web": patch
---

Improve Claude Code and Codex session cost estimates to account for cached-token spend, make Codex restore commands fall back to approval prompts for worker sessions instead of blindly reusing dangerous bypass flags, and register the Codex plugin in the web dashboard so native activity detection works there.
