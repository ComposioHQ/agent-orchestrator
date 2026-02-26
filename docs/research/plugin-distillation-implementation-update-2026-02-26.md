# Plugin Distillation Deep Update (2026-02-26)

## Scope
This update extends research from:
- `plugin-distillation-research.md`
- `plugin-catalog-industry-standard.md`
- `docs/research/orchestrator-plugin-distillation-2026-02-25.md`

Goal: prioritize fast, high-coverage plugin additions and implement the maximum set that can be landed safely in one PR.

## Additional Source-Backed Research

### Agent CLI integrations
- Gemini CLI command reference and non-interactive prompt mode (`-p`) support were validated from official docs.
- Goose CLI docs validated `goose run -t` style task execution.

### Notifier channel protocols
- Discord webhook execute endpoint confirmed (`POST /webhooks/{id}/{token}`).
- Microsoft Teams message cards / incoming webhook shape confirmed.
- Telegram Bot API `sendMessage` endpoint and `parse_mode` usage confirmed.

### Terminal automation
- Kitty remote control via `kitty @ ...` commands (`ls`, `launch`, etc.) confirmed.
- WezTerm CLI command surface (`wezterm cli ...`) confirmed.

## Distilled Implementation Strategy

Given breadth of cataloged plugins, the highest ROI in a single cycle is:
1. Add agent wrappers that map AO launch config to mainstream CLIs.
2. Add notifier channels with stable webhook/Bot APIs.
3. Add terminal integrations with scriptable tab/session control.
4. Wire all of them into built-in discovery and CLI dependency graph.

This yields broad ecosystem reach with minimal new external SDK dependencies.

## Implemented Plugins in This Cycle

### Agent plugins
- `agent-gemini`
- `agent-goose`
- `agent-amazon-q`
- `agent-kiro`

### Notifier plugins
- `notifier-discord`
- `notifier-teams`
- `notifier-telegram`

### Terminal plugins
- `terminal-kitty`
- `terminal-wezterm`

Total new plugins added: **9**

## Batch-2 Implemented Plugins (this update)

### Runtime
- `runtime-docker`

### Tracker
- `tracker-jira`

### SCM
- `scm-gitlab`

### Notifier
- `notifier-email`

### Terminal
- `terminal-zellij`

Additional plugins added in this update: **5** (cumulative added from distillation so far: **14**).

## Core Wiring Changes
- Registered all 9 plugins in built-in plugin discovery:
  - `packages/core/src/plugin-registry.ts`
- Added new plugin workspace dependencies for CLI runtime resolution:
  - `packages/cli/package.json`
- Added CLI direct-agent resolution support for new agents:
  - `packages/cli/src/lib/plugins.ts`

## Test Coverage Added
- Added unit tests for all 9 new plugin packages (manifest/behavior smoke tests).
- Extended CLI plugin-resolution tests for the new agent names.

## Why This Is a Clean Increment
- No breaking interface changes in `@composio/ao-core`.
- Plugin contracts remain strict and typed (`satisfies PluginModule<...>`).
- New capabilities are additive and config-selectable.
- Provides immediate practical coverage while leaving room for heavier Phase-2 plugins (Jira, GitLab SCM, Docker runtime).

## Next Distillation-to-Implementation Candidates
- `tracker-jira` (P0)
- `scm-gitlab` (P0)
- `runtime-docker` (P0)
- `notifier-email` (P0)
- `terminal-zellij` (P1)

## Sources
- Gemini CLI docs: https://cloud.google.com/gemini/docs/codeassist/gemini-cli
- Gemini CLI command reference: https://cloud.google.com/gemini/docs/codeassist/gemini-cli-commands
- Goose docs: https://block.github.io/goose/docs/
- Discord webhook docs: https://discord.com/developers/docs/resources/webhook#execute-webhook
- Microsoft Teams cards/webhooks: https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/connectors-using
- Telegram Bot API: https://core.telegram.org/bots/api#sendmessage
- Kitty remote control: https://sw.kovidgoyal.net/kitty/remote-control/
- WezTerm CLI: https://wezterm.org/cli/
