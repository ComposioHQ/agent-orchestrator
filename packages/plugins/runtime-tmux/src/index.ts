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
const PASTE_BUFFER_THRESHOLD = 200;
const CAPTURE_LINES = 40;
const CAPTURE_POLL_MS = 250;
const ENTER_RETRY_DELAYS_MS = [500, 1000, 1500, 2500] as const;

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

/** Run a tmux command and return stdout */
async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args, {
    timeout: TMUX_COMMAND_TIMEOUT_MS,
  });
  return stdout.trimEnd();
}

function lastNonEmptyLine(output: string): string {
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (line) return line;
  }
  return "";
}

function isPromptLine(line: string): boolean {
  return /^[>$#❯]\s*$/.test(line);
}

function hasPastedDraftMarker(output: string): boolean {
  return /\[Pasted Content \d+ chars\](?:\s*#\d+)?/.test(output);
}

function likelyHasDraftInput(output: string, message: string): boolean {
  if (hasPastedDraftMarker(output)) return true;

  // Fallback for terminals that show raw text instead of paste markers.
  const tail = message.slice(-Math.min(120, message.length)).trim();
  if (!tail) return false;
  return output.includes(tail);
}

async function capturePane(sessionName: string, lines = CAPTURE_LINES): Promise<string> {
  try {
    return await tmux("capture-pane", "-t", sessionName, "-p", "-S", `-${lines}`);
  } catch {
    return "";
  }
}

async function waitForPasteToSettle(sessionName: string, messageLength: number): Promise<string> {
  const settleBudgetMs = Math.min(15_000, 1_500 + Math.ceil(messageLength / 1000) * 600);
  let snapshot = await capturePane(sessionName);
  let stableCount = 0;
  const startedAt = Date.now();

  while (Date.now() - startedAt < settleBudgetMs) {
    await sleep(CAPTURE_POLL_MS);
    const next = await capturePane(sessionName);
    if (next === snapshot) {
      stableCount++;
      if (stableCount >= 2) return next;
    } else {
      stableCount = 0;
      snapshot = next;
    }
  }

  return snapshot;
}

function hasSubmissionStarted(opts: { before: string; after: string; message: string }): boolean {
  const { before, after, message } = opts;
  if (after === before) return false;

  const beforeHasDraft = likelyHasDraftInput(before, message);
  const afterHasDraft = likelyHasDraftInput(after, message);
  if (beforeHasDraft && !afterHasDraft) return true;

  const beforePrompt = isPromptLine(lastNonEmptyLine(before));
  const afterPrompt = isPromptLine(lastNonEmptyLine(after));
  if (beforePrompt && !afterPrompt) return true;

  return false;
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
            await tmux("load-buffer", "-b", bufferName, tmpPath);
            await tmux("paste-buffer", "-b", bufferName, "-t", sessionName, "-d");
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

      // For long or multiline messages, use load-buffer + paste-buffer
      // Use randomUUID to avoid temp file collisions on concurrent sends
      const usesPasteBuffer = message.includes("\n") || message.length > PASTE_BUFFER_THRESHOLD;
      if (usesPasteBuffer) {
        const bufferName = `ao-${randomUUID()}`;
        const tmpPath = join(tmpdir(), `ao-send-${randomUUID()}.txt`);
        writeFileSync(tmpPath, message, { encoding: "utf-8", mode: 0o600 });
        try {
          await tmux("load-buffer", "-b", bufferName, tmpPath);
          await tmux("paste-buffer", "-b", bufferName, "-t", handle.id, "-d");
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
      }

      if (!usesPasteBuffer) {
        await tmux("send-keys", "-t", handle.id, "Enter");
        return;
      }

      // Wait for multi-chunk paste rendering to settle before first Enter.
      let baselinePane = await waitForPasteToSettle(handle.id, message.length);
      await tmux("send-keys", "-t", handle.id, "Enter");

      for (const retryDelayMs of ENTER_RETRY_DELAYS_MS) {
        await sleep(retryDelayMs);
        const currentPane = await capturePane(handle.id);
        if (hasSubmissionStarted({ before: baselinePane, after: currentPane, message })) {
          return;
        }

        await tmux("send-keys", "-t", handle.id, "Enter");
        baselinePane = currentPane;
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
