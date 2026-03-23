---
"@composio/ao-cli": patch
"@composio/ao": patch
---

Let non-interactive `ao start` calls reuse an already running dashboard while still starting lifecycle recovery for the requested project.
