<h1 align="center">Agent Orchestrator — The Orchestration Layer for Parallel AI Agents</h1>

<p align="center">
<a href="https://platform.composio.dev/?utm_source=Github&utm_medium=Banner&utm_content=AgentOrchestrator">
  <img width="800" alt="Agent Orchestrator banner" src="docs/assets/agent_orchestrator_banner.png">
</a>
</p>

<div align="center">

Spawn parallel AI coding agents, each in its own git worktree. Agents autonomously fix CI failures, address review comments, and open PRs — you supervise from one dashboard.

[![GitHub stars](https://img.shields.io/github/stars/ComposioHQ/agent-orchestrator?style=flat-square)](https://github.com/ComposioHQ/agent-orchestrator/stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![PRs merged](https://img.shields.io/badge/PRs_merged-61-brightgreen?style=flat-square)](https://github.com/ComposioHQ/agent-orchestrator/pulls?q=is%3Amerged)
[![Tests](https://img.shields.io/badge/test_cases-3%2C288-blue?style=flat-square)](https://github.com/ComposioHQ/agent-orchestrator/releases/tag/metrics-v1)

</div>

---

Agent Orchestrator manages fleets of AI coding agents working in parallel on your codebase. Each agent gets its own git worktree, its own branch, and its own PR. When CI fails, the agent fixes it. When reviewers leave comments, the agent addresses them. You only get pulled in when human judgment is needed.

**Agent-agnostic** (Claude Code, Codex, Aider) · **Runtime-agnostic** (tmux, Docker) · **Tracker-agnostic** (GitHub, Linear)

<div align="center">

## See it in action

<a href="https://x.com/agent_wrapper/status/2026329204405723180">
  <img src="docs/assets/demo-video-tweet.png" alt="Agent Orchestrator demo — AI agents building their own orchestrator" width="560">
</a>
<br><br>
<a href="https://x.com/agent_wrapper/status/2026329204405723180"><img src="docs/assets/btn-watch-demo.png" alt="Watch the Demo on X" height="48"></a>
<br><br><br>
<a href="https://x.com/agent_wrapper/status/2025986105485733945">
  <img src="docs/assets/article-tweet.png" alt="The Self-Improving AI System That Built Itself" width="560">
</a>
<br><br>
<a href="https://x.com/agent_wrapper/status/2025986105485733945"><img src="docs/assets/btn-read-article.png" alt="Read the Full Article on X" height="48"></a>

</div>

## Quick Start

**Option A — From a repo URL (fastest):**

```bash
# Install
git clone https://github.com/ComposioHQ/agent-orchestrator.git
cd agent-orchestrator && bash scripts/setup.sh

# One command to clone, configure, and launch
ao start https://github.com/your-org/your-repo
```

Auto-detects language, package manager, SCM platform, and default branch. Generates `agent-orchestrator.yaml` and starts the dashboard + orchestrator.

**Option B — From an existing local repo:**

```bash
cd ~/your-project && ao init --auto
ao start
```

Then spawn agents:

```bash
ao spawn my-project 123    # GitHub issue, Linear ticket, or ad-hoc
```

Dashboard opens at `http://localhost:3000`. Run `ao status` for the CLI view.

**Option C — Containerized deployment:**

```bash
git clone https://github.com/ComposioHQ/agent-orchestrator.git
cd agent-orchestrator
mkdir -p projects
cp agent-orchestrator.yaml.example projects/agent-orchestrator.yaml
# edit projects/agent-orchestrator.yaml:
# - set the project path to /projects/your-repo
# - set defaults.runtime to process (or your preferred runtime)
docker compose up --build
```

Dashboard opens at `http://localhost:3000`. See [Container Deployment](#container-deployment) for image and agent options.

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

## Container Deployment

Use the root [compose.yaml](compose.yaml) and [Containerfile](Containerfile).

The image exposes `ao` as its default command, so you can use it either as a long-running service or as a one-shot onboarding container.

- Path mapping matters:
  - `AO_PROJECTS_DIR` defaults to `./projects` on the host
  - regardless of the host directory name, compose mounts it at `/projects` inside the container
  - the container defaults `AO_CONFIG_PATH` to `/projects/agent-orchestrator.yaml`
  - `compose up` runs `ao start` and uses that shared config path automatically
  - `agent-orchestrator.yaml` must use the container path, not the host path
- Example:

```yaml
projects:
  my-app:
    repo: your-org/my-app
    path: /projects/my-app
    defaultBranch: main
```

Examples:

- host `./projects/my-app` -> container `/projects/my-app`
- host `./somewhere/else/my-app` with `AO_PROJECTS_DIR=./somewhere/else` -> container `/projects/my-app`

- Put the shared compose config at `./projects/agent-orchestrator.yaml` on the host.
- Set `AO_INSTALL_AGENTS` before `docker compose build` or `podman compose build` to control which CLIs are baked into the image. Default: `claude-code,codex,aider,goose`.
- For GitHub issue/PR workflows, point `GH_CONFIG_DIR` at a host directory with `gh auth login` state.
- For Kubernetes access, place a kubeconfig at `./.kube/config` or override `KUBECONFIG_DIR`.
- If you do not want to build locally, switch the service image to `ghcr.io/composiohq/agent-orchestrator:latest`.
- If your config has multiple projects, override the compose command, for example: `docker compose run --rm agent-orchestrator start my-project`

For first-time onboarding without a prewritten config, run the image directly and pass the normal `ao` arguments:

```bash
docker run --rm -it \
  -p 3000:3000 \
  -p 14800:14800 \
  -p 14801:14801 \
  -v "$(pwd)/projects:/projects" \
  -v ao-data:/root/.agent-orchestrator \
  ghcr.io/composiohq/agent-orchestrator:latest \
  start https://github.com/your-org/your-repo
```

The same pattern works with Podman:

```bash
podman run --rm -it \
  -p 3000:3000 \
  -p 14800:14800 \
  -p 14801:14801 \
  -v "$(pwd)/projects:/projects" \
  -v ao-data:/root/.agent-orchestrator \
  ghcr.io/composiohq/agent-orchestrator:latest \
  start https://github.com/your-org/your-repo
```

That onboarding flow should clone into `./projects/<repo>` on the host and generate `./projects/<repo>/agent-orchestrator.yaml`.

The same works for `ao init`:

```bash
podman compose run --rm agent-orchestrator init
```

Because the service now works from `/projects`, that creates `./projects/agent-orchestrator.yaml` on the host by default.

For repo-URL onboarding with compose, use:

```bash
podman compose run --rm agent-orchestrator start https://github.com/your-org/your-repo
```

In that flow, the image default `AO_CONFIG_PATH=/projects/agent-orchestrator.yaml` makes the generated config land where later `podman compose up` will find it.
GitHub shorthand also works there, for example:

```bash
podman compose run --rm agent-orchestrator start your-org/your-repo
```

If you still see paths under `/app/<repo>` in the container logs, you are running an older image and should rebuild locally before retrying.

Optional mounts for richer integrations:

- `-v "$(pwd)/.gh:/root/.config/gh:ro"` if you want to reuse `gh auth login` state for private GitHub repos or PR workflows
- `-v "$(pwd)/.kube:/root/.kube:ro"` if you need Kubernetes access from inside the orchestrator
- when using `compose.yaml`, run additional CLI commands with `docker compose exec agent-orchestrator ao ...` or `podman compose exec agent-orchestrator ao ...`

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
- tmux (for the default runtime)
- `gh` CLI (for GitHub integration)

Or, if running Containerized:

- Docker or Podman
- Compose support (`docker compose` or `podman compose`)
- A checked-out project available under `./projects`

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
