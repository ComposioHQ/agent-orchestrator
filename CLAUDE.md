# CLAUDE.md — Agent Orchestrator Fork Guidelines

This file is read by Claude Code when working in this repository.

## Development Hierarchy

**Before writing any code, follow this priority order:**

| # | Approach | When to use |
|---|---|---|
| 1 | **Use config** | Behavior expressible via `agent-orchestrator.yaml` (reactions, agentRules, routing) |
| 2 | **New plugin** (existing slot) | New runtime, agent, SCM, tracker, notifier, or workspace |
| 3 | **New plugin type** (new slot) | Behavior needing a new plugin slot in plugin-registry |
| 4 | **Core code change** | Only when 1–3 are genuinely insufficient — justify in PR |

## What Config Covers

The yaml config is richer than it looks. Before coding, check:

```yaml
reactions:           # Handle any lifecycle event (ci-failed, changes-requested, agent-stuck…)
agentRules:          # Inject instructions into every agent's system prompt
notificationRouting: # Route urgent/action/warning/info to specific notifiers
defaults:            # Global runtime, agent, workspace, notifiers
projects.*:          # Per-project overrides for all of the above
plugins:             # Plugin credentials and settings
```

## Definition of a "Green" PR

A PR is green when **ALL FOUR** are true:

1. **CI green** — all required GitHub Actions checks pass (no failures, no pending required)
2. **No merge conflicts** — `mergeable: MERGEABLE` (not CONFLICTING)
3. **No serious unresolved comments** — no actionable items from CodeRabbit, Cursor Bugbot, Copilot, or human reviewers (nitpicks OK)
4. **CodeRabbit approved** — latest verdict is APPROVE or LGTM (REQUEST_CHANGES is a blocker)

**Never declare a PR green or ask for merge unless all 4 are true.**

## Coding Standards

- TDD: write the failing test first, then implement
- TypeScript strict: no `any`, no `// @ts-ignore`
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`
- Never push to main — always open a PR
- Never `git add -A` — stage only files you changed
- Files under ~300 LOC; split for clarity

## Running Tests

```bash
pnpm --filter @composio/ao-core test   # core package only
pnpm test                               # all packages
```

## This Is a Fork

This repo is `jleechanorg/agent-orchestrator`, forked from `ComposioHQ/agent-orchestrator`.

- PRs target `jleechanorg/agent-orchestrator`, not `ComposioHQ/agent-orchestrator`
- Upstream improvements can be proposed to ComposioHQ after landing here first
