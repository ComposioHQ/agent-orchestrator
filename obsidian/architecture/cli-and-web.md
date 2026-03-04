---
tags: [architecture, cli, web, agent-orchestrator]
created: 2026-03-04
updated: 2026-03-04
---

# CLI and Web Dashboard

## CLI (`packages/cli/`)

The `ao` command is built with **Commander.js** and is the primary interface for managing agent sessions.

### Key Commands

| Command | Description |
|---------|-------------|
| `ao status` | Overview of all sessions |
| `ao spawn <project> [issue]` | Spawn an agent for an issue (GitHub, Linear, or ad-hoc) |
| `ao send <session> "message"` | Send instructions to a running agent |
| `ao session ls` | List all sessions |
| `ao session kill <session>` | Kill a session |
| `ao session restore <session>` | Revive a crashed agent |
| `ao dashboard` | Open the web dashboard |
| `ao list [project]` | List sessions (optionally filtered by project) |
| `ao attach <session>` | Attach to a tmux session |
| `ao init --auto` | Initialize config for current project |
| `ao start` | Start the orchestrator |

### Design

- No config paths in commands -- everything is auto-discovered from `agent-orchestrator.yaml`
- Session names are user-facing short names (e.g., `int-1`, `ao-2`) while tmux names include the hash prefix for global uniqueness
- Package: `@composio/ao-cli`

## Web Dashboard (`packages/web/`)

Real-time dashboard for monitoring and managing agent sessions.

### Tech Stack

- **Next.js 15** (App Router)
- **React 19**
- **Tailwind CSS**
- **xterm.js** -- embedded terminal for live agent output
- **Server-Sent Events (SSE)** -- real-time session status updates

### Development

```bash
# Build all packages first (web depends on @composio/ao-core and plugins)
pnpm build

# Ensure agent-orchestrator.yaml exists in working directory
cp agent-orchestrator.yaml.example agent-orchestrator.yaml

# Start dev server
cd packages/web && pnpm dev
# Dashboard available at http://localhost:3000
```

**Why build first?** The web package imports from `@composio/ao-core` and plugin packages. These must be compiled to JavaScript before Next.js can resolve them.

### Package

`@composio/ao-web`

## Related

- [[overview]] -- System design and data flow
- [[plugin-system]] -- Plugin slots and pattern
