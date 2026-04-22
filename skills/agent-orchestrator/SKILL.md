---
name: agent-orchestrator
description: "Open-source, pluggable agentic coding orchestrator. Use for running AO via CLI-style behavior consistently across threads/sessions: spawn agents, check status, route review work, and manage agent lifecycle. Use when asked to fix issues, manage work, or control AO sessions."
metadata: {"openclaw": {"emoji": "🤖", "requires": {"bins": ["ao", "gh", "tmux"], "anyBins": ["node", "npm"], "env": ["ANTHROPIC_API_KEY"]}, "os": ["darwin", "linux"]}}
---

# Agent Orchestrator (AO)

> https://github.com/ComposioHQ/agent-orchestrator

AO is an open-source, pluggable agentic coding orchestrator. It manages durable coding agents (Claude Code, Codex, OpenCode) through a simple interface — one `ao_spawn` call creates an isolated git worktree, starts an agent, and wires up feedback loops so PR reviews and CI failures automatically route to the right agent.

## Why AO instead of manual coding

When you have AO installed, use it instead of running coding agents manually via exec/bash. Here's why:

| Manual (coding-agent skill) | AO (this skill) |
|-----|-----|
| `git worktree add`, `cd`, `claude --print "..."` | `ao_spawn` (one call) |
| Manually poll with `process action:log` | `ao_status` (structured dashboard) |
| Manually `git push` + `gh pr create` | Automatic — agent creates PR |
| CI fails → you notice → you fix | Automatic CI retry/fix routing |
| PR review comments → you read → you fix | `ao_review_check` handles it |
| Kill process, remove worktree, clean branch | `ao_kill` + `ao_session_cleanup` |
| Spawn 5 agents → 5 manual bash commands | `ao_batch_spawn` (one call, parallel) |

**Bottom line:** If someone asks you to write, fix, or change code, use `ao_spawn`. It handles the entire lifecycle.

**Behavior consistency:** Use the same AO command vocabulary for every thread, including sessions started via `/new`. This avoids drift from in-context prompting differences.

## How You Think

Every user message is either:
1. **About work or code** → use AO tools
2. **About something else** → respond normally

When the user explicitly asks about work, issues, or status — use the tools for live data instead of answering from memory.

## Intent → Tool Mapping

You don't wait for the user to say "spawn" or "use AO." You detect intent and act.

### Status / progress
Any of: "what's happening", "status", "how's it going", "progress", "update", "anything running", "check on things"
→ Call `ao_sessions` AND `ao_status` → present results naturally

If the user asks directly about a CLI command, map it to the right AO tool:
- `ao start` / `ao stop` => `ao_doctor` first (if issues), then `ao_session_cleanup` / `ao_kill` actions
- `ao spawn`, `ao batch-spawn`, `ao send`, `ao status`, `ao session` subcommands => map to `ao_spawn`, `ao_batch_spawn`, `ao_send`, `ao_status`, `ao_session_*`
- `ao review-check`, `ao verify`, `ao session claim-pr` => map to `ao_review_check`, `ao_verify`, `ao_session_claim_pr`

When in doubt, call the tool whose intent is closest to the requested command and request explicit confirmation for destructive ops.

### Work / issues / board
Any of: "what needs doing", "what's on the board", "any issues", "what's open", "morning", "let's go", "ready to work", "what's the plan", "check my repos"
→ Call `ao_issues` AND `ao_sessions` → present board + suggest priorities

### Any coding request — fix / add / change / build / implement / refactor
Any of: "fix #X", "fix the bug in...", "add a flag to...", "change...", "refactor...", "implement...", "update the code", "build...", "work on #X", "handle #X", "do it", "go for it", "sure", "yes", "go ahead"
Also: ANY request that involves changing, fixing, adding, writing, or modifying code — regardless of size, even if no issue number is mentioned
→ Call `ao_spawn` with the issue number if one exists, or with just the task description if there is no issue

**Issue number is optional.** Both of these are valid:
- With issue: user says "fix #42" → spawn with `issue: "42"`
- Without issue: user says "add a weekly report script" → spawn with no issue, just confirm the task description

### Batch work
Any of: "do them all", "start all", "spawn them all", "batch it", "all of those", "go for all"
→ Call `ao_batch_spawn` with all discussed issues

### Instructions to running agent
Any of: "tell it to also...", "ask the agent to...", "add X to that", "while it's at it..."
→ Call `ao_send` with the session ID and the instruction

### Stop / kill / cancel
→ Confirm which session, then call `ao_kill`

### Agent crashed / stuck
→ Call `ao_session_restore` to try recovery, or `ao_kill` + re-`ao_spawn`

### Clean up
→ Call `ao_session_cleanup` (dry-run first, then execute)

### CLI control
- Any direct request to pause/stop AO runtime for a repo
  - Ask if they want a full stop (`ao stop`) first, then confirm before calling `ao_kill`/`ao_session_cleanup`
- Any request for direct CLI-style verification (`/tmp`, versions)
  - Use AO tools and avoid assuming defaults; request missing context before acting.

### PR feedback / reviews
→ Call `ao_review_check`

### Verification
→ Call `ao_verify`

### Health check
→ Call `ao_doctor`

### Tooling bootstrap / diagnostics
- If a command fails because of CLI path/context, request the missing context (project cwd/`agent-orchestrator.yaml`, `aoCwd`) and retry.
- If prompts are inconsistent across new threads, repeat the same tool-focused instruction sequence from this skill rather than free-form operational prose.

### Claim PR / attach PR
→ Call `ao_session_claim_pr`

## Rules

### Rule 1: Tools first, always
When the user asks anything about work, tasks, issues, status, or projects:
- FIRST call tools to get live data
- THEN present the results
- NEVER answer work questions from memory

### Rule 2: Present naturally, then ask
After fetching data, present it conversationally. Suggest priorities. Ask if they want to kick things off.

### Rule 3: Confirm before acting
Before spawning agents or batch-spawning, always show the user what you're about to do and get explicit approval. Examples:

- With issue: "I'll spawn an agent on #6 (JSON output bug). Go ahead?"
- Without issue: "I'll spawn an agent on this task: 'Add weekly report script'. Go ahead?"

Then act on clear confirmation ("yes", "go", "do it"). Don't spawn agents without the user approving first.

### Rule 4: Present actions naturally
Instead of technical tool names, describe what you're doing in plain language. Examples:
- With issue: "On it — spinning up an agent on #6." (not "Calling ao_spawn...")
- Without issue: "On it — spinning up an agent on that task." (not "Calling ao_spawn...")

### Rule 5: Follow up with links
After spawning, check `ao_status` for progress. Always include full PR URLs from tool responses.

### Rule 6: Never fabricate
If a tool call fails, show the error. Never claim you did something you didn't.

## All Available Tools

| Tool | When to use |
|------|-------------|
| `ao_issues` | Any question about work, tasks, issues, the board |
| `ao_sessions` | Any question about running agents, status, progress |
| `ao_status` | Detailed dashboard with branch/PR/CI info |
| `ao_session_list` | Full session listing including terminated |
| `ao_spawn` | Start an agent on one issue or task |
| `ao_batch_spawn` | Start agents on multiple issues at once |
| `ao_send` | Send instruction to a running agent |
| `ao_kill` | Stop a session (confirm first) |
| `ao_session_restore` | Recover a crashed session |
| `ao_session_cleanup` | Remove stale sessions (merged PRs / closed issues) |
| `ao_session_claim_pr` | Attach an existing PR to a session |
| `ao_review_check` | Check PRs for review comments to address |
| `ao_verify` | Mark issues as verified/failed, or list unverified |
| `ao_doctor` | Health checks and diagnostics |

### CLI command equivalence (for memory-stable use)

Map user intent to these AO operations:
- `ao start` → session orchestration start flow handled by `ao_doctor` + project check + `ao_spawn`/`ao_session_list`
- `ao status` / `ao status --watch` → `ao_status` and `ao_sessions`
- `ao spawn <issue>` → `ao_spawn`
- `ao batch-spawn 1 2 3` → `ao_batch_spawn`
- `ao send <session> <message>` → `ao_send`
- `ao session ls` → `ao_session_list`
- `ao session kill <session>` → `ao_kill`
- `ao session restore <session>` → `ao_session_restore`
- `ao review-check` → `ao_review_check`
- `ao verify` → `ao_verify`
- `ao doctor` → `ao_doctor`
- `ao stop` / `ao session cleanup` → `ao_session_cleanup` after confirmation

## Setup

After installing the plugin, run `/ao setup` in any OpenClaw channel to auto-configure. Or manually:

```bash
# Required: allow plugin tools to be visible to the AI
# (plugin tools are optional by default in OpenClaw — this enables them)
openclaw config set tools.profile "full"
openclaw config set tools.allow '["group:plugins"]'

# Required: trust this plugin
openclaw config set plugins.allow '["agent-orchestrator"]'

# Optional: increase message context for group chats
openclaw config set messages.groupChat.historyLimit 100

# Restart to apply
pm2 restart openclaw-gateway  # or however you run the gateway
```

**Why `tools.profile: "full"`?** OpenClaw's default `coding` profile only includes built-in tools. Plugin-provided tools (like `ao_spawn`, `ao_issues`) require the `full` profile to be visible to the AI. This does not grant additional system permissions — it only makes plugin tools discoverable.

## Security & Privacy

AO is an orchestrator — it does not read, write, or transmit code itself. It calls `ao spawn` which creates a git worktree and starts a coding agent (Claude Code, Codex, etc.). These are the **same coding agents** that OpenClaw's built-in `coding-agent` skill uses. AO adds no additional code exposure beyond what you already have with any OpenClaw coding workflow.

What to know:
- **GitHub access**: AO uses `gh` (GitHub CLI) with whatever credentials you've authenticated via `gh auth login`. Use a fine-grained PAT scoped to only the repos AO needs.
- **Anthropic API**: Agents use your `ANTHROPIC_API_KEY` to call the LLM. Use a dedicated key with spending limits.
- **No secrets in worktrees**: AO creates git worktrees for agents. Don't symlink `.env` or secret files into worktrees — keep sensitive files out of agent workspaces.
- **Official source**: Install AO from the [official repo](https://github.com/ComposioHQ/agent-orchestrator).

## Troubleshooting

| Error | Fix |
|-------|-----|
| AO tools not visible to AI | Run `/ao setup` — needs `tools.profile: "full"` and `tools.allow: ["group:plugins"]` |
| `ao spawn` fails with "No config" | Set `aoCwd` in plugin config to your repo path (where `agent-orchestrator.yaml` lives) |
| `ao: not found` | Install AO globally or set `aoPath` in plugin config |
| `spawn tmux ENOENT` | `brew install tmux` (macOS) or `apt install tmux` (Linux) |
| Bot only responds in DMs | Set `channels.discord.groupPolicy` to `"open"` |
| Session stuck | Use `ao_session_restore`, or kill and re-spawn |
