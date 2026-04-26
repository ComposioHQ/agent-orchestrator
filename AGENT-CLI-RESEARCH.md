# Agent CLI Research: Gemini CLI & GitHub Copilot CLI

Research for adding agent plugin support for Gemini CLI and GitHub Copilot CLI
to agent-orchestrator. Based on running the actual CLIs on this machine and
studying the existing claude-code plugin as the reference implementation.

**Date:** 2026-04-26
**Gemini CLI version:** 0.35.3 (`@google/gemini-cli`)
**Copilot CLI version:** 1.0.36 (`copilot`)
**Reference:** `packages/plugins/agent-claude-code/src/index.ts`

---

## Verified by Running the CLIs

All claims in this document were tested on this machine unless marked otherwise.
Key tests performed:

| Test | Result |
|------|--------|
| `gemini -r <uuid>` resume by UUID | Works (confirmed) |
| `gemini -i` stays interactive | **Fails** — errors with "cannot be used when input is piped from stdin" (needs real TTY) |
| `gemini` process in `ps` | Shows as `node ... /opt/homebrew/bin/gemini` (NOT as `gemini`) |
| `copilot -i` stays interactive | Works (confirmed via tmux with TTY) |
| `copilot --resume=<uuid>` | Works (confirmed) |
| `copilot --name` + `--resume=<name>` | Works (name stored in workspace.yaml) |
| `copilot` process in `ps` | Shows as `copilot ...` (native binary, confirmed) |
| `copilot events.jsonl` real-time | **Delayed ~15-18s**, then batch-updated |
| `copilot events.jsonl` waiting_input event | **Does NOT exist** — permission denials are `tool.execution_complete` with `success: false` |
| Copilot permission prompts in tmux | TUI dialog boxes: "Do you want to allow this?", "Do you trust the files?" |
| `copilot -o json` (headless JSONL) | Works — returns JSONL events including shutdown metrics |
| `gemini -o json` (headless) | Works — returns single JSON object with stats |
| `gemini -o stream-json` | Works — returns init, message, result events as JSONL |

---

## Table of Contents

1. [Gemini CLI](#1-gemini-cli)
2. [GitHub Copilot CLI](#2-github-copilot-cli)
3. [Claude Code Plugin — Annotated Reference](#3-claude-code-plugin--annotated-reference)
4. [Comparison Matrix](#4-comparison-matrix)
5. [Implementation Plan](#5-implementation-plan)

---

## 1. Gemini CLI

### 1.1 Binary & Installation

| Property | Value |
|----------|-------|
| Binary | `/opt/homebrew/bin/gemini` |
| Package | `@google/gemini-cli` (npm) |
| Runtime | Node.js |
| Config dir | `~/.gemini/` |
| License | Apache 2.0 |
| Repo | `github.com/google-gemini/gemini-cli` |

### 1.2 Launch Command

```bash
# Interactive mode (default)
gemini

# Non-interactive (headless) — executes prompt and exits
gemini -p "Fix the bug in main.js"

# Interactive with auto-executed prompt
gemini -i "Fix the bug in main.js"

# With model selection
gemini -m gemini-3-flash-preview -p "task"

# JSON output (for scripted use)
gemini -p "task" -o json
```

**Key flags for agent plugin:**
- `-p/--prompt <text>` — Non-interactive (headless) mode. Exits after completion.
- `-i/--prompt-interactive <text>` — Execute prompt, then stay interactive.
- `-m/--model <string>` — Model selection.
- `-o/--output-format` — `text` | `json` | `stream-json`.
- `-y/--yolo` — Auto-approve all actions.
- `--approval-mode` — `default` | `auto_edit` | `yolo` | `plan`.
- `-s/--sandbox` — Run in sandbox mode.
- `-r/--resume <id|"latest"|index>` — Resume previous session.
- `--list-sessions` — List available sessions for current project.
- `-e/--extensions <array>` — Specify extensions to use.
- `--policy <array>` — Additional policy files.

**Plugin decision: `promptDelivery`**

Gemini CLI exits after `-p` (just like `claude -p`).

**Tested:** `gemini -i` **fails** when stdin is piped — it errors with
"The --prompt-interactive flag cannot be used when input is piped from stdin."
However, it should work in a tmux PTY (real TTY). Needs further testing in tmux.

Options:
- **Option A:** Use `-i` flag with `promptDelivery: "inline"` — IF it works in tmux PTY. Needs testing.
- **Option B (safer):** Launch bare `gemini` with `promptDelivery: "post-launch"` and send the prompt via `runtime.sendMessage()` after launch, like claude-code does.

Option B is safer until `-i` is confirmed working in tmux.

### 1.3 Permission / Approval Modes

| AO Mode | Gemini Flag | Notes |
|---------|-------------|-------|
| `permissionless` | `--yolo` or `--approval-mode yolo` | Auto-approve everything |
| `auto-edit` | `--approval-mode auto_edit` | Auto-approve edits only |
| `default` | (none) | Prompt for approval |
| `suggest` | `--approval-mode plan` | Read-only mode |

### 1.4 Session Data & Storage

```
~/.gemini/
  settings.json          # Global settings (MCP servers, auth, IDE config)
  projects.json          # Map of project path -> project name
  state.json             # General state
  trustedFolders.json    # Trusted folder list
  installation_id        # UUID
  user_id                # UUID
  google_account_id      # Google account identifier
  history/
    {project-name}/      # Session history by project
      .project_root      # Stores the absolute project path
  tmp/
    {project-name}/
      .project_root      # Project root path
      chats/
        session-YYYY-MM-DDTHH-MM-{sessionId}.json   # Session files
```

**Session file format** (JSON):
```json
{
  "sessionId": "b3a60267-b440-40f9-aefc-8fdc925ebc53",
  "projectHash": "fd81fa8bc9c39c899f03134976593325...",
  "startTime": "2026-04-26T16:12:25.940Z",
  "lastUpdated": "2026-04-26T16:12:34.714Z",
  "messages": [
    {
      "id": "08bab3e2-...",
      "timestamp": "2026-04-26T16:12:25.940Z",
      "type": "user",
      "content": [{ "text": "Show me environment variables" }]
    },
    {
      "id": "c39dfb31-...",
      "timestamp": "2026-04-26T16:12:34.714Z",
      "type": "gemini",
      "content": "I am currently operating in Plan Mode...",
      "thoughts": [...],
      "tokens": {
        "input": 14687,
        "output": 92,
        "cached": 0,
        "thoughts": 663,
        "tool": 0,
        "total": 15442
      },
      "model": "gemini-3.1-pro-preview-customtools"
    }
  ],
  "kind": "main"
}
```

**Project name resolution:**
Gemini maps workspace paths to project names in `~/.gemini/projects.json`:
```json
{
  "projects": {
    "/path/to/repo": "project-name"
  }
}
```

The project name is used as the directory key under `~/.gemini/tmp/` and `~/.gemini/history/`.

### 1.5 Session Resume

```bash
# List sessions for current project
gemini --list-sessions
# Output: "1. test What is 2+2? (2 minutes ago) [uuid]"

# Resume by index
gemini -r 1

# Resume latest
gemini -r latest

# Delete a session
gemini --delete-session 1
```

Session IDs are UUIDs. Resume uses index numbers or "latest".

### 1.6 Activity Detection Strategy

**No native JSONL event log.** Gemini stores sessions as JSON files (not streaming JSONL). The session file is only updated when messages complete — it's not useful for real-time activity detection.

**Recommended approach: AO Activity JSONL pattern** (same as Aider/OpenCode):
1. Implement `recordActivity()` using `recordTerminalActivity()` from core.
2. Implement `detectActivity()` with Gemini-specific terminal patterns.
3. `getActivityState()` reads from `.ao/activity.jsonl` (written by `recordActivity`).

**Terminal output patterns for `detectActivity()`:**

| State | Pattern |
|-------|---------|
| `idle` | Empty output, or prompt visible (`>` or `$` at end) |
| `waiting_input` | Permission prompts: `(Y)es/(N)o`, `Allow`, `Proceed?` |
| `active` | Everything else (thinking, reading, writing) |
| `blocked` | Error messages at bottom of buffer |

**For `getActivityState()` cascade:**
1. Process check (is gemini running?)
2. `checkActivityLogState()` for waiting_input/blocked from `.ao/activity.jsonl`
3. Session file `lastUpdated` as native signal (stat the session JSON)
4. `getActivityFallbackState()` from activity JSONL

### 1.7 JSON Output (for `getSessionInfo`)

The `-o json` output provides comprehensive token/cost stats:

```json
{
  "session_id": "6cdb579a-...",
  "response": "2 + 2 is 4.",
  "stats": {
    "models": {
      "gemini-2.5-flash-lite": {
        "tokens": { "input": 3797, "candidates": 34, "total": 4004, "cached": 0, "thoughts": 173 }
      },
      "gemini-3-flash-preview": {
        "tokens": { "input": 5399, "candidates": 8, "total": 13589, "cached": 8157, "thoughts": 25 }
      }
    },
    "tools": { "totalCalls": 0, "totalSuccess": 0, "totalFail": 0 },
    "files": { "totalLinesAdded": 0, "totalLinesRemoved": 0 }
  }
}
```

However, this output is only available when running with `-o json` (headless mode).
For interactive sessions, the session JSON files contain per-message token counts.

**Cost estimation challenge:** Gemini API pricing differs from Claude. The plugin would
need Gemini-specific pricing per model. Token counts are available from session files.

### 1.8 Process Detection

| Property | Value |
|----------|-------|
| Process name | `gemini` (symlink to Node.js) |
| Actual process | `node /opt/homebrew/lib/node_modules/@google/gemini-cli/dist/index.js` |
| Process regex | `/\/opt\/homebrew\/bin\/gemini/` or `/gemini-cli\/dist\/index\.js/` |

**Verified via `ps -eo pid,args`:** Gemini appears as two `node` processes:
```
58126 node --no-warnings=DEP0040 /opt/homebrew/bin/gemini -p ...
58497 /usr/local/bin/node --no-warnings=DEP0040 /opt/homebrew/bin/gemini -p ...
```

**Important:** The simple regex `/(?:^|\/)gemini(?:\s|$)/` will NOT work because the
process name is `node`, not `gemini`. Must match against the full command args.
Best pattern: `/\/gemini(?:\s|$)/` — matches the `/opt/homebrew/bin/gemini` path
in the args column.

### 1.9 Hooks / Workspace Integration

**Gemini has a hooks system** (`gemini hooks --help`) but it's currently minimal:
- Only subcommand is `gemini hooks migrate` (migrates hooks from Claude Code).
- No documented way to add custom PostToolUse hooks programmatically.

**Gemini also supports GEMINI.md** instruction files (like CLAUDE.md), but no
native hook mechanism for intercepting tool calls.

**Recommendation: Use PATH wrappers** (same as Aider/OpenCode):
- `setupWorkspaceHooks()` calls `setupPathWrapperWorkspace()` from core.
- The shared `~/.ao/bin/gh` and `~/.ao/bin/git` wrappers handle metadata updates.
- No agent-specific hook configuration needed.

### 1.10 Configuration

**Settings file:** `~/.gemini/settings.json`
```json
{
  "mcpServers": { ... },
  "ide": { "hasSeenNudge": true },
  "security": { "auth": { "selectedType": "gemini-api-key" } }
}
```

**Authentication:** Via `GEMINI_API_KEY` env var or Google account.

**Environment variables the plugin should set:**
- `AO_SESSION_ID` — Session identifier.
- `AO_ISSUE_ID` — Optional issue identifier.
- `GEMINI_API_KEY` — If configured in AO project config (pass-through).

### 1.11 Extension System

Gemini has a full extension system:
```bash
gemini extensions install <source>   # Install from git repos
gemini extensions list               # List installed
gemini extensions enable/disable     # Toggle
gemini extensions link <path>        # Local development
```

Not directly relevant for the AO plugin — but could be leveraged in the future
for custom activity reporting extensions.

### 1.12 Shared Skills System

Both Gemini and Copilot discover skills from `~/.agents/skills/` — a shared
directory used by multiple CLI tools. Skills are markdown files with YAML frontmatter.
This means AO could potentially install a skill that helps with metadata reporting.

---

## 2. GitHub Copilot CLI

### 2.1 Binary & Installation

| Property | Value |
|----------|-------|
| Binary | `/opt/homebrew/bin/copilot` (native Mach-O arm64) |
| Also via | `gh copilot` (GitHub CLI wrapper) |
| Config dir | `~/.copilot/` |
| Repo | github.com (not open source, but docs are public) |

### 2.2 Launch Command

```bash
# Interactive mode (default)
copilot

# Non-interactive — executes prompt and exits
copilot -p "Fix the bug" --allow-all

# Interactive with auto-executed prompt
copilot -i "Fix the bug"

# With model selection
copilot --model gpt-5.3-codex -p "task" --allow-all

# Autopilot mode
copilot --autopilot --allow-all

# Named session
copilot --name "my feature"

# Silent mode (scripting)
copilot -p "task" --allow-all -s

# JSON output
copilot -p "task" --allow-all --output-format json
```

**Key flags for agent plugin:**
- `-p/--prompt <text>` — Non-interactive mode.
- `-i/--interactive <prompt>` — Interactive with auto-executed prompt.
- `--mode <mode>` — `interactive` | `plan` | `autopilot`.
- `--model <model>` — Model selection (GPT-5.x, Claude, etc.).
- `--allow-all` / `--yolo` — Enable all permissions.
- `--allow-all-tools` — Auto-approve tool execution.
- `--allow-all-paths` — Auto-approve file access.
- `--no-ask-user` — Disable user interaction (fully autonomous).
- `--continue` — Resume most recent session.
- `--resume[=id|name]` — Resume specific session.
- `-n/--name <name>` — Name the session.
- `-s/--silent` — Output only agent response.
- `--output-format json` — JSONL output.
- `--autopilot` — Autonomous execution mode.
- `--max-autopilot-continues <n>` — Limit autopilot rounds.

**Plugin decision: `promptDelivery`**

Like Claude, `copilot -p` exits after completion. Options:
- **Option A (recommended):** Use `-i` flag with `promptDelivery: "inline"`. Keeps Copilot interactive after first prompt.
- **Option B:** Use `--autopilot --mode autopilot` with `-p` for fully autonomous headless execution. The agent won't wait for follow-ups.
- **Option C:** Launch bare `copilot` with `promptDelivery: "post-launch"` and send via `runtime.sendMessage()`.

Option A is best for parity with other agents. Option B is interesting for
fire-and-forget tasks where we don't need the agent to remain interactive.

### 2.3 Permission / Approval Modes

| AO Mode | Copilot Flag | Notes |
|---------|--------------|-------|
| `permissionless` | `--allow-all` or `--yolo` | All tools, paths, URLs auto-approved |
| `auto-edit` | `--allow-tool=write --allow-tool='shell(git:*)'` | Fine-grained |
| `default` | (none) | Prompt for approval |
| `suggest` | `--mode plan` | Read-only planning mode |

Copilot has the most granular permission system of all three agents:
```bash
# Allow specific commands
--allow-tool='shell(git:*)'       # All git commands
--allow-tool='shell(npm:*)'       # All npm commands
--deny-tool='shell(git push)'     # Deny git push specifically
--allow-tool=write                # All file writes
--allow-url=github.com            # URL access
```

Additional useful flags:
- `--no-ask-user` — Prevents the agent from asking questions (fully autonomous).
- `--no-custom-instructions` — Skip loading AGENTS.md files.

### 2.4 Session Data & Storage

```
~/.copilot/
  config.json                 # Auto-managed config (first launch, trusted folders)
  settings.json               # User settings
  command-history-state.json  # Command history
  mcp-config.json             # MCP server configuration (if created)
  logs/
    process-{timestamp}-{pid}.log   # Process logs
  session-state/
    {sessionId}/              # UUID directory per session
      workspace.yaml          # Session metadata
      events.jsonl            # Full event log (JSONL)
      checkpoints/
        index.md              # Session checkpoints
      files/                  # Working files
      research/               # Research artifacts
      rewind-snapshots/       # For reverting changes
  ide/                        # IDE integration config
```

**workspace.yaml format:**
```yaml
id: cbe88136-cfb2-499b-8350-ceaa1e310551
cwd: /path/to/workspace
git_root: /path/to/workspace
repository: owner/repo
host_type: github
branch: session/ao-103
summary_count: 0
created_at: 2026-04-26T16:12:30.735Z
updated_at: 2026-04-26T16:12:36.654Z
summary: what is 2+2
```

**events.jsonl format** (rich JSONL with parent-child event relationships):

```jsonl
{"type":"session.start","data":{"sessionId":"...","version":1,"producer":"copilot-agent","copilotVersion":"1.0.32","startTime":"...","context":{"cwd":"...","gitRoot":"...","branch":"...","repository":"...","hostType":"github"}}}
{"type":"session.model_change","data":{"newModel":"gpt-5.3-codex"}}
{"type":"user.message","data":{"content":"...", "interactionId":"..."}}
{"type":"assistant.turn_start","data":{"turnId":"0","interactionId":"..."}}
{"type":"assistant.message","data":{"messageId":"...","content":"...","toolRequests":[],"outputTokens":27}}
{"type":"assistant.turn_end","data":{"turnId":"0"}}
{"type":"session.shutdown","data":{"shutdownType":"routine","totalPremiumRequests":1,"modelMetrics":{"gpt-5.3-codex":{"requests":{"count":1},"usage":{"inputTokens":28903,"outputTokens":27,"cacheReadTokens":0,"reasoningTokens":20}}}}}
```

### 2.5 Session Resume

```bash
# Resume most recent
copilot --continue

# Resume by UUID
copilot --resume=cbe88136-cfb2-499b-8350-ceaa1e310551

# Resume by ID prefix (7+ hex chars)
copilot --resume=cbe88136

# Resume by name (exact, case-insensitive)
copilot --resume="my feature"

# Interactive session picker
copilot --resume
```

Session IDs are UUIDs stored in `~/.copilot/session-state/{uuid}/`.

### 2.6 Activity Detection Strategy

**Copilot has native JSONL** (`events.jsonl`) but with important caveats verified
by testing:

**Caveat 1: Delayed flush (~15-18s).** events.jsonl is NOT real-time. It first
appears ~15-18 seconds after session start, then updates in batches. Tested:
```
t=2s:  no events.jsonl
t=8s:  5 events (startup batch: session.start → assistant.turn_start)
t=18s: 12 events (tool execution batch)
t=final: 15 events (includes session.shutdown)
```

**Caveat 2: No `waiting_input` event type.** When Copilot is denied a tool in
non-interactive (`-p`) mode, it gets `tool.execution_complete` with `"success": false`
and `"error": {"message": "Permission denied..."}`. It does NOT emit a permission
request event — it just moves on.

**Caveat 3: Permission prompts only in interactive/tmux mode.** When running in a
TTY (how AO uses it via tmux), Copilot shows TUI dialog boxes for approval:
```
╭──────────────────────────────╮
│ Allow directory access       │
│ ...                          │
│ Do you want to allow this?   │
│   1. Yes                     │
│ ❯ 2. Yes, and add these...  │
│   3. No (Esc)                │
╰──────────────────────────────╯
```

**Recommended approach: Hybrid** (native JSONL + AO Activity JSONL):
- **Primary:** Read `events.jsonl` for active/ready/idle states (like Claude Code)
- **waiting_input/blocked:** Use AO Activity JSONL via `recordActivity()` + terminal
  pattern matching (like Aider). The native JSONL won't capture these states.

**Verified event types and their mapping:**

| Copilot Event Type | AO Activity State | Notes |
|--------------------|-------------------|-------|
| `session.start` | `active` (startup) | |
| `session.model_change` | `active` | |
| `user.message` | `active` | |
| `assistant.turn_start` | `active` | |
| `assistant.message` (non-final) | `active` | Has `toolRequests` |
| `assistant.message` (phase=`final_answer`) | `ready` | `outputTokens` present |
| `tool.execution_start` | `active` | `toolName` field present |
| `tool.execution_complete` (success=true) | `active` | |
| `tool.execution_complete` (success=false) | `blocked` | Permission denied or error |
| `assistant.turn_end` | `ready` | |
| `session.shutdown` | `exited` | |

**For `getActivityState()` cascade:**
1. Process check → `exited` if dead
2. Check AO activity JSONL (`checkActivityLogState()`) → `waiting_input`/`blocked`
3. Read last entry from `events.jsonl` → map to active/ready/idle with age decay
4. Fallback to AO activity JSONL age decay (`getActivityFallbackState()`)

**Finding the right session directory:**
Need to match the workspace path to a session. Strategy:
- Read `workspace.yaml` in each session directory under `~/.copilot/session-state/`
- Match by `cwd` or `git_root` field
- Use the most recently modified match
- Cache the mapping to avoid scanning every poll cycle

**Terminal output patterns for `detectActivity()`** (verified in tmux):

| Pattern | State | Notes |
|---------|-------|-------|
| `Do you want to allow this?` | `waiting_input` | Directory/path access prompt |
| `Do you trust the files in this folder?` | `waiting_input` | Folder trust prompt |
| `↑↓ to navigate` | `waiting_input` | TUI selection menu active |
| `> ` at end of output | `idle` | Interactive prompt |
| Empty output | `idle` | |
| Everything else | `active` | |

### 2.7 Cost & Usage Tracking

**Copilot has detailed cost tracking in events.jsonl:**

The `session.shutdown` event contains comprehensive metrics:
```json
{
  "totalPremiumRequests": 1,
  "totalApiDurationMs": 4473,
  "modelMetrics": {
    "gpt-5.3-codex": {
      "requests": { "count": 1, "cost": 1 },
      "usage": {
        "inputTokens": 28903,
        "outputTokens": 27,
        "cacheReadTokens": 0,
        "cacheWriteTokens": 0,
        "reasoningTokens": 20
      }
    }
  },
  "codeChanges": {
    "linesAdded": 0,
    "linesRemoved": 0,
    "filesModified": []
  }
}
```

Individual `assistant.message` events also include `outputTokens`.

**Cost estimation:** Copilot is subscription-based, so direct USD cost may not be
applicable. We can still report token usage and premium request counts.

### 2.8 Process Detection

| Property | Value |
|----------|-------|
| Process name | `copilot` (native binary, Mach-O arm64) |
| Process regex | `/(?:^|\/)copilot(?:\s\|$)/` |
| PID detection | Direct — native binary shows up as `copilot` in `ps` |

**Verified via `ps -eo pid,args`:** Copilot appears cleanly as:
```
64070 copilot -p count to 10 slowly --allow-all -s
```
Unlike Gemini (which is a Node.js script), Copilot is a native binary —
`/opt/homebrew/bin/copilot` (Mach-O arm64). The simple regex works.

### 2.9 Hooks / Workspace Integration

**Copilot has a plugin system** (`copilot plugin --help`):
```bash
copilot plugin install <source>   # Install from GitHub repos
copilot plugin list               # List installed
copilot plugin update <name>      # Update
copilot plugin uninstall <name>   # Remove
```

Plugins can provide: skills, agents, hooks, MCP servers, LSP servers.

**Copilot supports custom instructions** via AGENTS.md files:
- Repository-level: `.github/copilot-instructions.md` (created via `copilot init`)
- Custom dirs: `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` env var

**Recommendation: Use PATH wrappers** (same as Aider/OpenCode):
- The shared `~/.ao/bin/gh` and `~/.ao/bin/git` wrappers will work here.
- Additionally, we can write to `.github/copilot-instructions.md` or use
  `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` to inject AO session context.
- Future: could build a Copilot plugin that reports metadata natively.

### 2.10 OpenTelemetry Integration

Copilot has built-in OTel support — potentially useful for AO monitoring:

```bash
# File-based OTel export (for activity detection)
COPILOT_OTEL_FILE_EXPORTER_PATH=/tmp/copilot-otel.jsonl copilot

# OTLP export to a collector
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 copilot
```

**Exported signals:**
- Traces: `invoke_agent`, `chat <model>`, `execute_tool <tool>`
- Metrics: `gen_ai.client.token.usage`, `github.copilot.tool.call.count`, etc.

This could be used as an alternative activity detection mechanism — OTel file
output would provide real-time streaming events.

### 2.11 Available Models

Copilot CLI supports multiple model providers:
- **Claude:** claude-sonnet-4.6, claude-opus-4.7, claude-opus-4.6, claude-haiku-4.5
- **GPT:** gpt-5.4, gpt-5.3-codex, gpt-5.2, gpt-5.1, gpt-5.4-mini, gpt-5-mini, gpt-4.1
- **BYOK:** Any OpenAI-compatible, Azure, or Anthropic endpoint

### 2.12 Environment Variables

**Authentication:**
- `COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN` (precedence order)

**Behavior:**
- `COPILOT_ALLOW_ALL=true` — Same as `--allow-all`
- `COPILOT_MODEL` — Default model
- `COPILOT_HOME` — Override config directory
- `COPILOT_AUTO_UPDATE=false` — Disable auto-updates
- `COPILOT_OFFLINE=true` — Offline mode (requires local model)

**For the plugin to set:**
- `AO_SESSION_ID` — Session identifier
- `AO_ISSUE_ID` — Optional issue identifier
- `COPILOT_AUTO_UPDATE=false` — Prevent update prompts during execution

---

## 3. Claude Code Plugin — Annotated Reference

The existing `agent-claude-code` plugin (`packages/plugins/agent-claude-code/src/index.ts`,
884 lines) serves as the canonical reference. Here's how each Agent interface method
maps to the new plugins.

### 3.1 Plugin Structure

```typescript
// Manifest
export const manifest = {
  name: "claude-code",
  slot: "agent" as const,
  description: "Agent plugin: Claude Code CLI",
  version: "0.1.0",
  displayName: "Claude Code",
};

// Factory
export function create(): Agent { return createClaudeCodeAgent(); }

// Detection
export function detect(): boolean {
  execFileSync("claude", ["--version"], { stdio: "ignore" });
  return true;
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;
```

### 3.2 Method-by-Method Analysis

#### `getLaunchCommand(config)`
- Builds `claude [flags]` command string.
- Permission modes: `--dangerously-skip-permissions` for permissionless/auto-edit.
- Model: `--model <model>`.
- System prompt: `--append-system-prompt "$(cat /path/to/file)"` for long prompts.
- **No task prompt** — delivered post-launch via `runtime.sendMessage()`.
- Uses `shellEscape()` for all dynamic values.

#### `getEnvironment(config)`
- Sets `CLAUDECODE=""` (unset to prevent nested conflicts).
- Sets `AO_SESSION_ID`, optionally `AO_ISSUE_ID`.
- PATH and GH_PATH are injected by session-manager, not here.

#### `detectActivity(terminalOutput)` — Terminal pattern matching
- Empty → `idle`
- Prompt chars (`❯`, `>`, `$`, `#`) at end → `idle`
- Permission prompts in tail 5 lines → `waiting_input`
- Everything else → `active`

#### `getActivityState(session, readyThresholdMs)` — JSONL-based detection
This is the most complex method. Cascade:
1. **Process check:** `isProcessRunning()` → `exited` if dead
2. **Workspace check:** Return `null` if no workspace path
3. **Find JSONL:** `~/.claude/projects/{encoded-path}/{uuid}.jsonl`
   - Path encoding: `toClaudeProjectPath()` replaces `/` and `.` with `-`
   - Finds most recent `.jsonl` file (excluding `agent-*.jsonl`)
4. **Read last entry:** `readLastJsonlEntry()` from core (reads tail 131KB)
5. **Map entry type to state:**
   - `user`, `tool_use`, `progress` → `active` (if fresh) or `ready`/`idle` (by age)
   - `assistant`, `system`, `summary`, `result` → `ready` or `idle` (by age)
   - `permission_request` → `waiting_input`
   - `error` → `blocked`
   - Unknown → `active` (if fresh) or `ready`/`idle`

#### `isProcessRunning(handle)` — Dual runtime support
- **tmux:** Get pane TTYs → cached `ps -eo pid,tty,args` → match `/claude/` regex on TTY
- **process:** Signal-0 check via `process.kill(pid, 0)` with EPERM handling
- PS output cached with 5s TTL to avoid N `ps` calls for N sessions

#### `getSessionInfo(session)` — Cost, summary, session ID
- Reads JSONL tail (131KB) via `parseJsonlFileTail()`
- **Summary:** Last `type === "summary"` entry, or first user message (120 chars)
- **Cost:** Aggregates `costUSD` or `estimatedCostUsd` from all entries; calculates from tokens if zero
- **Session ID:** Filename without `.jsonl` extension

#### `getRestoreCommand(session, project)` — Session resume
- Finds latest JSONL → extracts UUID from filename
- Builds: `claude --resume <uuid> [--dangerously-skip-permissions] [--model <model>]`
- Only adds permission flag for orchestrator role sessions

#### `setupWorkspaceHooks(workspacePath)` — PostToolUse hook
- Writes `metadata-updater.sh` bash script to `.claude/`
- Updates `.claude/settings.json` with PostToolUse hook config
- Hook intercepts Bash tool calls: `gh pr create`, `git checkout -b`, `gh pr merge`
- Extracts PR URLs, branch names → writes to session metadata file

#### `postLaunchSetup(session)` — Re-ensure hooks
- Calls `setupHookInWorkspace()` again after launch (same as setupWorkspaceHooks)
- Ensures hooks survive across worktree creation timing issues

### 3.3 Patterns to Reuse

| Pattern | Used by | For new plugins |
|---------|---------|-----------------|
| `shellEscape()` | All | All dynamic command args |
| `normalizeAgentPermissionMode()` | All | Map AO modes to agent flags |
| PATH wrappers (`~/.ao/bin/`) | Aider, Codex, OpenCode | Gemini, Copilot |
| `readLastJsonlEntry()` | Claude, Codex | Copilot (native JSONL) |
| `readLastActivityEntry()` + `checkActivityLogState()` | Aider, OpenCode | Gemini (AO activity JSONL) |
| `getActivityFallbackState()` | Aider, Codex, OpenCode | Both |
| `recordTerminalActivity()` | Aider, OpenCode | Gemini |
| PS cache (5s TTL) | Claude | Copilot (native binary) |

---

## 4. Comparison Matrix

### 4.1 Feature Support

| Feature | Claude Code | Gemini CLI | Copilot CLI |
|---------|:-----------:|:----------:|:-----------:|
| **Non-interactive mode** | `-p` (exits) | `-p` (exits) | `-p` (exits) |
| **Interactive + auto-prompt** | N/A (use post-launch) | `-i` flag | `-i` flag |
| **Autonomous mode** | `--dangerously-skip-permissions` | `--yolo` / `--approval-mode yolo` | `--allow-all` / `--yolo` |
| **Auto-edit mode** | `--dangerously-skip-permissions` | `--approval-mode auto_edit` | `--allow-tool=write` |
| **Plan/read-only mode** | N/A | `--approval-mode plan` | `--mode plan` |
| **Model selection** | `--model` | `-m/--model` | `--model` |
| **Session resume** | `--resume <uuid>` | `-r <index\|latest\|uuid>` | `--resume[=id\|name]` / `--continue` |
| **Named sessions** | N/A | N/A | `--name <name>` |
| **Native JSONL events** | Yes (rich) | No (JSON sessions) | Yes (rich) |
| **Token tracking** | Per-entry in JSONL | Per-message in session JSON | Per-event in JSONL + shutdown summary |
| **Cost in USD** | `costUSD` field | No (free tier / API key) | `requests.cost` (premium requests) |
| **PostToolUse hooks** | `.claude/settings.json` | `gemini hooks` (minimal) | Plugin system (future) |
| **Custom instructions** | `CLAUDE.md` | `GEMINI.md` | `AGENTS.md` / `.github/copilot-instructions.md` |
| **MCP support** | Yes | Yes | Yes (built-in GitHub MCP) |
| **JSON output** | N/A | `-o json\|stream-json` | `--output-format json` |
| **Sandbox mode** | N/A | `-s/--sandbox` | N/A |
| **Native binary** | No (Node.js) | No (Node.js) | Yes (Mach-O arm64) |
| **OpenTelemetry** | No | No | Yes (built-in) |
| **Multi-model** | Claude only | Gemini models | GPT, Claude, BYOK |
| **Extensions/Plugins** | N/A | Extensions system | Plugin system |
| **Shared skills dir** | N/A | `~/.agents/skills/` | `~/.agents/skills/` |

### 4.2 Agent Interface Implementation Mapping

| Agent Method | Claude Code | Gemini CLI | Copilot CLI |
|-------------|-------------|------------|-------------|
| `name` | `"claude-code"` | `"gemini"` | `"copilot"` |
| `processName` | `"claude"` | `"gemini"` or match node args | `"copilot"` |
| `promptDelivery` | `"post-launch"` | `"inline"` (use `-i`) | `"inline"` (use `-i`) |
| `getLaunchCommand` | `claude [flags]` | `gemini -i <prompt> [flags]` | `copilot -i <prompt> [flags]` |
| `getEnvironment` | `CLAUDECODE=""` | `AO_SESSION_ID` | `AO_SESSION_ID`, `COPILOT_AUTO_UPDATE=false` |
| `detectActivity` | Terminal patterns | Terminal patterns | Terminal patterns |
| `getActivityState` | Native JSONL | AO activity JSONL + session mtime | Hybrid: native JSONL + AO activity JSONL |
| `isProcessRunning` | ps cache + regex | ps cache + node args match | ps cache + regex (native binary) |
| `getSessionInfo` | JSONL tail parse | Session JSON parse | events.jsonl parse |
| `getRestoreCommand` | `claude --resume <uuid>` | `gemini -r <uuid>` | `copilot --resume=<id>` |
| `setupWorkspaceHooks` | `.claude/settings.json` hook | PATH wrappers only | PATH wrappers only |
| `postLaunchSetup` | Re-ensure hooks | (none needed) | (none needed) |
| `recordActivity` | Not implemented (native JSONL) | Yes (AO JSONL pattern) | Optional (has native JSONL) |

### 4.3 Data Source Comparison

| Data | Claude Code | Gemini CLI | Copilot CLI |
|------|-------------|------------|-------------|
| Session files | `~/.claude/projects/{path}/{uuid}.jsonl` | `~/.gemini/tmp/{project}/chats/session-*.json` | `~/.copilot/session-state/{uuid}/events.jsonl` |
| Session list | Glob JSONL files by mtime | `gemini --list-sessions` or glob JSON files | Glob session-state dirs, read workspace.yaml |
| Activity | Last JSONL entry type + mtime | Session JSON `lastUpdated` + AO JSONL | Last events.jsonl entry type + timestamp |
| Cost/tokens | JSONL `costUSD`/`usage` fields | Session JSON `tokens` per message | events.jsonl `outputTokens` + shutdown `modelMetrics` |
| Summary | JSONL `summary` type entry | First user message from session JSON | workspace.yaml `summary` field |
| Session ID | JSONL filename (UUID) | Session JSON `sessionId` (UUID) | Directory name (UUID) |
| Branch/repo | N/A (metadata file) | N/A (PATH wrappers) | workspace.yaml `branch`, `repository` |

---

## 5. Implementation Plan

### 5.1 Gemini CLI Plugin (`agent-gemini`)

**Estimated complexity: Medium** (~350 lines, similar to Aider plugin)

Gemini uses the AO Activity JSONL pattern (no native streaming event log),
so it follows the Aider/OpenCode template.

#### Package setup
```
packages/plugins/agent-gemini/
  package.json          # @aoagents/ao-plugin-agent-gemini
  tsconfig.json
  src/
    index.ts            # Main implementation
    __tests__/
      index.test.ts
      activity-detection.test.ts
```

#### Implementation details

**`getLaunchCommand`:**
```typescript
// gemini -i <prompt> --approval-mode yolo --model <model>
const parts = ["gemini"];
if (config.prompt) parts.push("-i", shellEscape(config.prompt));
if (permissionMode === "permissionless") parts.push("--approval-mode", "yolo");
else if (permissionMode === "auto-edit") parts.push("--approval-mode", "auto_edit");
if (config.model) parts.push("-m", shellEscape(config.model));
if (config.systemPromptFile) {
  // Gemini doesn't have a direct system prompt flag — use policy file or
  // write to GEMINI.md in the workspace
}
```

**System prompt challenge:** Gemini CLI doesn't have a `--system-prompt` or
`--append-system-prompt` flag. Options:
1. Write to `GEMINI.md` in the workspace directory.
2. Use `--policy <file>` to load additional instructions.
3. Prefix the prompt with system instructions.

Option 1 (GEMINI.md) is cleanest — Gemini auto-loads this file from the workspace.

**`getActivityState`:** AO Activity JSONL pattern with session mtime fallback.
```
1. Process check → exited
2. checkActivityLogState() → waiting_input/blocked
3. Stat session JSON for lastUpdated timestamp → active/ready/idle by age
4. getActivityFallbackState() → final fallback
```

**`getSessionInfo`:**
- Read session JSON files from `~/.gemini/tmp/{project}/chats/`
- Project name from `~/.gemini/projects.json` (lookup by workspace path)
- Extract first user message as summary (120 char truncated)
- Aggregate token counts from message `tokens` fields
- Session ID from `sessionId` field in JSON

**`getRestoreCommand`:**
```typescript
// gemini -r <sessionId> [--approval-mode yolo] [-m model]
// Need to find session index or use UUID
```
Note: `gemini -r` takes an index number or "latest", not a UUID.
The plugin needs to either use `--list-sessions` to find the index, or
check if UUID-based resume is supported.

**`isProcessRunning`:**
Gemini is a Node.js CLI — needs to match against full command args:
```typescript
const processRe = /(?:gemini-cli\/dist\/index\.js|(?:^|\/)gemini(?:\s|$))/;
```

**`recordActivity` + `detectActivity`:**
Standard AO pattern using `recordTerminalActivity()`.

#### Key challenges
1. **System prompt delivery** — No `--system-prompt` flag; must use GEMINI.md.
2. **Session resume by UUID** — May need index-based lookup.
3. **Process detection** — Node.js binary requires matching command args.
4. **No native JSONL** — Must rely on AO Activity JSONL for real-time detection.
5. **Project name discovery** — Must read `~/.gemini/projects.json` to find session files.

### 5.2 Copilot CLI Plugin (`agent-copilot`)

**Estimated complexity: Medium-High** (~500-600 lines, similar to Claude Code plugin)

Copilot has native JSONL events — it follows the Claude Code template with
direct JSONL reading for activity detection.

#### Package setup
```
packages/plugins/agent-copilot/
  package.json          # @aoagents/ao-plugin-agent-copilot
  tsconfig.json
  src/
    index.ts            # Main implementation
    __tests__/
      index.test.ts
      activity-detection.test.ts
```

#### Implementation details

**`getLaunchCommand`:**
```typescript
// copilot -i <prompt> --allow-all --model <model> --no-ask-user
const parts = ["copilot"];
if (config.prompt) parts.push("-i", shellEscape(config.prompt));
if (permissionMode === "permissionless") parts.push("--allow-all", "--no-ask-user");
else if (permissionMode === "auto-edit") parts.push("--allow-tool=write", "--allow-tool='shell(git:*)'");
if (config.model) parts.push("--model", shellEscape(config.model));
parts.push("--no-auto-update"); // Prevent update prompts during agent execution
```

**System prompt delivery:**
Copilot supports custom instructions via:
1. `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` env var pointing to a dir with AGENTS.md.
2. Writing to `.github/copilot-instructions.md` in the workspace.
3. The shared `.ao/AGENTS.md` file (already created by `setupPathWrapperWorkspace()`).

Option 3 is already handled by the PATH wrapper setup — Copilot will auto-discover
the `AGENTS.md` file in `.ao/`.

**`getActivityState`:** Hybrid approach (native JSONL + AO Activity JSONL).

**Verified behavior:** events.jsonl has a ~15-18s flush delay and does NOT contain
`waiting_input` events. Permission prompts only appear in terminal output (TUI dialogs).

```
1. Process check → exited
2. Check AO activity JSONL (checkActivityLogState) → waiting_input/blocked
3. Find session dir, read last events.jsonl entry using readLastJsonlEntry()
4. Map event types:
   - user.message, assistant.turn_start, tool.execution_start → active (if fresh)
   - assistant.message (final_answer), assistant.turn_end → ready (by age)
   - tool.execution_complete (success=false) → blocked
   - session.shutdown → exited
5. Age-based decay: active → ready → idle
6. Fallback: getActivityFallbackState() from AO activity JSONL
```

**Session directory discovery:**
```typescript
async function findCopilotSessionDir(workspacePath: string): Promise<string | null> {
  const sessionsDir = join(homedir(), ".copilot", "session-state");
  // Read each session's workspace.yaml, match by cwd or git_root
  // Return most recently modified match
  // IMPORTANT: Cache this mapping — scanning all dirs every poll is expensive
}
```

**`recordActivity`:** Required (unlike Claude Code). Delegates to `recordTerminalActivity()`
to capture terminal permission prompts that events.jsonl doesn't log.

**`getSessionInfo`:**
- Read `workspace.yaml` for summary and session ID
- Parse `events.jsonl` tail for token usage
- Look for `session.shutdown` event for aggregate metrics
- Session ID is the directory name (UUID)

**`getRestoreCommand`:**
```typescript
// copilot --resume=<sessionId> --allow-all --model <model>
const parts = ["copilot", `--resume=${shellEscape(sessionUuid)}`];
// Also can use: copilot --resume="session name" (if named)
```

**`isProcessRunning`:**
Copilot is a native binary — straightforward:
```typescript
const processRe = /(?:^|\/)copilot(?:\s|$)/;
```

**`detectActivity`:** Terminal patterns for fallback.
```typescript
// Copilot uses similar patterns to Claude Code
// Prompt: "> " or "$ "
// Permission: "Allow?", "(y/n)", etc.
```

#### Key challenges (verified by testing)
1. **events.jsonl flush delay (~15-18s)** — File appears late and updates in batches, not per-event. The plugin must handle the window where events.jsonl doesn't exist yet.
2. **No waiting_input in JSONL** — Permission prompts are TUI-only (terminal output). Must implement `recordActivity()` + `detectActivity()` for waiting_input/blocked, making this a **hybrid** approach (not pure native JSONL like Claude Code).
3. **Session directory discovery** — Must scan `~/.copilot/session-state/` and match by workspace path in `workspace.yaml`. Needs caching.
4. **Cost model** — Copilot is subscription-based; report token counts and premium request counts, not USD.
5. **events.jsonl can be large** — Same tail-reading optimization as Claude needed.
6. **Folder trust prompt** — Copilot prompts for folder trust on first use. The plugin should either pre-trust the folder (add to `~/.copilot/config.json` `trustedFolders`) or use `--allow-all-paths`.

### 5.3 Priority & Dependencies

**Recommended build order:**

1. **Copilot CLI first** — It has native JSONL (richer data, better activity detection),
   large user base, and the implementation pattern is closest to the proven Claude Code plugin.

2. **Gemini CLI second** — Simpler implementation (AO Activity JSONL pattern), but less
   rich data for activity detection and cost tracking.

**Shared work before both:**
- No new core changes needed — all utilities (`readLastJsonlEntry`, `shellEscape`,
  `recordTerminalActivity`, `setupPathWrapperWorkspace`, etc.) already exist.
- Both plugins use PATH wrappers (no new hook mechanisms needed).

### 5.4 Testing Requirements

Per CLAUDE.md, every agent plugin must test:

| Test Case | Gemini | Copilot |
|-----------|--------|---------|
| Returns `exited` when process not running | Yes | Yes |
| Returns `waiting_input` from JSONL | Yes (AO JSONL) | Yes (native JSONL) |
| Returns `blocked` from JSONL | Yes (AO JSONL) | Yes (native JSONL) |
| Returns `active` from native signal | Yes (session mtime) | Yes (events.jsonl) |
| Returns `active` from JSONL fallback | Yes | Yes |
| Returns `idle` from JSONL fallback (old entry) | Yes | Yes |
| Returns `null` when no data | Yes | Yes |
| `detect()` finds binary | Yes | Yes |
| `getLaunchCommand()` builds correct flags | Yes | Yes |
| `getRestoreCommand()` finds session | Yes | Yes |
| `getSessionInfo()` extracts summary + tokens | Yes | Yes |
| Permission mode mapping | Yes | Yes |

### 5.5 Estimated Effort

| Task | Lines | Complexity |
|------|-------|------------|
| `agent-gemini` plugin | ~350 | Medium |
| `agent-gemini` tests | ~250 | Medium |
| `agent-copilot` plugin | ~550 | Medium-High |
| `agent-copilot` tests | ~400 | Medium-High |
| Integration testing | ~100 | Low |
| Documentation updates | ~50 | Low |
| **Total** | **~1700** | |

### 5.6 Open Questions

1. **Gemini session resume by UUID:** Does `gemini -r <uuid>` work, or only index-based?
   Need to test. If index-only, the plugin needs to run `gemini --list-sessions` to
   find the right index, which is fragile.

2. **Gemini system prompt delivery:** The `--policy` flag might be more appropriate than
   writing to GEMINI.md. Need to test whether policy files can contain general instructions
   or only tool-approval rules.

3. **Copilot authentication:** In AO's managed environment, will Copilot's auth tokens
   be available? Need to ensure `GH_TOKEN` or `COPILOT_GITHUB_TOKEN` is set.

4. **Copilot BYOK mode:** Should the plugin support `COPILOT_PROVIDER_*` env vars for
   custom model providers? This would make Copilot a universal agent adapter.

5. **Gemini API key propagation:** How should `GEMINI_API_KEY` be configured in AO?
   Should it be in `agent-orchestrator.yaml` or inherited from the environment?

6. **OTel as activity source:** Should the Copilot plugin use OTel file export as an
   alternative to events.jsonl parsing? OTel provides richer data (spans, metrics)
   but adds complexity and an env var requirement.
