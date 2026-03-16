# Agent Orchestrator — Agent & Contributor Guidelines

This file guides AI coding agents (Claude Code, Codex, Cursor, etc.) working on this codebase.

## Development Hierarchy — How to Add Capabilities

Before writing any code, ask: "Can I achieve this without changing core?"

Follow this order strictly:

### 1. Use Config First
Check whether `agent-orchestrator.yaml` already supports what you need:
- `reactions` — add/override event reactions (ci-failed, changes-requested, agent-stuck, etc.)
- `agentRules` — per-project or global instructions injected into agent system prompts
- `notificationRouting` — control which notifiers receive which priority levels
- `defaults` — set default runtime, agent, workspace, notifiers
- `projects[*].agentConfig` — per-project model, permissions, environment

If the config surface can express the behavior, **stop here**. No code needed.

### 2. Make a New Plugin (existing plugin slot)
If config is not enough, implement a plugin using an existing slot:
- `runtime` — how sessions run (tmux, docker, etc.)
- `agent` — how to talk to an AI agent (claude-code, codex, cursor, opencode, etc.)
- `scm` — source control operations (GitHub, GitLab, etc.)
- `tracker` — issue tracking (GitHub Issues, Linear, etc.)
- `notifier` — notifications (Slack, Discord, openclaw, webhook, etc.)
- `workspace` — how worktrees are set up (worktree, docker-volume, etc.)

Use an existing plugin package as a template. Publish as `@composio/ao-plugin-<slot>-<name>`.

### 3. Make a New Plugin Type (new plugin slot)
If none of the existing slots fit, propose and implement a new plugin slot in `plugin-registry.ts`.
This requires a small core change but keeps the business logic in a plugin.

Open an issue first to discuss the new slot design before implementing.

### 4. Change Core Code (last resort)
Only modify `packages/core/src/` if the capability genuinely cannot be expressed via config or any plugin slot.

Justify in your PR why options 1–3 were insufficient.

---

## Coding Standards

- **TDD**: write failing tests first, then implement. No code without tests.
- **TypeScript strict**: full type coverage, no `any`, no `// @ts-ignore`.
- **No `**kwargs` equivalents**: explicit named parameters only.
- **Files under ~300 LOC**: split when it aids clarity.
- **Conventional commits**: `feat:`, `fix:`, `chore:`, `docs:`, `test:`.
- **Never push to main directly** — always open a PR.
- **Never use `git add -A`** — stage only files you changed.

## Testing

```bash
# Run core tests
pnpm --filter @composio/ao-core test

# Run all tests
pnpm test
```

All tests must pass before pushing. CI failures are blockers — fix them, don't skip.

## PR Target — CRITICAL SAFETY RULE

**NEVER open a PR against `ComposioHQ/agent-orchestrator` (upstream) without explicit approval from jleechan.**

Before running `gh pr create`, verify the `--repo` target or the default remote. If it resolves to `ComposioHQ/agent-orchestrator`, stop and ask for approval before proceeding. The correct default target is always `jleechanorg/agent-orchestrator`.

## PR Checklist

Before opening a PR, verify:
- [ ] PR target is `jleechanorg/agent-orchestrator` (not ComposioHQ upstream)
- [ ] All existing tests pass
- [ ] New behavior has new tests (TDD)
- [ ] Config-first hierarchy followed (AGENTS.md §Development Hierarchy)
- [ ] No secrets or tokens committed
- [ ] Conventional commit messages

## Upstreaming to ComposioHQ — Strip List

When preparing a PR against `ComposioHQ/agent-orchestrator`, cherry-pick only the functional commits and **exclude**:

- `docs/design/*.md` — fork-only markdown design docs (HTML versions are fine to include)
- `CLAUDE.md` / `AGENTS.md` — fork-specific tooling instructions
- `roadmap/` — internal roadmap docs
- `.beads/` — local issue tracker artifacts
- Commits referencing fork-only infrastructure (openclaw, jleechanorg remotes, etc.)
