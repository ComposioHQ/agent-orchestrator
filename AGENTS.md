# Agent Orchestrator — Agent & Contributor Guidelines

This file guides AI coding agents (Claude Code, Codex, Cursor, etc.) working on this codebase.

## Development Hierarchy — How to Add Capabilities

Before writing any code, ask: "Can I achieve this without changing core?"
Follow this order **strictly**:

### 1. Use Config First
Check whether `agent-orchestrator.yaml` already supports what you need:
- `reactions` — add/override event reactions (ci-failed, changes-requested, agent-stuck, etc.)
- `agentRules` — per-project or global instructions injected into agent system prompts
- `notificationRouting` — control which notifiers receive which priority levels
- `defaults` — set default runtime, agent, workspace, notifiers
- `projects[*].agentConfig` — per-project model, permissions, environment

If the config surface can express the behavior, **stop here**. No code needed.

### 2. Make a New Plugin (existing plugin slot)
If config alone isn't enough, implement a plugin using an existing slot:
- `runtime` — how sessions run (tmux, docker, etc.)
- `agent` — how to talk to an AI agent (claude-code, codex, cursor, opencode, gemini, etc.)
- `scm` — source control operations (GitHub, GitLab, etc.)
- `tracker` — issue tracking (GitHub Issues, Linear, etc.)
- `notifier` — notifications (Slack, Discord, openclaw, webhook, etc.)
- `workspace` — how worktrees are set up (worktree, docker-volume, etc.)

Use an existing plugin package as a template. Publish as `@composio/ao-plugin-<slot>-<name>`.

### 3. Make a New Plugin Type (new plugin slot)
If none of the existing slots fit, propose and implement a new plugin slot in `plugin-registry.ts`.
This requires a small core change but keeps the business logic in a plugin.
Open an issue first to discuss the slot design before implementing.

### 4. Change Core Code (last resort)
Only modify `packages/core/src/` if the capability genuinely cannot be expressed via config or any plugin slot.
**Justify in your PR why options 1–3 were insufficient.**

---

## What "Green" Means for a PR

A PR is **green** when ALL FOUR are true:
1. **CI green** — all required GitHub Actions checks pass
2. **No merge conflicts** — `mergeable: MERGEABLE`
3. **No serious unresolved comments** — no actionable items from CodeRabbit, Cursor Bugbot, Copilot, or human reviewers (nitpicks OK)
4. **CodeRabbit approved** — latest verdict is APPROVE or LGTM

Never declare a PR green or ask for merge unless all 4 are true.

---

## Coding Standards

- **TDD**: write failing tests first, then implement. No code without tests.
- **TypeScript strict**: full type coverage, no `any`, no `// @ts-ignore`.
- **Conventional commits**: `feat:`, `fix:`, `chore:`, `docs:`, `test:`
- **Never push to main directly** — always open a PR.
- **Never use `git add -A`** — stage only files you changed.
- Files under ~300 LOC; split when it aids clarity.

## Running Tests

```bash
pnpm --filter @composio/ao-core test   # core package only
pnpm test                               # all packages
```

All tests must pass before pushing. CI failures are blockers.
