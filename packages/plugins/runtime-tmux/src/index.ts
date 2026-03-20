import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
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
} from "@composio/ao-core";

const execFileAsync = promisify(execFile);
const TMUX_COMMAND_TIMEOUT_MS = 5_000;

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
    throw new Error(`Invalid session ID "${id}": must match ${SAFE_SESSION_ID}`);
  }
}

/**
 * Configuration for Enter retry logic
 *
 * MAX_ENTER_RETRIES is the maximum number of Enter key attempts
 * BASE_ENTER_DELAY_MS is the base delay between attempts
 *
 * With 3 retries, the delays are:
 * - Attempt 0: 500ms (after capture-pane)
 * - Attempt 1: 1000ms (after capture-pane)
 * - Attempt 2: 2000ms (final attempt, no verification)
 */
const MAX_ENTER_RETRIES = 3;
const BASE_ENTER_DELAY_MS = 500;

/**
 * Heuristic to check if message might still be in the input area.
 *
 * This is a best-effort check - if the message preview is still present in
 * the last few lines of output and we haven't seen any indication that the agent
 * has started processing, we retry.
 *
 * Note: This check intentionally excludes detecting "Claude" since Claude Code
 * displays "Claude" in its interface at all times. This would cause the
 * retry mechanism to be disabled for the primary use case it was designed for.
 */
function messageMayStillBeInInput(message: string, output: string): boolean {
  // Check if a significant portion of the message is in the last few lines
  // This indicates the message might still be in the input prompt
  const lines = output.split('\n');
  const lastFewLines = lines.slice(-5).join('\n');
  const messagePreview = message.split('\n').slice(-2).join('\n');

  // If the message preview is present and we don't see signs of agent activity
  return lastFewLines.includes(messagePreview) &&
    !output.includes("▊"); // Common cursor indicator
}

/** Run a tmux command and return stdout */
async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args, {
    timeout: TMUX_COMMAND_TIMEOUT_MS,
  });
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
      for (const [key, value] of Object.entries(config.environment ?? {})) {
        envArgs.push("-e", `${key}=${value}`);
      }

      // Create tmux session in detached mode
      await tmux("new-session", "-d", "-s", sessionName, "-c", config.workspacePath, ...envArgs);

      // Send the launch command — clean up the session if this fails.
      // Use load-buffer + paste-buffer for long commands to avoid tmux/zsh
      // truncation issues (commands >200 chars get mangled by send-keys).
      try {
        if (config.launchCommand.length > 200) {
          const bufferName = `ao-launch-${randomUUID().slice(0, 8)}`;
          const tmpPath = join(tmpdir(), `ao-launch-${randomUUID()}.txt`);
          writeFileSync(tmpPath, config.launchCommand, { encoding: "utf-8", mode: 0o600 });
          try {
            // Use bracketed paste mode for better reliability
            await tmux("send-keys", "-t", sessionName, "-l", "\x1b[200~");
            await tmux("load-buffer", "-b", bufferName, tmpPath);
            await tmux("paste-buffer", "-b", bufferName, "-t", sessionName, "-d");
            await tmux("send-keys", "-t", sessionName, "-l", "\x1b[201~");
          } finally {
            try {
              unlinkSync(tmpPath);
            } catch {
              /* ignore cleanup errors */
            }
          }
          await sleep(300);
          await tmux("send-keys", "-t", sessionName, "Enter");
        } else {
          await tmux("send-keys", "-t", sessionName, config.launchCommand, "Enter");
        }
      } catch (err: unknown) {
        try {
          await tmux("kill-session", "-t", sessionName);
        } catch {
          // Best-effort cleanup
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
      // Clear any partial input
      await tmux("send-keys", "-t", handle.id, "C-u");

      // Send bracketed paste start sequence (\e[200~)
      // This tells the terminal to treat the upcoming text as a single paste event
      await tmux("send-keys", "-t", handle.id, "-l", "\x1b[200~");

      // For long or multiline messages, use load-buffer + paste-buffer
      // Use randomUUID to avoid temp file collisions on concurrent sends
      if (message.includes("\n") || message.length > 200) {
        const bufferName = `ao-${randomUUID()}`;
        const tmpPath = join(tmpdir(), `ao-send-${randomUUID()}.txt`);
        writeFileSync(tmpPath, message, { encoding: "utf-8", mode: 0o600 });

        try {
          await tmux("load-buffer", "-b", bufferName, tmpPath);
          await tmux("paste-buffer", "-b", bufferName, "-t", handle.id, "-d");
          // Send bracketed paste end inside try block so it's sent even on error
          await tmux("send-keys", "-t", handle.id, "-l", "\x1b[201~");
        } finally {
          // Clean up temp file and tmux buffer (in case paste-buffer failed
          // and the -d flag didn't delete it)
          try {
            unlinkSync(tmpPath);
          } catch {
            // ignore cleanup errors
          }
          try {
            await tmux("delete-buffer", "-b", bufferName);
          } catch {
            // Buffer may already be deleted by -d flag — that's fine
          }
        }
      } else {
        // Use -l (literal) so text like "Enter" or "Space" isn't interpreted
        // as tmux key names
        await tmux("send-keys", "-t", handle.id, "-l", message);
        // Send bracketed paste end for short messages too
        await tmux("send-keys", "-t", handle.id, "-l", "\x1b[201~");
      }

      // Small delay to let tmux process the pasted text before pressing Enter.
      // Bracketed paste mode helps, but we still add a small safety margin.
      await sleep(300);

      // Retry Enter with exponential backoff to handle race conditions
      // where Enter arrives before TUI is ready to process it.
      for (let attempt = 0; attempt < MAX_ENTER_RETRIES; attempt++) {
        await tmux("send-keys", "-t", handle.id, "Enter");

        // Skip verification on the last attempt - we've done our best
        if (attempt < MAX_ENTER_RETRIES - 1) {
          // Wait for output to stabilize
          await sleep(200);

          // Check if message might still be in input (retry if so)
          try {
            const output = await tmux("capture-pane", "-t", handle.id, "-p", "-S", "-5");
            if (!messageMayStillBeInInput(message, output)) {
              // Message appears to have been submitted successfully
              break;
            }
            // Message may still be in input, retry with longer delay
            await sleep(BASE_ENTER_DELAY_MS * Math.pow(2, attempt));
          } catch {
            // If we can't check the output, continue retrying with backoff
            // rather than breaking, as tmux might be temporarily unavailable
            await sleep(BASE_ENTER_DELAY_MS * Math.pow(2, attempt));
          }
        }
      }
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

export default { manifest, create } satisfies PluginModule<Runtime>;
