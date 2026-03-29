# Codebase Walkthrough — A Beginner-Friendly Tutorial

> **Who is this for?** Anyone who wants to understand how Agent Orchestrator works — from first-time contributors to curious developers who learn by reading code. No prior knowledge of the project is assumed.

---

## Table of Contents

1. [What Does This Project Do? (The Big Picture)](#1-what-does-this-project-do)
2. [A Simple Analogy](#2-a-simple-analogy)
3. [Repository Layout — How Files Are Organized](#3-repository-layout)
4. [Package Tour — Each Piece Explained](#4-package-tour)
   - [Core Library](#41-core-the-brain)
   - [CLI](#42-cli-the-command-center)
   - [Web Dashboard](#43-web-dashboard-the-control-room)
   - [Plugins](#44-plugins-the-swap-in-swap-out-parts)
5. [The Plugin System in Detail](#5-the-plugin-system-in-detail)
6. [How Data Flows Through the System](#6-how-data-flows-through-the-system)
7. [Key Concepts Explained Simply](#7-key-concepts-explained-simply)
   - [Sessions](#sessions)
   - [Worktrees](#worktrees)
   - [Reactions](#reactions)
   - [Metadata Storage](#metadata-storage)
8. [Step-by-Step: What Happens When You Run `ao start`](#8-step-by-step-ao-start)
9. [Step-by-Step: What Happens When CI Fails](#9-step-by-step-ci-fails)
10. [Diving Into the Code — File by File](#10-diving-into-the-code)
11. [Configuration Reference (Plain Language)](#11-configuration-reference)
12. [Contributing — Where to Start](#12-contributing)
13. [Glossary](#13-glossary)

---

## 1. What Does This Project Do?

Imagine you have 30 software bugs to fix. You could:

- **Option A** — Fix them yourself, one by one. Takes weeks.
- **Option B** — Hire 30 contractors, give each one a bug to fix, and just review their work.

Agent Orchestrator is the system that makes **Option B** work with AI agents instead of human contractors.

It:
1. Takes a list of issues (bugs, features, tasks) from GitHub or Linear.
2. Spins up one AI coding agent per issue, each in its own isolated copy of the codebase.
3. Watches what the agents do — did CI pass? Did a reviewer ask for changes?
4. Automatically routes feedback back to the right agent ("Your CI failed, here's why. Fix it.").
5. Notifies you when a PR is ready to merge.

You set it up once, and then you mostly just review and approve PRs.

---

## 2. A Simple Analogy

Think of it like a **construction company**:

| Construction Company | Agent Orchestrator |
|---|---|
| The company office | The **web dashboard** (localhost:3000) |
| The project manager | The **orchestrator agent** (a special AI session) |
| Workers | **AI coding agents** (Claude Code, Aider, etc.) |
| Job sites | **Git worktrees** (isolated copies of the codebase) |
| Work orders | **Issues** (GitHub/Linear tickets) |
| Building inspector | **CI system** (GitHub Actions, etc.) |
| Client feedback | **Code reviews** |
| Walkie-talkie | **tmux** (how the system talks to agents) |
| Company rulebook | **Plugin interfaces** (the contracts every tool must follow) |

When the building inspector (CI) finds a problem, the project manager (orchestrator) radios the worker (agent) with the details. The worker fixes it without you having to get involved.

---

## 3. Repository Layout

```
agent-orchestrator/
│
├── packages/               ← All source code lives here
│   ├── core/               ← The brain — types, config, business logic
│   ├── cli/                ← The `ao` command you type in your terminal
│   ├── web/                ← The dashboard you see in your browser
│   ├── ao/                 ← Thin wrapper that installs the `ao` binary globally
│   ├── mobile/             ← Mobile app (iOS/Android) for monitoring on the go
│   ├── plugins/            ← 20 swappable modules (runtime, agent, tracker, etc.)
│   └── integration-tests/  ← End-to-end tests (3,288 test cases)
│
├── docs/                   ← Documentation (you are here)
├── examples/               ← Example config files
├── scripts/                ← Setup and build scripts
│
├── agent-orchestrator.yaml.example  ← Template config file
├── ARCHITECTURE.md         ← Technical architecture notes
├── README.md               ← Project overview and quick start
└── package.json            ← Monorepo root (pnpm workspaces)
```

This is a **monorepo** — multiple packages in one repository, managed by pnpm. Each `packages/` subdirectory is its own npm package with its own `package.json`.

---

## 4. Package Tour

### 4.1 Core — The Brain

**Location:** `packages/core/`
**npm name:** `@composio/ao-core`

The core package is the heart of the system. Everything else depends on it. It does not have a user-facing command — it is a library that other packages import.

**What it contains:**

| File | What it does |
|---|---|
| `src/types.ts` | Defines every TypeScript interface in the system (39 KB) |
| `src/config.ts` | Reads and validates `agent-orchestrator.yaml` |
| `src/session-manager.ts` | Creates, kills, lists, and manages sessions |
| `src/lifecycle-manager.ts` | The state machine — decides what reaction to trigger next |
| `src/plugin-registry.ts` | Loads the right plugin for each slot |
| `src/metadata.ts` | Reads and writes session metadata files |
| `src/paths.ts` | Computes file paths using the hash-based naming system |
| `src/decomposer.ts` | Uses an LLM to break big tasks into smaller sub-tasks |
| `src/prompt-builder.ts` | Assembles the full prompt given to each agent |

**The most important file: `types.ts`**

This file defines 8 interfaces (one per "plugin slot") and every data structure in the system. If you want to understand what an `Agent`, `Runtime`, or `Session` looks like, start here.

```typescript
// packages/core/src/types.ts (simplified)

interface Session {
  id: string;             // e.g. "app-1"
  projectId: string;      // e.g. "my-app"
  status: SessionStatus;  // working, pr_open, merged, etc.
  branch: string | null;  // e.g. "feat/issue-42"
  pr: PRInfo | null;      // set once the agent opens a PR
}

interface Runtime {
  create(config): Promise<RuntimeHandle>;   // Start a tmux session
  sendMessage(handle, msg): Promise<void>;  // Type text into the session
  getOutput(handle): Promise<string>;       // Read what's on screen
}
```

### 4.2 CLI — The Command Center

**Location:** `packages/cli/`
**npm name:** `@composio/ao-cli`

This is the code behind every `ao` command you run. Each command lives in its own file under `src/commands/`.

**Commands and where they live:**

| Command | File | What it does |
|---|---|---|
| `ao start` | `commands/start.ts` | Boots the whole system — dashboard + orchestrator |
| `ao spawn` | `commands/spawn.ts` | Creates a new session for one issue |
| `ao session` | `commands/session.ts` | Lists or inspects sessions |
| `ao status` | `commands/status.ts` | Shows a status summary |
| `ao send` | `commands/send.ts` | Sends a message to a running agent |
| `ao open` | `commands/open.ts` | Opens a session in your terminal |
| `ao kill` | `commands/kill.ts` | Stops a session |
| `ao init` | `commands/init.ts` | Creates a starter config file |
| `ao doctor` | `commands/doctor.ts` | Diagnoses common setup issues |

**Entry point:** `packages/cli/src/index.ts` — this registers all commands with [Commander](https://github.com/tj/commander.js), the CLI framework used here.

### 4.3 Web Dashboard — The Control Room

**Location:** `packages/web/`
**npm name:** `@composio/ao-web`
**Tech stack:** Next.js 15, React 19, TailwindCSS, xterm.js

The dashboard is a Next.js application. It runs at `http://localhost:3000` when you run `ao start`.

**How to navigate the code:**

```
packages/web/src/
├── app/                    ← Next.js App Router pages
│   ├── page.tsx            ← Main dashboard page (session list)
│   ├── layout.tsx          ← Root layout (theme, fonts)
│   └── api/                ← API routes (the backend)
│       ├── sessions/       ← CRUD for sessions
│       ├── projects/       ← List projects
│       ├── events/         ← Server-Sent Events for live updates
│       ├── webhooks/       ← Receives GitHub/GitLab webhooks
│       └── prs/            ← PR actions (merge, close)
│
├── components/             ← React components
│   ├── Dashboard.tsx       ← The main session list view
│   ├── SessionCard.tsx     ← One card per session
│   ├── Terminal.tsx        ← Browser-based terminal (xterm.js)
│   └── ...
│
└── server/                 ← WebSocket servers (run alongside Next.js)
    ├── terminal-websocket.ts  ← Streams terminal output to browser
    └── direct-terminal-ws.ts  ← Proxies raw terminal for xterm.js
```

**How the dashboard stays live:**

The dashboard uses two mechanisms for real-time updates:
1. **Server-Sent Events (SSE)** via `/api/events` — the server pushes session status updates as a stream.
2. **WebSocket** via port 3001 — the browser connects to see live terminal output from agents.

### 4.4 Plugins — The Swap-In-Swap-Out Parts

**Location:** `packages/plugins/`

There are 20 plugin packages. Each one implements exactly one TypeScript interface from `core/types.ts`.

```
packages/plugins/
├── runtime-tmux/       ← Run agents in tmux sessions (default)
├── runtime-process/    ← Run agents as child processes
├── agent-claude-code/  ← Use Claude Code as the AI agent (default)
├── agent-aider/        ← Use Aider as the AI agent
├── agent-codex/        ← Use OpenAI Codex as the AI agent
├── agent-opencode/     ← Use Composio OpenCode as the AI agent
├── workspace-worktree/ ← Use git worktrees for isolation (default)
├── workspace-clone/    ← Use git clone for isolation
├── tracker-github/     ← Get issues from GitHub (default)
├── tracker-linear/     ← Get issues from Linear
├── tracker-gitlab/     ← Get issues from GitLab
├── scm-github/         ← Manage PRs, CI, reviews on GitHub (default)
├── scm-gitlab/         ← Manage PRs, CI, reviews on GitLab
├── notifier-desktop/   ← Send OS desktop notifications (default)
├── notifier-slack/     ← Send Slack messages
├── notifier-composio/  ← Unified notifications (Slack, Discord, email)
├── notifier-webhook/   ← POST to a generic webhook URL
├── notifier-openclaw/  ← OpenClaw-specific webhook
├── terminal-web/       ← Open sessions in browser terminal
└── terminal-iterm2/    ← Open sessions in macOS iTerm2
```

---

## 5. The Plugin System in Detail

This is the most important architectural concept in the codebase. Understanding it makes everything else click.

### The problem it solves

Different teams use different tools. Some use GitHub, some use GitLab. Some want Claude Code, some want Aider. Rather than hard-coding support for every combination, the system defines **contracts** (TypeScript interfaces) and lets plugins fulfill them.

### How a plugin is structured

Every plugin package exports a `PluginModule` object:

```typescript
// Example: packages/plugins/runtime-tmux/src/index.ts

import type { PluginModule, Runtime } from "@composio/ao-core";

export const plugin: PluginModule<Runtime> = {
  manifest: {
    name: "runtime-tmux",    // Unique identifier
    slot: "runtime",         // Which interface does this fill?
    description: "Run agents inside tmux sessions",
  },

  // Called once to check if tmux is installed
  detect(): boolean {
    return checkTmuxInstalled();
  },

  // Called to create an instance with optional config
  create(config?): Runtime {
    return new TmuxRuntime(config);
  },
};
```

The `create()` function returns an object that implements the `Runtime` interface. The rest of the system only ever calls the interface methods — it never knows which plugin is underneath.

### The 8 plugin slots

| Slot | Interface | Question it answers |
|---|---|---|
| `runtime` | `Runtime` | *Where* does the agent process run? (tmux, child process) |
| `agent` | `Agent` | *Which* AI tool is the agent? (Claude Code, Aider) |
| `workspace` | `Workspace` | *How* is the code isolated? (worktree, clone) |
| `tracker` | `Tracker` | *Where* do issues come from? (GitHub, Linear) |
| `scm` | `SCM` | *How* are PRs, CI, and reviews managed? (GitHub, GitLab) |
| `notifier` | `Notifier` | *How* are humans notified? (desktop, Slack) |
| `terminal` | `Terminal` | *How* do humans view agent output? (browser, iTerm2) |
| `lifecycle` | `Lifecycle` | *What* reactions fire when events happen? (built-in) |

### Swapping a plugin

In `agent-orchestrator.yaml`:

```yaml
defaults:
  runtime: tmux          # Use runtime-tmux plugin
  agent: claude-code     # Use agent-claude-code plugin

projects:
  my-app:
    agent: aider         # Override just for this project
```

The plugin registry reads this config and loads the right packages at startup.

---

## 6. How Data Flows Through the System

Let's trace the path of data from a GitHub issue to a merged PR.

```
GitHub Issue #42
       │
       ▼
┌─────────────────┐
│  Tracker Plugin │  tracker-github fetches issue title, body, labels
│  (tracker-github│
└────────┬────────┘
         │ Issue data
         ▼
┌─────────────────┐
│ Prompt Builder  │  Assembles: system prompt + project rules + issue body
│ (core)          │
└────────┬────────┘
         │ Full prompt text
         ▼
┌─────────────────┐
│ Workspace Plugin│  workspace-worktree creates a new git branch + worktree
│ (workspace-     │  at ~/.agent-orchestrator/{hash}-{project}/worktrees/app-1/
│  worktree)      │
└────────┬────────┘
         │ Worktree path
         ▼
┌─────────────────┐
│ Runtime Plugin  │  runtime-tmux starts a tmux session named {hash}-app-1
│ (runtime-tmux)  │  and types the agent launch command into it
└────────┬────────┘
         │ Agent is running
         ▼
┌─────────────────┐
│  Agent Plugin   │  agent-claude-code monitors the tmux output to detect
│ (agent-claude-  │  activity state: active, ready, idle, blocked, exited
│  code)          │
└────────┬────────┘
         │ Agent writes code, commits, pushes
         ▼
┌─────────────────┐
│  SCM Plugin     │  scm-github detects the pushed branch, creates a PR,
│  (scm-github)   │  polls CI status and review decisions
└────────┬────────┘
         │ PR opened, CI passes, review approved
         ▼
┌─────────────────┐
│ Lifecycle Mgr   │  Evaluates reactions: approved-and-green → notify
│ (core)          │
└────────┬────────┘
         │ Notification event
         ▼
┌─────────────────┐
│ Notifier Plugin │  notifier-desktop shows: "PR #42 is ready to merge!"
│ (notifier-      │
│  desktop)       │
└─────────────────┘
         │ You click "Merge" on the dashboard
         ▼
    PR is merged. Session is archived.
```

### Where does data live?

| Data | Where it lives | Updated by |
|---|---|---|
| Session status | `~/.agent-orchestrator/{hash}-{project}/sessions/{id}` | Core + workspace hooks |
| Git code | `~/.agent-orchestrator/{hash}-{project}/worktrees/{id}/` | The agent |
| Config | `agent-orchestrator.yaml` in your project | You |
| Dashboard state | Next.js server memory + SSE stream | Lifecycle manager |
| PR/CI data | GitHub/GitLab APIs | SCM plugin |

---

## 7. Key Concepts Explained Simply

### Sessions

A **session** is one unit of work: one AI agent, working on one issue, in one isolated branch.

Every session has a **short name** (e.g. `app-1`) you use in commands, and a **tmux name** (e.g. `a3b4c5d6-app-1`) that is globally unique even if you have multiple checkouts of this repo.

Session states form a progression:

```
spawning → working → pr_open → merged
                 ↘ exited
```

Session **activity** describes what the agent is doing right now:

```
active   → The agent is typing / running commands
ready    → The agent is waiting for input
idle     → No output for a while
blocked  → The agent seems stuck
exited   → The agent process stopped
```

### Worktrees

A **git worktree** is like making a copy of your repository without actually copying all the files. Git is clever enough to share the object store, so creating a worktree is fast and cheap.

Each session gets its own worktree at:
```
~/.agent-orchestrator/{hash}-{project}/worktrees/{session-id}/
```

This means 30 agents can work on the same codebase simultaneously, each on their own branch, without interfering with each other.

### Reactions

A **reaction** is an automated response to an event. You configure them in `agent-orchestrator.yaml`:

```yaml
reactions:
  ci-failed:              # When this event happens...
    auto: true            # ...trigger automatically (not waiting for human)
    action: send-to-agent # ...do this
    retries: 2            # Try this reaction up to 2 times before escalating
    message: "CI failed. Logs: {logs}"
```

Built-in reaction triggers:
- `ci-failed` — CI checks are failing on the agent's PR
- `changes-requested` — A reviewer requested changes
- `approved-and-green` — PR is approved and CI is passing
- `session-stuck` — Agent has been idle for too long

### Metadata Storage

The system stores each session's state in a plain text key=value file:

```
# ~/.agent-orchestrator/a3b4c5d6-my-app/sessions/app-1

project=my-app
issue=42
branch=feat/issue-42
status=pr_open
tmuxName=a3b4c5d6-app-1
worktree=/home/user/.agent-orchestrator/a3b4c5d6-my-app/worktrees/app-1
pr=https://github.com/org/repo/pull/123
createdAt=2026-03-01T10:30:00Z
```

The **hash** in the directory name (`a3b4c5d6`) is derived from the directory where your `agent-orchestrator.yaml` lives. This means:
- Two different checkouts of this repo will never collide, even if both manage the same project.
- All projects within the same config share the same hash prefix.

---

## 8. Step-by-Step: `ao start`

When you run `ao start https://github.com/org/repo`, here's exactly what happens:

**Step 1 — Parse arguments and locate config**
```
packages/cli/src/commands/start.ts
```
The CLI checks if a config file already exists. If not, it generates one with sensible defaults.

**Step 2 — Load and validate config**
```
packages/core/src/config.ts → loadConfig()
```
The YAML file is read and validated with Zod. Every field is type-checked. If something is wrong, you get a clear error message.

**Step 3 — Build the plugin registry**
```
packages/core/src/plugin-registry.ts → createPluginRegistry()
```
The registry reads the `defaults` section of your config and loads the corresponding plugin packages. Each plugin's `detect()` method is called to check if the required tool is installed (e.g., is tmux available?).

**Step 4 — Create the session manager**
```
packages/core/src/session-manager.ts → createSessionManager()
```
The session manager is initialized with the plugin registry. It can now spawn, list, and kill sessions.

**Step 5 — Spawn the orchestrator agent**
```
packages/cli/src/commands/start.ts → spawnOrchestrator()
```
A special session is created for the "orchestrator" — an AI agent that itself uses the `ao` CLI to manage worker sessions. It reads your issues and decides which ones to work on.

**Step 6 — Start the web dashboard**
```
packages/web/server/start-all.js
```
Next.js starts on port 3000. WebSocket servers start on ports 3001 and 3003 for terminal streaming.

**Step 7 — Start the lifecycle worker**
```
packages/cli/src/commands/lifecycle-worker.ts
```
A background process starts polling all active sessions every few seconds. It checks CI status, review status, and agent activity. When it detects an event, it evaluates the configured reactions.

**Step 8 — Open the browser**
The CLI opens `http://localhost:3000` in your default browser.

---

## 9. Step-by-Step: CI Fails

This is the reaction loop in action. A CI check fails on an agent's PR.

**Step 1 — GitHub sends a webhook**

GitHub POSTs to `http://your-server:3000/api/webhooks/github` with a payload describing the failed check run.

**Step 2 — Webhook is parsed**
```
packages/web/src/app/api/webhooks/[...slug]/route.ts
→ packages/plugins/scm-github/src/index.ts → parseWebhook()
```
The SCM plugin verifies the webhook signature (security) and extracts the PR number and check status.

**Step 3 — Event is emitted**

An `OrchestratorEvent` of type `ci.failing` is created and stored. The SSE stream pushes this to the dashboard so the status icon turns red immediately.

**Step 4 — Lifecycle manager reacts**
```
packages/core/src/lifecycle-manager.ts → evaluateReactions()
```
The lifecycle manager checks: is there a reaction configured for `ci-failed`? Is `auto: true`? If yes, it queues the reaction.

**Step 5 — CI logs are fetched**
```
packages/plugins/scm-github/src/index.ts → getCIChecks()
```
The SCM plugin fetches the full CI logs from GitHub's API so they can be sent to the agent.

**Step 6 — Message is sent to agent**
```
packages/core/src/session-manager.ts → sendMessage()
→ packages/plugins/runtime-tmux/src/index.ts → sendMessage()
```
The message "Your CI is failing. Here are the logs: ..." is typed into the agent's tmux session.

**Step 7 — Agent reads and responds**

Claude Code (or whichever agent is configured) reads the message, understands the failure, edits the relevant code, and pushes a new commit.

**Step 8 — CI runs again**

GitHub runs CI on the new commit. If it passes, the lifecycle manager fires the `ci.passing` event, and the dashboard updates to green.

---

## 10. Diving Into the Code

Here are the most educational files to read, in order:

### Start here (15 minutes)

1. **`packages/core/src/types.ts`** (lines 1–200)
   Read just the interface definitions. You'll see `Runtime`, `Agent`, `Workspace`, `Tracker`, `SCM`, `Notifier`. Every plugin implements one of these.

2. **`packages/core/src/config.ts`** (lines 1–100)
   See how the YAML config is loaded and validated with Zod schemas. Notice how it maps to the `OrchestratorConfig` type.

3. **`packages/plugins/runtime-tmux/src/index.ts`** (whole file)
   A concrete, short plugin implementation. Great for seeing the plugin pattern in practice.

### Understand the core loop (30 minutes)

4. **`packages/core/src/session-manager.ts`** (lines 1–150)
   The `spawn()` and `list()` functions. Understand what data is stored per session.

5. **`packages/core/src/lifecycle-manager.ts`** (lines 1–200)
   The state machine and reaction evaluator. This is the "brain" of automation.

6. **`packages/core/src/metadata.ts`** (whole file)
   Very short. Shows how session state is persisted in flat key=value files.

### See the full picture (60 minutes)

7. **`packages/cli/src/commands/start.ts`** (whole file)
   The entry point for `ao start`. Shows how all pieces are wired together.

8. **`packages/web/src/app/page.tsx`** (whole file)
   The main dashboard page. Shows how session data is fetched and displayed.

9. **`packages/web/src/app/api/events/route.ts`** (whole file)
   The Server-Sent Events endpoint. Shows how live updates reach the browser.

---

## 11. Configuration Reference

The `agent-orchestrator.yaml` file controls everything. Here is every section explained in plain language:

```yaml
# ─── Dashboard ───────────────────────────────────────────────
port: 3000              # Browser visits localhost:3000

# ─── Default Plugins ─────────────────────────────────────────
defaults:
  runtime: tmux         # Run agents in tmux (or: process)
  agent: claude-code    # Use Claude Code (or: aider, codex, opencode)
  workspace: worktree   # Isolate code in git worktrees (or: clone)
  notifiers:            # How to notify you (can list multiple)
    - desktop           # OS desktop notification

# ─── Projects ────────────────────────────────────────────────
projects:
  my-app:                         # Internal project ID
    repo: owner/my-app            # GitHub "owner/repo"
    path: ~/my-app                # Where the repo lives on your machine
    defaultBranch: main           # Base branch for PRs
    sessionPrefix: app            # Sessions named app-1, app-2, ...

    # Issue tracker (optional — defaults to GitHub)
    tracker:
      plugin: linear
      teamId: TEAM-ABC

    # Per-project overrides
    agent: aider                  # Use Aider instead of Claude Code here

    # Rules injected into every agent's prompt
    agentRules: |
      Always write tests.
      Never modify migrations directly.

# ─── Notifications ───────────────────────────────────────────
notifiers:
  my-slack:
    plugin: notifier-slack
    webhookUrl: https://hooks.slack.com/...

notificationRouting:
  high:   [desktop, my-slack]     # High priority → both channels
  medium: [desktop]
  low:    []                      # Low priority → silent

# ─── Reactions ───────────────────────────────────────────────
reactions:
  ci-failed:
    auto: true                    # Trigger without waiting for human
    action: send-to-agent         # Send a message to the agent
    retries: 2                    # Retry up to 2 times
    message: "CI failed. Fix it." # Custom message (optional)

  changes-requested:
    auto: true
    action: send-to-agent
    escalateAfter: 30m            # Notify human if not resolved in 30 min

  approved-and-green:
    auto: false                   # Wait for human approval to merge
    action: notify                # Just notify, don't auto-merge
```

---

## 12. Contributing

If you want to contribute, here are the best places to start:

### Add a new plugin

The cleanest contribution. Pick an interface (`Runtime`, `Agent`, `Tracker`, etc.), create a new package in `packages/plugins/`, implement the interface, and export a `PluginModule`.

1. Copy an existing plugin as a template: `cp -r packages/plugins/runtime-tmux packages/plugins/runtime-docker`
2. Implement the interface in `src/index.ts`
3. Add the package to `pnpm-workspace.yaml`
4. Register it in `packages/core/src/plugin-registry.ts`
5. Write tests

### Fix a bug

1. Read `TROUBLESHOOTING.md` for common issues.
2. Run `ao doctor` to see if the system can diagnose itself.
3. Check `packages/integration-tests/` for the relevant test.

### Improve the dashboard

The web package is a standard Next.js application. Components live in `packages/web/src/components/`. The main session list is in `Dashboard.tsx` and `SessionCard.tsx`.

### Before opening a PR

```bash
pnpm build       # Build all packages
pnpm typecheck   # Check TypeScript
pnpm lint        # Check code style
pnpm test        # Run all 3,288 tests
```

---

## 13. Glossary

| Term | Plain language meaning |
|---|---|
| **Agent** | An AI coding tool (Claude Code, Aider, etc.) that writes and edits code |
| **Activity state** | What an agent is doing right now: active, ready, idle, blocked, or exited |
| **CI** | Continuous Integration — automated tests and checks that run on every PR |
| **Commander** | The Node.js library used to build the `ao` CLI |
| **ESM** | ECMAScript Modules — the `import`/`export` system used in this codebase |
| **Git worktree** | An additional working directory linked to the same git repository, allowing multiple branches to be checked out simultaneously |
| **Hash** | A short fingerprint derived from your config file's directory path, used to prevent name collisions |
| **Lifecycle manager** | The component that watches session state and decides which reactions to fire |
| **Metadata file** | A plain text key=value file that stores a session's current state |
| **Monorepo** | A single repository containing multiple packages (here, managed by pnpm) |
| **Next.js** | The React framework used for the web dashboard |
| **Notifier** | A plugin that sends alerts to humans (desktop notifications, Slack, etc.) |
| **Orchestrator agent** | A special AI session that itself uses the `ao` CLI to manage worker agents |
| **Plugin** | A swappable module that implements one interface (Runtime, Agent, etc.) |
| **Plugin slot** | One of the 8 abstraction points where a plugin can be swapped in |
| **Plugin registry** | The component that loads and manages plugin instances |
| **pnpm** | The package manager used in this project (faster than npm, supports workspaces) |
| **Reaction** | An automated action triggered by an event (e.g., "when CI fails, tell the agent") |
| **Runtime** | A plugin that manages how/where an agent process runs (tmux, Docker, etc.) |
| **SCM** | Source Control Management — a plugin that talks to GitHub/GitLab for PRs and CI |
| **Session** | One unit of work: one agent, one issue, one branch, one PR |
| **Session prefix** | A short abbreviation of the project name (e.g., `app`, `be`) used in session IDs |
| **SSE** | Server-Sent Events — a browser technology for receiving a stream of updates from the server |
| **tmux** | A terminal multiplexer — it creates persistent terminal sessions that can run in the background |
| **Tracker** | A plugin that fetches issues from GitHub Issues, Linear, or GitLab |
| **Workspace** | A plugin that creates and manages isolated copies of the codebase for each agent |
| **Worktree** | Short for "git worktree" — see above |
| **Zod** | A TypeScript library for schema validation, used to validate the YAML config |

---

*This walkthrough was written to be the document you wish you had when you first opened the codebase. If something is unclear, please open an issue — that's feedback we want.*
