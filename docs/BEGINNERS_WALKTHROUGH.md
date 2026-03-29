# Beginner's Walkthrough: Understanding Agent Orchestrator

Welcome! This guide will walk you through Agent Orchestrator step by step. We'll use simple analogies to explain how everything works together.

---

## 📚 Table of Contents

| Part | Title | What You'll Learn |
|------|-------|------------------|
| 1 | The Big Picture 🎯 | What Agent Orchestrator is and why it exists |
| 2 | Architecture - The Building Blocks 🧱 | System diagram and seven plugin slots |
| 3 | How It Works - Step by Step 🚀 | Following an issue through the system |
| 4 | Directory Tour - Where Things Live 🗺️ | Codebase structure tour |
| 5 | Data Flow - How Information Moves 🌊 | How data travels through the system |
| 6 | Configuration - Your Settings ⚙️ | Setting up agent-orchestrator.yaml |
| 7 | Session Lifecycle - The Life Story of a Task 📖 | States and transitions of sessions |
| 8 | Plugin Development - How to Extend 🧩 | Writing your own plugins |
| 9 | Common Workflows - Real World Examples 🎬 | Practical scenarios |
| 10 | Glossary - Speak the Language 📚 | Technical terms explained simply |
| 11 | Quick Reference - Handy Links 🔗 | Where to find things |
| 12 | Your Next Steps 🎓 | Learning paths for different goals |
| 13 | Understanding the Dashboard - Your Control Center 🖥️ | How to read and use the dashboard |
| 14 | Observability - Knowing What's Happening 🔍 | Monitoring system health |
| 15 | Feedback System - How Agents Report Issues 📢 | Bug reports and improvement suggestions |
| 16 | Troubleshooting - Common Problems and Solutions 🔧 | Fixing common issues |
| 17 | Putting It All Together - A Complete Example 🎬 | End-to-end workflow example |

---



---

## Part 1: The Big Picture 🎯

### What is Agent Orchestrator?

Imagine you're a music conductor. Instead of playing all the instruments yourself, you lead a whole orchestra. Each musician plays their part, and you coordinate them so beautiful music happens.

**Agent Orchestrator is like a conductor for AI coding assistants.**

Instead of one AI trying to do everything, Agent Orchestrator:
- **Spawns multiple AI workers** - each gets their own workspace
- **Gives them tasks** - like fixing bugs or building features
- **Watches their progress** - on a nice dashboard
- **Handles feedback** - if tests fail, it tells the AI to fix them
- **Cleans up** - when work is done, it puts things away

You're still in charge - you review the work and decide what gets merged. The boring coordination work happens automatically.

### What does this look like in real life?

Without Agent Orchestrator:
```
You create branch → You start AI → You watch it work
Tests fail → You copy error → You paste back to AI → Repeat...
PR ready → You remember to check → You review → You merge
(Repeat for every issue)
```

With Agent Orchestrator:
```
You open dashboard → You click "Assign issue to AI"
You walk away...
Later: "Hey, your PR is ready and all tests pass!"
You review → You merge → Done
```

---

## Part 2: Architecture - The Building Blocks 🧱

### The System Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         YOU (The Human)                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │   Web Dashboard │  ← Your control center
                    └─────────────────┘
                              │
                              ▼
        ┌─────────────────────────────────────────────┐
        │          Agent Orchestrator Core             │
        │  (The Brain - coordinates everything)       │
        └─────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
   ┌─────────┐         ┌─────────┐          ┌─────────┐
   │ Tracker │         │   SCM   │          │Notifier │
   │(GitHub) │         │(GitHub) │          │(Desktop)│
   └─────────┘         └─────────┘          └─────────┘
                              │
                              ▼
        ┌─────────────────────────────────────────────┐
        │          Session Manager                    │
        │  (The Task Manager - creates workspaces)   │
        └─────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
   ┌─────────┐         ┌─────────┐          ┌─────────┐
   │ Runtime │         │Workspace│          │  Agent  │
   │  (tmux) │         │(worktree│          │(Claude) │
   │         │         │  clone) │          │         │
   └─────────┘         └─────────┘          └─────────┘
        │                                          │
        └──────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │   Git Repo      │  ← Your code
                    └─────────────────┘
```

### The Seven Plugin Slots (The LEGO Pieces)

Agent Orchestrator is built from interchangeable parts - like LEGO bricks! Each "slot" is a place where you can swap in different implementations.

| Slot | What it Does | Analogy | Default | Other Options |
|------|--------------|---------|---------|---------------|
| **Runtime** | Where agents run | The room the AI works in | tmux | Docker, K8s, process |
| **Agent** | Which AI to use | The worker (who does the coding) | Claude Code | Codex, Aider |
| **Workspace** | How code is isolated | The workbench space | worktree | clone |
| **Tracker** | Where issues live | The task board | GitHub | Linear |
| **SCM** | Where PRs are made | The review system | GitHub | GitLab |
| **Notifier** | How you get alerts | The notification bell | Desktop | Slack, webhook |
| **Terminal** | How you interact | The window you type in | iTerm2 | Web |

Note: **Lifecycle** is a built-in core component (the state machine), not a plugin slot. It handles reactions and session management internally.

**Why this is cool:** You can swap any piece without changing the others! Want to use Docker instead of tmux? Just change the runtime. Everything else keeps working.

---

## Part 3: How It Works - Step by Step 🚀

### Let's follow an issue through the system

```
Step 1: You assign an issue to AI
    └─► Dashboard receives request
        └─► Tracker plugin reads the issue from GitHub

Step 2: Session Manager creates a workspace
    └─► Workspace plugin creates a git worktree (a separate copy of your repo)
        └─► A new branch is created automatically

Step 3: An AI agent is spawned
    └─► Runtime plugin starts a tmux session
        └─► Agent plugin launches Claude Code with the issue details

Step 4: The AI works
    └─► It reads the code, writes tests, makes changes
        └─► All in its isolated workspace (safe from other agents!)

Step 5: The AI creates a PR
    └─► SCM plugin helps create a pull request
        └─► Dashboard shows the new PR status

Step 6: CI runs and fails (oops!)
    └─► Lifecycle Manager notices the failure
        └─► Notifier tells you: "CI failed"
        └─► Agent gets the error logs and tries to fix it

Step 7: Reviewer leaves comments
    └─► Lifecycle Manager detects new review comments
        └─► Agent receives the comments and addresses them

Step 8: PR is approved with green CI
    └─► You get a notification
        └─► You review, merge, done!
        └─► Session Manager cleans up the workspace
```

---

## Part 4: Directory Tour - Where Things Live 🗺️

Let's walk through the codebase like we're touring a house.

```
agent-orchestrator/              ← The whole house
│
├── packages/                    ← The main rooms
│   │
│   ├── core/                    ← The Foundation
│   │   └── src/
│   │       ├── session-manager.ts      ← Task assignment center
│   │       ├── lifecycle-manager.ts    ← Progress tracker
│   │       ├── prompt-builder.ts       ← Instruction writer
│   │       ├── config.ts               ← Settings loader
│   │       ├── plugin-registry.ts      ← Plugin manager
│   │       ├── paths.ts                ← Path builder
│   │       ├── types.ts                ← All the type definitions
│   │       └── observability.ts        ← Logging and tracking
│   │
│   ├── cli/                     ← The Control Panel
│   │   └── src/
│   │       └── index.ts                 ← All `ao` commands
│   │
│   ├── web/                     ← The Living Room (Dashboard)
│   │   └── src/
│   │       ├── app/                     ← Next.js pages
│   │       ├── components/              ← UI pieces
│   │       └── lib/                     └ Helpers
│   │
│   └── plugins/                 ← The Workshop (all plugins)
│       ├── runtime-tmux/                ← tmux runtime implementation
│       ├── agent-claude-code/           ← Claude Code adapter
│       ├── workspace-worktree/          ← worktree workspace
│       ├── tracker-github/              ← GitHub issue tracker
│       ├── scm-github/                  ← GitHub PR manager
│       ├── notifier-desktop/            ← Desktop notifications
│       └── ... (many more plugins)
│
├── docs/                        ← The Library
│   ├── DEVELOPMENT.md                  ← Developer guide
│   ├── CLI.md                          ← Command reference
│   └── design/                         ← Design documents
│
├── examples/                     ← Recipe book
│   └── *.yaml                    ← Example configurations
│
├── agent-orchestrator.yaml      ← Settings (you create this)
│
└── package.json                 ← Project info and scripts
```

### Key Files Explained

| File | What It's Like | What It Does |
|------|----------------|--------------|
| `packages/core/src/types.ts` | The Dictionary | Defines all the words (types) the system uses |
| `packages/core/src/session-manager.ts` | The Task Master | Creates, tracks, and destroys agent sessions |
| `packages/core/src/lifecycle-manager.ts` | The Watcher | Monitors progress and handles events |
| `packages/core/src/prompt-builder.ts` | The Teacher | Writes instructions for AI agents |
| `packages/core/src/config.ts` | The Librarian | Loads and validates configuration |
| `packages/cli/src/index.ts` | The Receptionist | Handles all `ao` commands |
| `packages/web/` | The Display | Shows everything on a nice web interface |
| `agent-orchestrator.yaml` | Your Settings | Configure how the system works for you |

---

## Part 5: Data Flow - How Information Moves 🌊

### The Flow of an Issue

```
┌──────────────┐
│   GitHub     │ ← Issue #123: "Fix login bug"
└──────┬───────┘
       │
       │ 1. Tracker plugin reads issue
       ▼
┌─────────────────────────┐
│   Session Manager       │
│                         │
│  - Reserves session ID  │
│  - Creates branch name  │
│  - Builds instructions  │
└──────┬──────────────────┘
       │
       │ 2. Creates workspace
       ▼
┌─────────────────────────┐
│   Workspace Plugin      │
│                         │
│  - Creates git worktree │
│  - Checks out branch    │
└──────┬──────────────────┘
       │
       │ 3. Spawns agent
       ▼
┌─────────────────────────┐
│   Runtime Plugin        │
│                         │
│  - Starts tmux session  │
│  - Launches AI agent    │
└──────┬──────────────────┘
       │
       │ 4. AI works here
       ▼
┌─────────────────────────┐
│   Agent Plugin          │
│                         │
│  - Reads code           │
│  - Writes changes       │
│  - Creates PR           │
└──────┬──────────────────┘
       │
       │ 5. Events flow back
       ▼
┌─────────────────────────┐
│   Lifecycle Manager     │
│                         │
│  - Tracks state         │
│  - Handles reactions    │
│  - Emits events         │
└──────┬──────────────────┘
       │
       │ 6. Updates display
       ▼
┌─────────────────────────┐
│   Web Dashboard         │
│                         │
│  - Shows status         │
│  - Receives commands    │
└─────────────────────────┘
```

### The Event Loop

Agent Orchestrator constantly checks what's happening - like a security guard patrolling:

```
Every few seconds, the Lifecycle Manager checks:

1. Are all sessions still running?
   ├─ No → Mark as crashed
   └─ Yes → Check activity state

2. What is each agent doing?
   ├─ Active → Keep watching
   ├─ Ready → Check for PR status
   ├─ Idle → Check if it needs attention
   └─ Exited → Clean up

3. What's happening with PRs?
   ├─ CI failed? → Send to agent to fix
   ├─ Review comments? → Forward to agent
   ├─ Approved? → Notify user
   └─ Merged? → Clean up session

4. Should we notify anyone?
   ├─ Important events → Send to notifier
   └─ Everything else → Log it
```

---

## Part 6: Configuration - Your Settings ⚙️

### The Configuration File

`agent-orchestrator.yaml` is like your personal preferences file:

```yaml
# Storage paths are now derived automatically from configPath using
# hash-based namespacing; you do not need to set dataDir/worktreeDir.
# The following keys are legacy and are ignored by current versions:
# dataDir: ~/.agent-orchestrator    # legacy – ignored
# worktreeDir: ~/.worktrees         # legacy – ignored

# What port the web dashboard uses
port: 3000

# Your default choices (can be overridden per project)
defaults:
  runtime: tmux              # Where agents run
  agent: claude-code         # Which AI to use
  workspace: worktree        # How to isolate code
  notifiers: [desktop]       # How you get notified

# Your projects (like different teams you manage)
projects:
  my-website:
    repo: org/website        # GitHub repository
    path: ~/my-website       # Where it lives locally
    defaultBranch: main      # The main branch name
    sessionPrefix: web        # Prefix for agent sessions

  backend-api:
    repo: org/api
    path: ~/backend
    defaultBranch: main
    sessionPrefix: api

# Automatic reactions (what happens when...)
reactions:
  ci-failed:
    auto: true               # Automatically handle
    action: send-to-agent    # Send error to AI
    retries: 2               # Try fixing twice

  changes-requested:
    auto: true               # Auto-forward comments
    action: send-to-agent
    escalateAfter: 30m       # Tell user if stuck for 30 min

  approved-and-green:
    auto: false              # You decide when to merge
    action: notify           # Just tell you it's ready
```

### Where Sessions Live

Agent Orchestrator uses a special naming system so everything stays organized:

```
~/.agent-orchestrator/
│
└── a3b4c5d6e7f8-my-website/    ← Hash-based folder (prevents conflicts)
    │
    ├── sessions/               ← Active sessions
    │   ├── web-1               ← Session metadata
    │   ├── web-2
    │   └── archive/            ← Completed sessions
    │       └── web-3/
    │
    └── worktrees/              ← Git worktrees
        ├── web-1/              ← Isolated code copy
        └── web-2/
```

The hash (`a3b4c5d6e7f8`) comes from your config folder - it means:
- Multiple copies of Agent Orchestrator don't fight each other
- Session names are always unique globally

---

## Part 7: Session Lifecycle - The Life Story of a Task 📖

### The Status States (What's happening?)

```
┌─────────────┐
│  spawning   │ ← Creating the workspace, starting the agent
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   working   │ ← Agent is actively coding
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  pr_open    │ ← Agent created a pull request
└──────┬──────┘
       │
       ├─────────────────┐
       │                 │
       ▼                 ▼
┌─────────────┐   ┌─────────────┐
│  ci_failed  │   │ review_...  │ ← CI failed or review started
└──────┬──────┘   └──────┬──────┘
       │                 │
       │ (agent fixes)    │ (agent addresses comments)
       ▼                 ▼
       └─────────┬───────┘
                 │
                 ▼
          ┌─────────────┐
          │  approved   │ ← PR is approved and CI passes
          └──────┬──────┘
                 │
                 ▼
          ┌─────────────┐
          │  mergeable  │ ← Ready to merge
          └──────┬──────┘
                 │
                 ▼
          ┌─────────────┐
          │   merged    │ ← Merged into main branch
          └──────┬──────┘
                 │
                 ▼
          ┌─────────────┐
          │   cleanup   │ ← Cleaning up workspace
          └──────┬──────┘
                 │
                 ▼
          ┌─────────────┐
          │    done     │ ← All finished!
          └─────────────┘
```

### The Activity States (What's the agent doing?)

While the status shows the big picture, activity shows what's happening right now:

| State | What It Means | Like When... |
|-------|---------------|--------------|
| `active` | Agent is working | A chef is cooking |
| `ready` | Agent finished, waiting | Chef plated the food |
| `idle` | Nothing happening for a while | Chef stepped away |
| `waiting_input` | Agent needs your answer | Chef asks "How spicy?" |
| `blocked` | Agent is stuck | Chef burned the dish |
| `exited` | Agent process stopped | Chef clocked out |

---

## Part 8: Plugin Development - How to Extend 🧩

### Understanding Plugins

Every major piece of Agent Orchestrator is a plugin. Think of it like this:

```
Plugin = A contract + An implementation

Contract (Interface): "I need a way to create, destroy, and send to a session"
Implementation (Your Code): "Here's how I do it with tmux/Docker/K8s/etc"
```

### The Plugin Pattern

Every plugin follows the same simple pattern. Here's a simplified example for a Runtime plugin:

```typescript
// (These interfaces mirror core types in a simplified way
//  so this example will typecheck if copied into a real plugin.)
interface RuntimeConfig {
  sessionId: string;
  workspacePath: string;
  launchCommand: string;
  // ... any other fields from the real RuntimeConfig
}

interface RuntimeHandle {
  name: string;

  // End the session associated with this runtime
  destroy(): Promise<void>;

  // Send text to a running session
  send(text: string): Promise<void>;

  // Check if a session is still running
  isRunning(): Promise<boolean>;
}

// 1. Describe yourself
export const manifest = {
  name: "my-plugin",           // Your name
  slot: "runtime",             // Which slot you fit in
  description: "My cool runtime",
  version: "0.1.0",
};

// 2. Provide your implementation
export async function create(config: RuntimeConfig): Promise<RuntimeHandle> {
  // You can use config.sessionId, config.workspacePath, config.launchCommand, etc.

  return {
    name: "my-plugin",

    async destroy() {
      // Clean up any resources for this session
    },

    async send(text: string) {
      // Send text to your runtime process
    },

    async isRunning() {
      // Return true if the runtime/session is still alive
      return false; // or true
    },
  };
}

// 3. Export in the right format
export default { manifest, create };
```

### Adding a New Plugin

To add a new plugin to the system:

1. **Create the package folder** in `packages/plugins/`
   ```
   packages/plugins/runtime-mynewruntime/
   ```

2. **Create your implementation** in `src/index.ts`

3. **Create package.json** with proper dependencies

4. **Register it** in `packages/core/src/plugin-registry.ts` by adding your package name to the `BUILTIN_PLUGINS` list
   ```typescript
   // In packages/core/src/plugin-registry.ts
   const BUILTIN_PLUGINS = [
     "@composio/ao-plugin-runtime-tmux",
     "@composio/ao-plugin-runtime-mynewruntime", // <--- add your plugin here
     // ...other built-in plugins
   ];
   ```

5. **Rebuild** and it's available!

---

## Part 9: Common Workflows - Real World Examples 🎬

### Example 1: Fix a Bug

```
1. Developer opens issue #456: "Login form doesn't validate email"

2. You click "Assign to AI" in dashboard

3. Agent Orchestrator:
   ├─ Creates worktree for issue-456 branch
   ├─ Spawns Claude Code with the issue
   ├─ Agent reads the code, finds the problem
   ├─ Adds email validation
   ├─ Writes tests
   ├─ Runs tests (pass!)
   ├─ Creates PR with description

4. CI runs and fails on unrelated test

5. Agent Orchestrator:
   ├─ Detects CI failure
   ├─ Sends error to agent
   ├─ Agent fixes the unrelated test
   └─ Pushes fix

6. CI passes, reviewer comments "Looks good"

7. You get notification, review quickly, merge

8. Agent Orchestrator cleans up the worktree
```

### Example 2: Handle Review Comments

```
1. PR #789 is open, awaiting review

2. Reviewer comments: "This function needs error handling"

3. Agent Orchestrator (Lifecycle Manager):
   ├─ Polls GitHub for PR status
   ├─ Detects new comment
   ├─ Sends comment to running agent
   └─ Agent receives it and fixes the code

4. Agent updates PR

5. Reviewer comments again: "Almost there, add tests"

6. Agent gets the comment and adds tests

7. Reviewer approves PR

8. CI runs and passes

9. You get notification: "PR #789 approved, ready to merge"
```

---

## Part 10: Glossary - Speak the Language 📚

| Term | Simple Meaning | Technical Meaning |
|------|---------------|-------------------|
| **Agent** | The AI worker (like Claude) | An AI coding tool that follows instructions |
| **Runtime** | Where the agent runs | The environment that hosts agent sessions (tmux, Docker) |
| **Workspace** | Where code lives | An isolated copy of the repo (worktree or clone) |
| **Session** | One agent working on one task | A unit of work with its own workspace and agent instance |
| **Plugin** | A swappable part | An implementation of a plugin slot interface |
| **Tracker** | Where issues live | Issue tracking system (GitHub, Linear) |
| **SCM** | Where PRs happen | Source Code Management system |
| **Worktree** | A linked copy of your repo | Git feature: shares history but has its own files |
| **Lifecycle** | The state machine | Tracks session status and handles reactions |
| **Reactions** | What happens when... | Automatic responses to events (CI failure, comments) |
| **Notifier** | How you get alerts | Notification channel (desktop, Slack, webhook) |
| **Manifest** | A plugin's ID card | Metadata describing a plugin |
| **State** | Where something is in a process | Current status (spawning, working, done) |
| **Activity** | What's happening now | Current action (active, idle, waiting) |
| **Dashboard** | The web UI | Next.js application showing all sessions |
| **Orchestrator** | The main coordinator | The agent that manages worker agents |
| **Worker** | A task-specific agent | An AI working on a specific issue |
| **Hash** | A unique fingerprint | SHA-256 used for isolation and naming |
| **Namespace** | A way to keep things separate | Using hashes to avoid conflicts |
| **Observability** | Knowing what's happening | Built-in telemetry, metrics, and health monitoring |
| **Surface** | A system component being monitored | A specific part of the system tracked for health |
| **Correlation ID** | Tracking tag for requests | Unique ID to trace operations across system |
| **Feedback Tool** | How agents report issues | Special tools for bug reports and improvement suggestions |
| **Dedupe Key** | Duplicate identifier | Hash used to detect duplicate feedback reports |
| **SSE** | Server-Sent Events | Push updates from server to dashboard in real-time |
| **Websocket** | Two-way communication | Protocol for real-time terminal streams |
| **Session Prefix** | Short project name | Auto-generated identifier (like "web" for "website") |
| **Config Hash** | Config directory fingerprint | Unique ID derived from config location for isolation |
| **CI** | Continuous Integration | Automated tests that run on code changes |
| **PR** | Pull Request | A proposed change to the codebase for review |
| **CLI** | Command Line Interface | Text-based tool for controlling Agent Orchestrator |
| **Health Status** | System condition check | Shows if a component is ok, warning, or error |
| **Global Pause** | Stop all agents | Emergency stop button for all running sessions |
| **Activity Dot** | Visual status indicator | Colored dot showing session state (green, gray, yellow, red) |
| **Claim PR** | Agent takes over existing PR | When agent starts working on already-open pull request |
| **Escalate** | Notify human of problem | When automatic handling fails, alert the user |
| **Terminal** | Agent's work window | Where you can see agent working in real-time |
| **Project** | A codebase managed by AO | A repository configured in agent-orchestrator.yaml |
| **Instance ID** | Unique project identifier | `{config-hash}-{project-id}` for namespacing |

---

## Part 11: Quick Reference - Handy Links 🔗

### Where to Find What

| Want to... | Go to... |
|------------|----------|
| Understand core architecture | `packages/core/README.md` |
| Learn about a specific plugin | `packages/plugins/PLUGIN_NAME/README.md` |
| See all CLI commands | `docs/CLI.md` |
| Set up your first project | `README.md` |
| Contribute code | `docs/DEVELOPMENT.md` |
| View configuration options | `agent-orchestrator.yaml.example` |

### How to Read Dashboard Indicators (from Part 13)

| Dot | Color | Meaning |
|-----|-------|---------|
| ● | Green | Agent actively working |
| ○ | Gray | Agent idle/waiting |
| ⚠ | Yellow | Needs your attention |
| ❌ | Red | Error/crashed |
| ✅ | Blue | Task complete |

### Observability Commands (from Part 14)

```bash
# View observability data
curl http://localhost:3000/api/observability

# View session logs
ao logs web-1

# Check system health
curl http://localhost:3000/api/health
```

### Troubleshooting Quick Guide (from Part 16)

```bash
# First things to check:
ps aux | grep ao              # Is AO running?
ao start                     # Check config
ao list                      # See sessions
ao logs <name>              # Check errors
```

### Important Files for Development

```
Core Services:
  packages/core/src/session-manager.ts    ← Session management
  packages/core/src/lifecycle-manager.ts  ← State and events
  packages/core/src/prompt-builder.ts     → AI instructions
  packages/core/src/config.ts             → Configuration
  packages/core/src/plugin-registry.ts    → Plugin loading

Types:
  packages/core/src/types.ts              → All interfaces

CLI:
  packages/cli/src/index.ts               → All commands

Web:
  packages/web/src/app/                   → Pages
  packages/web/src/components/            → UI components
```

---

## Part 12: Your Next Steps 🎓

### If you're just starting:

1. **Read the README** - Install and try it out
2. **Run `ao start`** - See the dashboard in action
3. **Spawn your first agent** - Try a simple issue
4. **Watch it work** - Follow the session in the dashboard (see Part 13)
5. **Check observability** - Understand system health (see Part 14)

### If you want to contribute:

1. **Read DEVELOPMENT.md** - Understand coding conventions
2. **Pick a simple plugin** - Read the code
3. **Try making a small change** - Build and test
4. **Read this walkthrough again** - Things will make more sense
5. **Submit feedback** - If you find bugs, use the feedback tools (see Part 15)

### If you want to build a plugin:

1. **Choose a slot** - What do you want to swap?
2. **Read the interface** - In `packages/core/src/types.ts`
3. **Copy an existing plugin** - Use it as a template
4. **Implement the methods** - Follow the pattern (see Part 8)
5. **Register and test** - See "Plugin Development" above

### If you run into problems:

1. **Check the troubleshooting guide** - Part 16 covers common issues
2. **Review observability** - Check system health (Part 14)
3. **Ask the community** - Join Discord
4. **Read the complete example** - Part 17 shows a full workflow

---

## Part 13: Understanding the Dashboard - Your Control Center 🖥️

### What You See When You Open the Dashboard

When you run `ao start` and open `http://localhost:3000`, you'll see a colorful interface that shows everything happening in real-time. Let's break it down like reading a car dashboard!

```
┌─────────────────────────────────────────────────────────────┐
│                    AGENT ORCHESTRATOR                      │
├─────────────────────────────────────────────────────────────┤
│  🏠 Projects (sidebar)                                     │
│  ├─ my-website    (3 active, 1 idle)                     │
│  └─ backend-api   (2 active)                              │
├─────────────────────────────────────────────────────────────┤
│                                                           │
│  📊 my-website Sessions                                    │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ web-1  Fix login bug              [● Working]        │ │
│  │ └─ Branch: feat/fix-login          PR: #234         │ │
│  │ └─ Agent: Claude Code                             │ │
│  │ └─ Activity: Reading auth.ts...                     │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ web-2  Add dark mode               [● Working]        │ │
│  │ └─ Branch: feat/dark-mode          PR: #235         │ │
│  │ └─ CI: ✅ Passing                                  │ │
│  │ └─ Review: ✅ Approved                            │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ web-3  Update dependencies         [○ Idle]           │ │
│  │ └─ Branch: chore/deps            PR: #236           │ │
│  │ └─ CI: ❌ Failed - needs attention                │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                           │
└─────────────────────────────────────────────────────────────┘
```

### Status Dots - What Do They Mean?

| Dot | Color | Meaning | Like When... |
|-----|-------|---------|--------------|
| ● | Green | Active | Agent is busy working |
| ○ | Gray | Idle | Agent is waiting for something |
| ⚠ | Yellow | Needs Attention | CI failed, review comments, or manual input needed |
| ❌ | Red | Error | Agent crashed or session failed |
| ✅ | Blue | Done | Task complete, PR ready to merge |

### Session Cards - Reading the Details

Each session card tells you a story:

```
┌─ Session Name ─────────────────────────────────────┐
│ web-1    Fix login bug                              │
│ ─────────────────────────────────────────────────── │
│ Status:   working (green dot)                       │
│ Branch:   feat/fix-login                            │
│ PR:       #234 https://github.com/.../pull/234      │
│ Agent:    Claude Code                               │
│ Started:  10 minutes ago                            │
│ ─────────────────────────────────────────────────── │
│ Activity: Reading auth.ts, finding the bug...       │
│ ─────────────────────────────────────────────────── │
│ Actions:  [Attach] [Kill] [View PR] [Log]          │
└─────────────────────────────────────────────────────┘
```

### Key Dashboard Components

| Component | What It Does | Why It Matters |
|-----------|--------------|---------------|
| **Project Sidebar** | Shows all your projects and their counts | Quickly see which projects need attention |
| **Session Cards** | Shows individual agent sessions | Monitor progress and spot problems |
| **Activity Dots** | Real-time status indicators | At-a-glance health check |
| **CI Badges** | Shows test/passing status | Know if code is safe to merge |
| **PR Status** | Shows review status | See if human action is needed |
| **Terminal Window** (click to open) | See agent working live | Watch the AI in action |
| **Global Pause** | Button to pause all sessions | Emergency stop for all agents |
| **Observability Banner** | System health overview | Know if the orchestrator itself is healthy |

### The Observability Banner

At the top of the dashboard, you might see a banner like:

```
⚠️ Lifecycle Worker: Last poll 5m ago (expected <30s)
   → Check: Are backend processes running?

✅ SSE Events: Streaming normally (42 connections)

🔍 Last correlation: abc123
```

This tells you if the system itself is working correctly, separate from the agents.

### Dashboard Actions Explained

| Action | What Happens | When to Use |
|--------|--------------|-------------|
| **Attach** | Opens a terminal showing the agent working | Want to see what the agent is doing |
| **Kill** | Stops the agent and cleans up session | Agent is stuck or made a mistake |
| **View PR** | Opens the pull request in GitHub | Ready to review the code |
| **Log** | Shows the agent's conversation history | Want to understand what happened |

### Colors You'll See

```
🟢 Green = Everything is good
🟡 Yellow = Needs attention
🔴 Red   = Something is wrong
🔵 Blue  = Ready / Complete
⚪ Gray  = Idle / Waiting
```

---

## Part 14: Observability - Knowing What's Happening 🔍

### What is Observability?

Imagine you're driving a car. You don't just look out the window — you check the speedometer, fuel gauge, and warning lights. That's observability!

**Agent Orchestrator has built-in observability** so you always know what's happening under the hood.

### Three Levels of Information

```
Level 1: Status Dots (Dashboard)
         └─ Quick, visual check of each session

Level 2: Dashboard Banner
         └─ System health overview (is AO itself working?)

Level 3: Detailed Logs & Metrics
         └─ Deep dive when you need to debug
```

### Key Metrics You Can See

The system automatically tracks:

| Metric | What It Tracks | Why It's Useful |
|--------|---------------|-----------------|
| `spawn` | How many sessions created | Is AO actually starting agents? |
| `restore` | Sessions that restarted after crash | Are sessions recovering? |
| `kill` | Sessions you manually stopped | Track your manual interventions |
| `cleanup` | Sessions cleaned up after done | Is cleanup working? |
| `lifecycle_poll` | How often AO checks status | Is the watch loop running? |
| `api_request` | Web API calls | Is the dashboard working? |
| `sse_connect` | Dashboard connections | How many people are watching? |

### Health Surfaces

The system tracks different "surfaces" — like checking different car systems:

```
Surface: lifecycle.worker
Status: ✅ ok
Last check: 2 seconds ago

Surface: sse.events
Status: ✅ ok
Active connections: 3

Surface: websocket.terminal
Status: ⚠️ warn
Last error: Connection timeout 5m ago
```

### Logs - For When You Need Details

By default, AO only shows warning and errors (to avoid clutter):

```bash
# Default - only important stuff
AO_LOG_LEVEL=warn

# Want more detail?
AO_LOG_LEVEL=info    # See normal operations

# Debugging something specific?
AO_LOG_LEVEL=debug   # See everything (lots of output!)
```

### Common Observability Scenarios

#### Scenario 1: Agent Seems Stuck

```
Dashboard shows: web-1 ● Working (for 2 hours)
Activity: (no change)

Check:
1. Is the dot still green? → Agent alive but slow
2. Check logs: `ao logs web-1`
3. Consider attaching: `ao attach web-1`
```

#### Scenario 2: Lifecycle Not Polling

```
Banner shows: ⚠️ Lifecycle Worker: Last poll 5m ago

What this means: The watch dog isn't patrolling!

Possible causes:
1. Backend process crashed → Restart `ao start`
2. System overload → Check CPU/memory
3. Network issue → Check GitHub/GitLab connection
```

#### Scenario 3: CI Keeps Failing

```
web-1: ❌ CI Failed
Retry 1: ❌ Failed
Retry 2: ❌ Failed

This is when you need to step in:
1. View the PR to see the actual error
2. Attach to the session: `ao attach web-1`
3. Send specific instructions to the agent
```

### How to Check Observability

```bash
# View current observability data
curl http://localhost:3000/api/observability

# View specific session logs
ao logs web-1

# View all active sessions
ao list

# View detailed session info
ao info web-1
```

---

## Part 15: Feedback System - How Agents Report Issues 📢

### The Problem: Agents Find Problems Too!

Sometimes while working, the AI agent discovers something wrong with Agent Orchestrator itself — not with your code, but with the system that manages the agents.

**Example:** The agent might find that a particular command doesn't work as expected, or there's a bug in how the system handles a certain type of task.

### The Solution: Feedback Tools

Agent Orchestrator gives agents special "feedback tools" to report these issues:

```
┌─────────────────────────────────────────────────────────────┐
│              Agent Discovers a Problem                     │
│                    │                                        │
│                    ▼                                        │
│         ┌──────────────────┐                               │
│         │  Which Tool?     │                               │
│         └────────┬─────────┘                               │
│                  │                                         │
│      ┌───────────┴───────────┐                             │
│      │                       │                             │
│      ▼                       ▼                             │
│  Bug Report        Improvement Suggestion                  │
│  (Something is       (Something could                     │
│   broken)              be better)                         │
└─────────────────────────────────────────────────────────────┘
```

### The Two Feedback Tools

#### 1. Bug Report 🐛

**When to use:** Something is broken or not working as expected

**What it includes:**
- **Title**: What's broken?
- **Body**: Detailed description
- **Evidence**: Files, commands, or logs that show the problem
- **Session**: Which agent session found it
- **Source**: Where in the system the problem is
- **Confidence**: How sure the agent is (0 to 1)

#### 2. Improvement Suggestion 💡

**When to use:** Something works, but could be better

**What it includes:**
- Same fields as bug report
- Focuses on enhancements rather than fixes

### Where Feedback Goes

When an agent submits feedback, it's saved here:

```
~/.agent-orchestrator/
  └── {config-hash}-observability/
      └── feedback/
          ├── report_2026-03-28T10-30-00_abc123.kv
          ├── report_2026-03-28T11-15-45_def456.kv
          └── ...
```

Each report is a simple key-value file that's easy to read and process.

### Why This Matters

```
Traditional development:
  - Developers find bugs while coding
  - They might forget to report them
  - Or report them inconsistently

With Feedback Tools:
  - Agents find bugs autonomously
  - Reports are structured and consistent
  - Includes evidence for debugging
  - Happens automatically, not forgotten
```

### Duplicate Detection

The system is smart! If multiple agents find the same problem, it only saves it once.

```
Agent 1: "Spawn command fails when path has spaces"
  → Saves report with dedupe key: a1b2c3d4e5f6

Agent 2: "Spawn fails on paths with spaces"
  → Same dedupe key → Not saved (duplicate)

Agent 3: "Worktrees don't work with special characters"
  → Different dedupe key → Saved as new issue
```

### For Developers: Reviewing Feedback

If you're maintaining Agent Orchestrator, here's how to review feedback:

```bash
# Find feedback directory
cd ~/.agent-orchestrator/{hash}-observability/feedback

# List all reports
ls -la

# Read a specific report
cat report_*.kv
```

Each report looks like:

```
version=1
id=report_2026-03-28T10-30-00_abc123
tool=bug_report
createdAt=2026-03-28T10:30:00.000Z
dedupeKey=a1b2c3d4e5f67890
title=Spawn command fails with spaces in path
body=When the workspace path contains spaces, the spawn command
evidence.0=/home/user/my project/code
evidence.1=ao spawn my-project ISSUE-123
evidence.2=Error: path not found
session=web-1
source=runtime-tmux
confidence=0.95
```

### The Big Picture

```
┌─────────────────────────────────────────────────────────────┐
│                   Agent Orchestrator                        │
│                                                             │
│   Agents Work → Find Problems → Use Feedback Tools          │
│                                      │                     │
│                                      ▼                     │
│                              Structured Reports             │
│                                      │                     │
│                                      ▼                     │
│                              Developers Review              │
│                                      │                     │
│                                      ▼                     │
│                              Fix & Improve AO               │
│                                                             │
└─────────────────────────────────────────────────────────────┘

Result: Agent Orchestrator gets better because agents use it!
```

---

## Part 16: Troubleshooting - Common Problems and Solutions 🔧

### Problem: Agent Won't Start

**Symptom:** You run `ao spawn` but nothing happens

```
Possible causes:
┌─────────────────────────────────────────────────────────────┐
│ 1. Config file not found                                   │
│    Solution: Run from directory containing                   │
│             agent-orchestrator.yaml                         │
│                                                             │
│ 2. Invalid project ID                                       │
│    Solution: Check project names with `ao projects`         │
│                                                             │
│ 3. Git worktree already exists with same name              │
│    Solution: Kill existing session with `ao kill <name>`   │
│                                                             │
│ 4. Runtime not available (e.g., tmux not installed)         │
│    Solution: Install tmux:                                  │
│             macOS: brew install tmux                        │
│             Linux: sudo apt install tmux                    │
└─────────────────────────────────────────────────────────────┘
```

### Problem: Agent Keeps Crashing

**Symptom:** Session shows red dot, exited status

```
Quick diagnosis:
┌─────────────────────────────────────────────────────────────┐
│ Check the logs:                                             │
│   ao logs <session-name>                                    │
│                                                             │
│ Common causes:                                              │
│                                                             │
│ 1. Agent ran out of memory                                  │
│    Solution: Reduce concurrent sessions                      │
│             or increase system memory                      │
│                                                             │
│ 2. Agent API quota exceeded                                 │
│    Solution: Check API usage, wait for quota reset         │
│                                                             │
│ 3. Terminal/Agent configuration error                       │
│    Solution: Check agent-orchestrator.yaml settings         │
│                                                             │
│ 4. Permission denied accessing files                       │
│    Solution: Check file permissions in workspace            │
└─────────────────────────────────────────────────────────────┘
```

### Problem: CI Fails Repeatedly

**Symptom:** Agent keeps trying but CI never passes

```
When to intervene:
┌─────────────────────────────────────────────────────────────┐
│ After 3+ retries, CI still fails → Time for human help   │
│                                                             │
│ Steps:                                                      │
│ 1. View the PR to see the actual error                     │
│ 2. Attach to session: `ao attach <name>`                    │
│ 3. Send specific guidance:                                 │
│    "The test failure is in X. Focus on fixing that."       │
│ 4. Or kill session and fix manually                        │
│                                                             │
│ Common CI issues:                                           │
│ - Flaky tests (tests that randomly fail)                   │
│ - Missing dependencies                                      │
│ - Timeout errors                                            │
│ - Code style violations                                      │
└─────────────────────────────────────────────────────────────┘
```

### Problem: Dashboard Shows Nothing

**Symptom:** Opening localhost:3000 shows empty or error

```
Check list:
┌─────────────────────────────────────────────────────────────┐
│ 1. Is `ao start` actually running?                        │
│    Check: ps aux | grep "ao start"                          │
│                                                             │
│ 2. Is the port correct?                                   │
│    Default: 3000                                            │
│    Check your agent-orchestrator.yaml for custom port       │
│                                                             │
│ 3. Is there a firewall blocking it?                         │
│    Try: curl http://localhost:3000/api/health              │
│                                                             │
│ 4. Restart everything:                                     │
│    Kill process → `ao start` again                          │
└─────────────────────────────────────────────────────────────┘
```

### Problem: Agent Is "Stuck" - Same Activity for Hours

**Symptom:** Activity doesn't change, but dot is still green

```
Diagnosis steps:
┌─────────────────────────────────────────────────────────────┐
│ 1. Check if agent is waiting for input                      │
│    Status: waiting_input → You need to respond!             │
│                                                             │
│ 2. Attach to see what's happening                           │
│    ao attach <session-name>                                  │
│                                                             │
│ 3. Send a nudge:                                           │
│    Continue with your task.                                  │
│                                                             │
│ 4. If truly stuck, kill and restart                        │
│    ao kill <session-name>                                    │
│    ao spawn <project> <issue>                               │
└─────────────────────────────────────────────────────────────┘
```

### Problem: Multiple Agents Fighting Each Other

**Symptom:** Two agents editing the same file

```
Prevention (this shouldn't happen normally):
┌─────────────────────────────────────────────────────────────┐
│ Each session should have:                                   │
│ - Unique worktree (automatic)                               │
│ - Unique branch (automatic)                                 │
│ - Different issue (your choice)                             │
│                                                             │
│ If it happens:                                              │
│ 1. Stop one of the agents                                   │
│ 2. Have them work on different issues                       │
│ 3. Check your session naming conventions                    │
└─────────────────────────────────────────────────────────────┘
```

### Problem: Worktree Clutter

**Symptom:** Too many worktrees taking up disk space

```
Cleanup steps:
┌─────────────────────────────────────────────────────────────┐
│ 1. List all sessions:                                       │
│    ao list                                                  │
│                                                             │
│ 2. Kill done sessions:                                     │
│    ao kill <session-name>                                   │
│                                                             │
│ 3. Manual cleanup (if needed):                             │
│    cd ~/.agent-orchestrator/<hash>-<project>/worktrees      │
│    rm -rf <worktree-name>                                   │
│                                                             │
│ Note: AO should auto-cleanup when sessions complete         │
└─────────────────────────────────────────────────────────────┘
```

### Problem: Can't Connect to Session Terminal

**Symptom:** Clicking "Attach" doesn't open terminal

```
Check:
┌─────────────────────────────────────────────────────────────┐
│ 1. Is tmux running?                                         │
│    tmux list-sessions                                        │
│                                                             │
│ 2. Is the tmux session actually alive?                      │
│    Status should show: active or ready                       │
│                                                             │
│ 3. Try attaching manually:                                   │
│    ao attach <session-name>                                  │
│                                                             │
│ 4. Check terminal integration setting in config             │
│    terminal: iterm2  # or web, terminal-iterm2              │
└─────────────────────────────────────────────────────────────┘
```

### Quick Reference: First Things to Check

When something goes wrong, check these in order:

```
1. Is AO running?         → ps aux | grep ao
2. Is config valid?       → ao start (check errors)
3. Are there sessions?    → ao list
4. Check logs             → ao logs <session>
5. Check system           → curl http://localhost:3000/api/health
6. Check observability    → curl http://localhost:3000/api/observability
```

### Getting Help

If you're still stuck:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Check existing docs                                      │
│    README.md, SETUP.md, TROUBLESHOOTING.md                  │
│                                                             │
│ 2. Search GitHub Issues                                     │
│    Someone might have had the same problem                  │
│                                                             │
│ 3. Join the Discord community                               │
│    https://discord.gg/UZv7JjxbwG                            │
│                                                             │
│ 4. File a bug report                                       │
│    Include:                                                 │
│    - What you were doing                                    │
│    - What happened                                          │
│    - Your config (sensitive parts removed)                  │
│    - Logs from ao logs <session>                           │
└─────────────────────────────────────────────────────────────┘
```

---

## Part 17: Putting It All Together - A Complete Example 🎬

### Let's Watch a Real Story Unfold

Here's a complete example of how Agent Orchestrator handles a real task from start to finish.

---

#### Chapter 1: The Morning Standup

```
You (at your desk): "OK, let's see what needs doing today."

1. You open the dashboard: http://localhost:3000
2. See 5 issues from GitHub
3. Pick one: "Add dark mode toggle to settings page"
```

---

#### Chapter 2: Assigning the Task

```
You click "Assign to AI" on the issue

Behind the scenes (automatic):
├─ Session Manager creates session ID: web-6
├─ Workspace plugin creates worktree: ~/.agent-orchestrator/.../web-6
├─ Git checkout: feat/dark-mode-toggle
├─ Runtime plugin starts tmux session
└─ Agent plugin launches Claude Code

Dashboard shows:
┌─────────────────────────────────────────────────────────┐
│ web-6  Add dark mode toggle  [● Working]                │
│ Started: Just now                                      │
│ Activity: Reading settings page...                     │
└─────────────────────────────────────────────────────────┘
```

---

#### Chapter 3: The Agent Works

```
10 minutes later:
Dashboard shows:
┌─────────────────────────────────────────────────────────┐
│ web-6  Add dark mode toggle  [● Working]                │
│ Activity: Writing theme toggle component...            │
└─────────────────────────────────────────────────────────┘

You're drinking coffee, answering emails.
```

---

#### Chapter 4: First CI Failure

```
20 minutes later:
Dashboard shows:
┌─────────────────────────────────────────────────────────┐
│ web-6  Add dark mode toggle  [⚠ CI Failed]              │
│ Activity: Fixing test failures...                       │
│                                                         │
│ Lifecycle Manager detected:                             │
│ - CI run failed (1 test)                               │
│ - Automatically sent error to agent                    │
│ - Agent is now fixing it                                │
└─────────────────────────────────────────────────────────┘

You didn't need to do anything!
```

---

#### Chapter 5: PR Created

```
45 minutes later:
Dashboard shows:
┌─────────────────────────────────────────────────────────┐
│ web-6  Add dark mode toggle  [● pr_open]                │
│ PR: https://github.com/.../pull/256                    │
│ CI: ✅ Passing                                         │
└─────────────────────────────────────────────────────────┘

You get a notification:
🔔 "PR #256 ready for review: Add dark mode toggle"
```

---

#### Chapter 6: Reviewer Comments

```
Your colleague reviews the PR and comments:
"The toggle works, but let's add a smooth animation."

Lifecycle Manager:
├─ Detects new review comment
├─ Sends it to agent
└─ Agent sees it and responds
```

---

#### Chapter 7: Agent Addresses Feedback

```
Dashboard shows:
┌─────────────────────────────────────────────────────────┐
│ web-6  Add dark mode toggle  [● Working]                │
│ Activity: Adding CSS transition to toggle...             │
└─────────────────────────────────────────────────────────┘

15 minutes later:
┌─────────────────────────────────────────────────────────┐
│ web-6  Add dark mode toggle  [● pr_open]                │
│ Activity: Pushed animation fix                          │
└─────────────────────────────────────────────────────────┘
```

---

#### Chapter 8: Approved!

```
Your colleague reviews again:
"Looks great! Approved! 👍"

Dashboard shows:
┌─────────────────────────────────────────────────────────┐
│ web-6  Add dark mode toggle  [✅ Approved & Green]       │
│ CI: ✅ Passing  Review: ✅ Approved                     │
└─────────────────────────────────────────────────────────┘

You get notification:
🔔 "PR #256 approved and ready to merge!"
```

---

#### Chapter 9: Merge and Cleanup

```
You review the code, click "Merge"

System automatically:
├─ Merges the PR into main branch
├─ Session Manager cleans up worktree
└─ Archives session metadata

Dashboard shows:
┌─────────────────────────────────────────────────────────┐
│ web-6  Add dark mode toggle  [✅ Done]                   │
│ Merged 2 minutes ago                                   │
└─────────────────────────────────────────────────────────┘
```

---

#### What You Actually Did

```
Time spent: ~5 minutes total

Your actions:
1. Clicked "Assign to AI" (10 seconds)
2. Reviewed PR (3 minutes)
3. Clicked "Merge" (10 seconds)

System handled:
- Branch creation
- Code changes
- CI failures
- Review comments
- Cleanup

Total time saved: ~2-3 hours
```

---

### The Moral of the Story

```
┌─────────────────────────────────────────────────────────┐
│  OLD WAY:                                                │
│  - Create branch                                        │
│  - Start AI agent                                        │
│  - Watch it work (or come back later)                    │
│  - Copy CI failure, paste to agent                       │
│  - Wait for fix                                          │
│  - Review                                                │
│  - Address review comments yourself                      │
│  - Clean up worktree                                     │
│  Time: 2-3 hours per task                               │
│                                                         │
│  NEW WAY:                                                │
│  - Click "Assign to AI"                                  │
│  - Do other work                                         │
│  - Get notified when ready                               │
│  - Review and merge                                      │
│  Time: 5 minutes per task                               │
└─────────────────────────────────────────────────────────┘
```

---

## Conclusion 🎉

You've now toured Agent Orchestrator from top to bottom! Here's what you learned:

### Core Concepts (Parts 1-3)
- **It's a conductor for AI workers** - coordinating multiple agents like an orchestra
- **Seven plugin slots** - swap any part you want (runtime, agent, workspace, tracker, SCM, notifier, terminal)
- **Sessions do the work** - each issue gets its own isolated workspace
- **Reactions handle feedback** - automatically route CI failures and comments

### Structure and Flow (Parts 4-5)
- **Directory structure** - packages/core, packages/web, packages/plugins, examples
- **Data flow** - from GitHub → Session Manager → Workspace → Runtime → Agent → Lifecycle → Dashboard
- **Event loop** - Lifecycle Manager constantly checks status and routes events

### Configuration and Lifecycle (Parts 6-7)
- **Simple YAML config** - agent-orchestrator.yaml controls everything
- **Session states** - spawning → working → pr_open → (ci_failed / review) → approved → merged → cleanup → done
- **Activity states** - active, ready, idle, waiting_input, blocked, exited

### Extending the System (Part 8)
- **Plugin pattern** - manifest + create function = new plugin
- **Easy registration** - add to BUILTIN_PLUGINS list

### Real-World Examples (Parts 9, 17)
- **Bug fix workflow** - assign → agent works → PR → CI fails → agent fixes → review → merge
- **Complete story** - a full example showing a task from start to finish

### Understanding the System (Parts 10-11)
- **Glossary** - all technical terms explained in everyday language
- **Quick reference** - where to find things, dashboard indicators, common commands

### Using the Dashboard (Part 13)
- **Reading status dots** - green (working), gray (idle), yellow (attention), red (error)
- **Session cards** - what each card tells you about an agent
- **Actions** - attach, kill, view PR, check logs

### Observability (Part 14)
- **Three levels** - status dots, dashboard banner, detailed logs
- **Metrics** - spawn, restore, kill, lifecycle_poll, api_request
- **Health surfaces** - check if system itself is working

### Feedback System (Part 15)
- **Agents can report bugs** - using bug_report and improvement_suggestion tools
- **Duplicate detection** - same issue reported multiple times only saved once
- **Structured reports** - easy for developers to review and fix

### Troubleshooting (Part 16)
- **Common problems** - agent won't start, crashes, CI failures, dashboard issues
- **Quick diagnosis** - first things to check, step-by-step solutions
- **Getting help** - docs, issues, Discord, bug reports

### The Big Picture

```
┌─────────────────────────────────────────────────────────────┐
│                    YOU ARE IN CHARGE                       │
│                                                             │
│  You tell agents what to do via issues                        │
│  Agents do the work autonomously                             │
│  System handles all the coordination                          │
│  You review, approve, and merge                            │
│                                                             │
│  Result: More code, less coordination work!                │
└─────────────────────────────────────────────────────────────┘
```

### Key Takeaways

- **Start simple** - use defaults, add complexity as you need it
- **Trust the system** - it handles isolation, cleanup, and feedback routing
- **Monitor health** - check observability if something seems wrong
- **Know when to step in** - escalations exist for a reason
- **Use the dashboard** - it's your command center
- **Contribute back** - if you find issues, the feedback system makes it easy

### Your Path Forward

| If you want to... | Start with... |
|-------------------|---------------|
| Try it out | Run `ao start` and assign an issue |
| Build a plugin | Read Part 8, copy an existing plugin |
| Debug problems | Check Part 16 troubleshooting guide |
| Monitor system | Review Part 14 observability |
| Understand everything | Read through all 17 parts again! |

---

## Final Words 🌟

Agent Orchestrator is designed to make working with AI agents feel natural and productive. The plugin architecture means it can grow with you — add new runtimes, try different agents, integrate with your favorite tools.

The best way to learn is to use it. Run `ao start`, assign an issue to an agent, and watch it work. Then explore the dashboard, check the logs, and see the observability data in action.

**Welcome to the future of software development — where you're the architect, and AI agents are the builders!** 🏗️🤖

---

*Still have questions? Join the [Discord community](https://discord.gg/UZv7JjxbwG) or check the [GitHub issues](https://github.com/ComposioHQ/agent-orchestrator/issues).*
