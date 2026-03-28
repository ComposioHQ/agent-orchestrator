# @composio/ao-cli

## 0.2.1

### Patch Changes

- ac625c3: Fix startup onboarding and install reliability:
  - Repair npm global install startup path by improving package resolution and web package discovery hints.
  - Make `ao start` prerequisite installs explicit and interactive for required tools (`tmux`, `git`) with clearer fallback guidance.
  - Keep `ao spawn` preflight check-only for `tmux` (no implicit install).
  - Remove redundant agent runtime re-detection during config generation.

## 0.2.0

### Minor Changes

- 3a650b0: Zero-friction onboarding: `ao start` auto-detects project, generates config, and launches dashboard — no prompts, no manual setup. Renamed npm package to `@composio/ao`. Made `@composio/ao-web` publishable with production entry point. Cross-platform agent detection. Auto-port-finding. Permission auto-retry in shell scripts.

### Patch Changes

- Updated dependencies [3a650b0]
  - @composio/ao-core@0.2.0
  - @composio/ao-web@0.2.0
  - @composio/ao-plugin-agent-claude-code@0.2.0
  - @composio/ao-plugin-agent-aider@0.2.0
  - @composio/ao-plugin-agent-codex@0.2.0
  - @composio/ao-plugin-agent-opencode@0.2.0
  - @composio/ao-plugin-notifier-composio@0.2.0
  - @composio/ao-plugin-notifier-desktop@0.2.0
  - @composio/ao-plugin-notifier-openclaw@0.1.1
  - @composio/ao-plugin-notifier-slack@0.2.0
  - @composio/ao-plugin-notifier-webhook@0.2.0
  - @composio/ao-plugin-runtime-process@0.2.0
  - @composio/ao-plugin-runtime-tmux@0.2.0
  - @composio/ao-plugin-scm-github@0.2.0
  - @composio/ao-plugin-terminal-iterm2@0.2.0
  - @composio/ao-plugin-terminal-web@0.2.0
  - @composio/ao-plugin-tracker-github@0.2.0
  - @composio/ao-plugin-tracker-linear@0.2.0
  - @composio/ao-plugin-workspace-clone@0.2.0
  - @composio/ao-plugin-workspace-worktree@0.2.0
