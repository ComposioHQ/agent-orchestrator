import {
  shellEscape,
  isAgentProcessRunning,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type ActivityDetection,
  type ActivityState,
  type PluginModule,
  type RuntimeHandle,
  type Session,
} from "@composio/ao-core";

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "codex",
  slot: "agent" as const,
  description: "Agent plugin: OpenAI Codex CLI",
  version: "0.1.0",
};

// =============================================================================
// Agent Implementation
// =============================================================================

function createCodexAgent(): Agent {
  return {
    name: "codex",
    processName: "codex",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const parts: string[] = ["codex"];

      if (config.permissions === "skip") {
        parts.push("--approval-mode", "full-auto");
      }

      if (config.model) {
        parts.push("--model", shellEscape(config.model));
      }

      if (config.systemPromptFile) {
        parts.push("--system-prompt", `"$(cat ${shellEscape(config.systemPromptFile)})"`);
      } else if (config.systemPrompt) {
        parts.push("--system-prompt", shellEscape(config.systemPrompt));
      }

      if (config.prompt) {
        // Use `--` to end option parsing so prompts starting with `-` aren't
        // misinterpreted as flags.
        parts.push("--", shellEscape(config.prompt));
      }

      return parts.join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;
      // NOTE: AO_PROJECT_ID is the caller's responsibility (spawn.ts sets it)
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }
      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      if (!terminalOutput.trim()) return "idle";
      // Codex doesn't have rich terminal output patterns yet
      return "active";
    },

    async getActivityState(session: Session, _readyThresholdMs?: number): Promise<ActivityDetection | null> {
      // Check if process is running first
      if (!session.runtimeHandle) return { state: "exited" };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited" };

      // NOTE: Codex stores rollout files in a global ~/.codex/sessions/ directory
      // without workspace-specific scoping. When multiple Codex sessions run in
      // parallel, we cannot reliably determine which rollout file belongs to which
      // session. Until Codex provides per-workspace session tracking, we return
      // null (unknown) rather than guessing. See issue #13 for details.
      //
      // TODO: Implement proper per-session activity detection when Codex supports it.
      return null;
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      return isAgentProcessRunning(handle, "codex");
    },

    async getSessionInfo(_session: Session): Promise<AgentSessionInfo | null> {
      // Codex doesn't have JSONL session files for introspection yet
      return null;
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createCodexAgent();
}

export default { manifest, create } satisfies PluginModule<Agent>;
