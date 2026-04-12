# Beginner's Walkthrough: Understanding Agent Orchestrator

Welcome! This guide will walk you through Agent Orchestrator step by step. We'll use simple analogies to explain how everything works together.

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

### The Eight Plugin Slots (The LEGO Pieces)

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
| **Lifecycle** | State management | The progress tracker | (built-in) | — |

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
│   └── agent-orchestrator.yaml.examples
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
# Where things are stored on your computer
dataDir: ~/.agent-orchestrator
worktreeDir: ~/.worktrees

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
    ├── sessions/              ← Active sessions
    │   ├── web-1              ← Session metadata
    │   └── web-2
    │
    ├── worktrees/             ← Git worktrees
    │   ├── web-1/             ← Isolated code copy
    │   └── web-2/
    │
    └── archive/               ← Completed sessions
        └── web-3/
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

Every plugin follows the same simple pattern:

```typescript
// 1. Describe yourself
export const manifest = {
  name: "my-plugin",           // Your name
  slot: "runtime",             // Which slot you fit in
  description: "My cool runtime",
  version: "0.1.0",
};

// 2. Provide your implementation
export function create(): Runtime {
  return {
    name: "my-plugin",

    // Start a new session
    async create(config) {
      // Do the work to start a session
      return { sessionName: "..." };
    },

    // End a session
    async destroy(sessionName) {
      // Clean up
    },

    // Send text to a running session
    async send(sessionName, text) {
      // Send the text
    },

    // Check if a session is still running
    async isRunning(sessionName) {
      return true; // or false
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

4. **Register it** in `packages/core/src/plugin-registry.ts`
   ```typescript
   import runtimeMynewruntime from "@composio/ao-runtime-mynewruntime";
   // Add to the loadBuiltins() function
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
| **Notifer** | How you get alerts | Notification channel (desktop, Slack, webhook) |
| **Manifest** | A plugin's ID card | Metadata describing a plugin |
| **State** | Where something is in a process | Current status (spawning, working, done) |
| **Activity** | What's happening now | Current action (active, idle, waiting) |
| **Dashboard** | The web UI | Next.js application showing all sessions |
| **Orchestrator** | The main coordinator | The agent that manages worker agents |
| **Worker** | A task-specific agent | An AI working on a specific issue |
| **Hash** | A unique fingerprint | SHA-256 used for isolation and naming |
| **Namespace** | A way to keep things separate | Using hashes to avoid conflicts |

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
4. **Watch it work** - Follow the session in the dashboard

### If you want to contribute:

1. **Read DEVELOPMENT.md** - Understand coding conventions
2. **Pick a simple plugin** - Read the code
3. **Try making a small change** - Build and test
4. **Read this walkthrough again** - Things will make more sense

### If you want to build a plugin:

1. **Choose a slot** - What do you want to swap?
2. **Read the interface** - In `packages/core/src/types.ts`
3. **Copy an existing plugin** - Use it as a template
4. **Implement the methods** - Follow the pattern
5. **Register and test** - See "Plugin Development" above

---

## Conclusion 🎉

You've now toured Agent Orchestrator from top to bottom! Remember:

- **It's a conductor for AI workers** - coordinating multiple agents
- **Everything is a plugin** - swap any part you want
- **Sessions do the work** - each issue gets its own isolated workspace
- **Reactions handle feedback** - automatically route CI failures and comments
- **You're still in charge** - review and merge when ready

The best way to learn is to use it. Run `ao start`, assign an issue to an agent, and watch it work!

---

*Still have questions? Join the [Discord community](https://discord.gg/UZv7JjxbwG) or check the [GitHub issues](https://github.com/ComposioHQ/agent-orchestrator/issues).*
