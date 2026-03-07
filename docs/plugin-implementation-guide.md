# Plugin Implementation Guide — Complete Reference

> **Date**: 2026-02-25
> **Purpose**: Definitive implementation reference for every plugin identified across distillation research and industry catalog analysis. Each entry includes interface mapping, config/auth, SDK, API details, proof of working implementations, and distillation sources.

---

## Table of Contents

1. [Universal Plugin Pattern](#universal-plugin-pattern)
2. [Agent Plugins (12 new)](#agent-plugins)
3. [Runtime Plugins (12 new)](#runtime-plugins)
4. [Tracker Plugins (10 new)](#tracker-plugins)
5. [SCM Plugins (5 new)](#scm-plugins)
6. [Notifier Plugins (13 new)](#notifier-plugins)
7. [Terminal Plugins (6 new)](#terminal-plugins)
8. [Workspace Plugins (5 new)](#workspace-plugins)
9. [Cross-Cutting Enhancements (6 new)](#cross-cutting-enhancements)
10. [Existing Plugin Upgrades](#existing-plugin-upgrades)
11. [Phased Roadmap](#phased-roadmap)

---

## Summary: 69 New Plugins + 4 Upgrades

| Slot | Currently Have | New Identified | Total Possible |
|------|---------------|---------------|----------------|
| **Agent** | 4 (claude-code, codex, aider, opencode) | 12 | 16 |
| **Runtime** | 2 (tmux, process) | 12 | 14 |
| **Tracker** | 2 (github, linear) | 10 | 12 |
| **SCM** | 1 (github) | 5 | 6 |
| **Notifier** | 4 (desktop, slack, composio, webhook) | 13 | 17 |
| **Terminal** | 2 (iterm2, web) | 6 | 8 |
| **Workspace** | 2 (worktree, clone) | 5 | 7 |
| **Cross-cutting** | 0 | 6 | 6 |
| **TOTAL** | **17** | **69** | **86** |

---

## Universal Plugin Pattern

Every plugin MUST follow this structure. All existing plugins in `packages/plugins/` use this exact pattern.

### File Structure

```
packages/plugins/{slot}-{name}/
  package.json
  tsconfig.json
  src/
    index.ts         # manifest + create() + default export
  __tests__/
    index.test.ts    # vitest tests
```

### package.json Template

```json
{
  "name": "@composio/ao-{slot}-{name}",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "scripts": { "build": "tsc", "test": "vitest run" },
  "dependencies": { "@composio/ao-core": "workspace:*" },
  "devDependencies": { "@types/node": "^20.0.0", "typescript": "^5.5.0", "vitest": "^2.0.0" }
}
```

### Export Pattern (MUST follow — compile-time type checking)

```typescript
import type { PluginModule, InterfaceType } from "@composio/ao-core";

export const manifest = {
  name: "plugin-name",
  slot: "slot-name" as const,
  description: "Slot plugin: description",
  version: "0.1.0",
};

export function create(config?: Record<string, unknown>): InterfaceType {
  // implementation
}

// CRITICAL: inline satisfies — never a separate variable
export default { manifest, create } satisfies PluginModule<InterfaceType>;
```

### Key Rules

| Rule | Why |
|------|-----|
| ESM modules with `.js` extensions in imports | Runtime requirement for ESM |
| `node:` prefix for builtins | Project convention |
| `execFile` only — NEVER `exec` | Shell injection prevention |
| `{ timeout: 30_000 }` on all external calls | Prevent hung processes |
| Auth via env vars — never in config files | Security |
| No external HTTP libs — use `fetch` or `node:https` | Minimize dependencies |
| `satisfies PluginModule<T>` inline on default export | Compile-time type checking |

**Proven by**: Every existing plugin follows this pattern — see `packages/plugins/agent-claude-code/src/index.ts`, `packages/plugins/runtime-tmux/src/index.ts`, `packages/plugins/notifier-slack/src/index.ts`.

---

## Agent Plugins

All agent plugins implement the `Agent` interface from `packages/core/src/types.ts`.

### Interface Methods

| Method | Required | Description |
|--------|----------|-------------|
| `name` | Yes | Readonly identifier |
| `processName` | Yes | Process name for `ps` detection |
| `getLaunchCommand(config)` | Yes | Shell command to start the agent |
| `getEnvironment(config)` | Yes | Env vars for the agent process |
| `detectActivity(terminalOutput)` | Yes | Classify terminal output → `ActivityState` |
| `getActivityState(session, thresholdMs)` | Yes | Native activity detection (JSONL/SQLite) |
| `isProcessRunning(handle)` | Yes | Check process alive via tmux TTY + `ps` |
| `getSessionInfo(session)` | Yes | Extract summary, cost, session ID |
| `getRestoreCommand?(session, project)` | Optional | Resume previous session |
| `setupWorkspaceHooks?(workspacePath, config)` | Optional | Install metadata-updating hooks |
| `postLaunchSetup?(session)` | Optional | Post-launch config |

### Common Agent Integration Pattern

All CLI agents share this integration shape (proven by our 4 existing agents):
- **Headless flag** → maps to `config.prompt` (non-interactive mode)
- **Auto-approve flag** → maps to `config.permissions === "skip"`
- **Model flag** → maps to `config.model`
- **System prompt flag** → maps to `config.systemPrompt`
- **Process exit** → task complete
- **Process detection** → `ps -eo pid,tty,args` with word-boundary regex on `processName`

Reference implementations:
- `packages/plugins/agent-claude-code/src/index.ts` — `getLaunchCommand()` at line ~586
- `packages/plugins/agent-codex/src/index.ts` — `getLaunchCommand()` at line ~282
- Tests: `packages/plugins/agent-claude-code/src/index.test.ts` lines 150-188 validate flag generation

---

### 1. `agent-gemini` — Google Gemini CLI

| Field | Value |
|-------|-------|
| **Priority** | P0 — High Impact |
| **Package** | `@composio/ao-agent-gemini` |
| **Stars** | 94k |
| **Install** | `npm i -g @google/gemini-cli` |
| **Process name** | `gemini` |
| **Headless flag** | `-p` (prompt mode, non-interactive) |
| **Auto-approve** | `--yolo` (skip all permission prompts) |
| **Model flag** | `--model <model>` |
| **JSON output** | `--output-format json` |
| **System prompt** | `--system-instruction "..."` |
| **Effort** | Low |
| **Confidence** | HIGH |

**Proof of working integration:**
- [Frayo44/agent-view](https://github.com/Frayo44/agent-view) (112 stars) — working TUI that orchestrates Gemini CLI alongside Claude Code, Codex, and OpenCode in tmux sessions. Validates that Gemini CLI works in orchestrated tmux environments with terminal output monitoring.
- [hoangsonww/AI-Agents-Orchestrator](https://github.com/hoangsonww/AI-Agents-Orchestrator) — includes Gemini as a provider with fallback patterns.
- The `-p` flag mirrors our own Claude Code plugin's prompt flag (`packages/plugins/agent-claude-code/src/index.ts` line 609: `parts.push("-p", shellEscape(config.prompt))`).

**Launch command implementation:**
```typescript
getLaunchCommand(config: AgentLaunchConfig): string {
  const parts = ["gemini"];
  if (config.permissions === "skip") parts.push("--yolo");
  if (config.model) parts.push("--model", config.model);
  if (config.systemPrompt) {
    parts.push("--system-instruction", shellEscape(config.systemPrompt));
  }
  if (config.prompt) parts.push("-p", shellEscape(config.prompt));
  return parts.join(" ");
}
```

**Activity detection:**
- Terminal output: look for `❯` or `gemini>` prompt → `"ready"`, permission text → `"waiting_input"`, else `"active"`
- Native: Gemini CLI stores session data in `~/.gemini/sessions/` — parse for last activity timestamp

**Environment:**
```typescript
getEnvironment(config: AgentLaunchConfig): Record<string, string> {
  return {
    AO_SESSION_ID: config.sessionId,
    ...(config.issueId ? { AO_ISSUE_ID: config.issueId } : {}),
  };
}
```

**Config (agent-orchestrator.yaml):**
```yaml
defaults:
  agent: gemini
projects:
  my-app:
    agent: gemini
    agentConfig:
      permissions: skip
      model: gemini-2.5-pro
```

**Distillation sources:**
- [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) — official repo, CLI flags reference
- [Frayo44/agent-view](https://github.com/Frayo44/agent-view) — validates multi-agent tmux orchestration
- [hoangsonww/AI-Agents-Orchestrator](https://github.com/hoangsonww/AI-Agents-Orchestrator) — Gemini provider with fallback

---

### 2. `agent-cline` — Cline CLI

| Field | Value |
|-------|-------|
| **Priority** | P0 |
| **Package** | `@composio/ao-agent-cline` |
| **Stars** | 57k |
| **Install** | `npm i -g cline` |
| **Process name** | `cline` |
| **Headless flag** | `-y` (auto-accept) |
| **Auto-approve** | `--yolo` |
| **JSON output** | `--json` |
| **Effort** | Low |
| **Confidence** | MEDIUM — Cline is primarily a VS Code extension; standalone CLI availability needs verification at implementation time |

**Launch command:**
```typescript
getLaunchCommand(config: AgentLaunchConfig): string {
  const parts = ["cline"];
  if (config.permissions === "skip") parts.push("--yolo");
  if (config.model) parts.push("--model", config.model);
  if (config.prompt) parts.push("-y", shellEscape(config.prompt));
  return parts.join(" ");
}
```

**Implementation note:** Verify the actual npm package name and CLI binary name at implementation time. Cline originated as a VS Code extension (`cline/cline`). A standalone CLI may be available under a different package name.

**Distillation sources:**
- [cline/cline](https://github.com/cline/cline) — official repo (57k stars)

---

### 3. `agent-copilot` — GitHub Copilot CLI

| Field | Value |
|-------|-------|
| **Priority** | P0 |
| **Package** | `@composio/ao-agent-copilot` |
| **Install** | `gh extension install github/copilot-cli` |
| **Process name** | `copilot` |
| **Headless flag** | `-p` |
| **Auto-approve** | `--allow-all-tools` |
| **JSON output** | Partial |
| **Effort** | Low |
| **Confidence** | MEDIUM — `gh copilot suggest/explain` confirmed non-interactive; full agentic loop less certain |

**Key difference:** Installed as a `gh` extension. Process detection may need to match `gh copilot` or `copilot` depending on invocation.

**Auth:** Uses `gh auth` OAuth token — already configured if user has `gh` CLI.

**Launch command:**
```typescript
getLaunchCommand(config: AgentLaunchConfig): string {
  const parts = ["gh", "copilot"];
  if (config.permissions === "skip") parts.push("--allow-all-tools");
  if (config.prompt) parts.push("-p", shellEscape(config.prompt));
  return parts.join(" ");
}
```

**Distillation sources:**
- [GitHub Copilot CLI docs](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line)

---

### 4. `agent-goose` — Block Goose Agent

| Field | Value |
|-------|-------|
| **Priority** | P0 |
| **Package** | `@composio/ao-agent-goose` |
| **Stars** | 27k |
| **Install** | `brew install block/tap/goose` |
| **Process name** | `goose` |
| **Headless flag** | `run -t "task"` (non-interactive by design) |
| **Auto-approve** | N/A (task mode is fully autonomous) |
| **JSON output** | Session list supports JSON |
| **Effort** | Low |
| **Confidence** | HIGH |

**Proof of working integration:**
- [awslabs/cli-agent-orchestrator](https://github.com/awslabs/cli-agent-orchestrator) — has a working provider for Goose with regex-based status detection.
- Goose's `run -t` is inherently non-interactive — it runs the task to completion without prompts.

**Launch command:**
```typescript
getLaunchCommand(config: AgentLaunchConfig): string {
  const parts = ["goose", "run"];
  if (config.prompt) parts.push("-t", shellEscape(config.prompt));
  return parts.join(" ");
}
```

**Distillation sources:**
- [block/goose](https://github.com/block/goose) — official repo (27k stars)
- [awslabs/cli-agent-orchestrator](https://github.com/awslabs/cli-agent-orchestrator) — working provider integration

---

### 5. `agent-continue` — Continue Dev CLI

| Field | Value |
|-------|-------|
| **Priority** | P1 |
| **Package** | `@composio/ao-agent-continue` |
| **Stars** | 31.5k |
| **Install** | `npm i -g @continuedev/cli` |
| **Process name** | `continue` |
| **Headless flag** | `-p` |
| **Auto-approve** | `--auto` |
| **JSON output** | `--format json` |
| **Effort** | Low |
| **Confidence** | LOW — Continue is primarily an IDE extension; standalone CLI needs verification |

**Distillation sources:**
- [continuedev/continue](https://github.com/continuedev/continue) — official repo (31.5k stars)

---

### 6. `agent-kiro` — AWS Kiro CLI

| Field | Value |
|-------|-------|
| **Priority** | P1 |
| **Package** | `@composio/ao-agent-kiro` |
| **Stars** | 3k |
| **Install** | `npm i -g kiro-cli` |
| **Process name** | `kiro` |
| **Headless flag** | `--no-interactive` |
| **Auto-approve** | `--trust-all-tools` |
| **JSON output** | No |
| **Effort** | Low |
| **Confidence** | HIGH — CAO has a working provider with regex status detection |

**Proof of working integration:**
- [awslabs/cli-agent-orchestrator](https://github.com/awslabs/cli-agent-orchestrator) (256 stars, Apache-2.0) — **production AWS Labs repo** with a working Kiro provider. Implements regex-based status detection to classify terminal output into 5 states: IDLE, PROCESSING, COMPLETED, WAITING_USER_ANSWER, ERROR.
- CAO's provider system architecture (four-layer: entry points → services → provider system → clients) validates that Kiro CLI works in tmux-based orchestrated environments.

**Activity detection pattern (from CAO):**
```typescript
// Regex-based status detection distilled from awslabs/cli-agent-orchestrator
const KIRO_PATTERNS = {
  IDLE: /kiro>\s*$/,
  PROCESSING: /\.\.\.|thinking|generating/i,
  WAITING: /\[y\/n\]|confirm|approve/i,
  ERROR: /error:|exception:|failed/i,
  COMPLETED: /completed|done|task finished/i,
};

detectActivity(terminalOutput: string): ActivityState {
  const lastLines = terminalOutput.split("\n").slice(-5).join("\n");
  if (KIRO_PATTERNS.WAITING.test(lastLines)) return "waiting_input";
  if (KIRO_PATTERNS.ERROR.test(lastLines)) return "blocked";
  if (KIRO_PATTERNS.IDLE.test(lastLines)) return "ready";
  if (KIRO_PATTERNS.PROCESSING.test(lastLines)) return "active";
  return "active";
}
```

**Launch command:**
```typescript
getLaunchCommand(config: AgentLaunchConfig): string {
  const parts = ["kiro", "--no-interactive"];
  if (config.permissions === "skip") parts.push("--trust-all-tools");
  if (config.prompt) parts.push(shellEscape(config.prompt));
  return parts.join(" ");
}
```

**Distillation sources:**
- [awslabs/cli-agent-orchestrator](https://github.com/awslabs/cli-agent-orchestrator) — working provider with regex detection
- [AWS Blog: Introducing CLI Agent Orchestrator](https://aws.amazon.com/blogs/opensource/introducing-cli-agent-orchestrator-transforming-developer-cli-tools-into-a-multi-agent-powerhouse/)

---

### 7. `agent-amazon-q` — Amazon Q Developer CLI

| Field | Value |
|-------|-------|
| **Priority** | P1 |
| **Package** | `@composio/ao-agent-amazon-q` |
| **Stars** | 4.5k |
| **Install** | `brew install amazon-q` |
| **Process name** | `q` |
| **Headless flag** | `--no-interactive` |
| **Auto-approve** | `--trust-all-tools` |
| **JSON output** | No |
| **Effort** | Low |
| **Confidence** | HIGH — CAO has a working provider (same team, same company) |

**Proof of working integration:**
- [awslabs/cli-agent-orchestrator](https://github.com/awslabs/cli-agent-orchestrator) — **same AWS Labs team** ships a working Q CLI provider. This is the strongest possible proof — the orchestrator and the agent are from the same organization.
- CAO detects 5 states from Q CLI terminal output: IDLE, PROCESSING, COMPLETED, WAITING_USER_ANSWER, ERROR.
- Uses Watchdog filesystem observers on terminal logs for idle detection.

**Activity detection pattern (from CAO):**
```typescript
const Q_PATTERNS = {
  IDLE: />\s*$|q>\s*$/,
  PROCESSING: /thinking|generating|\.\.\./i,
  COMPLETED: /completed|done|finished/i,
  WAITING: /\[y\/n\]|confirm|approve/i,
  ERROR: /error:|exception:|failed/i,
};
```

**Launch command:**
```typescript
getLaunchCommand(config: AgentLaunchConfig): string {
  const parts = ["q", "chat", "--no-interactive"];
  if (config.permissions === "skip") parts.push("--trust-all-tools");
  if (config.prompt) parts.push(shellEscape(config.prompt));
  return parts.join(" ");
}
```

**Distillation sources:**
- [awslabs/cli-agent-orchestrator](https://github.com/awslabs/cli-agent-orchestrator) — working Q CLI provider
- [DeepWiki: CAO architecture](https://deepwiki.com/awslabs/cli-agent-orchestrator)

---

### 8. `agent-cursor` — Cursor CLI

| Field | Value |
|-------|-------|
| **Priority** | P2 |
| **Package** | `@composio/ao-agent-cursor` |
| **Stars** | 32k |
| **Install** | Ships with Cursor IDE |
| **Process name** | `cursor` |
| **Headless flag** | `-p` |
| **Auto-approve** | `--trust` |
| **JSON output** | `--output-format json` |
| **Effort** | Low |
| **Confidence** | MEDIUM |

**Launch command:**
```typescript
getLaunchCommand(config: AgentLaunchConfig): string {
  const parts = ["cursor"];
  if (config.permissions === "skip") parts.push("--trust");
  if (config.model) parts.push("--model", config.model);
  if (config.prompt) parts.push("-p", shellEscape(config.prompt));
  return parts.join(" ");
}
```

---

### 9. `agent-auggie` — Augment Code CLI

| Field | Value |
|-------|-------|
| **Priority** | P2 |
| **Package** | `@composio/ao-agent-auggie` |
| **Stars** | 143 |
| **Install** | `npm i -g @augmentcode/auggie` |
| **Process name** | `auggie` |
| **Headless flag** | `--print` |
| **Auto-approve** | `--quiet` |
| **Effort** | Low |
| **Confidence** | MEDIUM |

---

### 10. `agent-trae` — ByteDance Trae Agent

| Field | Value |
|-------|-------|
| **Priority** | P2 |
| **Package** | `@composio/ao-agent-trae` |
| **Stars** | 10k |
| **Install** | `pip install trae-agent` |
| **Process name** | `trae-cli` |
| **Headless flag** | `trae-cli run "task"` |
| **Auto-approve** | N/A |
| **Effort** | Low |
| **Confidence** | MEDIUM |

**Key difference:** Python-based. Process detection regex needs to match `trae-cli` or `python.*trae`.

---

### 11. `agent-openhands` — OpenHands (formerly OpenDevin)

| Field | Value |
|-------|-------|
| **Priority** | P2 |
| **Package** | `@composio/ao-agent-openhands` |
| **Stars** | 65k |
| **Install** | `pip install openhands` |
| **Process name** | `openhands` |
| **Headless flag** | `--headless -t` |
| **Auto-approve** | N/A (headless = fully autonomous) |
| **JSON output** | `--json` |
| **Effort** | Low |
| **Confidence** | HIGH — OpenHands is well-documented for headless server/CI usage |

---

### 12. `agent-amp` — Sourcegraph Amp

| Field | Value |
|-------|-------|
| **Priority** | P2 |
| **Package** | `@composio/ao-agent-amp` |
| **Install** | `npm i -g @sourcegraph/amp` |
| **Process name** | `amp` |
| **Headless flag** | `-x` |
| **Auto-approve** | `--dangerously-allow-all` |
| **JSON output** | No |
| **Effort** | Low |
| **Confidence** | HIGH — validated by sandboxed.sh |

**Proof of working integration:**
- [Th0rgal/openagent](https://github.com/Th0rgal/openagent) (sandboxed.sh, 252 stars) — self-hosted orchestrator with systemd-nspawn isolation that **supports Claude Code, OpenCode, and Amp**. Confirms Amp works in orchestrated non-interactive environments.

**Distillation sources:**
- [Th0rgal/openagent](https://github.com/Th0rgal/openagent) — validates Amp in sandboxed orchestration

---

## Runtime Plugins

All implement the `Runtime` interface from `packages/core/src/types.ts`.

### Interface Methods

| Method | Required | Description |
|--------|----------|-------------|
| `name` | Yes | Readonly identifier |
| `create(config)` | Yes | Create session env → `RuntimeHandle` |
| `destroy(handle)` | Yes | Tear down session env |
| `sendMessage(handle, message)` | Yes | Send text to running agent |
| `getOutput(handle, lines?)` | Yes | Capture recent output |
| `isAlive(handle)` | Yes | Check if session is running |
| `getMetrics?(handle)` | Optional | Uptime, memory, CPU |
| `getAttachInfo?(handle)` | Optional | Info for Terminal plugin |

Reference: `packages/plugins/runtime-tmux/src/index.ts`

---

### 1. `runtime-docker` — Docker Container Runtime

| Field | Value |
|-------|-------|
| **Priority** | P0 |
| **Package** | `@composio/ao-runtime-docker` |
| **Type** | Container |
| **Startup** | ~500ms |
| **Cost** | Free (self-hosted) |
| **npm SDK** | `dockerode` (optional — can use `execFile("docker", ...)`) |
| **Effort** | Medium |

**Interface mapping:**
```typescript
create(config): Promise<RuntimeHandle> {
  // docker create --name {sessionId} -w /workspace -v {workspacePath}:/workspace
  //   -e KEY=VALUE... {image} sleep infinity
  // docker start {sessionId}
  // docker exec -d {sessionId} sh -c "{launchCommand}"
  return { id: containerId, runtimeName: "docker", data: { createdAt, image } };
}

destroy(handle): Promise<void> {
  // docker rm -f {handle.id}
}

sendMessage(handle, message): Promise<void> {
  // Write to temp file, docker cp into container, pipe to agent stdin
}

getOutput(handle, lines?): Promise<string> {
  // docker logs --tail {lines} {handle.id}
}

isAlive(handle): Promise<boolean> {
  // docker inspect --format '{{.State.Running}}' {handle.id}
}

getMetrics(handle): Promise<RuntimeMetrics> {
  // docker stats --no-stream --format '{{json .}}' {handle.id}
}

getAttachInfo(handle): Promise<AttachInfo> {
  return { type: "docker", target: handle.id, command: `docker exec -it ${handle.id} bash` };
}
```

**Security:**
- All docker commands via `execFile("docker", [...args])` — never `exec`
- Container name validated against `/^[a-zA-Z0-9_-]+$/`
- Optional: `--network=none` for airgapped, configurable egress rules

**Config:**
```yaml
defaults:
  runtime: docker
projects:
  my-app:
    runtime: docker
    runtimeConfig:
      image: node:20-slim
      network: bridge
      memory: 4g
```

**Proof of working pattern:**
- [alibaba/OpenSandbox](https://github.com/alibaba/OpenSandbox) (1.1k stars) — production Docker runtime with Lifecycle API (create/start/stop/delete) + Execution API (commands/run, files/read). TypeScript SDK available. Validates Docker container management for agent workloads.
- [docker/cagent](https://github.com/docker/cagent) (2k stars) — Docker's own agent framework using containers. OCI distribution model.

**Distillation sources:**
- [alibaba/OpenSandbox](https://github.com/alibaba/OpenSandbox) — two-tier API maps to our Runtime interface
- [docker/cagent](https://github.com/docker/cagent) — Docker-native agent framework
- [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad) — tmux+docker hybrid

---

### 2. `runtime-e2b` — E2B Firecracker VM

| Field | Value |
|-------|-------|
| **Priority** | P0 |
| **Package** | `@composio/ao-runtime-e2b` |
| **Type** | Firecracker microVM |
| **Startup** | ~150ms |
| **Cost** | ~$0.10/hr |
| **npm SDK** | `e2b` (official, well-maintained) |
| **Effort** | Low |

**Interface mapping:**
```typescript
import { Sandbox } from "e2b";

create(config): Promise<RuntimeHandle> {
  const sandbox = await Sandbox.create({ template: "base" });
  await sandbox.commands.run(config.launchCommand);
  return { id: sandbox.sandboxId, runtimeName: "e2b", data: { sandboxId: sandbox.sandboxId } };
}

destroy(handle): Promise<void> {
  const sandbox = await Sandbox.connect(handle.data.sandboxId as string);
  await sandbox.kill();
}

sendMessage(handle, message): Promise<void> {
  const sandbox = await Sandbox.connect(handle.data.sandboxId as string);
  await sandbox.commands.run(`echo '...' | ...`); // pipe to agent
}

getOutput(handle, lines?): Promise<string> {
  const sandbox = await Sandbox.connect(handle.data.sandboxId as string);
  const result = await sandbox.commands.run("tail -n " + (lines ?? 50) + " /tmp/agent.log");
  return result.stdout;
}

isAlive(handle): Promise<boolean> {
  try { await Sandbox.connect(handle.data.sandboxId as string); return true; }
  catch { return false; }
}
```

**Auth:** `E2B_API_KEY` environment variable.

**Proof:** E2B is purpose-built for AI agent sandboxing. The `e2b` npm package is well-documented with `Sandbox.create()`, `sandbox.commands.run()`, `sandbox.files.read()` APIs.

**Distillation sources:**
- [E2B documentation](https://e2b.dev/docs) — official SDK, purpose-built for agents

---

### 3. `runtime-daytona` — Daytona Dev Environment

| Field | Value |
|-------|-------|
| **Priority** | P1 |
| **Package** | `@composio/ao-runtime-daytona` |
| **Type** | Container/VM |
| **Startup** | ~200ms |
| **Cost** | ~$0.10/hr |
| **npm SDK** | `@daytonaio/sdk` (official) |
| **Effort** | Low |

**Interface mapping:**
```typescript
import { Daytona } from "@daytonaio/sdk";

create(config): Promise<RuntimeHandle> {
  const daytona = new Daytona();
  const sandbox = await daytona.create({ language: "typescript" });
  await sandbox.process.start(config.launchCommand);
  return { id: sandbox.id, runtimeName: "daytona", data: { sandboxId: sandbox.id } };
}
```

**Auth:** `DAYTONA_API_KEY` environment variable.

---

### 4. `runtime-modal` — Modal gVisor Sandbox

| Field | Value |
|-------|-------|
| **Priority** | P1 |
| **Package** | `@composio/ao-runtime-modal` |
| **Startup** | 2-4s |
| **Cost** | ~$0.28/hr |
| **npm SDK** | `@modal-labs/sdk` (beta) |
| **Effort** | Medium |
| **Key feature** | GPU support for agents that need it |

**Auth:** `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET`.

---

### 5. `runtime-fly` — Fly.io Firecracker VM

| Field | Value |
|-------|-------|
| **Priority** | P2 |
| **Package** | `@composio/ao-runtime-fly` |
| **Startup** | <1s |
| **Cost** | ~$0.01-0.05/hr |
| **npm SDK** | `fly-machines-sdk` |
| **Effort** | Medium |

**Interface mapping via Machines REST API:**
```
POST   /v1/apps/{app}/machines           — create()
DELETE /v1/apps/{app}/machines/{id}       — destroy()
POST   /v1/apps/{app}/machines/{id}/exec  — sendMessage()/getOutput()
GET    /v1/apps/{app}/machines/{id}       — isAlive()
```

**Auth:** `FLY_API_TOKEN`.

---

### 6. `runtime-morph` — Morph VM with Snapshots

| Field | Value |
|-------|-------|
| **Priority** | P2 |
| **npm SDK** | `morph-typescript-sdk` |
| **Key feature** | Snapshot/branch model — instant spawn from pre-built snapshots |
| **Effort** | Medium |

---

### 7. `runtime-cloudflare` — Cloudflare Containers

| Field | Value |
|-------|-------|
| **Priority** | P2 |
| **Cost** | ~$0.07/hr active |
| **npm SDK** | `@cloudflare/sandbox-sdk` |
| **Effort** | Medium |

**Auth:** `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.

---

### 8. `runtime-opensandbox` — Alibaba OpenSandbox

| Field | Value |
|-------|-------|
| **Priority** | P2 |
| **Package** | `@composio/ao-runtime-opensandbox` |
| **Type** | Docker + K8s dual runtime |
| **Startup** | ~30s |
| **npm SDK** | TypeScript SDK available |
| **Effort** | Medium |

**Proof of working:**
- [alibaba/OpenSandbox](https://github.com/alibaba/OpenSandbox) (1.1k stars, Apache-2.0) — production sandbox platform by Alibaba. Clean two-tier HTTP API:
  - **Lifecycle API**: `POST /v1/sandboxes` (create), `DELETE /v1/sandboxes/{id}` (destroy), `POST /v1/sandboxes/{id}/pause` (cost savings), `POST /v1/sandboxes/{id}/resume`
  - **Execution API**: `POST /v1/sandboxes/{id}/commands/run` (sendMessage), `GET /v1/sandboxes/{id}/commands/{cid}` (getOutput), file read/write
- Docker backend for development, K8s backend for production
- Network egress controls (configurable allowed domains per sandbox)
- Pause/resume via CRIU for cost savings on idle sessions
- Multi-language SDKs (Python, TypeScript, Java)

**Interface mapping is the cleanest of all runtime options** — the two-tier API maps 1:1 to our Runtime interface.

---

### 9. `runtime-k8s-sandbox` — Kubernetes Agent Sandbox

| Field | Value |
|-------|-------|
| **Priority** | P3 |
| **Package** | `@composio/ao-runtime-k8s-sandbox` |
| **Type** | K8s CRD-based |
| **Startup** | <1s (warm pool) |
| **SDK** | Python SDK only (use kubectl/REST) |
| **Effort** | High |

**Proof of working:**
- [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) (1.1k stars) — **official Kubernetes SIG project**. Uses CRDs:
  - `Sandbox` — individual sandbox instance
  - `SandboxTemplate` — reusable config template
  - `SandboxClaim` — request for a sandbox (what our plugin creates)
  - `SandboxWarmPool` — pre-provisioned pool for sub-second startup
- gVisor/Kata container isolation
- Will likely become the K8s standard for agent workloads

**Interface mapping:**
```typescript
create(config): Promise<RuntimeHandle> {
  // kubectl apply SandboxClaim resource
  // Wait for .status.phase === "Ready"
  // Return handle with sandbox name
}

destroy(handle): Promise<void> {
  // kubectl delete sandboxclaim {handle.id}
}
```

**Distillation sources:**
- [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) — official K8s SIG
- [Google Blog: Unleashing AI Agents on K8s](https://opensource.googleblog.com/2025/11/unleashing-autonomous-ai-agents-why-kubernetes-needs-a-new-standard-for-agent-execution.html)

---

### 10-12. `runtime-hetzner`, `runtime-podman`, `runtime-lxc`

| Plugin | Priority | Key Detail |
|--------|----------|-----------|
| `runtime-hetzner` | P3 | Cheapest VMs ($3.49/mo). REST API. `HETZNER_API_TOKEN`. |
| `runtime-podman` | P3 | Docker-compatible CLI. Reuse `runtime-docker` code with `podman` instead of `docker`. Rootless. |
| `runtime-lxc` | P4 | System containers via `lxc` CLI. `lxc launch`, `lxc exec`, `lxc delete`. |

---

## Tracker Plugins

All implement the `Tracker` interface from `packages/core/src/types.ts`.

### Interface Methods

| Method | Required | Description |
|--------|----------|-------------|
| `name` | Yes | Readonly identifier |
| `getIssue(identifier, project)` | Yes | Fetch issue → `Issue` |
| `isCompleted(identifier, project)` | Yes | Check if closed/done |
| `issueUrl(identifier, project)` | Yes | Generate issue URL |
| `issueLabel?(url, project)` | Optional | Extract label from URL |
| `branchName(identifier, project)` | Yes | Generate git branch name |
| `generatePrompt(identifier, project)` | Yes | Build agent prompt from issue |
| `listIssues?(filters, project)` | Optional | List issues with filters |
| `updateIssue?(identifier, update, project)` | Optional | Update state/labels/assignee |
| `createIssue?(input, project)` | Optional | Create new issue |

Reference: `packages/plugins/tracker-github/src/index.ts` (uses `gh` CLI), `packages/plugins/tracker-linear/src/index.ts` (uses GraphQL + dual transport)

---

### 1. `tracker-jira` — Atlassian Jira

| Field | Value |
|-------|-------|
| **Priority** | P0 — Highest enterprise demand |
| **Package** | `@composio/ao-tracker-jira` |
| **Market share** | ~89% of enterprise teams |
| **API** | REST v3 |
| **Auth** | Basic Auth (email + API token) |
| **npm SDK** | `jira.js` (excellent, well-maintained) |
| **Effort** | Medium |
| **Confidence** | HIGH — proven patterns exist |

**Auth setup:**
```bash
JIRA_HOST=https://mycompany.atlassian.net
JIRA_EMAIL=user@company.com
JIRA_API_TOKEN=ATATT3xFfGF0...
```

**Critical implementation detail — status transitions require 2 API calls:**
```typescript
updateIssue(identifier: string, update: IssueUpdate): Promise<void> {
  if (update.state) {
    // Step 1: GET available transitions (dynamic IDs per workflow)
    const transitions = await client.issues.getTransitions({ issueIdOrKey: identifier });
    // Step 2: Find transition matching target state
    const target = transitions.transitions.find(t =>
      t.to.statusCategory.key === mapStateToJiraCategory(update.state)
    );
    // Step 3: Perform transition
    await client.issues.doTransition({
      issueIdOrKey: identifier,
      transition: { id: target.id },
    });
  }
}
```

This is unlike GitHub/Linear which allow direct state setting. Jira uses dynamic transition IDs per workflow configuration.

**Dual transport pattern** (following `tracker-linear`'s proven `GraphQLTransport` design):
```typescript
export function create(config?: Record<string, unknown>): Tracker {
  const composioKey = process.env["COMPOSIO_API_KEY"];
  if (composioKey) {
    return createJiraTracker(createComposioTransport(composioKey));
  }
  return createJiraTracker(createDirectTransport()); // uses JIRA_* env vars
}
```

**Interface mapping:**
```typescript
getIssue(identifier, project): Promise<Issue> {
  const issue = await client.issues.getIssue({ issueIdOrKey: identifier });
  return {
    id: issue.key,              // "PROJ-123"
    title: issue.fields.summary,
    description: issue.fields.description?.content?.[0]?.content?.[0]?.text ?? "",
    url: `${host}/browse/${issue.key}`,
    state: mapJiraStatus(issue.fields.status.statusCategory.key),
    labels: issue.fields.labels,
    assignee: issue.fields.assignee?.displayName,
    priority: mapJiraPriority(issue.fields.priority?.name),
  };
}

issueUrl(identifier, project): string {
  return `${process.env["JIRA_HOST"]}/browse/${identifier}`;
}

issueLabel(url): string {
  const match = url.match(/\/browse\/([A-Z]+-\d+)/);
  return match?.[1] ?? url;
}

branchName(identifier): string {
  return `feat/${identifier.toLowerCase()}`; // "feat/proj-123"
}

listIssues(filters, project): Promise<Issue[]> {
  // JQL: "project = 'PROJ' AND status = 'To Do' AND assignee = currentUser()"
  const jql = buildJQL(filters, project);
  const result = await client.issueSearch.searchForIssuesUsingJql({ jql, maxResults: filters.limit ?? 50 });
  return result.issues.map(mapToIssue);
}
```

**Config:**
```yaml
projects:
  my-app:
    tracker:
      plugin: jira
      projectKey: PROJ
      boardId: 42          # Optional: for sprint queries
```

**Proof of working patterns:**
- [OpenAI Codex Jira-GitHub Cookbook](https://developers.openai.com/cookbook/examples/codex/jira-github) — proven Jira ticket → PR workflow with working code
- [crewAI Jira integrations](https://github.com/crewAIInc/crewAI) — agentic Jira workflows
- `jira.js` npm package — 800+ stars, actively maintained, covers all Jira REST v3 endpoints
- Jira REST API v3: `https://developer.atlassian.com/cloud/jira/platform/rest/v3/`

---

### 2. `tracker-gitlab` — GitLab Issues

| Field | Value |
|-------|-------|
| **Priority** | P1 |
| **Market share** | Very high |
| **API** | REST v4 |
| **Auth** | PAT header (`GITLAB_TOKEN`) |
| **npm SDK** | `@gitbeaker/rest` (mature, well-maintained) |
| **Effort** | Easy |

**Key difference from GitHub:** Uses `iid` (project-scoped ID) not global `id`.

```typescript
getIssue(identifier, project): Promise<Issue> {
  const issue = await api.Issues.show(project.repo, parseInt(identifier));
  return { id: `#${issue.iid}`, title: issue.title, ... };
}
```

---

### 3. `tracker-shortcut` — Shortcut

| Field | Value |
|-------|-------|
| **Priority** | P1 |
| **npm SDK** | `@shortcut/client` (official) |
| **Auth** | `SHORTCUT_API_TOKEN` |
| **Effort** | Easy |

---

### 4. `tracker-azure-devops` — Azure DevOps Work Items

| Field | Value |
|-------|-------|
| **Priority** | P1 |
| **npm SDK** | `azure-devops-node-api` (official Microsoft SDK) |
| **Auth** | `AZURE_DEVOPS_TOKEN` + `AZURE_DEVOPS_ORG` |
| **Effort** | Medium |

---

### 5-10. `tracker-clickup`, `tracker-plane`, `tracker-asana`, `tracker-monday`, `tracker-trello`, `tracker-youtrack`

| Plugin | Priority | npm SDK | Auth Env Var |
|--------|----------|---------|-------------|
| `tracker-clickup` | P2 | `@yoryoboy/clickup-sdk` | `CLICKUP_API_TOKEN` |
| `tracker-plane` | P2 | `@makeplane/plane-node-sdk` (official) | `PLANE_API_KEY` + `PLANE_HOST` |
| `tracker-asana` | P2 | `asana` (official) | `ASANA_ACCESS_TOKEN` |
| `tracker-monday` | P3 | `@mondaydotcomorg/api` (official, GraphQL) | `MONDAY_API_TOKEN` |
| `tracker-trello` | P3 | `trello.js` | `TRELLO_API_KEY` + `TRELLO_TOKEN` |
| `tracker-youtrack` | P3 | `youtrack-rest-client` | `YOUTRACK_TOKEN` + `YOUTRACK_HOST` |

---

## SCM Plugins

All implement the `SCM` interface from `packages/core/src/types.ts`.

### Interface Methods

| Method | Required | Description |
|--------|----------|-------------|
| `detectPR(session, project)` | Yes | Find open PR for branch → `PRInfo \| null` |
| `getPRState(pr)` | Yes | Get PR state |
| `getPRSummary?(pr)` | Optional | State + title + additions + deletions |
| `mergePR(pr, method?)` | Yes | Merge the PR |
| `closePR(pr)` | Yes | Close without merge |
| `getCIChecks(pr)` | Yes | Individual CI check statuses |
| `getCISummary(pr)` | Yes | Overall CI status |
| `getReviews(pr)` | Yes | All reviews |
| `getReviewDecision(pr)` | Yes | Overall review decision |
| `getPendingComments(pr)` | Yes | Unresolved review comments |
| `getAutomatedComments(pr)` | Yes | Bot/linter comments |
| `getMergeability(pr)` | Yes | Full merge readiness check |

Reference: `packages/plugins/scm-github/src/index.ts` (uses `gh` CLI + GraphQL)

---

### 1. `scm-gitlab` — GitLab Merge Requests

| Field | Value |
|-------|-------|
| **Priority** | P0 — Highest priority SCM gap |
| **Package** | `@composio/ao-scm-gitlab` |
| **Market share** | ~29% |
| **CLI tool** | `glab` (official, mirrors `gh` almost exactly) |
| **npm SDK** | `@gitbeaker/rest` |
| **Effort** | Medium |

**Terminology mapping:**

| GitHub | GitLab |
|--------|--------|
| Pull Request | Merge Request (MR) |
| `number` | `iid` (project-scoped) |
| Check Runs | Pipeline Jobs |
| `gh` CLI | `glab` CLI |

**Interface mapping using `glab` (mirrors `gh`):**
```typescript
detectPR(session, project): Promise<PRInfo | null> {
  // glab mr list --source-branch {branch} --repo {repo}
  //   --json iid,title,webUrl,sourceBranch,targetBranch,state,draft
}

mergePR(pr, method?): Promise<void> {
  // glab mr merge {iid} --repo {repo} [--squash|--rebase]
}

getCIChecks(pr): Promise<CICheck[]> {
  // Pipeline jobs: GET /api/v4/projects/{id}/merge_requests/{iid}/pipelines
  // then: GET /api/v4/projects/{id}/pipelines/{pipelineId}/jobs
}

getReviewDecision(pr): Promise<ReviewDecision> {
  // Approvals API: GET /api/v4/projects/{id}/merge_requests/{iid}/approvals
  // approvals_left === 0 → "approved", else "pending"
}
```

**Auth:** `GITLAB_TOKEN` + optional `GITLAB_HOST` (for self-hosted).

**Proof:** `glab` CLI (official, maintained by GitLab) mirrors `gh` almost exactly. `@gitbeaker/rest` npm package covers all GitLab REST v4 endpoints.

**Distillation sources:**
- [GitLab REST API v4](https://docs.gitlab.com/api/merge_requests.html)
- [GitLab CLI (glab)](https://gitlab.com/gitlab-org/cli)
- [@gitbeaker/rest](https://github.com/jdalrymple/gitbeaker)

---

### 2. `scm-bitbucket` — Bitbucket Cloud

| Field | Value |
|-------|-------|
| **Priority** | P1 |
| **Market share** | ~18-21% |
| **npm SDK** | `@coderabbitai/bitbucket` (TypeScript) |
| **Auth** | `BITBUCKET_USERNAME` + `BITBUCKET_APP_PASSWORD` |
| **Effort** | Medium |
| **Key difference** | Simpler approval model — no "changes requested" state |

**REST endpoints:**
```
GET  /2.0/repositories/{workspace}/{repo}/pullrequests?q=source.branch.name="{branch}"
POST /2.0/repositories/{workspace}/{repo}/pullrequests/{id}/merge
POST /2.0/repositories/{workspace}/{repo}/pullrequests/{id}/decline
GET  /2.0/repositories/{workspace}/{repo}/pullrequests/{id}/statuses
GET  /2.0/repositories/{workspace}/{repo}/pullrequests/{id}/comments
```

---

### 3. `scm-azure-devops` — Azure DevOps Repos

| Field | Value |
|-------|-------|
| **Priority** | P1 |
| **Market share** | ~13-14% |
| **CLI** | `az repos pr` |
| **npm SDK** | `azure-devops-node-api` (official) |
| **Auth** | `AZURE_DEVOPS_TOKEN` + `AZURE_DEVOPS_ORG` |
| **Key difference** | Numeric votes: -10 (rejected) to 10 (approved) |

---

### 4. `scm-gitea` — Gitea/Forgejo/Codeberg

| Field | Value |
|-------|-------|
| **Priority** | P2 |
| **CLI** | `tea` |
| **npm SDK** | `gitea-js` (auto-generated) |
| **Auth** | `GITEA_TOKEN` + `GITEA_HOST` |
| **Key advantage** | One plugin covers Gitea + Forgejo + Codeberg (API-compatible) |

---

### 5. `scm-gerrit` — Gerrit Code Review

| Field | Value |
|-------|-------|
| **Priority** | P3 |
| **Effort** | High |
| **Key differences** | "Changes" with "Patch Sets", voting -2 to +2, REST responses prefixed with `)]}'\n` |

---

## Notifier Plugins

All implement the `Notifier` interface from `packages/core/src/types.ts`.

### Interface Methods

| Method | Required | Description |
|--------|----------|-------------|
| `name` | Yes | Readonly identifier |
| `notify(event)` | Yes | Push notification |
| `notifyWithActions?(event, actions)` | Optional | With buttons/links |
| `post?(message, context?)` | Optional | Channel message |

Reference: `packages/plugins/notifier-slack/src/index.ts` (webhook + Block Kit), `packages/plugins/notifier-desktop/src/index.ts` (osascript/notify-send)

---

### 1. `notifier-discord` — Discord Webhooks

| Field | Value |
|-------|-------|
| **Priority** | P0 |
| **Package** | `@composio/ao-notifier-discord` |
| **Users** | 231M MAU |
| **API** | Webhook POST |
| **Auth** | URL token (embedded in webhook URL) |
| **Code blocks** | Yes (syntax highlighting) |
| **Buttons** | Yes (embeds with links) |
| **npm SDK** | Plain `fetch` (no library needed) |
| **Effort** | Low |

**Implementation:**
```typescript
async notify(event: OrchestratorEvent): Promise<void> {
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [{
        title: `${priorityEmoji(event.priority)} ${event.type} — ${event.sessionId}`,
        description: event.message,
        color: priorityColor(event.priority),
        fields: [
          { name: "Project", value: event.projectId, inline: true },
          { name: "Priority", value: event.priority, inline: true },
        ],
        timestamp: event.timestamp.toISOString(),
      }],
    }),
  });
}

async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
  // Discord embeds support URL links but NOT interactive buttons via webhooks
  const fields = actions.filter(a => a.url).map(a => ({
    name: a.label, value: `[Open](${a.url})`, inline: true,
  }));
  // ... same as notify() with additional fields
}
```

**Config:** `webhookUrl` in notifier config.

**Proof:**
- [23blocks-OS/ai-maestro](https://github.com/23blocks-OS/ai-maestro) (354 stars) — has a working Discord gateway on port 3023. Validates Discord integration for agent orchestrators with bidirectional messaging.
- Discord Webhook API is extremely simple — single POST endpoint with JSON payload.

---

### 2. `notifier-teams` — Microsoft Teams

| Field | Value |
|-------|-------|
| **Priority** | P0 |
| **Users** | 360M MAU |
| **API** | Webhook + Adaptive Cards |
| **Auth** | URL token |
| **Effort** | Low |

**Implementation:**
```typescript
async notify(event: OrchestratorEvent): Promise<void> {
  const card = {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      content: {
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard", version: "1.4",
        body: [
          { type: "TextBlock", text: `${event.type} — ${event.sessionId}`, weight: "bolder", size: "medium" },
          { type: "TextBlock", text: event.message, wrap: true },
          { type: "FactSet", facts: [
            { title: "Project", value: event.projectId },
            { title: "Priority", value: event.priority },
          ]},
        ],
      },
    }],
  };
  await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(card) });
}
```

---

### 3. `notifier-telegram` — Telegram Bot

| Field | Value |
|-------|-------|
| **Priority** | P0 |
| **Users** | 1B MAU |
| **API** | Bot API POST |
| **Auth** | `TELEGRAM_BOT_TOKEN` (from BotFather) |
| **Code blocks** | Yes (MarkdownV2) |
| **Buttons** | Yes (inline keyboard) |
| **npm SDK** | Plain `fetch` |
| **Effort** | Low |

**Implementation:**
```typescript
const API = `https://api.telegram.org/bot${process.env["TELEGRAM_BOT_TOKEN"]}`;

async notify(event: OrchestratorEvent): Promise<void> {
  const text = `${priorityEmoji(event.priority)} *${escapeMarkdown(event.type)}*\n\`${event.sessionId}\`\n\n${escapeMarkdown(event.message)}`;
  await fetch(`${API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "MarkdownV2" }),
  });
}

async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
  const inline_keyboard = [actions.filter(a => a.url).map(a => ({ text: a.label, url: a.url }))];
  await fetch(`${API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId, text: formatMessage(event),
      parse_mode: "MarkdownV2",
      reply_markup: { inline_keyboard },
    }),
  });
}
```

**Config:** `chatId` in notifier config (group chat ID or user ID).

---

### 4. `notifier-email` — Email (Resend/SMTP)

| Field | Value |
|-------|-------|
| **Priority** | P0 |
| **API** | Resend API or SMTP |
| **Auth** | `RESEND_API_KEY` or SMTP credentials |
| **npm SDK** | `resend` (preferred) or `nodemailer` |
| **Effort** | Low |

**Implementation with Resend:**
```typescript
import { Resend } from "resend";
const resend = new Resend(process.env["RESEND_API_KEY"]);

async notify(event: OrchestratorEvent): Promise<void> {
  await resend.emails.send({
    from: "Agent Orchestrator <ao@yourdomain.com>",
    to: config.to as string[],
    subject: `[${event.priority.toUpperCase()}] ${event.type} — ${event.sessionId}`,
    html: `<h2>${event.type} — ${event.sessionId}</h2><p>${event.message}</p>`,
  });
}
```

**Proof:** [ai-maestro](https://github.com/23blocks-OS/ai-maestro) has a working email gateway on port 3020.

---

### 5. `notifier-google-chat` — Google Chat Webhooks

| Priority | P1 | Auth | URL token | API | Webhook + Cards v2 | Effort | Low |
|----------|----|------|-----------|-----|---------------------|--------|-----|

### 6. `notifier-mattermost` — Self-Hosted Slack Alternative

| Priority | P1 | Key advantage | Slack-compatible webhook format — reuse `notifier-slack` formatting |
|----------|----|--------------|----------------------------------------------------------------------|

### 7. `notifier-ntfy` — ntfy.sh Open Source Push

| Field | Value |
|-------|-------|
| **Priority** | P1 |
| **API** | PUT/POST to topic |
| **Auth** | None (public) or token |
| **Buttons** | Yes (3 actions max) |
| **Effort** | Low |

**Implementation:**
```typescript
async notify(event: OrchestratorEvent): Promise<void> {
  await fetch(`${ntfyUrl}/${topic}`, {
    method: "POST",
    headers: {
      "Title": `${event.type} — ${event.sessionId}`,
      "Priority": ntfyPriority(event.priority),
      "Tags": event.priority === "urgent" ? "warning" : "information_source",
    },
    body: event.message,
  });
}
```

### 8. `notifier-pagerduty` — PagerDuty Alerts

| Field | Value |
|-------|-------|
| **Priority** | P1 |
| **API** | Events API v2 |
| **Auth** | `PAGERDUTY_ROUTING_KEY` |
| **npm SDK** | `@pagerduty/pdjs` |
| **Effort** | Low |
| **Best for** | On-call escalation for urgent events only |

**Implementation:**
```typescript
async notify(event: OrchestratorEvent): Promise<void> {
  if (event.priority !== "urgent" && event.priority !== "action") return; // Only page for critical
  await fetch("https://events.pagerduty.com/v2/enqueue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      routing_key: process.env["PAGERDUTY_ROUTING_KEY"],
      event_action: "trigger",
      payload: {
        summary: `${event.type} — ${event.sessionId}: ${event.message}`,
        source: "agent-orchestrator",
        severity: event.priority === "urgent" ? "critical" : "warning",
      },
    }),
  });
}
```

### 9-13. Remaining Notifiers

| Plugin | Priority | Auth | Key Detail |
|--------|----------|------|-----------|
| `notifier-pushover` | P2 | `PUSHOVER_APP_TOKEN` + `PUSHOVER_USER_KEY` | Sysadmin favorite |
| `notifier-sms` | P2 | `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` | Critical alerts only |
| `notifier-lark` | P2 | URL token | China/Asia tech (ByteDance) |
| `notifier-dingtalk` | P2 | URL token + HMAC-SHA256 | 700M registered (Alibaba) |
| `notifier-webex` | P3 | Bot token | Cisco, Adaptive Cards |

---

## Terminal Plugins

All implement the `Terminal` interface from `packages/core/src/types.ts`.

### Interface Methods

| Method | Required | Description |
|--------|----------|-------------|
| `name` | Yes | Readonly identifier |
| `openSession(session)` | Yes | Open session for human interaction |
| `openAll(sessions)` | Yes | Open all sessions |
| `isSessionOpen?(session)` | Optional | Check if already open |

Reference: `packages/plugins/terminal-iterm2/src/index.ts`

---

### 1. `terminal-kitty` — Kitty Terminal

| Field | Value |
|-------|-------|
| **Priority** | P0 |
| **Package** | `@composio/ao-terminal-kitty` |
| **Platforms** | macOS, Linux |
| **Protocol** | JSON-based socket (remote control) |
| **Effort** | Low |

**Key commands (all via `kitten @` or `kitty @`):**
```bash
kitten @ ls                                    # List all tabs (JSON output)
kitten @ launch --type=tab --title "name" cmd  # Create tab
kitten @ focus-tab --match title:name          # Focus tab
kitten @ send-text --match title:name "msg\n"  # Send text
kitten @ get-text --match title:name           # Read content
```

**Implementation:**
```typescript
async openSession(session: Session): Promise<void> {
  const name = session.runtimeHandle?.id ?? session.id;
  const { stdout } = await execFileAsync("kitten", ["@", "ls"], { timeout: 10_000 });
  const windows = JSON.parse(stdout);
  const existing = findTabByTitle(windows, name);

  if (existing) {
    await execFileAsync("kitten", ["@", "focus-tab", "--match", `id:${existing.id}`], { timeout: 10_000 });
  } else {
    await execFileAsync("kitten", [
      "@", "launch", "--type=tab", "--title", name,
      "tmux", "attach", "-t", name,
    ], { timeout: 10_000 });
  }
}

async isSessionOpen(session: Session): Promise<boolean> {
  const { stdout } = await execFileAsync("kitten", ["@", "ls"], { timeout: 10_000 });
  return !!findTabByTitle(JSON.parse(stdout), session.runtimeHandle?.id ?? session.id);
}
```

**Why Kitty over iTerm2:**
- Cross-platform (macOS + Linux) vs iTerm2 (macOS only)
- JSON-based protocol (structured, parseable) vs AppleScript (fragile)
- More reliable error handling
- Native split pane support

**Proof:** [Kitty Remote Control docs](https://sw.kovidgoyal.net/kitty/remote-control/) — official, well-documented JSON protocol.

---

### 2. `terminal-wezterm` — WezTerm Terminal

| Field | Value |
|-------|-------|
| **Priority** | P0 |
| **Platforms** | macOS, Linux, **Windows** |
| **Protocol** | CLI (`wezterm cli`) |
| **Effort** | Low |

**Key commands:**
```bash
wezterm cli list --format json          # List tabs (JSON)
wezterm cli spawn -- tmux attach -t x   # Create tab
wezterm cli activate-tab --tab-id 42    # Focus tab
wezterm cli send-text --pane-id 42 msg  # Send text
wezterm cli get-text --pane-id 42       # Read content
```

**Key advantage:** Best cross-platform coverage (macOS + Linux + Windows).

---

### 3. `terminal-zellij` — Zellij Multiplexer

| Field | Value |
|-------|-------|
| **Priority** | P1 |
| **Platforms** | macOS, Linux |
| **Protocol** | CLI (`zellij action`) |
| **Effort** | Low |

**Key commands:**
```bash
zellij action new-tab --name x -- tmux attach -t x  # Create tab
zellij action go-to-tab-name x                       # Focus tab
zellij action write-chars "message"                   # Send text
zellij action dump-screen /tmp/screen.txt             # Read content
```

---

### 4. `terminal-cmux` — cmux (AI-native)

| Field | Value |
|-------|-------|
| **Priority** | P1 |
| **Platforms** | macOS only |
| **Protocol** | Unix socket API |
| **Effort** | Low |

**Proof:** [manaflow-ai/cmux](https://github.com/manaflow-ai/cmux) — purpose-built for AI agents with `cmux notify` CLI, socket API, and agent metadata display.

---

### 5-6. `terminal-ghostty`, `terminal-windows-terminal`

| Plugin | Priority | Platform | Protocol | Limitation |
|--------|----------|----------|----------|-----------|
| `terminal-ghostty` | P2 | macOS, Linux | AppleScript (macOS) | Limited Linux control |
| `terminal-windows-terminal` | P2 | Windows | `wt.exe` CLI | No send-text/get-text |

---

## Workspace Plugins

All implement the `Workspace` interface from `packages/core/src/types.ts`.

Reference: `packages/plugins/workspace-worktree/src/index.ts`

---

### 1. `workspace-devcontainer` — Dev Containers

| Field | Value |
|-------|-------|
| **Priority** | P0 |
| **Package** | `@composio/ao-workspace-devcontainer` |
| **Isolation** | Container |
| **Setup speed** | 30s-5min |
| **Prerequisite** | `npm i -g @devcontainers/cli` |
| **Effort** | Medium |

**Implementation:**
```typescript
create(config): Promise<WorkspaceInfo> {
  // 1. Create git worktree (reuse workspace-worktree logic)
  const worktreePath = await createWorktree(config);
  // 2. Build & start devcontainer
  await execFileAsync("devcontainer", ["up", "--workspace-folder", worktreePath], { timeout: 300_000 });
  return { path: worktreePath, branch: config.branch, sessionId: config.sessionId, projectId: config.projectId };
}

destroy(workspacePath): Promise<void> {
  await execFileAsync("devcontainer", ["down", "--workspace-folder", workspacePath], { timeout: 30_000 });
  await removeWorktree(workspacePath);
}
```

**Key advantage:** Many projects already have `.devcontainer/devcontainer.json` — zero additional configuration.

---

### 2-5. Remaining Workspaces

| Plugin | Priority | Isolation | Speed | Key Detail |
|--------|----------|-----------|-------|-----------|
| `workspace-container-use` | P1 | Container+Worktree | 10-30s | Container isolation with git branch |
| `workspace-overlay` | P1 | OverlayFS CoW | ~100ms | **Fastest** — Linux only, read-only base |
| `workspace-tempdir` | P2 | Temp directory | 1-5s | Simple `git clone --depth 1` into tmpdir |
| `workspace-docker-compose` | P3 | Container+Network | 30s-2min | For projects needing service deps |

---

## Cross-Cutting Enhancements

### 1. OpenTelemetry Integration

| Priority | P0 | npm SDK | `@opentelemetry/sdk-node` |

Add spans around: session spawn, lifecycle poll, PR detection, notification send. Export to OTLP collector.

**Proof:** [microsoft/agent-framework](https://github.com/microsoft/agent-framework) (7.4k stars) — OpenTelemetry built-in from day one.

### 2. Prometheus Metrics

| Priority | P0 | npm SDK | `prom-client` |

Add `/metrics` endpoint. Counters: sessions_spawned/completed, notifications_sent. Gauges: active_sessions, sessions_by_status.

**Proof:** [hoangsonww/AI-Agents-Orchestrator](https://github.com/hoangsonww/AI-Agents-Orchestrator) — working Prometheus metrics integration.

### 3. Sentry Error Tracking

| Priority | P0 | npm SDK | `@sentry/node` | Auth | `SENTRY_DSN` |

### 4. Secret Providers

| Priority | P1 | Pattern | `SecretProvider` interface |

Zero-code options: `doppler run -- ao start`, `op run -- ao start`. Interface-based: Vault (`node-vault`), AWS SM (`@aws-sdk/client-secrets-manager`), Infisical (`@infisical/sdk`).

### 5. CI/CD Standalone

For non-GitHub/GitLab CI: CircleCI (REST v2), Jenkins (`jenkins` npm), Buildkite (REST+GraphQL), Vercel (`@vercel/client`).

### 6. Memory System (Future)

| Priority | P1 (future) | Effort | High |

**Patterns from research:**

| Feature | Source | Proof |
|---------|--------|-------|
| Per-agent graph DB | [ai-maestro](https://github.com/23blocks-OS/ai-maestro) | CozoDB integration — working code with delta indexing for 10x speedup |
| Hierarchical scoping | [crewAI](https://github.com/crewAIInc/crewAI) | Unified Memory class with `/project/agent/session` scope trees |
| Memory consolidation | [crewAI](https://github.com/crewAIInc/crewAI) | LLM-driven dedup of near-duplicate memories |
| Non-blocking persistence | [crewAI](https://github.com/crewAIInc/crewAI) | Background saves, synchronous reads (drain-on-read) |
| Shared memory with rules | [Swarms](https://github.com/kyegomez/swarms) | Cross-agent shared context with behavioral constraints |

---

## Existing Plugin Upgrades

### `notifier-desktop` — Replace osascript with terminal-notifier

**Current:** `osascript` AppleScript `display notification` (macOS only, no click-through, notifications stack).

**Upgrade:**
```typescript
// Before:
execFileAsync("osascript", ["-e", `display notification "${message}" with title "${title}"`]);

// After:
execFileAsync("terminal-notifier", [
  "-title", title,
  "-message", message,
  "-open", prUrl,           // Click opens PR in browser
  "-group", sessionId,      // Replaces previous notification (no stacking)
  "-appIcon", iconPath,
]);
```

Add Windows support via `node-notifier`.

### `notifier-slack` — Add Message Threading

**Current:** One-way webhook, each notification is separate.

**Upgrade:** Use Slack Web API (`SLACK_BOT_TOKEN`) for threading. Store `ts` (timestamp) per session, thread follow-ups under original notification.

```typescript
const sessionThreads = new Map<string, string>();

async notify(event): Promise<void> {
  const parentTs = sessionThreads.get(event.sessionId);
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env["SLACK_BOT_TOKEN"]}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel: channelId, text: formatMessage(event), thread_ts: parentTs }),
  });
  const data = await response.json();
  if (!parentTs && data.ok) sessionThreads.set(event.sessionId, data.ts);
}
```

### `notifier-webhook` — Add HMAC Signing

**Current:** Plain POST, no authenticity verification.

**Upgrade:**
```typescript
import { createHmac } from "node:crypto";

const body = JSON.stringify(payload);
const signature = createHmac("sha256", process.env["WEBHOOK_SECRET"]!).update(body).digest("hex");
headers["X-Webhook-Signature"] = `sha256=${signature}`;
headers["X-Webhook-Timestamp"] = Date.now().toString();
```

**Distillation source:** [Convoy](https://github.com/frain-dev/convoy) — webhook delivery with HMAC signing.

### `terminal-iterm2` — Migrate to Python API

Replace AppleScript with iTerm2 Python API (`it2` CLI) for better reliability, error handling, and split pane support. See: [iTerm2 Python API](https://iterm2.com/python-api/).

---

## Phased Roadmap

### Phase 1 — Maximum Impact (covers ~90% of teams)

| # | Plugin | Slot | Effort | Proof/Source |
|---|--------|------|--------|-------------|
| 1 | `agent-gemini` | Agent | Low | [agent-view](https://github.com/Frayo44/agent-view) validates in tmux |
| 2 | `agent-cline` | Agent | Low | [cline/cline](https://github.com/cline/cline) |
| 3 | `agent-copilot` | Agent | Low | `gh` extension model |
| 4 | `agent-goose` | Agent | Low | [CAO](https://github.com/awslabs/cli-agent-orchestrator) working provider |
| 5 | `tracker-jira` | Tracker | Medium | [Codex Jira Cookbook](https://developers.openai.com/cookbook/examples/codex/jira-github), `jira.js` npm |
| 6 | `scm-gitlab` | SCM | Medium | [glab CLI](https://gitlab.com/gitlab-org/cli), [@gitbeaker/rest](https://github.com/jdalrymple/gitbeaker) |
| 7 | `runtime-docker` | Runtime | Medium | [OpenSandbox](https://github.com/alibaba/OpenSandbox), [cagent](https://github.com/docker/cagent) |
| 8 | `notifier-discord` | Notifier | Low | [ai-maestro](https://github.com/23blocks-OS/ai-maestro) Discord gateway |
| 9 | `notifier-teams` | Notifier | Low | Adaptive Cards API |
| 10 | `notifier-telegram` | Notifier | Low | Telegram Bot API |
| 11 | `notifier-email` | Notifier | Low | [ai-maestro](https://github.com/23blocks-OS/ai-maestro) email gateway, Resend API |
| 12 | `terminal-kitty` | Terminal | Low | [Kitty Remote Control](https://sw.kovidgoyal.net/kitty/remote-control/) |

### Phase 2 — Enterprise & Cloud

| # | Plugin | Slot | Effort | Proof/Source |
|---|--------|------|--------|-------------|
| 13 | `runtime-e2b` | Runtime | Low | [E2B SDK](https://e2b.dev/docs) |
| 14 | `runtime-daytona` | Runtime | Low | [Daytona SDK](https://github.com/daytonaio/sdk) |
| 15 | `scm-bitbucket` | SCM | Medium | Bitbucket REST API |
| 16 | `scm-azure-devops` | SCM | Medium | `azure-devops-node-api` SDK |
| 17 | `tracker-shortcut` | Tracker | Low | `@shortcut/client` official SDK |
| 18 | `tracker-azure-devops` | Tracker | Medium | `azure-devops-node-api` SDK |
| 19 | `tracker-clickup` | Tracker | Low | ClickUp REST API |
| 20 | `agent-continue` | Agent | Low | [continuedev/continue](https://github.com/continuedev/continue) |
| 21 | `agent-kiro` | Agent | Low | [CAO](https://github.com/awslabs/cli-agent-orchestrator) working provider |
| 22 | `terminal-wezterm` | Terminal | Low | WezTerm CLI docs |
| 23 | `workspace-devcontainer` | Workspace | Medium | [devcontainers/cli](https://github.com/devcontainers/cli) |

### Phase 3 — Comprehensive Coverage

| # | Plugin | Slot | Effort |
|---|--------|------|--------|
| 24-27 | `notifier-google-chat/mattermost/ntfy/pagerduty` | Notifier | Low each |
| 28-30 | `tracker-plane/asana/monday` | Tracker | Low-Medium |
| 31-33 | `runtime-modal/fly/morph` | Runtime | Medium |
| 34 | `scm-gitea` | SCM | Low |
| 35 | `terminal-zellij` | Terminal | Low |
| 36 | `workspace-overlay` | Workspace | Medium |
| 37-40 | `agent-cursor/auggie/trae/openhands` | Agent | Low each |

### Phase 4 — Long Tail

Regional notifiers (Lark, DingTalk, Webex), niche trackers (Trello, YouTrack), specialized runtimes (Hetzner, Podman, LXC, K8s Sandbox), Gerrit SCM, cross-cutting enhancements (OpenTelemetry, Prometheus, Sentry, SecretProvider, CI standalone, Memory).

---

## Sources

### Distillation Repositories

| Repository | Stars | What We Distilled |
|-----------|-------|-------------------|
| [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad) | 6.1k | Daemon mode, dual-polling, pause/resume |
| [ruvnet/claude-flow](https://github.com/ruvnet/claude-flow) | 14.4k | 3-tier routing, ReasoningBank, background workers |
| [awslabs/cli-agent-orchestrator](https://github.com/awslabs/cli-agent-orchestrator) | 256 | MCP server, regex status detection, Q/Kiro providers |
| [awslabs/agent-squad](https://github.com/awslabs/agent-squad) | 7.4k | LLM routing, agent-as-tools, 3-tier memory |
| [23blocks-OS/ai-maestro](https://github.com/23blocks-OS/ai-maestro) | 354 | AMP messaging, CozoDB memory, Discord/email gateways |
| [hoangsonww/AI-Agents-Orchestrator](https://github.com/hoangsonww/AI-Agents-Orchestrator) | 14 | FallbackManager, circuit breaker, Prometheus |
| [crewAIInc/crewAI](https://github.com/crewAIInc/crewAI) | 44.6k | Flow DSL, memory consolidation, A2A protocol |
| [kyegomez/swarms](https://github.com/kyegomez/swarms) | 5.8k | SwarmRouter, MajorityVoting, shared memory |
| [microsoft/agent-framework](https://github.com/microsoft/agent-framework) | 7.4k | 5 orchestration patterns, middleware, OpenTelemetry |
| [wshobson/agents](https://github.com/wshobson/agents) | 240+ | Progressive disclosure, skill marketplace |
| [Frayo44/agent-view](https://github.com/Frayo44/agent-view) | 112 | TUI dashboard, multi-agent status detection |
| [bufanoc/tmux-orchestrator-ai-code](https://github.com/bufanoc/tmux-orchestrator-ai-code) | — | Self-scheduling, 3-tier hierarchy |
| [docker/cagent](https://github.com/docker/cagent) | 2k | OCI distribution, cassette testing |
| [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) | 1.1k | K8s CRDs, warm pools, gVisor/Kata |
| [alibaba/OpenSandbox](https://github.com/alibaba/OpenSandbox) | 1.1k | Two-tier API, Docker+K8s, pause/resume |
| [Th0rgal/openagent](https://github.com/Th0rgal/openagent) | 252 | systemd-nspawn, Amp validation |

### API Documentation

- [Jira REST API v3](https://developer.atlassian.com/cloud/jira/platform/rest/v3/)
- [GitLab REST API v4](https://docs.gitlab.com/api/)
- [Bitbucket REST API](https://developer.atlassian.com/cloud/bitbucket/rest/)
- [Azure DevOps REST API](https://learn.microsoft.com/en-us/rest/api/azure/devops/)
- [Shortcut REST API](https://developer.shortcut.com/api/rest/v3)
- [Discord Webhook API](https://discord.com/developers/docs/resources/webhook)
- [MS Teams Adaptive Cards](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [PagerDuty Events API v2](https://developer.pagerduty.com/api-reference/)
- [ntfy.sh API](https://docs.ntfy.sh/)
- [Kitty Remote Control](https://sw.kovidgoyal.net/kitty/remote-control/)
- [WezTerm CLI](https://wezfurlong.org/wezterm/cli/)
- [E2B SDK](https://e2b.dev/docs)
- [Daytona SDK](https://www.daytona.io/docs)
- [OpenTelemetry Node SDK](https://opentelemetry.io/docs/languages/js/)

### Blog Posts & Analysis

- [AWS Blog: CLI Agent Orchestrator](https://aws.amazon.com/blogs/opensource/introducing-cli-agent-orchestrator-transforming-developer-cli-tools-into-a-multi-agent-powerhouse/)
- [Docker Blog: cagent](https://www.docker.com/blog/cagent-build-and-distribute-ai-agents-and-workflows/)
- [Google Blog: K8s Agent Sandbox](https://opensource.googleblog.com/2025/11/unleashing-autonomous-ai-agents-why-kubernetes-needs-a-new-standard-for-agent-execution.html)
- [AI Maestro: From 47 Terminal Windows to One Dashboard](https://medium.com/23blocks/building-ai-maestro-from-47-terminal-windows-to-one-beautiful-dashboard-64cd25ff3b43)
- [OpenAI Codex Jira-GitHub Cookbook](https://developers.openai.com/cookbook/examples/codex/jira-github)
- [Open Source AI Agent Frameworks Compared 2026](https://openagents.org/blog/posts/2026-02-23-open-source-ai-agent-frameworks-compared)
