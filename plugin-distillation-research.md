# Plugin Distillation Research — Agent Orchestrator Ecosystem Analysis

> **Date**: 2026-02-25
> **Purpose**: Deep research on 20+ open-source agent orchestrator repos to identify plugins, patterns, and features that can be distilled into our orchestrator's 8-slot plugin architecture.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Repositories Analyzed](#repositories-analyzed)
3. [Current Plugin Inventory](#current-plugin-inventory)
4. [Gap Analysis by Plugin Slot](#gap-analysis-by-plugin-slot)
5. [Plugin Distillation Matrix](#plugin-distillation-matrix)
6. [Cross-Cutting Patterns Worth Adopting](#cross-cutting-patterns-worth-adopting)
7. [Prioritized Implementation Roadmap](#prioritized-implementation-roadmap)
8. [Per-Repo Deep Research Summaries](#per-repo-deep-research-summaries)
9. [Sources](#sources)

---

## Executive Summary

We analyzed **20+ open-source agent orchestration repositories** spanning direct competitors, general multi-agent frameworks, sandbox runtimes, and notification/tracker ecosystems. The goal: identify every plugin, pattern, and feature that could be distilled into our 8-slot plugin architecture (Runtime, Agent, Workspace, Tracker, SCM, Notifier, Terminal, Lifecycle).

### Key Findings

- **Our architecture is the most modular** — no other project has clean, typed, swappable plugin interfaces for all 8 concerns. Most are monolithic.
- **Our biggest gaps are**: runtime-docker/k8s, tracker-jira, scm-gitlab, agent-gemini-cli, memory/intelligence layer, agent-to-agent messaging, and terminal-kitty/warp.
- **Our biggest strengths vs. competitors**: typed plugin contracts with compile-time `satisfies` checking, tracker/SCM integration, auto-reactions for CI/reviews, push notification system, and stateless metadata design.
- **Most valuable distillation targets**: Docker/K8s runtimes (from OpenSandbox, K8s Agent Sandbox), memory system (from ai-maestro, crewAI), agent-to-agent messaging (from ai-maestro AMP), intelligent routing (from claude-flow), and new agent plugins (Gemini CLI, Amp, Q CLI).

### Implementation update (this branch)

Implemented from this distillation cycle:
- Agent plugins: `gemini`, `goose`, `amazon-q`, `kiro`
- Notifier plugins: `discord`, `teams`, `telegram`
- Terminal plugins: `kitty`, `wezterm`

These are fully wired as built-ins in the plugin registry and CLI dependency graph.

### Repos by Relevance to Our System

| Tier | Repository | Why |
|------|-----------|-----|
| **Direct competitors** | claude-squad, ai-maestro, CAO, sandboxed.sh, tmux-orchestrator | Same problem space: CLI coding agents + tmux |
| **Framework inspiration** | crewAI, Swarms, Microsoft Agent Framework, Agent Squad | Orchestration patterns, memory, routing |
| **Runtime substrates** | OpenSandbox, K8s Agent Sandbox, Docker cagent | Container/K8s runtime plugins |
| **Plugin/skill repos** | wshobson/agents, agent-view | Skill definitions, TUI, progressive disclosure |
| **Feature-specific** | claude-flow, AI-Agents-Orchestrator | Swarm intelligence, fallback/offline patterns |

---

## Repositories Analyzed

| # | Repository | Stars | Language | License | Category |
|---|-----------|-------|----------|---------|----------|
| 1 | [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad) | 6,100 | Go | AGPL-3.0 | Direct competitor |
| 2 | [ruvnet/claude-flow](https://github.com/ruvnet/claude-flow) | 14,400 | TypeScript | MIT | Framework |
| 3 | [awslabs/cli-agent-orchestrator](https://github.com/awslabs/cli-agent-orchestrator) | 256 | Python | Apache-2.0 | Direct competitor |
| 4 | [awslabs/agent-squad](https://github.com/awslabs/agent-squad) | 7,456 | Python+TS | Apache-2.0 | Framework |
| 5 | [23blocks-OS/ai-maestro](https://github.com/23blocks-OS/ai-maestro) | 354 | TypeScript | MIT | Direct competitor |
| 6 | [hoangsonww/AI-Agents-Orchestrator](https://github.com/hoangsonww/AI-Agents-Orchestrator) | 14 | Python | MIT | Framework |
| 7 | [crewAIInc/crewAI](https://github.com/crewAIInc/crewAI) | 44,600 | Python | MIT | Framework |
| 8 | [kyegomez/swarms](https://github.com/kyegomez/swarms) | 5,800 | Python | Apache-2.0 | Framework |
| 9 | [microsoft/agent-framework](https://github.com/microsoft/agent-framework) | 7,400 | Python+.NET | MIT | Framework |
| 10 | [wshobson/agents](https://github.com/wshobson/agents) | 240+ commits | Markdown | MIT | Skill marketplace |
| 11 | [Frayo44/agent-view](https://github.com/Frayo44/agent-view) | 112 | TypeScript | MIT | TUI monitor |
| 12 | [bufanoc/tmux-orchestrator-ai-code](https://github.com/bufanoc/tmux-orchestrator-ai-code) | — | Bash+Python | MIT | Direct competitor |
| 13 | [docker/cagent](https://github.com/docker/cagent) | 2,000 | Go | Apache-2.0 | Agent framework |
| 14 | [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) | 1,100 | Go+Python | Apache-2.0 | K8s runtime |
| 15 | [alibaba/OpenSandbox](https://github.com/alibaba/OpenSandbox) | 1,100 | Python+Go+TS | Apache-2.0 | Sandbox platform |
| 16 | [Th0rgal/openagent](https://github.com/Th0rgal/openagent) (sandboxed.sh) | 252 | Rust+TS | MIT | Self-hosted orchestrator |
| 17+ | Notification/Tracker/Terminal ecosystem research (agent-slack, Linear API, Jira integration patterns, Convoy, terminal-notifier, Kitty, Warp, cmux) | — | Various | Various | Plugin research |

---

## Current Plugin Inventory

| Slot | Existing Plugins | Count |
|------|-----------------|-------|
| **Runtime** | tmux, process | 2 |
| **Agent** | claude-code, codex, aider, opencode | 4 |
| **Workspace** | worktree, clone | 2 |
| **Tracker** | github, linear | 2 |
| **SCM** | github | 1 |
| **Notifier** | desktop, slack, composio, webhook | 4 |
| **Terminal** | iterm2, web | 2 |
| **Lifecycle** | (core, not pluggable) | — |
| **Total** | | **17** |

---

## Gap Analysis by Plugin Slot

### Runtime (Current: tmux, process)

**Missing plugins identified from research:**

| Plugin | Source Repo | Priority | Rationale |
|--------|-----------|----------|-----------|
| `runtime-docker` | OpenSandbox, cagent | **High** | Direct Docker container management via `docker create/start/exec`. Works anywhere Docker runs. Simplest path to container isolation. |
| `runtime-opensandbox` | alibaba/OpenSandbox | **High** | Clean HTTP API maps directly to our Runtime interface. Supports both Docker (dev) and K8s (prod). TypeScript SDK available. Network egress controls. Pause/resume for cost savings. |
| `runtime-k8s-sandbox` | kubernetes-sigs/agent-sandbox | **Medium** | Official K8s SIG project. gVisor/Kata isolation. Warm pools for sub-second startup. Will likely become the standard K8s primitive for agent workloads. |
| `runtime-nspawn` | Th0rgal/openagent | **Low** | systemd-nspawn for lighter-weight Linux isolation. Faster than Docker, no daemon dependency. Validated by sandboxed.sh. |

**Key implementation details:**
- OpenSandbox has a two-tier API (Lifecycle API for provisioning, Execution API for commands) that maps cleanly to our `Runtime` interface's `create()`/`destroy()`/`sendMessage()`/`getOutput()`
- K8s Agent Sandbox uses CRDs (`Sandbox`, `SandboxTemplate`, `SandboxClaim`, `SandboxWarmPool`) — our plugin would create `SandboxClaim` resources
- Docker standalone would use `execFile("docker", ["create", ...])` / `execFile("docker", ["exec", ...])` — consistent with our `execFile` security requirement

### Agent (Current: claude-code, codex, aider, opencode)

**Missing plugins identified from research:**

| Plugin | Source Repo | Priority | Rationale |
|--------|-----------|----------|-----------|
| `agent-gemini-cli` | agent-view, AI-Agents-Orchestrator | **High** | Google's Gemini CLI is now widely used. Agent View already supports it. |
| `agent-amp` | Th0rgal/openagent | **Medium** | Sourcegraph's Amp coding agent. sandboxed.sh validates it works in orchestrated environments. |
| `agent-q-cli` | awslabs/cli-agent-orchestrator | **Medium** | Amazon Q CLI. CAO has a working provider with regex-based status detection. |
| `agent-kiro-cli` | awslabs/cli-agent-orchestrator | **Low** | AWS Kiro CLI. Same status detection patterns as Q CLI. |
| `agent-ollama` | AI-Agents-Orchestrator | **Low** | Local models via Ollama HTTP API. Enables offline/fallback operation. |
| `agent-cagent` | docker/cagent | **Low** | Treat a Docker cagent team as a single agent within our orchestrator. |

**Key patterns from research:**
- CAO uses regex-based terminal output parsing to detect 5 states (IDLE, PROCESSING, COMPLETED, WAITING_USER_ANSWER, ERROR) — this is how all CLI agents could be monitored
- AI-Agents-Orchestrator's `FallbackManager` concept: try primary cloud agent, on transient failure, fall back to local agent (Ollama)
- claude-squad's `generic-agent` via arbitrary shell command — our agent interface already supports this

### Workspace (Current: worktree, clone)

**No new plugins identified**, but patterns worth noting:

| Pattern | Source Repo | Notes |
|---------|-----------|-------|
| Session forking | agent-view | Fork a running session into a new worktree mid-task |
| Agent portability | ai-maestro | Export/import agent state as ZIP archives |
| Per-mission scoping | sandboxed.sh | File scoping model with per-mission directories |
| Container workspaces | OpenSandbox | Each sandbox gets isolated filesystem + persistent storage |

### Tracker (Current: github, linear)

**Missing plugins identified from research:**

| Plugin | Source Repo | Priority | Rationale |
|--------|-----------|----------|-----------|
| `tracker-jira` | CrewAI-Agentic-Jira, OpenAI Codex cookbook | **High** | Jira is the dominant enterprise tracker. REST API is straightforward. Proven ticket-to-PR patterns exist (Codex cookbook). |
| `tracker-asana` | — | **Low** | Asana has a REST API. Lower priority than Jira. |

**Key implementation details for `tracker-jira`:**
- REST API at `https://{instance}.atlassian.net/rest/api/3/`
- Auth: `JIRA_API_TOKEN` + `JIRA_EMAIL` as Basic Auth
- Status transitions require dynamic transition ID lookup via `GET /issue/{id}/transitions`
- JQL for querying: `project = "PROJ" AND status = "To Do" AND assignee = currentUser()`
- Follow `tracker-linear`'s `GraphQLTransport` pattern: support both direct REST and Composio SDK transports

### SCM (Current: github)

**Missing plugins identified from research:**

| Plugin | Source Repo | Priority | Rationale |
|--------|-----------|----------|-----------|
| `scm-gitlab` | — | **Medium** | GitLab is the second-largest SCM. MRs map to PRs, pipelines map to CI checks. |
| `scm-bitbucket` | — | **Low** | Bitbucket Cloud has a REST API. Lower priority. |

### Notifier (Current: desktop, slack, composio, webhook)

**Missing/enhanced plugins identified from research:**

| Plugin | Source Repo | Priority | Rationale |
|--------|-----------|----------|-----------|
| `notifier-discord` | ai-maestro | **Medium** | ai-maestro has Discord gateway (port 3023). Discord's webhook API is simpler than Slack's. |
| `notifier-telegram` | — | **Medium** | Telegram Bot API is extremely simple. One HTTP POST per message. |
| `notifier-email` | ai-maestro | **Low** | ai-maestro has email gateway (port 3020). Useful for enterprise teams. |
| `notifier-slack-app` (interactive) | Slack ecosystem | **Low** | Full Slack App with Socket Mode for interactive buttons ("Approve Merge", "View PR"). Current plugin is one-way webhook only. |
| Desktop notifier upgrade | terminal-notifier, node-notifier | **Medium** | Replace `osascript` with `terminal-notifier` for click-through URLs, notification grouping, custom icons. Add Windows support via `node-notifier`. |
| Webhook HMAC signing | Convoy, Composio | **Low** | Add `X-Webhook-Signature` HMAC-SHA256 header to `notifier-webhook` for authenticity verification. |

### Terminal (Current: iterm2, web)

**Missing plugins identified from research:**

| Plugin | Source Repo | Priority | Rationale |
|--------|-----------|----------|-----------|
| `terminal-kitty` | Kitty remote control docs | **High** | Cross-platform (macOS + Linux), JSON-based protocol, more reliable than AppleScript. `kitty @ launch --type=tab` / `kitty @ focus-tab`. |
| `terminal-warp` | warpdotdev/Warp | **Medium** | Now open source. Agent-focused ("Agentic Development Environment"). Multiple autonomous agents in panes. |
| `terminal-cmux` | manaflow-ai/cmux | **Low** | Purpose-built for AI agents. `cmux notify` CLI, socket API for pane management, agent metadata display. Small user base. |
| `terminal-tui` (ao tui) | agent-view | **Medium** | Ink/blessed TUI for terminal-based monitoring. Vim-style navigation, status indicators, session management. |

**Enhancement: `terminal-iterm2`** — migrate from AppleScript to Python API (via `it2` CLI) for better reliability, error handling, and split pane support.

### Lifecycle / Core (Not a plugin slot, but extensible)

**New capabilities identified from research:**

| Capability | Source Repo | Priority | Description |
|-----------|-----------|----------|-------------|
| **Memory system** | ai-maestro, crewAI | **High** | Per-session persistent memory (CozoDB/SQLite/LanceDB). Semantic search over past conversations. Code graph via AST. Hierarchical scoping. |
| **Agent messaging (AMP)** | ai-maestro | **High** | Formal agent-to-agent messaging with priority, types, Ed25519 signatures, file-based persistence + instant delivery. |
| **Intelligent routing** | claude-flow | **Medium** | 3-tier complexity-based routing: cheap/medium/expensive model selection per task. |
| **Self-scheduling** | tmux-orchestrator | **Medium** | Agents schedule their own next check-in with contextual notes for autonomous operation. |
| **Circuit breaker** | AI-Agents-Orchestrator | **Medium** | Closed/Open/HalfOpen pattern — stop sending work to repeatedly-failing agents temporarily. |
| **Fallback/degradation** | AI-Agents-Orchestrator | **Medium** | Auto-route from failed cloud agent to local fallback on transient errors. |
| **Webhook receiver** | Linear/Jira/GitHub webhooks | **Medium** | Event-driven session spawning from external system webhooks instead of polling. |
| **Background workers** | claude-flow | **Low** | Daemon with scheduled workers for code mapping, security audit, test gap analysis, memory consolidation. |
| **Consensus/voting** | Swarms | **Low** | Multiple agents review same code, iteratively build consensus. For high-stakes changes. |
| **Workflow chains** | AI-Agents-Orchestrator, crewAI | **Low** | Sequential agent pipelines where Agent A implements, Agent B reviews, Agent C refines. |

---

## Plugin Distillation Matrix

This matrix maps specific features from researched repos to concrete plugin implementations.

### From claude-squad (smtg-ai)
| Feature | Our Plugin | Implementation |
|---------|-----------|----------------|
| Daemon/autoyes mode | Lifecycle | Auto-approve agent permission prompts for autonomous operation |
| Dual-polling (100ms/500ms) | Runtime | Fast poll for active sessions, slow poll for idle |
| Pause/resume with worktree teardown | Workspace | Pause agent, preserve worktree, resume later |
| Generic-agent via shell command | Agent | Already supported via our agent interface |

### From claude-flow (ruvnet)
| Feature | Our Plugin | Implementation |
|---------|-----------|----------------|
| 3-tier complexity routing | Lifecycle | Classify task complexity -> route to Haiku/Sonnet/Opus |
| ReasoningBank (RETRIEVE/JUDGE/DISTILL/CONSOLIDATE) | Memory (new) | Store successful patterns, reuse for similar tasks |
| Stream-JSON chaining | Agent/Runtime | Agent-to-agent streaming without intermediate files |
| Background workers | Lifecycle | Scheduled workers for code mapping, test gaps, audits |
| Token optimization | Agent | Context compression middleware between agent and LLM |

### From AWS CLI Agent Orchestrator
| Feature | Our Plugin | Implementation |
|---------|-----------|----------------|
| MCP server for orchestration | Core | Expose `ao` as MCP tools (spawn, status, message) |
| Cron-scheduled flows | Lifecycle | Automated agent sessions on schedule with preconditions |
| Watchdog-based message delivery | Runtime | Filesystem observers on terminal logs for idle detection |
| Regex-based status detection | Agent | Scan terminal output for agent state patterns |
| Agent profiles (YAML frontmatter .md) | Agent | Portable agent configuration format |

### From Agent Squad (AWS)
| Feature | Our Plugin | Implementation |
|---------|-----------|----------------|
| LLM-powered intent classification | Lifecycle | Auto-route tasks to best agent based on description analysis |
| Agent-as-tools pattern | Lifecycle | Wrap agents as callable tools for a supervisor agent |
| Three-tier memory | Memory (new) | User-facing, internal-team, and combined memory stores |
| Overlap analysis | Lifecycle | Detect agent capability conflicts in configuration |

### From ai-maestro (23blocks)
| Feature | Our Plugin | Implementation |
|---------|-----------|----------------|
| Agent Messaging Protocol (AMP) | Messaging (new) | File-based persistence + tmux instant delivery, Ed25519 signed |
| Per-agent CozoDB | Memory (new) | Graph database for memory, code entities, embeddings |
| Self-staggering subconscious | Lifecycle | Background processing with hash-based offset staggering |
| Delta indexing for code graph | Memory (new) | Content-hash incremental re-indexing (10x speedup) |
| External gateways (Slack/Discord/Email/WhatsApp) | Notifier | Bidirectional messaging bridges to external platforms |
| Peer mesh networking | Runtime | Multi-machine orchestration via SSH |

### From crewAI
| Feature | Our Plugin | Implementation |
|---------|-----------|----------------|
| Flow decorator DSL (@start/@listen/@router) | Lifecycle | Event-driven workflow composition for reactions |
| Hierarchical process with auto-manager | Lifecycle | Auto-generate manager agent for complex task decomposition |
| Unified Memory with scope trees | Memory (new) | `/project/app/agent/claude-1/session/abc` hierarchy |
| Memory consolidation with dedup | Memory (new) | Detect near-duplicates, LLM-driven merge decisions |
| Non-blocking memory (drain-on-read) | Memory (new) | Background saves, sync on read |
| A2A protocol support | Core | Agent-to-Agent protocol for inter-agent communication |

### From Swarms
| Feature | Our Plugin | Implementation |
|---------|-----------|----------------|
| SwarmRouter with auto-selection | Lifecycle | Embedding-based auto-select of orchestration strategy |
| AgentRearrange string syntax ("a -> b, c") | Config | Concise flow definition in YAML config |
| MajorityVoting consensus | Lifecycle | Multi-agent code review with iterative consensus |
| SpreadSheetSwarm massive parallelism | Lifecycle | CSV-tracked bulk operations (refactor 500 files) |
| HeavySwarm 5-phase analysis | Lifecycle | Comprehend -> analyze -> research -> implement -> validate |
| Shared memory with rule injection | Memory (new) | Cross-agent shared context with behavioral constraints |

### From Microsoft Agent Framework
| Feature | Our Plugin | Implementation |
|---------|-----------|----------------|
| 5 orchestration patterns | Lifecycle | Sequential, concurrent, handoff, group chat, magentic |
| Middleware pipeline | Core | Request/response interception for plugins |
| Workflow-as-Agent | Lifecycle | Treat composed workflow as single callable agent |
| Checkpointing | Lifecycle | Save/restore long-running session state |
| Time-travel debugging | Web dashboard | Replay sessions from JSONL event logs |

### From wshobson/agents
| Feature | Our Plugin | Implementation |
|---------|-----------|----------------|
| Progressive disclosure (99% token savings) | Plugin loader | 3-tier loading: metadata -> instructions -> resources |
| Zero-token marketplace | CLI/Web | Browse plugins without loading into context |
| Skill activation triggers | Lifecycle | Auto-activate skills based on task pattern matching |
| Model tier assignment | Agent config | Per-task model selection (Opus/Sonnet/Haiku) |
| 146 skills library | Skills (new) | Distill domain knowledge into reusable skill files |

### From Docker/K8s Runtimes
| Feature | Our Plugin | Implementation |
|---------|-----------|----------------|
| OpenSandbox HTTP API | `runtime-opensandbox` | POST /v1/sandboxes, commands/run, files/read |
| K8s Sandbox CRDs + warm pools | `runtime-k8s-sandbox` | SandboxClaim + SandboxTemplate + SandboxWarmPool |
| OCI registry distribution | Plugin distribution | Package agents/configs as OCI artifacts |
| Egress network controls | Runtime config | Configurable allowed domains per sandbox |
| Pause/resume (CRIU) | Runtime | Cost savings for idle sessions |
| Deterministic testing (cassettes) | Testing | Record/replay agent interactions for testing |

### From Notification/Tracker Ecosystem
| Feature | Our Plugin | Implementation |
|---------|-----------|----------------|
| Jira REST API integration | `tracker-jira` | Full CRUD with dynamic transition ID lookup |
| terminal-notifier click-through | `notifier-desktop` upgrade | Replace osascript, add URLs, grouping |
| Kitty remote control | `terminal-kitty` | JSON-based protocol, cross-platform |
| Warp agent panes | `terminal-warp` | Open source, agent-focused terminal |
| Slack message threading | `notifier-slack` upgrade | Thread follow-ups under original PR notification |
| HMAC webhook signing | `notifier-webhook` upgrade | Authenticity verification |
| Webhook receiver | Web package | Event-driven session spawning from external systems |

---

## Cross-Cutting Patterns Worth Adopting

### 1. Event-Driven Session Spawning
**Source**: Linear webhooks, Jira automation, GitHub webhooks
**Pattern**: Instead of polling trackers, receive webhook events from external systems to trigger session creation. Add webhook receiver endpoints to the web package.

### 2. Dual-Channel Notification Delivery
**Source**: ai-maestro
**Pattern**: Deliver notifications through both persistent storage (reliability) and instant channel (responsiveness) simultaneously. If webhook fails, the event is still in the log.

### 3. Notification Grouping/Replacement
**Source**: terminal-notifier, Slack `chat.update`
**Pattern**: Use session ID as group key so status updates replace rather than stack. Prevents notification flooding.

### 4. Transport Abstraction for Integrations
**Source**: tracker-linear's `GraphQLTransport` pattern
**Pattern**: Support both direct API and Composio SDK transports for each tracker/SCM plugin. Users choose based on their setup.

### 5. Agent State Detection via Terminal Output
**Source**: CAO, claude-squad, agent-view
**Pattern**: Regex-based parsing of terminal output to detect agent states (idle, processing, waiting for input, error) without modifying the agent itself.

### 6. Tiered Model Routing
**Source**: claude-flow, wshobson/agents
**Pattern**: Route tasks to appropriate model tier based on complexity. Simple fixes -> Haiku, standard features -> Sonnet, complex architecture -> Opus.

### 7. Self-Scheduling Agents
**Source**: tmux-orchestrator-ai-code
**Pattern**: Agents schedule their own next check-in with contextual notes. Enables truly autonomous overnight operation.

### 8. Circuit Breaker for Agent Failures
**Source**: AI-Agents-Orchestrator
**Pattern**: Closed/Open/HalfOpen states. After N consecutive failures, stop sending work to that agent temporarily. Auto-recovery testing after cooldown.

### 9. Progressive Disclosure for Token Efficiency
**Source**: wshobson/agents
**Pattern**: Three-tier loading (metadata ~20 tokens -> instructions ~500 tokens -> resources ~2000 tokens) reduces context window usage by 99%.

### 10. Specification-First Workflow
**Source**: tmux-orchestrator-ai-code
**Pattern**: Require clear task specifications before spawning agents. Enforced in lifecycle: validate issue has sufficient detail before allocation.

---

## Prioritized Implementation Roadmap

### Tier 1 — High Priority (Direct plugin gap fills)

| # | Plugin | Slot | Effort | Impact | Source Reference |
|---|--------|------|--------|--------|-----------------|
| 1 | `runtime-docker` | Runtime | Medium | High | OpenSandbox, cagent |
| 2 | `tracker-jira` | Tracker | Medium | High | Codex Jira cookbook, CrewAI-Agentic-Jira |
| 3 | `agent-gemini-cli` | Agent | Low | High | agent-view, AI-Agents-Orchestrator |
| 4 | `terminal-kitty` | Terminal | Low | Medium | Kitty remote control docs |
| 5 | `notifier-desktop` upgrade | Notifier | Low | Medium | terminal-notifier, node-notifier |
| 6 | `notifier-discord` | Notifier | Low | Medium | ai-maestro gateway pattern |

### Tier 2 — Medium Priority (Competitive features)

| # | Plugin | Slot | Effort | Impact | Source Reference |
|---|--------|------|--------|--------|-----------------|
| 7 | `runtime-opensandbox` | Runtime | Medium | High | alibaba/OpenSandbox |
| 8 | `scm-gitlab` | SCM | Medium | Medium | GitLab MR/Pipeline API |
| 9 | `agent-amp` | Agent | Low | Low | Th0rgal/openagent |
| 10 | `agent-q-cli` | Agent | Low | Low | awslabs/cli-agent-orchestrator |
| 11 | `terminal-warp` | Terminal | Medium | Medium | warpdotdev/Warp |
| 12 | `notifier-telegram` | Notifier | Low | Low | Telegram Bot API |
| 13 | `notifier-slack` upgrade (threading) | Notifier | Low | Medium | Slack Web API |

### Tier 3 — High-Value Core Enhancements (Not plugins, but features)

| # | Feature | Area | Effort | Impact | Source Reference |
|---|---------|------|--------|--------|-----------------|
| 14 | Memory system | New plugin slot | High | Very High | ai-maestro CozoDB, crewAI Memory |
| 15 | Agent-to-agent messaging | Lifecycle | High | High | ai-maestro AMP |
| 16 | Webhook receiver (event-driven spawning) | Web | Medium | High | Linear/Jira/GitHub webhooks |
| 17 | Intelligent task routing | Lifecycle | Medium | Medium | claude-flow 3-tier routing |
| 18 | Circuit breaker pattern | Core | Low | Medium | AI-Agents-Orchestrator |
| 19 | Self-scheduling agents | Lifecycle | Low | Medium | tmux-orchestrator-ai-code |
| 20 | MCP server for orchestration | Core | Medium | Medium | awslabs/cli-agent-orchestrator |

### Tier 4 — Future / Exploratory

| # | Feature | Area | Effort | Impact | Source Reference |
|---|---------|------|--------|--------|-----------------|
| 21 | `runtime-k8s-sandbox` | Runtime | High | Medium | kubernetes-sigs/agent-sandbox |
| 22 | Consensus/voting for code review | Lifecycle | Medium | Low | Swarms MajorityVoting |
| 23 | Workflow chains (sequential pipelines) | Lifecycle | Medium | Low | crewAI Flows, AI-Agents-Orchestrator |
| 24 | Background workers | Lifecycle | High | Low | claude-flow daemon |
| 25 | Progressive disclosure plugin loader | Core | Medium | Low | wshobson/agents |
| 26 | OCI registry for agent distribution | Distribution | Medium | Low | docker/cagent |
| 27 | TUI dashboard (`ao tui`) | CLI | Medium | Medium | agent-view |

---

## Per-Repo Deep Research Summaries

### 1. smtg-ai/claude-squad

**Overview**: 6.1k stars, Go, AGPL-3.0. Terminal TUI managing multiple AI agents in tmux sessions with git worktree isolation.

**Architecture**: Single Go binary. TUI (Bubble Tea) -> tmux session manager -> git worktree manager. No plugin system.

**Key features**: Daemon mode (autoyes), dual-polling (100ms active / 500ms idle), pause/resume with worktree teardown, generic-agent via shell command.

**What they do better**: Simpler UX for individual developers, beautiful TUI, session forking.

**What we do better**: Plugin architecture, tracker/SCM integration, auto-reactions, push notifications, multi-runtime support.

**Distillable ideas**: Daemon/autoyes pattern, dual-polling optimization, pause/resume with worktree preservation.

---

### 2. ruvnet/claude-flow

**Overview**: 14.4k stars, TypeScript, MIT. Multi-agent swarm platform with 250K+ LOC V3 rebuild.

**Architecture**: Monorepo with 15 packages. CLI (26 commands) + MCP Server (175+ tools). Swarm coordination with queen types. 12 background workers.

**Key features**: 3-tier intelligent routing (WASM/cheap/expensive), SONA self-learning, ReasoningBank pipeline, 6 swarm topologies, 5 consensus algorithms, stream-JSON chaining.

**Critical assessment**: 85% mock/stub controversy (Issue #653). Claims vs. reality gap. Impressive feature breadth but credibility concerns.

**Distillable ideas**: Complexity-based model routing, background worker daemon, ReasoningBank learning loop, token optimization middleware, stream-chaining for agent communication.

---

### 3. awslabs/cli-agent-orchestrator (CAO)

**Overview**: 256 stars, Python, Apache-2.0. Hierarchical multi-agent orchestration in tmux terminals.

**Architecture**: Four-layer (entry points -> services -> provider system -> clients). FastAPI HTTP + MCP server. SQLite persistence. Watchdog file observers.

**Key features**: 3 MCP tools (handoff/assign/send_message), cron-scheduled flows, regex-based status detection for 4 CLI providers (Q CLI, Kiro, Claude Code, Codex), agent profiles as markdown with YAML frontmatter.

**Distillable ideas**: MCP server for orchestration, scheduled flows with preconditions, Watchdog-based message delivery, terminal output regex for status detection, `CAO_TERMINAL_ID` ambient context pattern.

---

### 4. awslabs/agent-squad

**Overview**: 7.4k stars, Python+TypeScript, Apache-2.0. Conversational multi-agent framework (formerly Multi-Agent Orchestrator).

**Architecture**: Hub-and-spoke with LLM classifier. In-process agents (not CLI processes). SupervisorAgent with agent-as-tools pattern.

**Key features**: LLM-powered intent classification, dual language (Python+TS), streaming with AccumulatorTransform, 3-tier memory in SupervisorAgent, agent overlap analysis, storage-agnostic persistence.

**Distillable ideas**: LLM classifier for task routing, agent-as-tools pattern, three-tier memory architecture, overlap analysis for agent configurations, streaming accumulator.

---

### 5. 23blocks-OS/ai-maestro

**Overview**: 354 stars, TypeScript, MIT. Agent orchestrator with skills, memory, and messaging. Single Next.js app.

**Architecture**: Custom server.mjs (HTTP+WebSocket), 6 subsystems, filesystem-first storage, agent-first identity model.

**Key features**: Agent Messaging Protocol (AMP) with Ed25519 signatures, per-agent CozoDB graph database, self-staggering subconscious scheduler, delta indexing for code graph, external gateways (Slack/Discord/Email/WhatsApp), peer mesh networking, agent portability via ZIP export.

**What they do better**: Memory/intelligence layer, agent-to-agent messaging, multi-machine support, rich dashboard.

**What we do better**: Plugin architecture, tracker/SCM integration, auto-reactions, push notifications.

**Distillable ideas**: AMP messaging protocol, per-agent graph DB, self-staggering background processing, delta indexing, external gateway pattern, peer mesh networking, agent portability.

---

### 6. hoangsonww/AI-Agents-Orchestrator

**Overview**: 14 stars, Python, MIT. Sequential multi-agent pipeline for code quality.

**Architecture**: 5-layer (interface -> orchestration -> cross-cutting -> adapter -> runtime). CLI (Click+Rich) + Vue 3 dashboard.

**Key features**: FallbackManager (cloud-to-local routing), circuit breaker (Closed/Open/HalfOpen), 3-tier caching, Prometheus metrics, offline mode with Ollama/llama.cpp, iterative refinement with stopping criteria.

**Distillable ideas**: FallbackManager pattern, circuit breaker, offline mode with local models, iteration with `min_suggestions_threshold`, Prometheus observability plugin.

---

### 7. crewAIInc/crewAI

**Overview**: 44.6k stars, Python, MIT. Role-playing autonomous AI agent framework.

**Architecture**: Dual model — Crews (autonomous agent teams) + Flows (event-driven DAG workflows with `@start`/`@listen`/`@router` decorators).

**Key features**: Unified Memory class with hierarchical scoping and composite scoring, memory consolidation with LLM-driven dedup, non-blocking saves with drain-on-read, A2A protocol, 100+ tools, HITL support.

**Distillable ideas**: Flow decorator DSL for lifecycle events, auto-generated manager agent, unified memory with scope trees, memory consolidation, non-blocking persistence, A2A protocol.

---

### 8. kyegomez/swarms

**Overview**: 5.8k stars, Python, Apache-2.0. Enterprise multi-agent orchestration with 14+ swarm architectures.

**Architecture**: SwarmRouter factory pattern with auto-selection via embeddings. LiteLLM for 100+ providers.

**Key features**: 14+ topologies (Sequential, Concurrent, MajorityVoting, MoA, GroupChat, Hierarchical, GraphWorkflow, SpreadSheetSwarm, ForestSwarm), AgentRearrange string syntax ("a -> b, c"), HeavySwarm 5-phase analysis, AutoSwarmBuilder, shared memory with rule injection.

**Distillable ideas**: SwarmRouter auto-selection, string-based flow syntax, MajorityVoting for code review, SpreadSheetSwarm for bulk operations, HeavySwarm 5-phase pattern, shared memory with rules.

---

### 9. microsoft/agent-framework

**Overview**: 7.4k stars, Python+.NET, MIT. Successor to Semantic Kernel + AutoGen.

**Architecture**: Three-tier (Agent -> ChatClient -> Workflow). 22 Python packages. 5 orchestration patterns.

**Key features**: Sequential/Concurrent/Handoff/GroupChat/Magentic patterns, Workflow-as-Agent, time-travel debugging, checkpointing, middleware pipeline, DevUI, A2A protocol, OpenTelemetry built-in.

**Distillable ideas**: 5 orchestration patterns, middleware pipeline, Workflow-as-Agent abstraction, checkpointing, time-travel debugging from event logs.

---

### 10. wshobson/agents

**Overview**: 72 plugins, 112 agents, 146 skills for Claude Code. Unix-philosophy marketplace.

**Architecture**: Four-layer (marketplace registry -> plugin structure -> runtime -> execution tiers). Progressive disclosure (99% token savings).

**Key features**: Zero-token marketplace browsing, 3-tier progressive loading, 4-tier model strategy (Opus/Inherit/Sonnet/Haiku), 16 workflow orchestrators, Conductor project management, hypothesis-driven debugging.

**Distillable ideas**: Progressive disclosure pattern, zero-token marketplace, skill activation triggers, model tier assignment, 146-skill domain knowledge library.

---

### 11. Frayo44/agent-view

**Overview**: 112 stars, TypeScript (Bun), MIT. TUI for managing AI coding sessions.

**Architecture**: Bun + tmux. Vim-style keyboard navigation. Tool-agnostic (Claude Code, Gemini CLI, OpenCode, Codex, custom).

**Key features**: Session forking with git worktree, smart status detection, command palette, standalone binaries.

**Distillable ideas**: TUI dashboard pattern (`ao tui`), status detection heuristics, session forking, tool-agnostic monitoring.

---

### 12. bufanoc/tmux-orchestrator-ai-code

**Overview**: Shell scripts + Python. Three-tier agent hierarchy for autonomous overnight coding.

**Architecture**: Orchestrator -> Project Managers -> Engineers. Communication via `tmux send-keys`. Self-scheduling with `schedule_with_note.sh`.

**Key features**: Self-scheduling agents, 3-tier hierarchy, cross-project intelligence, 30-minute commit discipline, accumulated learnings.

**Distillable ideas**: Self-scheduling pattern, three-tier hierarchy for agent roles, 30-minute commit policy, specification-first workflow, overnight autonomous mode.

---

### 13-16. Docker/K8s Agent Runtimes

**Docker cagent** (2k stars, Go): Full agent framework with OCI distribution. Not a sandbox runtime but a peer to our orchestrator. Interesting for: OCI registry model, deterministic cassette testing, provider fallback chains.

**K8s Agent Sandbox** (1.1k stars, Go+Python): Official K8s SIG project. CRD-based sandbox management. Warm pools for sub-second startup. gVisor/Kata isolation. Will likely become the K8s standard for agent workloads.

**OpenSandbox** (1.1k stars, Alibaba): Most integration-ready sandbox platform. Clean two-tier API (Lifecycle + Execution). Docker + K8s runtimes. Multi-language SDKs (Python, TS, Java). Network egress controls. Pause/resume via CRIU.

**Sandboxed.sh** (252 stars, Rust+TS): Self-hosted orchestrator with systemd-nspawn isolation. Supports Claude Code, OpenCode, Amp. Validates nspawn as viable lightweight runtime.

---

### Notification/Tracker/Terminal Ecosystem

**Slack**: Current webhook plugin is one-way. Upgrade path: Slack Web API for threading + message updates. Full Slack App with Socket Mode for interactive buttons.

**Linear**: Existing plugin is comprehensive. Enhancement: Add webhook receiver for event-driven session spawning (issue assigned -> auto-spawn).

**Jira**: REST API at `https://{instance}.atlassian.net/rest/api/3/`. Auth via Basic (email + API token). Status transitions require dynamic transition ID lookup. JQL for queries. Proven patterns in Codex cookbook.

**Desktop**: Replace `osascript` with `terminal-notifier` for click-through URLs, grouping, and custom icons. Add `node-notifier` for Windows support.

**Terminal-Kitty**: JSON-based remote control protocol. `kitty @ launch --type=tab --title session-name tmux attach -t session`. Cross-platform.

**Terminal-Warp**: Open-source agentic terminal. Autonomous agent panes. Multi-agent support (Oz + Claude Code + Codex).

**Terminal-cmux**: Purpose-built for AI agents. Notification via `cmux notify` CLI or OSC escape sequences. Socket API for pane management.

---

## Sources

### Primary Repositories
- [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad)
- [ruvnet/claude-flow](https://github.com/ruvnet/claude-flow) | [DeepWiki](https://deepwiki.com/ruvnet/claude-flow)
- [awslabs/cli-agent-orchestrator](https://github.com/awslabs/cli-agent-orchestrator) | [DeepWiki](https://deepwiki.com/awslabs/cli-agent-orchestrator)
- [awslabs/agent-squad](https://github.com/awslabs/agent-squad) | [DeepWiki](https://deepwiki.com/awslabs/agent-squad)
- [23blocks-OS/ai-maestro](https://github.com/23blocks-OS/ai-maestro) | [DeepWiki](https://deepwiki.com/23blocks-OS/ai-maestro)
- [hoangsonww/AI-Agents-Orchestrator](https://github.com/hoangsonww/AI-Agents-Orchestrator) | [DeepWiki](https://deepwiki.com/hoangsonww/AI-Agents-Orchestrator)
- [crewAIInc/crewAI](https://github.com/crewAIInc/crewAI) | [DeepWiki](https://deepwiki.com/crewAIInc/crewAI)
- [kyegomez/swarms](https://github.com/kyegomez/swarms) | [DeepWiki](https://deepwiki.com/kyegomez/swarms)
- [microsoft/agent-framework](https://github.com/microsoft/agent-framework)
- [wshobson/agents](https://github.com/wshobson/agents)
- [Frayo44/agent-view](https://github.com/Frayo44/agent-view)
- [bufanoc/tmux-orchestrator-ai-code](https://github.com/bufanoc/tmux-orchestrator-ai-code)
- [docker/cagent](https://github.com/docker/cagent)
- [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
- [alibaba/OpenSandbox](https://github.com/alibaba/OpenSandbox)
- [Th0rgal/openagent](https://github.com/Th0rgal/openagent) (sandboxed.sh)

### Documentation and Blog Posts
- [AWS Blog: Introducing CLI Agent Orchestrator](https://aws.amazon.com/blogs/opensource/introducing-cli-agent-orchestrator-transforming-developer-cli-tools-into-a-multi-agent-powerhouse/)
- [Microsoft Learn: Agent Framework Overview](https://learn.microsoft.com/en-us/agent-framework/overview/agent-framework-overview)
- [Microsoft Learn: Workflow Orchestrations](https://learn.microsoft.com/en-us/agent-framework/user-guide/workflows/orchestrations/overview)
- [Google: Unleashing AI Agents on K8s](https://opensource.googleblog.com/2025/11/unleashing-autonomous-ai-agents-why-kubernetes-needs-a-new-standard-for-agent-execution.html)
- [Docker Blog: Build and Distribute AI Agents with cagent](https://www.docker.com/blog/cagent-build-and-distribute-ai-agents-and-workflows/)
- [CrewAI Docs: Memory](https://docs.crewai.com/en/concepts/memory) | [Flows](https://docs.crewai.com/en/concepts/flows)
- [Swarms Docs: Multi-Agent Architectures](https://docs.swarms.world/en/latest/swarms/structs/)
- [OpenAI Codex Jira-GitHub Cookbook](https://developers.openai.com/cookbook/examples/codex/jira-github)
- [Linear Webhooks Developer Docs](https://linear.app/developers/webhooks)
- [Kitty Remote Control](https://sw.kovidgoyal.net/kitty/remote-control/)
- [iTerm2 Python API](https://iterm2.com/python-api/)

### Third-Party Analysis
- [Open Source AI Agent Frameworks Compared 2026](https://openagents.org/blog/posts/2026-02-23-open-source-ai-agent-frameworks-compared)
- [Top 7 Agentic AI Frameworks 2026](https://www.alphamatch.ai/blog/top-agentic-ai-frameworks-2026)
- [9 Best AI Orchestration Tools in 2026](https://getstream.io/blog/best-ai-orchestration-tools/)
- [CrewAI Framework 2025 Complete Review](https://latenode.com/blog/ai-frameworks-technical-infrastructure/crewai-framework/crewai-framework-2025-complete-review-of-the-open-source-multi-agent-ai-platform)
- [AI Maestro: From 47 Terminal Windows to One Dashboard](https://medium.com/23blocks/building-ai-maestro-from-47-terminal-windows-to-one-beautiful-dashboard-64cd25ff3b43)
- [Claude-Flow Issue #653: Mock/Stub Implementations](https://github.com/ruvnet/claude-flow/issues/653)
