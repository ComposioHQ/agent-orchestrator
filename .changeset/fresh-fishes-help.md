---
"@composio/ao-cli": patch
"@composio/ao": patch
---

Fix startup onboarding and install reliability:

- Repair npm global install startup path by improving package resolution and web package discovery hints.
- Make `ao start` prerequisite installs explicit and interactive for required tools (`tmux`, `git`) with clearer fallback guidance.
- Keep `ao spawn` preflight check-only for `tmux` (no implicit install).
- Remove redundant agent runtime re-detection during config generation.

