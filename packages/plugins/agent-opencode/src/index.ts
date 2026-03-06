import {
  shellEscape,
  asValidOpenCodeSessionId,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type ActivityDetection,
  type ActivityState,
  type PluginModule,
  type RuntimeHandle,
  type Session,
} from "@composio/ao-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface OpenCodeSessionListEntry {
  id: string;
  title?: string;
  updated?: string;
}

function parseSessionList(raw: string): OpenCodeSessionListEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is OpenCodeSessionListEntry => {
    if (!item || typeof item !== "object") return false;
    const record = item as Record<string, unknown>;
    return asValidOpenCodeSessionId(record["id"]) !== undefined;
  });
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

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
      const options: string[] = [];
      const sharedOptions: string[] = [];

      const existingSessionId = asOptionalString(
        config.projectConfig.agentConfig?.["opencodeSessionId"],
      );

      if (existingSessionId) {
        options.push("--session", shellEscape(existingSessionId));
      }

      // Select specific OpenCode subagent if configured
      if (config.subagent) {
        sharedOptions.push("--agent", shellEscape(config.subagent));
      }

      let promptValue: string | undefined;
      if (config.prompt) {
        if (config.systemPromptFile) {
          promptValue = `"$(cat ${shellEscape(config.systemPromptFile)}; printf '\\n\\n'; printf %s ${shellEscape(config.prompt)})"`;
        } else if (config.systemPrompt) {
          promptValue = shellEscape(`${config.systemPrompt}\n\n${config.prompt}`);
        } else {
          promptValue = shellEscape(config.prompt);
        }
      } else if (config.systemPromptFile) {
        promptValue = `"$(cat ${shellEscape(config.systemPromptFile)})"`;
      } else if (config.systemPrompt) {
        promptValue = shellEscape(config.systemPrompt);
      }

      if (config.model) {
        sharedOptions.push("--model", shellEscape(config.model));
      }

      if (!existingSessionId) {
        const runOptions = ["--title", shellEscape(`AO:${config.sessionId}`), ...sharedOptions];
        const runCommand = promptValue
          ? ["opencode", "run", "--format", "json", ...runOptions, promptValue].join(" ")
          : ["opencode", "run", "--format", "json", ...runOptions, "--command", "true"].join(" ");

        const captureSessionId = [
          "node",
          "-e",
          shellEscape(
            "let buf='';process.stdin.on('data',c=>buf+=c).on('end',()=>{const lines=buf.toString().split('\\n');for(const line of lines){if(!line.trim())continue;try{const evt=JSON.parse(line);if(evt.type==='step_start'&&evt.session_id){process.stdout.write(evt.session_id);process.exit(0);}}catch{}}process.exit(1);})",
          ),
        ].join(" ");

        const fallbackSessionId = `opencode session list --format json | node -e ${shellEscape("let input='';process.stdin.on('data',c=>input+=c).on('end',()=>{const title=process.argv[1];let rows;try{rows=JSON.parse(input)}catch{process.exit(1)};if(!Array.isArray(rows))process.exit(1);const matches=rows.filter(r=>r&&r.title===title&&typeof r.id==='string').sort((a,b)=>new Date(b.updated||0)-new Date(a.updated||0));if(matches.length===0)process.exit(1);process.stdout.write(matches[0].id);});")} ${shellEscape(`AO:${config.sessionId}`)}`;

        const sessionIdCapture = `"$( { ${runCommand} | ${captureSessionId}; } || ${fallbackSessionId} )"`;

        const continueCommand = ["opencode", "--session", sessionIdCapture, ...sharedOptions].join(
          " ",
        );
        return `exec ${continueCommand}`;
      }

      if (promptValue) {
        options.push("--prompt", promptValue);
      }

      options.push(...sharedOptions);

      return ["opencode", ...options].join(" ");
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

    async getActivityState(
      session: Session,
      _readyThresholdMs?: number,
    ): Promise<ActivityDetection | null> {
      // Check if process is running first
      const exitedAt = new Date();
      if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited", timestamp: exitedAt };

      if (session.metadata?.opencodeSessionId) {
        try {
          const { stdout } = await execFileAsync(
            "opencode",
            ["session", "list", "--format", "json"],
            { timeout: 30_000 },
          );

          const sessions = parseSessionList(stdout);
          const targetSession = sessions.find((s) => s.id === session.metadata.opencodeSessionId);

          if (targetSession) {
            const lastActivity = targetSession.updated
              ? new Date(targetSession.updated)
              : undefined;
            return {
              state: "active",
              ...(lastActivity &&
                !Number.isNaN(lastActivity.getTime()) && { timestamp: lastActivity }),
            };
          }
        } catch {
          return null;
        }
      }

      return null;
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      try {
        if (handle.runtimeName === "tmux" && handle.id) {
          const { stdout: ttyOut } = await execFileAsync(
            "tmux",
            ["list-panes", "-t", handle.id, "-F", "#{pane_tty}"],
            { timeout: 30_000 },
          );
          const ttys = ttyOut
            .trim()
            .split("\n")
            .map((t) => t.trim())
            .filter(Boolean);
          if (ttys.length === 0) return false;

          const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid,tty,args"], {
            timeout: 30_000,
          });
          const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
          const processRe = /(?:^|\/)opencode(?:\s|$)/;
          for (const line of psOut.split("\n")) {
            const cols = line.trimStart().split(/\s+/);
            if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
            const args = cols.slice(2).join(" ");
            if (processRe.test(args)) {
              return true;
            }
          }
          return false;
        }

        const rawPid = handle.data["pid"];
        const pid = typeof rawPid === "number" ? rawPid : Number(rawPid);
        if (Number.isFinite(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            return true;
          } catch (err: unknown) {
            if (err instanceof Error && "code" in err && err.code === "EPERM") {
              return true;
            }
            return false;
          }
        }

        return false;
      } catch {
        return false;
      }
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
