/**
 * OpenClaw Plugin: Agent Orchestrator v0.3.0
 *
 * Open-source, pluggable agentic coding orchestrator. Manages durable coding
 * agents (Claude Code, Codex, OpenCode) and wires up feedback loops so PR
 * reviews and CI failures automatically route to the right agent.
 *
 * Provides:
 * - Hook: injects live repo data into AI context for work-related messages
 * - Slash command: /ao (with subcommands)
 * - 14 agent tools: ao_sessions, ao_session_list, ao_status, ao_issues,
 *   ao_spawn, ao_batch_spawn, ao_send, ao_kill, ao_doctor, ao_review_check,
 *   ao_verify, ao_session_cleanup, ao_session_restore, ao_session_claim_pr
 * - Background services: health monitoring + issue board scanner + auto follow-up
 */

import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PluginConfig {
  aoPath?: string;
  aoCwd?: string;
  ghPath?: string;
  healthPollIntervalMs?: number;
  boardScanIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runCmd(bin: string, args: string[], timeoutMs: number = 15_000, cwd?: string): string {
  return execFileSync(bin, args, {
    encoding: "utf-8",
    timeout: timeoutMs,
    cwd,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  }).trim();
}

function tryRun(
  bin: string,
  args: string[],
  timeoutMs?: number,
  cwd?: string,
): { ok: true; output: string } | { ok: false; error: string } {
  try {
    return { ok: true, output: runCmd(bin, args, timeoutMs, cwd) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

function tryRunAo(config: PluginConfig, args: string[], timeoutMs?: number) {
  // AO requires cwd to be the repo root where agent-orchestrator.yaml lives
  const cwd = config.aoCwd || process.cwd();
  return tryRun(config.aoPath || "ao", args, timeoutMs, cwd);
}

function tryRunGh(config: PluginConfig, args: string[], timeoutMs?: number) {
  // Run gh from aoCwd so default-repo queries resolve correctly
  const cwd = config.aoCwd || process.cwd();
  return tryRun(config.ghPath || "gh", args, timeoutMs, cwd);
}

// ---------------------------------------------------------------------------
// Issue board helpers
// ---------------------------------------------------------------------------

interface GitHubIssue {
  number: number;
  title: string;
  labels: Array<{ name: string }>;
  state: string;
  assignees: Array<{ login: string }>;
  createdAt: string;
  url: string;
}

function fetchIssues(config: PluginConfig, repo?: string): GitHubIssue[] {
  const args = ["issue", "list"];
  if (repo) args.push("-R", repo);
  args.push("--state", "open", "--json", "number,title,labels,state,assignees,createdAt,url", "--limit", "30");
  const result = tryRunGh(
    config,
    args,
    15_000,
  );
  if (!result.ok) return [];
  try {
    return JSON.parse(result.output) as GitHubIssue[];
  } catch {
    return [];
  }
}

function formatIssueList(issues: GitHubIssue[]): string {
  if (issues.length === 0) return "No open issues found.";
  return issues
    .map((issue, i) => {
      const labels = issue.labels.map((l) => l.name).join(", ");
      const labelStr = labels ? ` [${labels}]` : "";
      return `${i + 1}. #${issue.number} — ${issue.title}${labelStr}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Spawn with silent retry
// ---------------------------------------------------------------------------

async function spawnWithRetry(
  config: PluginConfig,
  issueArgs: string[],
  maxRetries: number = 3,
): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  let lastResult: { ok: true; output: string } | { ok: false; error: string } | undefined;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    lastResult = tryRunAo(config, issueArgs, 30_000);
    if (lastResult.ok) return lastResult;
    // Only retry on transient errors, not config/auth errors
    if (
      lastResult.error.includes("not found") ||
      lastResult.error.includes("not configured") ||
      lastResult.error.includes("401")
    ) {
      return lastResult;
    }
    if (attempt < maxRetries - 1) {
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
  return lastResult!;
}

// ---------------------------------------------------------------------------
// Work-trigger detection
// ---------------------------------------------------------------------------

const WORK_TRIGGERS = [
  "what needs", "what should i", "what do i need",
  "start working", "morning", "let's go", "lets go",
  "what's going on", "whats going on", "status update",
  "check my repos", "check my issues", "check issues",
  "any issues", "what's on the board", "whats on the board",
  "what can i work on", "what to work on", "work on today",
  "what's open", "whats open", "open issues",
  "scan my repos", "scan repos", "scan issues",
  "engineering update", "dev update", "project update",
  "anything to do", "what's pending", "whats pending",
  "ready to work", "what's the plan", "whats the plan",
];

function isWorkRelated(message: string): boolean {
  const lower = message.toLowerCase();
  return WORK_TRIGGERS.some((t) => lower.includes(t));
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export default function (api: any) {
  const config: PluginConfig = (api.pluginConfig as PluginConfig) || {};

  // =========================================================================
  // HOOKS — intercept work-related messages and inject live data
  //
  // OpenClaw hook names (see docs.openclaw.ai/concepts/agent-loop):
  //   message_received  — inbound message arrives from any channel
  //   before_prompt_build — runs after session load, can inject context via
  //                         event.appendSystemContext / event.prependContext
  // =========================================================================

  /** Build a live-data context block from AO + GitHub */
  function buildLiveContext(): string | null {
    try {
      const issues = fetchIssues(config);
      const sessionsResult = tryRunAo(config, ["status"], 10_000);

      const issuesSummary =
        issues.length > 0
          ? `Open issues (${issues.length}):\n${formatIssueList(issues)}`
          : "No open issues across your repos.";

      const sessionsSummary = sessionsResult.ok
        ? `Active sessions:\n${sessionsResult.output}`
        : "No active AO sessions (or AO not running).";

      return [
        "=== LIVE AGENT ORCHESTRATOR DATA (just fetched — use this, NOT your memory) ===",
        "",
        issuesSummary,
        "",
        sessionsSummary,
        "",
        "INSTRUCTIONS: Present this data to the user. Recommend which issues to start agents on.",
        "Ask for approval before spawning. Use ao_batch_spawn after they approve.",
        "Do NOT answer from memory about their projects — this live data supersedes everything.",
        "=== END LIVE DATA ===",
      ].join("\n");
    } catch (err) {
      api.logger.warn(`[ao-hook] Failed to build live context: ${err}`);
      return null;
    }
  }

  // Track pending work-related messages per session/channel to avoid
  // cross-conversation interference. Uses Map with timestamps for TTL cleanup.
  const pendingWorkSessions = new Map<string, number>();
  const PENDING_TTL_MS = 60_000; // 60s — if prompt build doesn't fire, clean up

  function cleanStalePending() {
    const now = Date.now();
    for (const [key, ts] of pendingWorkSessions) {
      if (now - ts > PENDING_TTL_MS) pendingWorkSessions.delete(key);
    }
  }

  function getSessionKey(event: any): string {
    return event?.sessionKey || event?.sessionId || event?.channelId || "default";
  }

  // Hook 1: message_received — detect work-related inbound messages
  const onMessageReceived = async (event: any) => {
    const message =
      event?.message?.text ||
      event?.message?.content ||
      event?.text ||
      event?.content ||
      "";

    if (isWorkRelated(message)) {
      cleanStalePending();
      pendingWorkSessions.set(getSessionKey(event), Date.now());
      api.logger.info("[ao-hook] Work-related message detected, will inject context");
    }
  };

  // Hook 2: before_prompt_build — inject AO routing context + live data
  const onBeforePromptBuild = async (event: any) => {
    const key = getSessionKey(event);

    // Inform the model that AO is available and what it offers.
    // Not a command — just context so the model can make an informed choice.
    const routingContext = [
      "[Agent Orchestrator] This project has AO installed — an open-source orchestrator " +
      "for durable coding agents (Claude Code, Codex, OpenCode). ao_spawn creates an " +
      "isolated git worktree, starts an agent, and wires up feedback loops so PR reviews " +
      "and CI failures automatically route to the right agent.",
    ];

    // If this is a work-related message, also inject live repo data
    if (pendingWorkSessions.has(key)) {
      pendingWorkSessions.delete(key);
      api.logger.info("[ao-hook] Injecting live data into prompt context...");
      const context = buildLiveContext();
      if (context) routingContext.push(context);
    }

    const fullContext = routingContext.join("\n\n");

    // OpenClaw before_prompt_build supports these injection points:
    if (typeof event.appendSystemContext === "function") {
      event.appendSystemContext(fullContext);
    } else if (typeof event.prependContext === "function") {
      event.prependContext(fullContext);
    } else if (event.context && typeof event.context === "object") {
      // Fallback: write to context object directly
      event.context.aoLiveData = fullContext;
    } else if (event.messages && Array.isArray(event.messages)) {
      // Last resort: push a system message
      event.messages.push({ role: "system", content: fullContext });
    }

    api.logger.info("[ao-hook] Injected AO context into prompt");
  };

  // Register hooks using the correct OpenClaw event names
  const register = (name: string, handler: (event: any) => Promise<void>) => {
    try {
      if (typeof api.on === "function") {
        api.on(name, handler, { priority: 10 });
      } else if (typeof api.registerHook === "function") {
        api.registerHook(name, handler, { priority: 10 });
      }
    } catch {
      api.logger.warn(`[ao-hook] Failed to register hook: ${name}`);
    }
  };

  register("message_received", onMessageReceived);
  register("before_prompt_build", onBeforePromptBuild);

  api.logger.info("[ao-hook] Hooks registered (message_received, before_prompt_build)");

  // =========================================================================
  // SLASH COMMAND — single /ao command with subcommand parsing
  // =========================================================================

  api.registerCommand({
    name: "ao",
    description:
      "Agent Orchestrator — /ao sessions | status | spawn | issues | batch-spawn | retry | kill | doctor",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const raw = (ctx.args || "").trim();
      const parts = raw.split(/\s+/);
      const subcommand = parts[0]?.toLowerCase() || "help";
      const rest = parts.slice(1).join(" ").trim();

      // Sanitize user input: strip leading dashes to prevent flag injection
      const sanitizeArg = (arg: string): string => arg.replace(/^-+/, "");
      const isValidIssueId = (s: string): boolean => /^#?\d+$/.test(s.trim());
      const isValidSessionId = (s: string): boolean => /^[\w-]+$/.test(s.trim());

      switch (subcommand) {
        case "sessions": {
          const result = tryRunAo(config, ["status"]);
          if (!result.ok) return { text: `Failed to get sessions:\n${result.error}` };
          return { text: result.output || "No active sessions." };
        }

        case "status": {
          // `ao status` shows all sessions; no per-session lookup available
          const result = tryRunAo(config, ["status"]);
          if (!result.ok) return { text: `Failed:\n${result.error}` };
          return { text: result.output };
        }

        case "spawn": {
          if (!rest) return { text: "Usage: /ao spawn <issue-number>" };
          const issueArg = sanitizeArg(rest.split(/\s+/)[0]);
          if (!isValidIssueId(issueArg)) return { text: `Invalid issue identifier: ${issueArg}. Expected a number like 42 or #42.` };
          const result = await spawnWithRetry(config, ["spawn", issueArg]);
          if (!result.ok) return { text: `Failed to spawn:\n${result.error}` };
          return { text: result.output };
        }

        case "issues": {
          const issues = fetchIssues(config, rest || undefined);
          return { text: formatIssueList(issues) };
        }

        case "batch-spawn": {
          if (!rest) return { text: "Usage: /ao batch-spawn <issue1> <issue2> ..." };
          const issueArgs = rest.split(/\s+/).map(sanitizeArg);
          if (!issueArgs.every(isValidIssueId)) return { text: `Invalid issue identifiers. Expected numbers like: 42 43 44` };
          const result = tryRunAo(config, ["batch-spawn", ...issueArgs], 60_000);
          if (!result.ok) return { text: `Failed to batch-spawn:\n${result.error}` };
          return { text: result.output };
        }

        case "retry": {
          if (!rest) return { text: "Usage: /ao retry <session-id>" };
          const sessionId = sanitizeArg(rest.trim());
          if (!isValidSessionId(sessionId)) return { text: `Invalid session ID: ${rest}. Expected format like ao-42.` };
          const result = tryRunAo(config, ["send", sessionId, "Please retry the failed task."]);
          if (!result.ok) return { text: `Failed to send retry:\n${result.error}` };
          return { text: `Retry sent to session ${sessionId}.` };
        }

        case "kill": {
          if (!rest) return { text: "Usage: /ao kill <session-id>" };
          const sessionId = sanitizeArg(rest.trim());
          if (!isValidSessionId(sessionId)) return { text: `Invalid session ID: ${rest}. Expected format like ao-42.` };
          const result = tryRunAo(config, ["session", "kill", sessionId]);
          if (!result.ok) return { text: `Failed to kill session:\n${result.error}` };
          return { text: `Session ${sessionId} killed.` };
        }

        case "doctor": {
          const result = tryRunAo(config, ["doctor"], 30_000);
          if (!result.ok) return { text: `Failed to run doctor:\n${result.error}` };
          return { text: result.output };
        }

        case "setup": {
          // Auto-configure OpenClaw settings for AO plugin
          const steps: string[] = [];
          const runSetup = (bin: string, args: string[]): boolean => {
            try {
              execFileSync(bin, args, { encoding: "utf-8", timeout: 10_000 });
              return true;
            } catch {
              return false;
            }
          };

          // 1. tools.profile must be "full" for plugin tools to be visible
          if (runSetup("openclaw", ["config", "set", "tools.profile", "full"]))
            steps.push("✅ tools.profile → full");
          else steps.push("❌ Failed to set tools.profile");

          // 2. Allow plugin tools
          if (runSetup("openclaw", ["config", "set", "tools.allow", '["group:plugins"]']))
            steps.push("✅ tools.allow → group:plugins");
          else steps.push("❌ Failed to set tools.allow");

          // 3. Trust the plugin
          if (runSetup("openclaw", ["config", "set", "plugins.allow", '["agent-orchestrator"]']))
            steps.push("✅ plugins.allow → agent-orchestrator");
          else steps.push("❌ Failed to set plugins.allow");

          // 4. Group chat settings
          if (runSetup("openclaw", ["config", "set", "messages.groupChat.historyLimit", "100"]))
            steps.push("✅ historyLimit → 100");
          else steps.push("⚠️ Could not set historyLimit");

          steps.push("");
          steps.push("⚡ Restart the gateway to apply: pm2 restart openclaw-gateway");
          steps.push("Then verify with: /ao doctor");

          return { text: `AO Plugin Setup\n\n${steps.join("\n")}` };
        }

        default:
          return {
            text: [
              "Agent Orchestrator commands:",
              "  /ao sessions              — list all sessions",
              "  /ao status                — all sessions overview",
              "  /ao issues [owner/repo]   — list open issues",
              "  /ao spawn <issue>         — spawn agent on issue",
              "  /ao batch-spawn <i1> <i2> — spawn multiple agents",
              "  /ao retry <id>            — retry failed session",
              "  /ao kill <id>             — kill a session",
              "  /ao doctor                — run health checks",
              "  /ao setup                 — auto-configure OpenClaw for AO",
            ].join("\n"),
          };
      }
    },
  });

  // =========================================================================
  // AGENT TOOLS
  // =========================================================================

  api.registerTool({
    name: "ao_sessions",
    description:
      "Returns live session data from Agent Orchestrator — what agents are running, " +
      "their status, branches, and progress. Use when the user asks about status or progress.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      const result = tryRunAo(config, ["status"]);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Failed to get sessions: ${result.error}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: result.output || "No active sessions." }],
      };
    },
  });

  api.registerTool({
    name: "ao_issues",
    description:
      "Returns live GitHub issue data — open issues, labels, assignees, and priorities. " +
      "Use when the user asks about work, tasks, issues, or what needs attention.",
    parameters: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "GitHub repo in owner/repo format. Omit to scan the default repo.",
        },
        labels: {
          type: "string",
          description: "Comma-separated label filter (e.g. 'bug,P1'). Optional.",
        },
      },
      required: [],
    },
    async execute(_toolCallId: string, params: { repo?: string; labels?: string }) {
      const ghArgs = ["issue", "list"];
      if (params.repo) ghArgs.push("-R", params.repo);
      if (params.labels) ghArgs.push("--label", params.labels);
      ghArgs.push("--state", "open", "--json", "number,title,labels,state,assignees,createdAt,url", "--limit", "30");
      const result = tryRunGh(
        config,
        ghArgs,
        15_000,
      );
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Failed to fetch issues: ${result.error}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: result.output }] };
    },
  });

  api.registerTool({
    name: "ao_spawn",
    description:
      "Spawn a durable coding agent (Claude Code, Codex, or OpenCode) on a task. " +
      "Creates an isolated git worktree, starts the agent, and wires up feedback " +
      "loops — CI failures and PR reviews automatically route back to the agent. " +
      "Works with issue numbers (#42) or without for freeform tasks.",
    parameters: {
      type: "object",
      properties: {
        issue: { type: "string", description: "Issue identifier (e.g. #42). Optional — omit for freeform tasks, then use ao_send to describe the work." },
        agent: { type: "string", description: "Override agent plugin (e.g. codex, claude-code)" },
        claimPr: { type: "string", description: "Immediately claim an existing PR number for the session" },
        decompose: { type: "boolean", description: "Decompose issue into subtasks before spawning" },
      },
    },
    async execute(
      _toolCallId: string,
      params: { issue?: string; agent?: string; claimPr?: string; decompose?: boolean },
    ) {
      const args = ["spawn"];
      if (params.issue) {
        args.push(params.issue);
      } else {
        // Freeform spawn — ao CLI supports bare `ao spawn` which creates
        // a session without an issue. Use ao_send afterward to describe the task.
        api.logger.info("[ao_spawn] Spawning without issue — freeform session");
      }
      if (params.agent) args.push("--agent", params.agent);
      if (params.claimPr) args.push("--claim-pr", params.claimPr);
      if (params.decompose) args.push("--decompose");
      const result = await spawnWithRetry(config, args);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Failed to spawn: ${result.error}` }],
          isError: true,
        };
      }
      const spawnOutput = params.issue
        ? result.output
        : result.output + "\n\nNote: This is a freeform session (no issue). Use ao_send to describe the task to the agent.";
      return { content: [{ type: "text", text: spawnOutput }] };
    },
  });

  api.registerTool({
    name: "ao_batch_spawn",
    description:
      "Spawn durable coding agents for multiple GitHub issues in parallel. " +
      "Always confirm the list with the user before calling this. " +
      "Each agent gets its own isolated worktree with CI and PR review feedback loops.",
    parameters: {
      type: "object",
      properties: {
        issues: {
          type: "array",
          items: { type: "string" },
          description: "List of GitHub issue numbers",
        },
      },
      required: ["issues"],
    },
    async execute(_toolCallId: string, params: { issues: string[] }) {
      const result = tryRunAo(config, ["batch-spawn", ...params.issues], 60_000);

      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Failed to batch-spawn: ${result.error}` }],
          isError: true,
        };
      }

      // Schedule auto follow-ups
      const checkStatus = (label: string) => {
        const status = tryRunAo(config, ["status"], 10_000);
        const msg = status.ok ? status.output : "Could not reach AO for status check.";
        try {
          api.runtime?.sendMessageToDefaultSession?.(
            `${label}:\n\n${msg}\n\nNeed me to do anything?`,
          );
        } catch {
          api.logger.info(`[ao-followup] ${label}: ${msg}`);
        }
      };

      batchSpawnFollowUpTimeouts.push(setTimeout(() => checkStatus("Progress check (3 min)"), 3 * 60_000));
      batchSpawnFollowUpTimeouts.push(setTimeout(() => checkStatus("Status update (8 min)"), 8 * 60_000));

      api.logger.info("[ao-batch] Scheduled auto follow-ups at 3min and 8min");

      return {
        content: [
          {
            type: "text",
            text:
              result.output +
              "\n\nI'll check status automatically in a few minutes and update you.",
          },
        ],
      };
    },
  });

  api.registerTool({
    name: "ao_send",
    description: "Send a message to a running Agent Orchestrator session.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "The AO session ID (e.g. ao-5)" },
        message: { type: "string", description: "Message to send" },
      },
      required: ["sessionId", "message"],
    },
    async execute(_toolCallId: string, params: { sessionId: string; message: string }) {
      const result = tryRunAo(config, ["send", params.sessionId, params.message]);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Failed to send: ${result.error}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `Message sent to ${params.sessionId}.` }],
      };
    },
  });

  api.registerTool({
    name: "ao_kill",
    description:
      "Kill an Agent Orchestrator session. Always confirm with the user before calling this.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "The AO session ID to kill" },
      },
      required: ["sessionId"],
    },
    async execute(_toolCallId: string, params: { sessionId: string }) {
      const result = tryRunAo(config, ["session", "kill", params.sessionId]);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Failed to kill: ${result.error}` }],
          isError: true,
        };
      }
      return {
        content: [
          { type: "text", text: `Session ${params.sessionId} killed and worktree cleaned up.` },
        ],
      };
    },
  });

  api.registerTool({
    name: "ao_doctor",
    description: "Run Agent Orchestrator health checks. Use when troubleshooting.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      const result = tryRunAo(config, ["doctor"], 30_000);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Doctor failed: ${result.error}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: result.output }] };
    },
  });

  api.registerTool({
    name: "ao_review_check",
    description:
      "Check PRs for review comments and trigger agents to address them. " +
      "Use when the user asks to check reviews, handle PR feedback, or address reviewer comments. " +
      "Optionally pass a project ID to filter.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project ID (checks all if omitted)" },
        dryRun: { type: "boolean", description: "Show what would be done without acting" },
      },
      required: [],
    },
    async execute(_toolCallId: string, params: { project?: string; dryRun?: boolean }) {
      const args = ["review-check"];
      if (params.project) args.push(params.project);
      if (params.dryRun) args.push("--dry-run");
      const result = tryRunAo(config, args, 30_000);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Review check failed: ${result.error}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: result.output || "No review comments to address." }] };
    },
  });

  api.registerTool({
    name: "ao_verify",
    description:
      "Mark an issue as verified (or failed) after checking the fix on staging. " +
      "Use when the user confirms a fix works or reports it doesn't. " +
      "Use with --list to show all merged-but-unverified issues.",
    parameters: {
      type: "object",
      properties: {
        issue: { type: "string", description: "Issue number to verify" },
        project: { type: "string", description: "Project ID (required if multiple projects)" },
        fail: { type: "boolean", description: "Mark verification as failed instead of passing" },
        comment: { type: "string", description: "Custom comment to add" },
        list: { type: "boolean", description: "List all issues with merged-unverified label" },
      },
      required: [],
    },
    async execute(
      _toolCallId: string,
      params: { issue?: string; project?: string; fail?: boolean; comment?: string; list?: boolean },
    ) {
      const args = ["verify"];
      if (params.list) {
        args.push("--list");
        if (params.project) args.push("-p", params.project);
      } else {
        if (!params.issue) {
          return {
            content: [{ type: "text", text: "Need an issue number. Use list: true to see unverified issues." }],
            isError: true,
          };
        }
        args.push(params.issue);
        if (params.project) args.push("-p", params.project);
        if (params.fail) args.push("--fail");
        if (params.comment) args.push("-c", params.comment);
      }
      const result = tryRunAo(config, args, 15_000);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Verify failed: ${result.error}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: result.output }] };
    },
  });

  api.registerTool({
    name: "ao_session_cleanup",
    description:
      "Kill sessions where the PR is merged or the issue is closed. " +
      "Cleans up stale sessions. Use dry-run first to preview.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project ID to filter" },
        dryRun: { type: "boolean", description: "Preview what would be cleaned up" },
      },
      required: [],
    },
    async execute(_toolCallId: string, params: { project?: string; dryRun?: boolean }) {
      const args = ["session", "cleanup"];
      if (params.project) args.push("-p", params.project);
      if (params.dryRun) args.push("--dry-run");
      const result = tryRunAo(config, args, 30_000);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Cleanup failed: ${result.error}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: result.output || "No sessions to clean up." }] };
    },
  });

  api.registerTool({
    name: "ao_session_restore",
    description:
      "Restore a terminated or crashed agent session in-place. " +
      "Use when a session died unexpectedly and needs to resume.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session name to restore" },
      },
      required: ["sessionId"],
    },
    async execute(_toolCallId: string, params: { sessionId: string }) {
      const result = tryRunAo(config, ["session", "restore", params.sessionId], 30_000);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Restore failed: ${result.error}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: result.output }] };
    },
  });

  api.registerTool({
    name: "ao_session_claim_pr",
    description:
      "Attach an existing PR to an agent session. " +
      "Use when there's a PR that was created outside AO that should be tracked.",
    parameters: {
      type: "object",
      properties: {
        pr: { type: "string", description: "Pull request number or URL" },
        sessionId: { type: "string", description: "Session name (optional)" },
        assignOnGithub: { type: "boolean", description: "Assign the PR to the authenticated GitHub user" },
      },
      required: ["pr"],
    },
    async execute(
      _toolCallId: string,
      params: { pr: string; sessionId?: string; assignOnGithub?: boolean },
    ) {
      const args = ["session", "claim-pr", params.pr];
      if (params.sessionId) args.push(params.sessionId);
      if (params.assignOnGithub) args.push("--assign-on-github");
      const result = tryRunAo(config, args, 15_000);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Claim PR failed: ${result.error}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: result.output }] };
    },
  });

  api.registerTool({
    name: "ao_session_list",
    description:
      "List all agent sessions with detailed info. " +
      "Use for a comprehensive session listing. For a quick status overview, use ao_sessions instead.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project ID to filter" },
      },
      required: [],
    },
    async execute(_toolCallId: string, params: { project?: string }) {
      const args = ["session", "ls"];
      if (params.project) args.push("-p", params.project);
      const result = tryRunAo(config, args, 15_000);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Session list failed: ${result.error}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: result.output || "No sessions found." }] };
    },
  });

  api.registerTool({
    name: "ao_status",
    description:
      "Show all sessions with branch, activity, PR, and CI status. " +
      "Returns JSON when requested. Use for a comprehensive dashboard view.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Filter by project ID" },
        json: { type: "boolean", description: "Return output as JSON for easier parsing" },
      },
      required: [],
    },
    async execute(_toolCallId: string, params: { project?: string; json?: boolean }) {
      const args = ["status"];
      if (params.project) args.push("-p", params.project);
      if (params.json) args.push("--json");
      const result = tryRunAo(config, args, 15_000);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Status failed: ${result.error}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: result.output }] };
    },
  });

  // =========================================================================
  // BACKGROUND SERVICES
  // =========================================================================

  let healthInterval: ReturnType<typeof setInterval> | null = null;
  let boardScanInterval: ReturnType<typeof setInterval> | null = null;
  let boardScanInitialTimeout: ReturnType<typeof setTimeout> | null = null;
  const batchSpawnFollowUpTimeouts: ReturnType<typeof setTimeout>[] = [];
  let lastKnownIssueIds: Set<number> = new Set();
  let isFirstBoardScan = true;

  // --- Health monitor ---
  api.registerService({
    id: "ao-health",
    start: async () => {
      const pollMs = config.healthPollIntervalMs ?? 30_000;
      if (pollMs <= 0) return;

      api.logger.info(`[ao-health] Starting (every ${pollMs / 1000}s)`);
      healthInterval = setInterval(() => {
        const result = tryRunAo(config, ["status"], 10_000);
        if (!result.ok) {
          api.logger.warn(`[ao-health] AO unreachable: ${result.error}`);
        }
      }, pollMs);
    },
    stop: async () => {
      if (healthInterval) {
        clearInterval(healthInterval);
        healthInterval = null;
      }
      // Clear any pending batch-spawn follow-up timeouts
      for (const t of batchSpawnFollowUpTimeouts.splice(0)) {
        clearTimeout(t);
      }
    },
  });

  // --- Issue board scanner ---
  api.registerService({
    id: "ao-board-scanner",
    start: async () => {
      const scanMs = config.boardScanIntervalMs ?? 1_800_000;
      if (scanMs <= 0) return;

      api.logger.info(`[ao-board-scanner] Starting (every ${scanMs / 60_000}min)`);

      const scan = () => {
        try {
          const issues = fetchIssues(config);
          const currentIds = new Set(issues.map((i) => i.number));

          if (isFirstBoardScan) {
            lastKnownIssueIds = currentIds;
            isFirstBoardScan = false;
            api.logger.info(`[ao-board-scanner] Baseline: ${currentIds.size} open issues`);
            return;
          }

          const newIssues = issues.filter((i) => !lastKnownIssueIds.has(i.number));

          if (newIssues.length > 0) {
            const summary = newIssues
              .map((i) => {
                const labels = i.labels.map((l) => l.name).join(", ");
                return `#${i.number} — ${i.title}${labels ? ` [${labels}]` : ""}`;
              })
              .join("\n");

            api.logger.info(`[ao-board-scanner] ${newIssues.length} new issue(s)`);

            try {
              api.runtime?.sendMessageToDefaultSession?.(
                `New issues detected:\n\n${summary}\n\nWant me to start agents on any of these?`,
              );
            } catch {
              api.logger.info(`[ao-board-scanner] New issues:\n${summary}`);
            }
          }

          lastKnownIssueIds = currentIds;
        } catch (err) {
          api.logger.warn(`[ao-board-scanner] Scan failed: ${err}`);
        }
      };

      boardScanInitialTimeout = setTimeout(scan, 10_000);
      boardScanInterval = setInterval(scan, scanMs);
    },
    stop: async () => {
      if (boardScanInitialTimeout) {
        clearTimeout(boardScanInitialTimeout);
        boardScanInitialTimeout = null;
      }
      if (boardScanInterval) {
        clearInterval(boardScanInterval);
        boardScanInterval = null;
      }
    },
  });
}
