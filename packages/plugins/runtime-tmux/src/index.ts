import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PluginModule,
  Runtime,
  RuntimeCreateConfig,
  RuntimeHandle,
  RuntimeMetrics,
  AttachInfo,
} from "@agent-orchestrator/core";

const execFileAsync = promisify(execFile);

export const manifest = {
  name: "tmux",
  slot: "runtime" as const,
  description: "Runtime plugin: tmux sessions",
  version: "0.1.0",
};

/** Only allow safe characters in session IDs */
const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

function assertValidSessionId(id: string): void {
  if (!SAFE_SESSION_ID.test(id)) {
    throw new Error(
      `Invalid session ID "${id}": must match ${SAFE_SESSION_ID}`,
    );
  }
}

/** Run a tmux command and return stdout */
async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args);
  return stdout.trimEnd();
}

export function create(): Runtime {
  return {
    name: "tmux",

    async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
      assertValidSessionId(config.sessionId);
      const sessionName = config.sessionId;

      // Build environment flags: -e KEY=VALUE for each env var
      const envArgs: string[] = [];
      for (const [key, value] of Object.entries(config.environment)) {
        envArgs.push("-e", `${key}=${value}`);
      }

      // Create tmux session in detached mode
      await tmux(
        "new-session",
        "-d",
        "-s",
        sessionName,
        "-c",
        config.workspacePath,
        ...envArgs,
      );

      // Send the launch command
      await tmux("send-keys", "-t", sessionName, config.launchCommand, "Enter");

      return {
        id: sessionName,
        runtimeName: "tmux",
        data: {
          createdAt: Date.now(),
          workspacePath: config.workspacePath,
        },
      };
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      try {
        await tmux("kill-session", "-t", handle.id);
      } catch {
        // Session may already be dead — that's fine
      }
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      // Wait for idle before sending (up to 60s)
      const maxWait = 60;
      const pollInterval = 2;
      let sentWhileBusy = false;
      let busy = false;
      for (let waited = 0; waited < maxWait; waited += pollInterval) {
        busy = await isBusy(handle.id);
        if (!busy) break;
        await sleep(pollInterval * 1000);
      }
      if (busy) {
        sentWhileBusy = true;
      }

      // Clear any partial input
      await tmux("send-keys", "-t", handle.id, "C-u");
      await sleep(200);

      // For long or multiline messages, use load-buffer + paste-buffer
      // Use randomUUID to avoid temp file collisions on concurrent sends
      if (message.includes("\n") || message.length > 200) {
        const tmpPath = join(tmpdir(), `ao-send-${randomUUID()}.txt`);
        writeFileSync(tmpPath, message, "utf-8");
        try {
          await tmux("load-buffer", tmpPath);
          await tmux("paste-buffer", "-t", handle.id);
        } finally {
          try {
            unlinkSync(tmpPath);
          } catch {
            // ignore cleanup errors
          }
        }
      } else {
        await tmux("send-keys", "-t", handle.id, message);
      }

      await sleep(300);
      await tmux("send-keys", "-t", handle.id, "Enter");

      if (sentWhileBusy) {
        throw new Error(
          `Session ${handle.id} was still busy after ${maxWait}s — message sent but may be lost`,
        );
      }
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      try {
        return await tmux(
          "capture-pane",
          "-t",
          handle.id,
          "-p",
          "-S",
          `-${lines}`,
        );
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
      const createdAt = (handle.data.createdAt as number) ?? Date.now();
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
  };
}

/** Check if a tmux session is currently busy (agent processing) */
async function isBusy(sessionName: string): Promise<boolean> {
  try {
    // Single capture-pane call to avoid TOCTOU and redundant subprocess spawns
    const output = await tmux(
      "capture-pane",
      "-t",
      sessionName,
      "-p",
      "-S",
      "-5",
    );
    const lines = output.split("\n").filter((l) => l.trim() !== "");
    const lastLine = lines[lines.length - 1] ?? "";

    // Idle indicators: prompt char, permission mode
    if (/[❯$]|⏵⏵|bypass permissions/.test(lastLine)) {
      return false;
    }

    // Active indicators: processing spinners (check same output)
    if (output.includes("esc to interrupt")) {
      return true;
    }

    // Default: assume busy if we can't tell
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default { manifest, create } satisfies PluginModule<Runtime>;
