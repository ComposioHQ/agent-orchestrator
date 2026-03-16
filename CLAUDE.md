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

## This Is a Fork

This repo is `jleechanorg/agent-orchestrator`, forked from `ComposioHQ/agent-orchestrator`.

- PRs go against `jleechanorg/agent-orchestrator`, not `ComposioHQ/agent-orchestrator`
- Upstream improvements can be proposed to ComposioHQ after landing here first
- Remote `jleechanorg` points to the fork; `origin` points to upstream (read-only)

## PR Target — CRITICAL SAFETY RULE

**NEVER open a PR against `ComposioHQ/agent-orchestrator` (upstream) without explicit approval from jleechan.**

Before creating any PR, confirm the target repo. If the target is `ComposioHQ/agent-orchestrator`, stop and ask:
> "This would open a PR against the ComposioHQ upstream. Do you approve?"

Only proceed after explicit in-thread approval. Default target is always `jleechanorg/agent-orchestrator`.

## Upstreaming to ComposioHQ — What to Strip

When cherry-picking work to a `feat/*-upstream` branch for a ComposioHQ PR, **do not include**:

- `docs/design/*.md` — fork-only markdown design docs (HTML equivalents are fine)
- `CLAUDE.md` — fork-specific Claude Code instructions
- `AGENTS.md` — fork-specific agent/contributor guidelines
- `roadmap/` — fork roadmap docs
- `.beads/` — local issue tracker
- Any commit that references fork infrastructure (openclaw, jleechanorg-specific tooling)
