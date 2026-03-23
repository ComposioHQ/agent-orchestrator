# Agent Orchestrator Config Reference

File: `agent-orchestrator.yaml` (in project root)

## Top-level settings

```yaml
port: 3000                    # Dashboard port (auto-finds free port if busy)
terminalPort: 3001            # Terminal WebSocket port
readyThresholdMs: 300000      # Ms before "ready" session becomes "idle" (5 min)
```

## Default plugins

```yaml
defaults:
  runtime: tmux               # tmux | process
  agent: claude-code          # claude-code | aider | codex | opencode
  workspace: worktree         # worktree | clone
  notifiers:                  # Active notifier plugins
    - desktop                 # desktop | slack | webhook | composio | openclaw
  orchestrator:
    agent: claude-code        # Override agent for orchestrator sessions
  worker:
    agent: claude-code        # Override agent for worker sessions
```

## Projects

```yaml
projects:
  my-app:
    name: My App              # Display name
    repo: owner/repo          # GitHub "owner/repo"
    path: ~/code/my-app       # Local repo path
    defaultBranch: main       # main | master | develop
    sessionPrefix: myapp      # Session name prefix (myapp-1, myapp-2)

    # Per-project plugin overrides (optional)
    runtime: tmux
    agent: claude-code
    workspace: worktree

    # Agent configuration (optional)
    agentConfig:
      permissions: auto       # auto | manual
      model: claude-sonnet-4-20250514

    # Rules passed to every agent prompt (optional)
    agentRules: |
      Always run tests before committing.
      Use conventional commits.
    agentRulesFile: .ao-rules  # Or point to a file
    orchestratorRules: |       # Rules for the orchestrator agent

    # Orchestrator session strategy (optional)
    orchestratorSessionStrategy: reuse
    # Options: reuse | delete | ignore | delete-new | ignore-new | kill-previous

    # Workspace setup (optional)
    symlinks:                  # Symlink into worktrees
      - .env
      - node_modules
    postCreate:                # Run after workspace creation
      - pnpm install

    # Issue tracker (optional)
    tracker:
      plugin: github           # github | linear | gitlab

    # SCM (optional, usually auto-detected)
    scm:
      plugin: github           # github | gitlab
```

## Notifier channels

```yaml
notifiers:
  desktop:
    plugin: desktop
  slack:
    plugin: slack
    # Requires SLACK_WEBHOOK_URL env var
  openclaw:
    plugin: openclaw
    url: http://127.0.0.1:18789/hooks/agent
    token: ${OPENCLAW_HOOKS_TOKEN}
    retries: 3
    retryDelayMs: 1000
    wakeMode: now              # now | next-heartbeat
```

## Notification routing

```yaml
notificationRouting:
  critical:
    - desktop
    - slack
    - openclaw
  high:
    - desktop
    - openclaw
  low:
    - desktop
```
