# Agent Orchestrator (`ao`)

## What it does

Agent Orchestrator (`ao`) spawns and manages **persistent, long-running AI coding sessions** in tmux. Each session gets its own git worktree, works on a single issue, and creates a PR. `ao` monitors CI, reviews, and merge-readiness — escalating to you only when human input is needed.

## When to use it

Use `ao` when the user asks for any of:
- "persistent session", "long-running agent", "background coding session"
- "agent orchestrator", "ao spawn", "ao start"
- spawning an agent to work on a GitHub/GitLab issue
- running multiple coding agents in parallel
- monitoring agent progress across issues

**Do NOT** use `ao` for one-shot questions, code explanations, or tasks that don't need a persistent session.

## Lifecycle

```
ao init          → Create config (agent-orchestrator.yaml)
ao start <proj>  → Launch orchestrator + dashboard + lifecycle worker
ao spawn <proj> <issue>  → Spawn a worker session for an issue
ao status        → Show all sessions, PRs, CI, reviews
ao stop <proj>   → Tear down orchestrator and dashboard
```

### Quick start (URL-based — no config needed)

```bash
ao start https://github.com/owner/repo
# Auto-clones, auto-configures, starts orchestrator
```

### Spawning sessions

```bash
# From configured project
ao spawn my-project #42
ao spawn my-project INT-1234

# Ad-hoc repo (no prior config needed)
ao spawn --repo ComposioHQ/integrator #42

# Claim an existing PR
ao spawn my-project --claim-pr 1299

# Batch spawn
ao batch-spawn my-project #10 #11 #12
```

## Configuration

Config file search order:
1. `AO_CONFIG_PATH` environment variable
2. `agent-orchestrator.yaml` in current directory (searched upward)
3. `~/.agent-orchestrator.yaml`
4. `$XDG_CONFIG_HOME/agent-orchestrator/config.yaml` (default: `~/.config/agent-orchestrator/config.yaml`)

Run `ao status` to see which config file is active.

Minimal config:
```yaml
projects:
  my-app:
    repo: owner/repo
    path: ~/my-app
```

## Commands reference

| Command | Description |
|---------|-------------|
| `ao init` | Create config interactively |
| `ao start [project]` | Start orchestrator + dashboard |
| `ao start <url>` | Clone repo, auto-configure, start |
| `ao spawn <project> [issue]` | Spawn worker session for an issue |
| `ao spawn --repo owner/repo [issue]` | Spawn for ad-hoc repo (no config needed) |
| `ao batch-spawn <project> <issues...>` | Spawn sessions for multiple issues |
| `ao status` | Show all sessions with PR/CI/review status |
| `ao stop [project]` | Stop orchestrator and dashboard |
| `ao send <session> <message>` | Send a message to a running session |
| `ao kill <session>` | Kill a session |
| `ao session claim-pr <pr>` | Claim a PR from inside a session |
| `ao verify --list` | List issues awaiting post-merge verification |

## Integration with notification systems

`ao` supports notifier plugins for escalations:
- `desktop` — native OS notifications
- `slack` — Slack channel messages
- `webhook` — generic HTTP POST
- `openclaw` — OpenClaw webhook integration (bidirectional)

Configure in `agent-orchestrator.yaml`:
```yaml
defaults:
  notifiers: [desktop, openclaw]

notifiers:
  openclaw:
    plugin: openclaw
    url: "http://127.0.0.1:18789/hooks/agent"
    token: "${OPENCLAW_HOOKS_TOKEN}"
```
