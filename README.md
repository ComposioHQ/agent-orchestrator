## OpenClaw Instance — Marc Mantei's Agent Swarm

This fork runs on the OpenClaw instance with Claude Max, managing all projects via Telegram notifications (@SwarmManager_Bot).

### Configured Projects

| Projekt | ao-Befehl | Prefix | Model |
|---|---|---|---|
| ChargePilot Launch | `ao spawn chargepilot <issue>` | cp- | opus |
| ChargePilot App | `ao spawn chargepilot-app <issue>` | cpa- | opus |
| getchargepilot.app | `ao spawn getchargepilot <issue>` | gcp- | sonnet |
| mitbeziehung.de | `ao spawn mitbeziehung <issue>` | mb- | sonnet |
| Event Platform | `ao spawn event-platform <issue>` | emp- | opus |

### Extras (nicht im Upstream)
- Dashboard bindet auf `0.0.0.0` (LAN-Zugang)
- Telegram Bridge (`~/.openclaw/telegram-bridge/bridge.mjs`) via Webhook-Notifier
- Issue Scanner (`~/.openclaw/workspace/.clawdbot/scan-github-issues.sh`) scannt alle 15 min via Cron

### Fork Changes

<!-- FORK_CHANGES_START -->

> **10 commits** since fork (2026-02-24 — 2026-02-25) · 6 features · 2 fixes

**2026-02-25**
- fix: add default messages for send-to-agent reactions (`ee4e742`)
- config: add github tracker to all projects (`566c858`)
- feat: add systemd user-units for reliable service management (`077c5f2`)
- feat: auto-spawn agents for open issues on `ao start` (`168595d`)
- feat: add agent-orchestrator as a managed project (`5140107`)
- feat: add `ao self-update` for controlled self-deployment (`071637d`)
- feat: add automatic PR code review on review_pending state (`4eb50ec`)
- fix: pass notifier config to plugins via extractPluginConfig (`70b82b7`)

**2026-02-24**
- docs: add OpenClaw instance overview to README (`669b0ae`)
- feat: bind dashboard and dev server to 0.0.0.0 for LAN access (`8282ee2`)

<!-- FORK_CHANGES_END -->

---

<div align="center">

# Agent Orchestrator — The Orchestration Layer for Parallel AI Agents

Spawn parallel AI coding agents, each in its own git worktree. Agents autonomously fix CI failures, address review comments, and open PRs — you supervise from one dashboard.

[![GitHub stars](https://img.shields.io/github/stars/ComposioHQ/agent-orchestrator?style=flat-square)](https://github.com/ComposioHQ/agent-orchestrator/stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![PRs merged](https://img.shields.io/badge/PRs_merged-61-brightgreen?style=flat-square)](https://github.com/ComposioHQ/agent-orchestrator/pulls?q=is%3Amerged)
[![Tests](https://img.shields.io/badge/test_cases-3%2C288-blue?style=flat-square)](https://github.com/ComposioHQ/agent-orchestrator/releases/tag/metrics-v1)

</div>

---

Agent Orchestrator manages fleets of AI coding agents working in parallel on your codebase. Each agent gets its own git worktree, its own branch, and its own PR. When CI fails, the agent fixes it. When reviewers leave comments, the agent addresses them. You only get pulled in when human judgment is needed.

**Agent-agnostic** (Claude Code, Codex, Aider) · **Runtime-agnostic** (tmux, Docker) · **Tracker-agnostic** (GitHub, Linear)

<!-- TODO: Add dashboard screenshot or terminal GIF showing 10+ sessions with attention zones -->

## Quick Start

```bash
# Install
git clone https://github.com/ComposioHQ/agent-orchestrator.git
cd agent-orchestrator && bash scripts/setup.sh

# Configure your project
cd ~/your-project && ao init --auto

# Launch and spawn an agent
ao start
ao spawn my-project 123    # GitHub issue, Linear ticket, or ad-hoc
```

Dashboard opens at `http://localhost:3000`. Run `ao status` for the CLI view.

## How It Works

```
ao spawn my-project 123
```

1. **Workspace** creates an isolated git worktree with a feature branch
2. **Runtime** starts a tmux session (or Docker container)
3. **Agent** launches Claude Code (or Codex, or Aider) with issue context
4. Agent works autonomously — reads code, writes tests, creates PR
5. **Reactions** auto-handle CI failures and review comments
6. **Notifier** pings you only when judgment is needed

### Plugin Architecture

Eight slots. Every abstraction is swappable.

| Slot | Default | Alternatives |
|------|---------|-------------|
| Runtime | tmux | docker, k8s, process |
| Agent | claude-code | codex, aider, opencode |
| Workspace | worktree | clone |
| Tracker | github | linear |
| SCM | github | — |
| Notifier | desktop | slack, composio, webhook |
| Terminal | iterm2 | web |
| Lifecycle | core | — |

All interfaces defined in [`packages/core/src/types.ts`](packages/core/src/types.ts). A plugin implements one interface and exports a `PluginModule`. That's it.

## Configuration

```yaml
# agent-orchestrator.yaml
port: 3000

defaults:
  runtime: tmux
  agent: claude-code
  workspace: worktree
  notifiers: [desktop]

projects:
  my-app:
    repo: owner/my-app
    path: ~/my-app
    defaultBranch: main
    sessionPrefix: app

reactions:
  ci-failed:
    auto: true
    action: send-to-agent
    retries: 2
  changes-requested:
    auto: true
    action: send-to-agent
    escalateAfter: 30m
  approved-and-green:
    auto: false       # flip to true for auto-merge
    action: notify
```

CI fails → agent gets the logs and fixes it. Reviewer requests changes → agent addresses them. PR approved with green CI → you get a notification to merge.

See [`agent-orchestrator.yaml.example`](agent-orchestrator.yaml.example) for the full reference.

## CLI

```bash
ao status                              # Overview of all sessions
ao spawn <project> [issue]             # Spawn an agent
ao send <session> "Fix the tests"      # Send instructions
ao session ls                          # List sessions
ao session kill <session>              # Kill a session
ao session restore <session>           # Revive a crashed agent
ao dashboard                           # Open web dashboard
```

## Why Agent Orchestrator?

Running one AI agent in a terminal is easy. Running 30 across different issues, branches, and PRs is a coordination problem.

**Without orchestration**, you manually: create branches, start agents, check if they're stuck, read CI failures, forward review comments, track which PRs are ready to merge, clean up when done.

**With Agent Orchestrator**, you: `ao spawn` and walk away. The system handles isolation, feedback routing, and status tracking. You review PRs and make decisions — the rest is automated.

## Prerequisites

- Node.js 20+
- Git 2.25+
- tmux (for default runtime)
- `gh` CLI (for GitHub integration)

## Development

```bash
pnpm install && pnpm build    # Install and build all packages
pnpm test                      # Run tests (3,288 test cases)
pnpm dev                       # Start web dashboard dev server
```

See [CLAUDE.md](CLAUDE.md) for code conventions and architecture details.

## Documentation

| Doc | What it covers |
|-----|---------------|
| [Setup Guide](SETUP.md) | Detailed installation and configuration |
| [Examples](examples/) | Config templates (GitHub, Linear, multi-project, auto-merge) |
| [CLAUDE.md](CLAUDE.md) | Architecture, conventions, plugin pattern |
| [Troubleshooting](TROUBLESHOOTING.md) | Common issues and fixes |

## Contributing

Contributions welcome. The plugin system makes it straightforward to add support for new agents, runtimes, trackers, and notification channels. Every plugin is an implementation of a TypeScript interface — see [CLAUDE.md](CLAUDE.md) for the pattern.

## License

MIT
