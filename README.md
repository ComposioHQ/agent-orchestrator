# Agent Orchestrator

Orchestrate parallel AI coding agents across any runtime, any repo, any issue tracker.

## Quick Start

```bash
git clone https://github.com/ComposioHQ/agent-orchestrator.git
cd agent-orchestrator && bash scripts/setup.sh
cd ~/your-project && ao init --auto && ao start
```

**That's it!** Dashboard opens at http://localhost:3000

## What Is This?

Agent Orchestrator spawns and manages multiple AI coding agents working in parallel on your repository. Each agent works in isolation (separate worktrees), handles its own PR lifecycle, and auto-responds to CI failures and review comments.

**Key benefits:**
- 🚀 **10-30x productivity** - Work on 10+ issues simultaneously
- 🤖 **Human-in-the-loop** - Agents notify you when judgment needed, not for routine work
- 🔌 **Fully pluggable** - Swap any component (runtime, agent, tracker, SCM)
- 📊 **Real-time dashboard** - Monitor all agents from one place

**Built itself:** This project was built using itself (399 commits, 34 PRs, 63 hours of dog-fooding).

## Features

- **Agent-agnostic**: Claude Code, Codex, Aider, or bring your own
- **Runtime-agnostic**: tmux, Docker, Kubernetes, or custom
- **Tracker-agnostic**: GitHub Issues, Linear, Jira, or custom
- **Auto-reactions**: CI failures, review comments, merge conflicts → handled automatically
- **Notifications**: Desktop, Slack, Composio, or webhook - only when you're needed
- **Live terminal**: See agents working in real-time through browser

## Architecture

8 plugin slots - every abstraction is swappable:

| Slot      | Interface   | Default   | Alternatives          |
|-----------|-------------|-----------|-----------------------|
| Runtime   | `Runtime`   | tmux      | docker, k8s, process  |
| Agent     | `Agent`     | claude-code | codex, aider, opencode |
| Workspace | `Workspace` | worktree  | clone                 |
| Tracker   | `Tracker`   | github    | linear, jira          |
| SCM       | `SCM`       | github    | (gitlab, bitbucket)   |
| Notifier  | `Notifier`  | desktop   | slack, composio, webhook |
| Terminal  | `Terminal`  | iterm2    | web                   |
| Lifecycle | core        | —         | —                     |

## Installation

### Prerequisites

- Node 20+
- Git 2.25+
- tmux (for tmux runtime)
- gh CLI (for GitHub integration)

### Setup

```bash
# Clone and run setup
git clone https://github.com/ComposioHQ/agent-orchestrator.git
cd agent-orchestrator
bash scripts/setup.sh
```

The setup script:
- Installs dependencies with pnpm
- Builds all packages
- Rebuilds node-pty from source (fixes terminal issues)
- Links `ao` CLI globally

### Initialize Your Project

```bash
cd ~/your-project
ao init --auto  # Auto-detects project type, generates config
ao start        # Launches orchestrator + dashboard
```

**Auto-detection:**
- Git repo and remote
- Project type (languages, frameworks, test runners)
- Generates custom agent rules based on your stack

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

# Web dashboard
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

Configure reactions for common scenarios:

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

Basic config (`agent-orchestrator.yaml`):

```yaml
dataDir: ~/.agent-orchestrator
worktreeDir: ~/.worktrees
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
    agentRules: |
      Always run tests before pushing.
      Use conventional commits.
      Write clear commit messages.
```

See `agent-orchestrator.yaml.example` for full reference.

## Examples

See `examples/` directory for:
- `simple-github.yaml` - Minimal GitHub Issues setup
- `linear-team.yaml` - Linear integration
- `multi-project.yaml` - Multiple repos
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

## Testing

### Quick Verification Test

Verify your setup is working correctly:

```bash
# Automated test (5 seconds)
./scripts/test-orchestrator-setup.sh

# Manual test - see QUICKTEST.md for details
```

See [QUICKTEST.md](QUICKTEST.md) for detailed test procedures and troubleshooting.

## Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common issues and solutions.

**Most common:**
- Terminal not working → node-pty rebuild (automatic via postinstall hook)
- Port in use → Kill existing server or change port in config
- Config not found → Run `ao init` from your project directory

## Philosophy

**Push, not pull:** Spawn agents, walk away, get notified only when your judgment is needed.

- Stateless orchestrator (filesystem > database)
- Plugin everything (no vendor lock-in)
- Amplify judgment, don't bypass it
- Auto-handle routine, escalate complex decisions

## Contributing

Contributions welcome! See `CLAUDE.md` for code conventions and architecture details.

## License

MIT

## Links

- [Setup Guide](SETUP.md) - Detailed setup and configuration
- [Examples](examples/) - Config templates for common use cases
- [CLAUDE.md](CLAUDE.md) - Code conventions and architecture
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) - Common issues and fixes
