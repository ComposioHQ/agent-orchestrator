---
tags: [architecture, agent-orchestrator]
created: 2026-03-04
updated: 2026-03-04
---

# System Overview

## Core Concept

`ao spawn <project> <issue>` is the primary entry point. A single command creates an isolated workspace, starts a runtime, launches an AI agent with issue context, and monitors the full lifecycle through to PR merge.

## Design Principles

1. **Runtime-agnostic** -- tmux, Docker, k8s; swap via plugin
2. **Agent-agnostic** -- Claude Code, Codex, Aider, OpenCode; swap via plugin
3. **Tracker-agnostic** -- GitHub Issues, Linear, Jira; swap via plugin
4. **Stateless orchestrator** -- no database; flat metadata files (`key=value`) + JSONL event log
5. **Convention over configuration** -- auto-derive paths, session prefixes, and namespacing from config location hash
6. **Security first** -- `execFile` not `exec`, validate all external input, no shell interpolation
7. **Push, not pull** -- Notifier is the primary human interface; dashboard is secondary

## Key Paths

| Path | Purpose |
|------|---------|
| `packages/core/src/types.ts` | All plugin interfaces (Runtime, Agent, Workspace, Tracker, SCM, Notifier, Terminal) |
| `packages/cli/` | `ao` CLI built with Commander.js |
| `packages/web/` | Next.js 15 web dashboard (React 19, Tailwind, SSE) |
| `agent-orchestrator.yaml` | Project config (Zod-validated at load time) |
| `~/.agent-orchestrator/` | Runtime data: sessions, worktrees, archive (not versioned) |
| `packages/plugins/` | All plugin implementations (runtime-tmux, agent-claude-code, etc.) |

## Data Flow

```
ao spawn <project> <issue>
  |
  v
Config -- load agent-orchestrator.yaml, resolve project, derive hash namespace
  |
  v
Workspace -- create git worktree + feature branch (isolated from main)
  |
  v
Runtime -- start tmux session (or Docker container, k8s pod)
  |
  v
Agent -- launch Claude Code (or Codex, Aider) with issue context + CLAUDE.md
  |
  v
Agent works -- reads code, writes implementation, creates PR
  |
  v
Reactions -- auto-handle CI failures (retry), review comments (address)
  |
  v
Notifier -- ping human only when judgment needed (approve, merge, escalate)
```

## Runtime Data Layout

All runtime data lives under `~/.agent-orchestrator/{hash}-{projectId}/`. The hash is derived from the config directory path (SHA-256, first 12 chars), so multiple checkouts of the same orchestrator never collide.

```
~/.agent-orchestrator/
  a3b4c5d6e7f8-integrator/
    sessions/       -- metadata files (int-1, int-2, ...)
    worktrees/      -- git worktrees (int-1/, int-2/, ...)
    archive/        -- completed sessions
    .origin         -- config path reference
```

## Related

- [[plugin-system]] -- Plugin slot details and pattern
- [[cli-and-web]] -- CLI commands and web dashboard
- [[overview|Back to top]]
