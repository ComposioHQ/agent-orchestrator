import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type PluginModule,
  type Runtime,
  type RuntimeCreateConfig,
  type RuntimeHandle,
  type RuntimeMetrics,
  type AttachInfo,
  shellEscape,
} from "@aoagents/ao-core";
import {
  resolveCommsFiles,
  createCommsFiles,
  appendInboxMessage,
  appendMessage,
  generateDedupKey,
  setupComms,
  readNewMessages,
  readEpoch,
  watchDirectory,
  AGENT_EVENTS_FILE,
  type SessionCommsFiles,
} from "@aoagents/ao-plugin-runtime-file";
} from "@aoagents/ao-plugin-runtime-file";

const execFileAsync = promisify(execFile);
const TMUX_COMMAND_TIMEOUT_MS = 5_000;

export const manifest = {
  name: "tmux",
  slot: "runtime" as const,
  description: "Runtime plugin: tmux sessions",
  version: "0.1.0",
};

const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

function assertValidSessionId(id: string): void {
  if (!SAFE_SESSION_ID.test(id)) {
    throw new Error(`Invalid session ID "${id}": must match ${SAFE_SESSION_ID}`);
  }
}

function writeLaunchScript(command: string): string {
  const scriptPath = join(tmpdir(), `ao-launch-${randomUUID()}.sh`);
  const content = `#!/usr/bin/env bash\nrm -- "$0" 2>/dev/null || true\n${command}\n`;
  writeFileSync(scriptPath, content, { encoding: "utf-8", mode: 0o700 });
  return `bash ${shellEscape(scriptPath)}`;
}

async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args, {
    timeout: TMUX_COMMAND_TIMEOUT_MS,
  });
  return stdout.trimEnd();
}

async function setupCommsForSession(
  workspacePath: string,
  sessionsDir: string,
  sessionId: string,
  agentName: string,
): Promise<SessionCommsFiles> {
  const files = resolveCommsFiles(sessionsDir, sessionId);
  createCommsFiles(files);
  try {
    await setupComms(workspacePath, { hooks: agentName === "claude-code" });
  } catch (err) {
    console.warn(`[runtime-tmux] comms setup failed:`, err instanceof Error ? err.message : String(err));
  }
  return files;
}

export function create(): Runtime {
  return {
    name: "tmux",

    async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
      assertValidSessionId(config.sessionId);
      const sessionName = config.sessionId;

      const env = config.environment ?? {};
      const sessionsDir = env["AO_DATA_DIR"] ?? "";
      const agentName = env["AO_AGENT_NAME"] ?? "";

      let files: SessionCommsFiles | null = null;
      if (sessionsDir) {
        files = await setupCommsForSession(
          config.workspacePath,
          sessionsDir,
          config.sessionId,
          agentName,
        );
      }

      const tmuxEnv: Record<string, string> = { ...env };
      if (files) {
        tmuxEnv["AO_INBOX_PATH"] = files.inbox;
        tmuxEnv["AO_AGENT_EVENTS_PATH"] = files.agentEvents;
        tmuxEnv["AO_AGENT_EPOCH"] = String(readEpoch(sessionsDir, config.sessionId));
        tmuxEnv["PATH"] = `${join(config.workspacePath, ".ao")}:${env["PATH"] ?? process.env.PATH ?? ""}`;
      }

      const envArgs: string[] = [];
      for (const [key, value] of Object.entries(tmuxEnv)) {
        envArgs.push("-e", `${key}=${value}`);
      }

      await tmux("new-session", "-d", "-s", sessionName, "-c", config.workspacePath, ...envArgs);

      try {
        if (config.launchCommand.length > 200) {
          const invocation = writeLaunchScript(config.launchCommand);
          await tmux("send-keys", "-t", sessionName, "-l", invocation);
          await sleep(300);
          await tmux("send-keys", "-t", sessionName, "Enter");
        } else {
          await tmux("send-keys", "-t", sessionName, config.launchCommand, "Enter");
        }
      } catch (err: unknown) {
        try {
          await tmux("kill-session", "-t", sessionName);
        } catch {
          // best-effort cleanup
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to send launch command to session "${sessionName}": ${msg}`, {
          cause: err,
        });
      }

      return {
        id: sessionName,
        runtimeName: "tmux",
        data: {
          createdAt: Date.now(),
          workspacePath: config.workspacePath,
          sessionsDir,
          sessionId: config.sessionId,
          inboxPath: files?.inbox ?? "",
          agentEventsPath: files?.agentEvents ?? "",
        },
      };
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      try {
        await tmux("kill-session", "-t", handle.id);
      } catch {
        // session may already be dead
      }
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      const sessionsDir = handle.data["sessionsDir"] as string | undefined;
      const sessionId = handle.data["sessionId"] as string | undefined;
      if (!sessionsDir || !sessionId) {
        throw new Error(
          `Cannot send message to session "${handle.id}": missing sessionsDir/sessionId in runtime handle`,
        );
      }

      const files = resolveCommsFiles(sessionsDir, sessionId);
      const epoch = readEpoch(sessionsDir, sessionId);
      appendInboxMessage(files.inbox, sessionId, epoch, "instruction", message, generateDedupKey());
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      try {
        return await tmux("capture-pane", "-t", handle.id, "-p", "-S", `-${lines}`);
      } catch {
        return "";
      }
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      try {
        await tmux("has-session", "-t", handle.id);
        return true;
      } catch {
        return false;
      }
    },

    async getMetrics(handle: RuntimeHandle): Promise<RuntimeMetrics> {
      const createdAt = (handle.data["createdAt"] as number) ?? Date.now();
      return {
        uptimeMs: Date.now() - createdAt,
      };
    },

    async getAttachInfo(handle: RuntimeHandle): Promise<AttachInfo> {
      return {
        type: "tmux",
        target: handle.id,
        command: `tmux attach -t ${handle.id}`,
      };
    },

    watchEvents(handle: RuntimeHandle, callback: (events: unknown[]) => void): () => void {
      const agentEventsPath = handle.data["agentEventsPath"] as string | undefined;
      if (!agentEventsPath) return () => {};

      const dir = dirname(agentEventsPath);
      let watcher: ReturnType<typeof watchDirectory> | null = null;

      try {
        watcher = watchDirectory(dir, (filename) => {
          if (filename !== null && filename !== AGENT_EVENTS_FILE) return;
          let messages: unknown[];
          try {
            const result = readNewMessages(agentEventsPath);
            messages = result.messages;
          } catch {
            return;
          }
          if (messages.length === 0) return;
          try {
            callback(messages);
          } catch {
            // best effort
          }
        });
      } catch {
        return () => {};
      }

      return () => {
        try {
          watcher?.close();
        } catch {
          // best effort
        }
      };
    },

    async writeSystemEvent(
      handle: RuntimeHandle,
      type: string,
      message: string,
      data?: Record<string, unknown>,
    ): Promise<void> {
      const sessionsDir = handle.data["sessionsDir"] as string | undefined;
      const sessionId = handle.data["sessionId"] as string | undefined;
      if (!sessionsDir || !sessionId) return;

      const files = resolveCommsFiles(sessionsDir, sessionId);
      const epoch = readEpoch(sessionsDir, sessionId);
      try {
        appendMessage(files.systemEvents, sessionId, epoch, "system", type, message, data);
      } catch {
        // best effort
      }
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
