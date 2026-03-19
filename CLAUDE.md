# CLAUDE.md — Agent Orchestrator Fork Guidelines

This file is read by Claude Code when working in this repository.

## Development Hierarchy

**Before writing any code, follow this order:**

| Priority | Approach | When to use |
|---|---|---|
| 1 | **Config** | Behavior expressible via `agent-orchestrator.yaml` (reactions, agentRules, routing) |
| 2 | **New plugin** (existing slot) | New runtime, agent, SCM, tracker, notifier, or workspace implementation |
| 3 | **New plugin type** (new slot) | Behavior that needs a new plugin slot in plugin-registry |
| 4 | **Core code change** | Only when 1–3 are genuinely insufficient — justify in PR |

Core code (`packages/core/src/`) should be treated as stable infrastructure. The vast majority of new capabilities should live in plugins. Roadmap docs, design notes, and fork-specific tooling config live in `roadmap/`, `.beads/`, and `CLAUDE.md` — these are first-class artifacts, not noise.

## What "Config" Covers

The yaml config is richer than it looks. Before coding, check:

```yaml
reactions:          # Handle any lifecycle event (ci-failed, changes-requested, agent-stuck…)
agentRules:         # Inject instructions into every agent's system prompt
notificationRouting: # Route urgent/action/warning/info to specific notifiers
defaults:           # Global runtime, agent, workspace, notifiers
projects.*:         # Per-project overrides for all of the above
plugins:            # Plugin credentials and settings
```

## Definition of a "Green" PR

A PR is green when **ALL FOUR** are true:

1. **CI green** — all required GitHub Actions checks pass (no failures, no pending required)
2. **No merge conflicts** — `mergeable: MERGEABLE` (not CONFLICTING)
3. **No serious unresolved comments** — no actionable items from CodeRabbit, Cursor Bugbot, Copilot, or human reviewers (nitpicks are OK)
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
pnpm --filter @composio/ao-core test        # core package only
pnpm test                                   # all packages
```

## This Is an Independent Fork

This repo is `jleechanorg/agent-orchestrator`. It started as a fork of `ComposioHQ/agent-orchestrator` but is now developed independently. Upstream sync is not a goal.

- All PRs target `jleechanorg/agent-orchestrator`
- `roadmap/` docs are tracked and welcomed — they are the design record for this fork
- `.beads/issues.jsonl` is the issue tracker — commit it when beads are opened or closed

**Upstream-strip rule**: When preparing PRs to `ComposioHQ/agent-orchestrator`, remove all fork-only artifacts. Explicitly exclude: `CLAUDE.md`, `AGENTS.md`, `roadmap/`, `.beads/`, `docs/design/*.md`, and any commits referencing fork-specific infra (openclaw, jleechanorg-specific tooling).

## PR Target — CRITICAL SAFETY RULE

**NEVER open a PR against `ComposioHQ/agent-orchestrator` without explicit in-thread approval from jleechan.**

Before creating any PR, confirm the target repo. If the target is `ComposioHQ/agent-orchestrator`, stop and ask:
> "This would open a PR against the ComposioHQ upstream. Do you approve?"

Default target is always `jleechanorg/agent-orchestrator`.
