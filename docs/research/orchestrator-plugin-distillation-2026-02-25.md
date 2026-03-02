# Agent Orchestrator Plugin Distillation (2026-02-25)

## Objective
Build a practical, implementation-ready distillation of mature agent-orchestration ecosystems and extract plugin opportunities for `agent-orchestrator`.

## Current AO Baseline (from code audit)
Current plugin slots in this repo: `runtime`, `agent`, `workspace`, `tracker`, `scm`, `notifier`, `terminal`.

Built-in plugins already present:
- Runtime: `tmux`, `process`
- Agent: `claude-code`, `codex`, `aider`, `opencode`
- Workspace: `worktree`, `clone`
- Tracker: `github`, `linear`
- SCM: `github`
- Notifier: `composio`, `desktop`, `slack`, `webhook`
- Terminal: `iterm2`, `web`

## Search Method (GitHub + DeepWiki)
Searches executed (representative set):
- `best open source ai agent orchestration framework plugin architecture github`
- `LangGraph docs durable execution checkpointer`
- `microsoft autogen agentchat extensions tools`
- `CrewAI tools integrations observability`
- `OpenHands integrations GitHub GitLab Slack MCP`
- `model context protocol servers github`
- `OpenAI Agents SDK tools handoffs guardrails github`
- `DeepWiki langgraph`, `DeepWiki AutoGen`, `DeepWiki CrewAI`, `DeepWiki OpenHands`

Selection criteria:
- Mature adoption and active maintenance
- Real extension points (tools, models, runtimes, memory, observability)
- Transferability to AO’s slot-based plugin architecture

## Deep-Dive Distillation

### 1) LangGraph
What matters for AO:
- Durable execution/checkpointing as first-class primitive
- Native human-in-the-loop interruptions and resume
- Strong state+memory model around long-running workflows

Plugin implications:
- Add checkpoint/memory plugins (Redis/Postgres/S3 backends)
- Add resume/replay primitives in lifecycle orchestration

### 2) Microsoft AutoGen
What matters for AO:
- Multi-agent team patterns (selectors, group chat, handoff)
- Tool ecosystem adapters (MCP, LangChain tools, OpenAPI)
- Rich model-context abstractions

Plugin implications:
- Add multi-agent orchestration mode plugin(s)
- Add tool-gateway plugin layer (MCP/OpenAPI bridge)

### 3) CrewAI
What matters for AO:
- Explicit separation between agent definitions and tool execution
- Enterprise-facing observability and eventing patterns

Plugin implications:
- Add structured workflow templates (planner/executor/reviewer)
- Add event sink plugins for traces + operational analytics

### 4) OpenHands
What matters for AO:
- Multiple runtime backends (Docker, process, remote)
- Integrations surface includes GitHub/GitLab/Jira/Slack + MCP
- Strong emphasis on coding-agent execution environment abstraction

Plugin implications:
- Prioritize runtime expansion (`docker`, `kubernetes`, `ssh`, cloud sandbox)
- Prioritize `tracker-jira` and `scm-gitlab`

### 5) OpenAI Agents SDK
What matters for AO:
- Guardrails + handoffs + session memory as composable primitives
- Built-in tracing concept to make orchestration inspectable

Plugin implications:
- Add guardrail/policy plugin slot (or sub-interface)
- Add orchestration trace plugin hooks

### 6) MCP Ecosystem
What matters for AO:
- MCP is becoming the standard interoperability layer for tools
- Large and growing server ecosystem

Plugin implications:
- Add MCP gateway plugin to expose tool servers into any AO agent plugin

### 7) Langfuse / Observability Ecosystem
What matters for AO:
- Traces, scores, and prompt/version observability are now baseline

Plugin implications:
- Add telemetry sink plugins (`langfuse`, `otel`, `datadog`, `grafana`)

## Plugin Backlog (Distilled + Prioritized)

### P0 (High impact, fast ROI)
- `tracker-jira`
- `scm-gitlab`
- `runtime-docker`
- `notifier-discord`
- `notifier-teams`
- `tool-mcp-gateway` (new capability layer)

### P1 (High impact, moderate complexity)
- `runtime-kubernetes`
- `runtime-ssh`
- `terminal-vscode`
- `workspace-snapshot` (workspace checkpoint/restore backend)
- `telemetry-langfuse`

### P2 (Strategic)
- `policy-guardrails` plugin family
- `multi-agent-topology` plugin family (planner/executor/reviewer)
- `scm-bitbucket`
- `tracker-azure-devops`

## Data Distillation Into AO Architecture
Transferable patterns:
- Standardized tool protocol: adopt MCP gateway to avoid per-tool bespoke integrations
- Durable orchestration: add checkpoint/memory plugin contract for long-lived sessions
- Ops-grade visibility: emit normalized orchestration traces to telemetry plugins
- Policy and human control: add guardrail hooks before/after sensitive actions

## Implementation Blueprint (Clean Rollout)

### Phase 1: Foundation
- Make plugin loading truly config-driven for built-in and external plugins
- Normalize plugin config injection (especially notifier and terminal config)
- Add docs + capability matrix + acceptance criteria per plugin

### Phase 2: Core Expansions
- Implement `tracker-jira`, `scm-gitlab`, `runtime-docker`
- Implement MCP gateway integration path

### Phase 3: Reliability + Ops
- Add checkpoint/memory backend contract
- Add telemetry sink plugins (start with Langfuse or OpenTelemetry)

### Phase 4: Enterprise + Scale
- Add policy/guardrail layer and workflow topology plugins

## What Was Implemented In This Branch
- Config-driven external plugin loading in `PluginRegistry`
  - Supports bare names via convention (`@composio/ao-plugin-{slot}-{name}`)
  - Supports direct npm package names and local path imports
- Plugin config extraction now forwards practical config:
  - Notifier config mapping (including `webhook` -> `webhookUrl` alias)
  - `terminal-web` dashboard URL derivation from configured port
- Added/updated core tests to lock behavior

## References
- LangGraph docs: https://langchain-ai.github.io/langgraph/
- AutoGen docs: https://microsoft.github.io/autogen/stable/
- CrewAI docs: https://docs.crewai.com/
- OpenHands docs: https://docs.all-hands.dev/
- OpenHands site (integrations/runtime summary): https://www.all-hands.dev/
- OpenAI Agents SDK repo: https://github.com/openai/openai-agents-python
- MCP servers/org: https://github.com/modelcontextprotocol
- Langfuse docs: https://langfuse.com/docs
- DeepWiki (LangGraph): https://deepwiki.com/langchain-ai/langgraph
- DeepWiki (AutoGen): https://deepwiki.com/microsoft/autogen
- DeepWiki (CrewAI): https://deepwiki.com/crewAIInc/crewAI
- DeepWiki (OpenHands): https://deepwiki.com/All-Hands-AI/OpenHands
