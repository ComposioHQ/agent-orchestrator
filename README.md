# Agent Orchestrator

Orchestrate parallel AI coding agents across any runtime, any repository, any issue tracker.

## Quick Start

**macOS / Linux:**
```bash
git clone https://github.com/ComposioHQ/agent-orchestrator.git
cd agent-orchestrator && bash scripts/setup.sh
cd ~/your-project && ao init --auto && ao start
```

**Windows (PowerShell):**
```powershell
git clone https://github.com/ComposioHQ/agent-orchestrator.git
cd agent-orchestrator
# Install pnpm if not already installed
iwr https://get.pnpm.io/install.ps1 -useb | iex
# Restart PowerShell, then:
pnpm install
pnpm build
cd packages/cli && pnpm link --global && cd ../..
cd $HOME\your-project && ao init --auto && ao start
```

**Windows (WSL or Git Bash):** Use the macOS/Linux instructions above.

Dashboard opens at http://localhost:3000


## Overview

Agent Orchestrator manages multiple AI coding agents working in parallel on your repository. Each agent operates in isolation using separate git worktrees, handles its own pull request lifecycle, and automatically responds to CI failures and review comments.

**Key features:**

- **Parallel execution** - Work on multiple issues simultaneously
- **Human-in-the-loop** - Agents escalate to you only when judgment is needed
- **Fully pluggable** - Swap any component (runtime, agent, tracker, SCM)
- **Real-time dashboard** - Monitor all agents from a unified interface

## Features

- **Agent-agnostic**: Claude Code, Codex, Aider, or bring your own
- **Runtime-agnostic**: tmux, Docker, Kubernetes, or custom
- **Tracker-agnostic**: GitHub Issues, Linear, Jira, or custom
- **Auto-reactions**: CI failures, review comments, merge conflicts handled automatically
- **Notifications**: Desktop, Slack, Composio, or webhook - only when needed
- **Live terminal**: Watch agents work in real-time through the browser

## Architecture

Eight plugin slots - every abstraction is swappable:

| Slot      | Interface   | Default     | Alternatives             |
| --------- | ----------- | ----------- | ------------------------ |
| Runtime   | `Runtime`   | tmux        | docker, k8s, process     |
| Agent     | `Agent`     | claude-code | codex, aider, opencode   |
| Workspace | `Workspace` | worktree    | clone                    |
| Tracker   | `Tracker`   | github      | linear, jira             |
| SCM       | `SCM`       | github      | (gitlab, bitbucket)      |
| Notifier  | `Notifier`  | desktop     | slack, composio, webhook |
| Terminal  | `Terminal`  | iterm2      | web                      |
| Lifecycle | core        | —           | —                        |

All interfaces are defined in `packages/core/src/types.ts`.

## Installation

### Prerequisites

- Node 20+
- Git 2.25+
- tmux — macOS/Linux only, required for the default tmux runtime (`brew install tmux` / `apt install tmux`)
- gh CLI — for GitHub integration ([install guide](https://cli.github.com))

> **Windows note:** tmux is not available on native Windows. Use WSL (Windows Subsystem for Linux) for full compatibility, or switch to the `process` runtime in your config.

### Setup

#### macOS / Linux

```bash
git clone https://github.com/ComposioHQ/agent-orchestrator.git
cd agent-orchestrator
bash scripts/setup.sh
```

The setup script automatically installs pnpm if missing (no sudo/root needed), installs dependencies, builds all packages, rebuilds node-pty from source, and links the `ao` CLI globally.

#### Windows (PowerShell)

```powershell
# 1. Clone the repo
git clone https://github.com/ComposioHQ/agent-orchestrator.git
cd agent-orchestrator

# 2. Install pnpm (if not already installed)
iwr https://get.pnpm.io/install.ps1 -useb | iex
# Close and reopen PowerShell after this step

# 3. Install dependencies and build
pnpm install
pnpm build

# 4. Link the CLI globally
cd packages/cli
pnpm link --global
cd ../..
```

#### Windows (WSL or Git Bash)

Use the macOS/Linux instructions above — the bash script works without changes inside WSL or Git Bash.

### Initialize Your Project

```bash
cd ~/your-project
ao init --auto  # Auto-detects project type, generates config
ao start        # Launches orchestrator and dashboard
```

Auto-detection recognizes your git repository, remote, project type (languages, frameworks, test runners), and generates custom agent rules based on your stack.

## Usage

### Spawn Agents

```bash
# Spawn agent for a GitHub issue
ao spawn my-project 123

# Spawn for a Linear issue
ao spawn my-project INT-1234

# Spawn without issue (ad-hoc work)
ao spawn my-project
```

### Monitor Progress

```bash
# Command-line dashboard
ao status

# Web dashboard (default port 3000, configurable in agent-orchestrator.yaml)
open http://localhost:3000
```

### Manage Sessions

```bash
# List all sessions
ao session ls

# Send message to agent
ao send <session-id> "Fix the linting errors"

# Kill session
ao session kill <session-id>
```

### Auto-Reactions

Configure automatic responses to common scenarios:

```yaml
reactions:
  ci-failed:
    auto: true
    action: send-to-agent
    retries: 3

  changes-requested:
    auto: true
    action: send-to-agent
    escalateAfter: 1h

  approved-and-green:
    auto: true
    action: auto-merge
```

## Configuration

Basic configuration in `agent-orchestrator.yaml`:

```yaml
port: 3000  # Dashboard port (each project needs a unique port if running multiple)

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
    agentRules: |
      Always run tests before pushing.
      Use conventional commits.
      Write clear commit messages.
```

See `agent-orchestrator.yaml.example` for complete reference documentation.

## Examples

The `examples/` directory contains configuration templates:

- `simple-github.yaml` - Minimal GitHub Issues setup
- `linear-team.yaml` - Linear integration
- `multi-project.yaml` - Multiple repositories
- `auto-merge.yaml` - Aggressive automation

## Development

```bash
pnpm install
pnpm build
pnpm dev  # Start web dev server
```

### Project Structure

```
packages/
  core/          - Core types and services
  cli/           - ao command-line tool
  web/           - Next.js dashboard
  plugins/
    runtime-*/   - Runtime plugins
    agent-*/     - Agent plugins
    workspace-*/ - Workspace plugins
    tracker-*/   - Tracker plugins
    scm-*/       - SCM plugins
    notifier-*/  - Notifier plugins
    terminal-*/  - Terminal plugins
```

## Design Philosophy

**Push, not pull:** Spawn agents, step away, get notified only when your judgment is needed.

- Stateless orchestrator (filesystem over database)
- Plugin everything (no vendor lock-in)
- Amplify human judgment, don't bypass it
- Auto-handle routine work, escalate complex decisions

## Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common issues and solutions.

**Common issues:**

- Terminal not working → node-pty rebuild (automatic via postinstall hook)
- Port in use → Change `port:` in config or kill existing server (`lsof -ti:3000 | xargs kill`)
- Config not found → Run `ao init` from your project directory

## Contributing

Contributions welcome. See `CLAUDE.md` for code conventions and architecture details.

## License

MIT

## Documentation

- [Setup Guide](SETUP.md) - Detailed setup and configuration
- [Examples](examples/) - Config templates for common use cases
- [CLAUDE.md](CLAUDE.md) - Code conventions and architecture
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) - Common issues and fixes
