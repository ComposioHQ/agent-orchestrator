# JARVIS Spec Simplification Analysis

Research analysis of the JARVIS build spec — an autonomous software development orchestrator — evaluated against the existing Agent Orchestrator (AO) codebase to identify MVP features, unnecessary complexity, and a simplified architecture.

**Bottom line: AO already implements 70-80% of what JARVIS describes. The remaining 20-30% can be achieved with ~500 lines of TypeScript and zero new infrastructure dependencies.**

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [MVP vs Nice-to-Have Feature Matrix](#mvp-vs-nice-to-have)
3. [Real-Time Dashboard: Convex vs SSE](#real-time-convex-vs-sse)
4. [Supervisor Pattern: LangGraph vs TypeScript](#supervisor-langgraph-vs-typescript)
5. [Data Layer: PostgreSQL + pgvector + Redis vs Flat Files](#data-layer)
6. [Subprocess Orchestration: claude -p Patterns](#subprocess-orchestration)
7. [Auth and Self-Improvement](#auth-and-self-improvement)
8. [Risk Assessment](#risk-assessment)
9. [Simplified Architecture Proposal](#simplified-architecture)

---

## Executive Summary

The JARVIS spec describes a system with 9 major components. Here is how they map to what AO already has and what is actually needed:

| JARVIS Component | AO Already Has | Effort to Add | Verdict |
|-----------------|----------------|---------------|---------|
| Multi-agent orchestration (supervisor spawns parallel agents in worktrees) | Session manager + Runtime/Agent/Workspace plugins | ~120 lines for typed agent routing | **Build on AO** |
| LangGraph supervisor graph | Nothing (but doesn't need it) | 0 — use TypeScript state machine | **Skip LangGraph** |
| Real-time Next.js dashboard with Convex | SSE + REST API routes + Next.js dashboard | 0 — enhance existing SSE | **Skip Convex** |
| FastAPI + PostgreSQL + pgvector + Redis | Flat metadata files + JSONL events + SSE | 0 — current stack is sufficient | **Skip entirely** |
| Auth.js v5 + RBAC | Nothing (localhost-only tool) | ~50 lines for bearer token if needed | **Defer** |
| Self-improvement (modify own codebase) | Nothing | 1 file (lessons-learned.md) | **Defer self-modification, do prompt refinement** |
| Git worktree isolation per agent | Workspace plugin (worktree) | Already done | **Already exists** |
| SSE streaming for chat | SSE endpoint + WebSocket terminal | Enhance existing SSE | **Already mostly exists** |
| Convex HTTP API for orchestrator-to-dashboard sync | SSE snapshot events every 5s | Make SSE event-driven | **Skip Convex** |

**Estimated effort for JARVIS parity: 2-3 days of incremental improvements to AO, not a ground-up rewrite.**

---

## MVP vs Nice-to-Have

### Genuinely Necessary (MVP)

1. **Typed agent routing** — A supervisor that classifies tasks and routes to specialized agents (researcher, coder, reviewer, etc.) with different system prompts. This is ~80-120 lines of TypeScript using AO's existing `SessionManager.spawn()`.

2. **Parallel agent execution** — Spawning multiple agents concurrently, each in its own worktree. AO already does this with `ao start --issue <id>` for multiple issues.

3. **Task decomposition** — Breaking a large task into subtasks. A single `claude -p` call with structured JSON output can decompose and classify. ~30 lines.

4. **Status dashboard** — Real-time view of all agents, their status, and outputs. AO already has this at `packages/web/`.

5. **PR lifecycle management** — Auto-detecting PRs, monitoring CI, forwarding review comments. AO already does this via the SCM plugin + lifecycle manager + reaction engine.

### Nice-to-Have (Post-MVP)

6. **Chat interface** — Sending messages to agents via a web UI. AO has `ao send` and the terminal WebSocket. A chat UI is polish, not core functionality.

7. **Kanban board** — Visual task tracking with drag-and-drop. The existing session list with status filtering provides the same information. Kanban is a UX upgrade.

8. **Log streaming** — Real-time output from each agent. Can be added as a new SSE event type that tails `runtime.getOutput()`. ~50 lines.

9. **Bearer token auth** — Needed only when accessing remotely. ~50 lines of middleware.

### Not Needed (Skip or Much Later)

10. **Convex** — Adds vendor lock-in and dual-write complexity for zero benefit over SSE.
11. **LangGraph** — Framework designed for in-process LLM chains, not subprocess orchestration.
12. **PostgreSQL + pgvector** — Flat files + JSONL handles the scale (tens of sessions, not millions).
13. **Redis** — Single-process architecture doesn't need cross-process pub/sub.
14. **FastAPI** — Adding Python to a TypeScript codebase for no architectural reason.
15. **Auth.js v5 + RBAC** — No multi-user requirement exists.
16. **Self-modification** — Research-grade feature with unsolved safety problems. Use prompt refinement instead.

---

## Real-Time: Convex vs SSE

### Recommendation: Keep SSE. Do not add Convex.

**Why Convex doesn't fit:**

Convex is a reactive backend-as-a-service with automatic real-time query subscriptions. It excels when the database IS the source of truth and multiple clients need to see each other's writes instantly.

AO's data doesn't live in a database. It lives in:
- Flat metadata files on disk (session state)
- GitHub API (CI status, reviews, merge readiness)
- Runtime state (tmux alive/dead, terminal output)
- JSONL event logs

To use Convex, you'd need to sync all this data into Convex, then read it out reactively. That's strictly more complex than reading it directly via SSE.

**What AO already has:**

- `/api/events` SSE endpoint (103 lines) that pushes session snapshots every 5s
- WebSocket connections for terminal access
- REST API for mutations (spawn, kill, send, merge)

**What to improve (not replace):**

| Improvement | Effort | Impact |
|-------------|--------|--------|
| Make SSE event-driven (emit on state change, not polling every 5s) | ~50 lines | Sub-second updates |
| Add SWR/React Query on client for REST data | ~30 lines | Better caching, stale-while-revalidate |
| Add log streaming SSE endpoint | ~50 lines | Real-time agent output |
| Add chat message SSE events | ~30 lines | Agent responses in real-time |

**Cost comparison:**

| | SSE (current) | Convex |
|---|---|---|
| New dependencies | 0 | convex, @convex/react, cloud account |
| Data sync needed | No | Yes (must sync flat files + GitHub API into Convex) |
| Vendor lock-in | None | Medium-high |
| Lines of code | ~103 (exists) | Schema + queries + sync + hooks (hundreds) |
| Monthly cost | $0 | $0-$25+/month |

---

## Supervisor: LangGraph vs TypeScript

### Recommendation: TypeScript state machine. Skip LangGraph entirely.

**Why LangGraph doesn't fit:**

LangGraph is designed for **in-process LLM tool-calling chains** with graph-based state machines, checkpointing, and streaming middleware. The JARVIS supervisor needs to **spawn subprocesses in git worktrees** — a fundamentally different execution model.

Using LangGraph for subprocess orchestration is like using a database ORM to manage shell scripts. You'd use 10% of its capabilities while fighting the 90% that assumes in-process agents.

Additionally, LangGraph is primarily a Python framework. Adding Python to AO's TypeScript codebase creates a language boundary with no architectural benefit.

**What the supervisor actually needs to do:**

```
1. Receive a task description
2. Call claude -p to classify and decompose into subtasks
3. For each subtask, spawn an AO session with the right agent type and prompt
4. Monitor progress via existing lifecycle manager
5. Collect results when all agents complete
```

This is ~80-120 lines of TypeScript that uses AO's existing plugin system:

```typescript
// Simplified supervisor logic

type AgentType = "researcher" | "architect" | "coder" | "reviewer" | "devops" | "security";

const AGENT_PROMPTS: Record<AgentType, string> = {
  researcher: "You are a research agent. Investigate and document findings...",
  architect: "You are an architecture agent. Design the system structure...",
  coder: "You are a coding agent. Implement the feature...",
  reviewer: "You are a review agent. Review the code changes...",
  devops: "You are a devops agent. Set up infrastructure...",
  security: "You are a security agent. Audit for vulnerabilities...",
};

async function decompose(task: string): Promise<Array<{ type: AgentType; description: string }>> {
  const { stdout } = await execFileAsync("claude", [
    "-p", `Decompose into subtasks with types (${Object.keys(AGENT_PROMPTS).join("|")}). Return JSON.`,
    "--output-format", "json", "--json-schema", DECOMPOSE_SCHEMA
  ], { timeout: 60_000 });
  return JSON.parse(stdout).result;
}

async function runSupervisor(task: string, projectId: string) {
  const subtasks = await decompose(task);
  const sessions = await Promise.all(subtasks.map(st =>
    sessionManager.spawn({
      projectId,
      prompt: `${AGENT_PROMPTS[st.type]}\n\nTask: ${st.description}`,
    })
  ));
  // Lifecycle manager monitors progress, reactions handle CI/review
  return sessions;
}
```

**Comparison table:**

| Approach | Lines | Dependencies | Fits AO? |
|----------|-------|-------------|----------|
| LangGraph Python | ~50 + bridge code | 20-30 Python packages | No — language mismatch |
| LangGraph TypeScript | ~60 + adapter code | @langchain/langgraph + deps | No — over-engineered |
| TypeScript state machine | ~80-120 | 0 | Yes — native to codebase |

---

## Data Layer: PostgreSQL + pgvector + Redis vs Flat Files

### Recommendation: Keep flat files. No database needed for MVP.

**Current AO data layer:**

| Data | Storage | Scale |
|------|---------|-------|
| Session state | Flat key=value files | Tens of sessions |
| Events | JSONL append-only files | Thousands of events |
| Config | YAML + Zod validation | Single file |
| Real-time | In-memory Map + SSE | Single process |

**Why PostgreSQL is unnecessary:**

AO manages tens of concurrent sessions (bounded by how many agents a human can meaningfully review). Reads happen every 5-30 seconds. Writes happen on state transitions (a few per minute). `readdirSync` + file parsing handles this trivially. PostgreSQL solves concurrent multi-process writes to relational data — a problem AO doesn't have.

**Why pgvector is unnecessary:**

The "knowledge retrieval" use case is better served by:
1. Structured JSONL event logs (grep-searchable, already typed)
2. A `lessons-learned.md` file included in agent prompts
3. The 200K+ token context window of modern models

Semantic vector search adds value at scale (millions of documents). For hundreds of structured events, it's over-engineering.

**Why Redis is unnecessary:**

AO is single-process. In-process `EventEmitter` provides microsecond-latency pub/sub. Redis solves cross-process pub/sub and distributed caching — problems that don't exist here.

**Upgrade path (when needed):**

| Trigger | Upgrade To |
|---------|-----------|
| Need SQL queries on sessions | SQLite via `better-sqlite3` |
| Need full-text search on events | SQLite FTS5 |
| Need vector search | `sqlite-vec` extension |
| Need multi-server deployment | PostgreSQL (reconsider architecture) |

---

## Subprocess Orchestration: claude -p Patterns

### Recommendation: AO's approach is already correct. Enhance, don't replace.

**What AO already has that JARVIS reinvents:**

| JARVIS Component | AO Equivalent |
|-----------------|---------------|
| executor.py spawning subprocesses | Runtime plugin (tmux/process) + Agent plugin |
| Git worktree per agent | Workspace plugin (worktree) |
| Typed agent prompts | `AgentLaunchConfig.systemPrompt` + `prompt` |
| Result collection | `Agent.getSessionInfo()` |
| State tracking | SessionManager + LifecycleManager |
| PR/CI/review handling | SCM plugin with full PR lifecycle |

**What `claude -p` adds over interactive sessions:**

| Feature | Interactive (tmux) | Print mode (-p) |
|---------|-------------------|----------------|
| Structured output | Parse JSONL files | `--output-format json` |
| Cost control | Manual monitoring | `--max-budget-usd` |
| Human attachment | `tmux attach` | Not possible |
| Multi-turn | Natural | `--resume <session_id>` |
| Dependencies | tmux | None |

**The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) is worth tracking.** It's a TypeScript library that provides Claude Code's full agent loop (tools, file editing, bash execution) without subprocess overhead. Could back a future `runtime-sdk` plugin for containerized/serverless environments.

**Concrete improvements to AO:**

1. Add `--max-budget-usd` and `--max-turns` to `AgentLaunchConfig` for cost control
2. Enhance `runtime-process` to use `--output-format stream-json` for structured output
3. Keep tmux as the default for human-interactive workflows (the ability to `tmux attach` is a genuine differentiator)
4. Evaluate Agent SDK for environments where tmux is unavailable

---

## Auth and Self-Improvement

### Auth: Defer entirely for MVP

AO runs on localhost. Anyone with localhost access already has shell access. Auth is redundant.

**When remote access is needed:** Add a `DASHBOARD_TOKEN` env var with a single middleware check (~50 lines). Auth.js v5 + RBAC is only needed if AO becomes a multi-user platform, which requires a user model, persistent storage, and invitation flows that don't exist.

### Self-Improvement: Use prompt refinement, not code modification

Self-modifying orchestrators have uniquely high risk because:
- The orchestrator controls other agents — bugs cascade across all projects
- The orchestrator manages git — a broken workspace plugin corrupts working trees
- The orchestrator sends notifications — a broken notifier means humans never learn something failed

**Recommended alternatives (in order of priority):**

| Approach | Risk | Value | When |
|----------|------|-------|------|
| `docs/lessons-learned.md` included in prompts | None | High | Now |
| `agentRules`/`agentRulesFile` config refinement | Low | High | Already exists in config |
| Agent-filed improvement suggestions (GitHub issues) | Low | Medium | Near-term |
| Constrained YAML auto-tuning (thresholds, intervals) | Medium | Medium | Post-MVP |
| Full codebase self-modification | Very high | Low incremental over alternatives | Much later / possibly never |

---

## Risk Assessment

### Riskiest Parts of the JARVIS Build

Ranked by likelihood of failure multiplied by impact:

1. **Dual data layer (Convex + flat files)** — Risk: data consistency bugs, dual-write failures, debugging nightmare. Impact: corrupted dashboard state. **Mitigation: don't add Convex.**

2. **Python/TypeScript language boundary** — Risk: type safety gaps at the boundary, build complexity, developer context-switching. Impact: maintenance burden, bugs at the seam. **Mitigation: stay TypeScript-only.**

3. **Self-modification** — Risk: recursive failure, unintended scope, loss of human oversight. Impact: corrupted orchestrator, cascading failures. **Mitigation: use prompt refinement instead.**

4. **PostgreSQL + Redis operational burden** — Risk: migration management, connection pools, health monitoring, backup/restore. Impact: operational toil that distracts from feature work. **Mitigation: keep flat files.**

5. **LangGraph learning curve + API churn** — Risk: framework recently went through breaking changes (0.x to 1.x). Impact: wasted learning effort, rewrite risk. **Mitigation: use plain TypeScript.**

6. **Auth.js v5 complexity** — Risk: significant API changes from v4, session management edge cases, CSRF handling. Impact: auth bugs that block all users. **Mitigation: defer auth entirely.**

### Lowest-Risk Improvements

1. Typed agent routing via supervisor command — uses existing plugin system
2. Event-driven SSE — replacing polling with EventEmitter in existing code
3. `lessons-learned.md` — a single file, zero code changes
4. Cost control flags — passing `--max-budget-usd` through existing config

---

## Simplified Architecture Proposal

### The 80/20 Architecture

Delivers 80% of JARVIS's value at 20% of the complexity by building on AO:

```
┌─────────────────────────────────────────────────┐
│                  ao CLI                          │
│  ao start   — spawn agent on issue              │
│  ao plan    — decompose + spawn multiple agents  │  ← NEW: supervisor command
│  ao status  — list all sessions                  │
│  ao send    — send message to agent              │
│  ao kill    — terminate session                  │
│  ao open    — attach to agent terminal           │
└──────────────┬──────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────┐
│              Core Services                       │
│  SessionManager   — CRUD + spawn orchestration   │
│  LifecycleManager — state machine + reactions    │
│  PluginRegistry   — load + resolve plugins       │
│  Supervisor       — classify + decompose + route │  ← NEW: ~120 lines TS
└──────────────┬──────────────────────────────────┘
               │
     ┌─────────┼─────────┬──────────┬────────────┐
     ▼         ▼         ▼          ▼            ▼
  Runtime    Agent    Workspace   Tracker       SCM
  (tmux/     (claude-  (worktree)  (github/     (github)
   process)   code)                 linear)
```

### What to Build (In Priority Order)

**Phase 1: Typed Agent Routing (~2 days)**

Add `ao plan` command that:
1. Takes a high-level task description
2. Calls `claude -p` to decompose into typed subtasks
3. Spawns an AO session per subtask with agent-type-specific system prompts
4. Uses existing lifecycle manager to monitor and react

Files to modify:
- `packages/cli/src/commands/` — new `plan.ts` command
- `packages/core/src/` — new `supervisor.ts` service (~120 lines)
- `agent-orchestrator.yaml` — add agent type prompt templates to project config

**Phase 2: Event-Driven SSE (~1 day)**

Replace the 5s polling in the SSE endpoint with EventEmitter subscriptions:
1. Lifecycle manager emits typed events on state transitions
2. SSE handler subscribes and pushes immediately
3. Add log streaming as a new SSE event type

Files to modify:
- `packages/core/src/lifecycle-manager.ts` — emit events via EventEmitter
- `packages/web/src/app/api/events/route.ts` — subscribe to EventEmitter instead of polling
- `packages/web/src/app/api/sessions/[id]/logs/route.ts` — new log streaming endpoint

**Phase 3: Cost Control (~0.5 day)**

Add `--max-budget-usd` and `--max-turns` to agent launch config:

Files to modify:
- `packages/core/src/types.ts` — add fields to `AgentLaunchConfig`
- `packages/plugins/agent-claude-code/src/index.ts` — pass flags in `getLaunchCommand()`

**Phase 4: Dashboard Improvements (~2-3 days)**

Enhance the existing Next.js dashboard:
- Add SWR for client-side data fetching with stale-while-revalidate
- Add agent chat UI (using existing `ao send` + SSE for responses)
- Add log viewer component (consuming new log streaming SSE)
- Kanban view (grouping sessions by attention level — existing `getAttentionLevel()`)

**Phase 5: Knowledge/Learning System (~1 day)**

- Create `docs/lessons-learned.md`
- Include in agent system prompts via `agentRulesFile`
- Add a reaction that appends CI failure resolutions to the file
- Future: agents can write to it, humans review via git diffs

### What NOT to Build

| Component | Reason | Alternative |
|-----------|--------|-------------|
| Convex integration | Architectural mismatch, vendor lock-in | SSE + SWR |
| LangGraph supervisor | Wrong abstraction for subprocess orchestration | ~120 lines TypeScript |
| PostgreSQL database | Overkill for tens of sessions | Flat files (upgrade to SQLite if needed) |
| pgvector | No vector search use case at this scale | lessons-learned.md in prompts |
| Redis | Single-process, no cross-process pub/sub needed | EventEmitter |
| FastAPI backend | Adding Python to TypeScript codebase | Keep Next.js API routes |
| Auth.js v5 + RBAC | No multi-user requirement | Bearer token when remote access needed |
| Self-modification | Unsolved safety problems, high blast radius | Prompt refinement + lessons-learned |

### Estimated Total Effort

| Phase | Effort | New Dependencies |
|-------|--------|-----------------|
| Phase 1: Typed agent routing | ~2 days | 0 |
| Phase 2: Event-driven SSE | ~1 day | 0 |
| Phase 3: Cost control | ~0.5 day | 0 |
| Phase 4: Dashboard improvements | ~2-3 days | swr (1 package) |
| Phase 5: Knowledge system | ~1 day | 0 |
| **Total** | **~7 days** | **1 package** |

Compare to the JARVIS spec: Python + TypeScript dual codebase, LangGraph, Convex, PostgreSQL, pgvector, Redis, FastAPI, Auth.js v5 — estimated weeks to months with 10+ new dependencies and 3 hosted services.

---

## Key Insight

The JARVIS spec describes building a new system from scratch. But AO already IS the system — with a mature plugin architecture, session lifecycle management, PR/CI/review automation, and a real-time dashboard. The spec's value is in the **ideas** (typed agent routing, task decomposition, cost control), not in the **technology choices** (LangGraph, Convex, PostgreSQL, FastAPI). Take the ideas, implement them in AO's existing TypeScript stack, ship in days instead of months.
