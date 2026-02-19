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
  name: "opencode",
  slot: "agent" as const,
  description: "Agent plugin: OpenCode",
  version: "0.1.0",
};

// =============================================================================
// Agent Implementation
// =============================================================================

function createOpenCodeAgent(): Agent {
  return {
    name: "opencode",
    processName: "opencode",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const parts: string[] = ["opencode"];

      if (config.prompt) {
        parts.push("run", shellEscape(config.prompt));
      }

      if (config.model) {
        parts.push("--model", shellEscape(config.model));
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
      // OpenCode doesn't have rich terminal output patterns yet
      return "active";
    },

    async getActivityState(session: Session, _readyThresholdMs?: number): Promise<ActivityDetection | null> {
      // Check if process is running first
      if (!session.runtimeHandle) return { state: "exited" };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited" };

      // NOTE: OpenCode stores all session data in a single global SQLite database
      // at ~/.local/share/opencode/opencode.db without per-workspace scoping. When
      // multiple OpenCode sessions run in parallel, database modifications from any
      // session will cause all sessions to appear active. Until OpenCode provides
      // per-workspace session tracking, we return null (unknown) rather than guessing.
      //
      // TODO: Implement proper per-session activity detection when OpenCode supports it.
      return null;
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      return isAgentProcessRunning(handle, "opencode");
    },

    async getSessionInfo(_session: Session): Promise<AgentSessionInfo | null> {
      // OpenCode doesn't have JSONL session files for introspection yet
      return null;
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createOpenCodeAgent();
}

export default { manifest, create } satisfies PluginModule<Agent>;
