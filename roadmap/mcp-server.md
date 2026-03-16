# MCP Server for Agent Orchestrator

**Created:** 2026-03-15
**Branch:** feat/mcp-server-roadmap
**Status:** Proposed

## Motivation

Currently, Claude Code interacts with agent-orchestrator entirely via CLI (`pnpm`, `ao` commands, shell scripts). This works for development but limits Claude's ability to autonomously drive the orchestrator mid-conversation — e.g., starting agent runs, polling status, and routing results to notifiers without manual copy-paste.

An MCP server would expose orchestrator primitives as callable tools, enabling fully autonomous orchestration loops from within a Claude session.

## Proposed Tools

| Tool | Description |
|---|---|
| `ao_run` | Trigger an orchestration run for a PR/branch |
| `ao_status` | Get current agent run status (running, complete, failed) |
| `ao_agents_list` | List available agent plugins |
| `ao_logs` | Tail recent run logs |
| `ao_config_get` | Read resolved config for a project |
| `ao_config_set` | Set a config key (runtime, agent, notifier) |

## Design

- **Transport:** stdio (local dev) or SSE (remote)
- **Auth:** none locally; API key for remote
- **Implementation:** new package `packages/mcp-server/` wrapping `@composio/ao-core`
- **Entry point:** `packages/mcp-server/src/index.ts` → registered in `~/.claude.json` mcpServers

## Use Cases

1. **Autonomous PR triage** — Claude spawns agent, waits for result, posts Slack summary
2. **Config iteration** — Claude edits `agent-orchestrator.yaml`, triggers run, observes output, adjusts
3. **Integration test orchestration** — Claude drives full E2E flow without leaving the chat

## Out of Scope (v1)

- Remote/multi-user auth
- Web UI for MCP tool calls
- Streaming logs

## Next Steps

1. Scaffold `packages/mcp-server/` with MCP SDK
2. Implement `ao_run` and `ao_status` tools (highest leverage)
3. Register in `~/.claude.json` and smoke-test
4. Add remaining tools iteratively
