/**
 * Returns the complete AO config schema as formatted text.
 * Used by `ao config-help` and injected into orchestrator system prompts.
 */
export function getConfigInstruction(): string {
  return `
# Agent Orchestrator Config Reference
# File: agent-orchestrator.yaml

# ── Top-level settings ──────────────────────────────────────────────

port: 3000                    # Dashboard port (default: 3000, auto-finds free port if busy)
terminalPort: 3001            # Terminal WebSocket port (default: 3001)
directTerminalPort: 3003      # Direct terminal WebSocket port (default: 3003)
readyThresholdMs: 300000      # Ms before "ready" session becomes "idle" (default: 5 min)

# ── Default plugins ─────────────────────────────────────────────────
# These apply to all projects unless overridden per-project.

defaults:
  runtime: tmux               # tmux | process
  agent: claude-code          # claude-code | aider | codex | opencode
  workspace: worktree         # worktree | clone
  notifiers:                  # List of active notifier plugins
    - desktop                 # desktop | discord | slack | webhook | composio | openclaw
  orchestrator:
    agent: claude-code        # Agent for orchestrator sessions (optional override)
  worker:
    agent: claude-code        # Agent for worker sessions (optional override)

# ── Projects ────────────────────────────────────────────────────────
# Each key is a project ID (typically the repo directory name).

projects:
  my-app:
    name: My App              # Display name
    repo: owner/repo          # GitHub "owner/repo" format
    path: ~/code/my-app       # Local path to the repo
    defaultBranch: main       # main | master | next | develop
    sessionPrefix: myapp      # Prefix for session names (e.g. myapp-1, myapp-2)

    # ── Per-project plugin overrides (optional) ───────────────────
    runtime: tmux             # Override default runtime
    agent: claude-code        # Override default agent
    workspace: worktree       # Override default workspace

    # ── Agent configuration (optional) ────────────────────────────
    agentConfig:
      permissions: auto       # auto | manual — agent permission mode
      model: claude-sonnet-4-20250514

    # ── Agent rules (optional) ────────────────────────────────────
    agentRules: |             # Inline rules passed to every agent prompt
      Always run tests before committing.
      Use conventional commits.
    agentRulesFile: .ao-rules # Or point to a file (relative to project path)
    orchestratorRules: |      # Rules for the orchestrator agent

    # ── Orchestrator session strategy (optional) ──────────────────
    # Controls what happens to the orchestrator session on restart.
    orchestratorSessionStrategy: reuse
    # Options: reuse | delete | ignore | delete-new | ignore-new | kill-previous

    # ── Workspace setup (optional) ────────────────────────────────
    symlinks:                 # Files/dirs to symlink into workspaces
      - .env
      - node_modules
    postCreate:               # Commands to run after workspace creation
      - pnpm install

    # ── Issue tracker (optional) ──────────────────────────────────
    tracker:
      plugin: github          # github | linear | gitlab
      # Linear-specific:
      # teamId: TEAM-123
      # projectId: PROJECT-456

    # ── SCM configuration (optional, usually auto-detected) ───────
    scm:
      plugin: github          # github | gitlab

    # ── Task decomposition (optional) ─────────────────────────────
    decomposer:
      enabled: false          # Auto-decompose backlog issues
      maxDepth: 3             # Max recursion depth
      model: claude-sonnet-4-20250514
      requireApproval: true   # Require human approval before executing

    # ── Per-project reaction overrides (optional) ─────────────────
    # reactions:
    #   ci-failure:
    #     enabled: true

# ── Notification channels (optional) ────────────────────────────────

notifiers:
  desktop:
    plugin: desktop
  slack:
    plugin: slack
    # Requires SLACK_WEBHOOK_URL env var
  webhook:
    plugin: webhook
    # url: https://example.com/hook
  openclaw:
    plugin: openclaw
    # url: http://127.0.0.1:18789/hooks/agent
    # token: \${OPENCLAW_HOOKS_TOKEN}
    # Run 'ao setup openclaw' for guided configuration

# ── Notification routing (optional) ─────────────────────────────────
# Route notifications by priority level.

notificationRouting:
  critical:
    - desktop
    - slack
  high:
    - desktop
  low:
    - desktop

# ── Available plugins ───────────────────────────────────────────────
#
# Agent:     claude-code, aider, codex, opencode
# Runtime:   tmux, process
# Workspace: worktree, clone
# SCM:       github, gitlab
# Tracker:   github, linear, gitlab
# Notifier:  desktop, discord, slack, webhook, composio, openclaw
# Terminal:  iterm2, web
`.trim();
}
