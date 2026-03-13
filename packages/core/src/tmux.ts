/**
 * tmux command wrappers — async helpers for tmux operations.
 *
 * Uses child_process.execFile for safe command execution (no shell injection).
 */

import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PASTE_BUFFER_THRESHOLD = 200;
const BASE_PASTE_DELAY_MS = 1000;
const PASTE_DELAY_PER_1K_CHARS_MS = 500;
const MAX_ADAPTIVE_PASTE_DELAY_MS = 15_000;
const ENTER_RETRY_DELAYS_MS = [500, 1000, 1500] as const;
const CAPTURE_PANE_LINES = 40;

/** Run a tmux command and return stdout. */
function tmux(...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) {
        // tmux exits non-zero for many benign cases (no sessions, etc.)
        reject(new Error(`tmux ${args[0]} failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/** Check if tmux server is running. */
export async function isTmuxAvailable(): Promise<boolean> {
  try {
    await tmux("list-sessions", "-F", "#{session_name}");
    return true;
  } catch {
    return false;
  }
}

export interface TmuxSessionInfo {
  name: string;
  created: string;
  attached: boolean;
  windows: number;
}

/** List all tmux sessions. */
export async function listSessions(): Promise<TmuxSessionInfo[]> {
  try {
    const output = await tmux(
      "list-sessions",
      "-F",
      "#{session_name}\t#{session_created_string}\t#{session_attached}\t#{session_windows}",
    );

    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name = "", created = "", attached = "0", windows = "1"] = line.split("\t");
        return {
          name,
          created,
          attached: attached !== "0",
          windows: parseInt(windows, 10) || 1,
        };
      });
  } catch {
    // No tmux server or no sessions
    return [];
  }
}

/** Check if a specific tmux session exists. */
export async function hasSession(sessionName: string): Promise<boolean> {
  try {
    await tmux("has-session", "-t", sessionName);
    return true;
  } catch {
    return false;
  }
}

export interface NewSessionOptions {
  /** Session name */
  name: string;
  /** Working directory */
  cwd: string;
  /** Initial command to run */
  command?: string;
  /** Environment variables to set */
  environment?: Record<string, string>;
  /** Window width/height */
  width?: number;
  height?: number;
}

/** Create a new tmux session (detached). */
export async function newSession(opts: NewSessionOptions): Promise<void> {
  const args = ["new-session", "-d", "-s", opts.name, "-c", opts.cwd];

  // Add environment variables
  if (opts.environment) {
    for (const [key, value] of Object.entries(opts.environment)) {
      args.push("-e", `${key}=${value}`);
    }
  }

  // Window size
  if (opts.width) {
    args.push("-x", String(opts.width));
  }
  if (opts.height) {
    args.push("-y", String(opts.height));
  }

  await tmux(...args);

  // Send the initial command if provided
  if (opts.command) {
    await sendKeys(opts.name, opts.command);
  }
}

/**
 * Send keys (text + Enter) to a tmux session.
 * For long/multiline messages, uses load-buffer + paste-buffer with
 * a named buffer to avoid racing on the global paste buffer.
 * Sends Escape first to clear any partial input in the agent.
 */
export async function sendKeys(
  sessionName: string,
  text: string,
  pressEnter = true,
): Promise<void> {
  const usesPasteBuffer = text.includes("\n") || text.length > PASTE_BUFFER_THRESHOLD;

  // Clear any partial input first (matches bash reference scripts)
  await tmux("send-keys", "-t", sessionName, "Escape");
  // Small delay to ensure Escape is processed before pasting
  await sleep(100);

  if (usesPasteBuffer) {
    // Use a named buffer to avoid global paste buffer race conditions
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { randomUUID } = await import("node:crypto");

    const bufferName = `ao-${randomUUID().slice(0, 8)}`;
    const tmpFile = join(tmpdir(), `ao-tmux-${bufferName}.txt`);
    writeFileSync(tmpFile, text, { encoding: "utf-8", mode: 0o600 });

    try {
      await tmux("load-buffer", "-b", bufferName, tmpFile);
      await tmux("paste-buffer", "-b", bufferName, "-d", "-t", sessionName);
    } finally {
      try {
        unlinkSync(tmpFile);
      } catch {
        /* ignore cleanup errors */
      }
    }
  } else {
    // Use -l (literal) to prevent tmux from interpreting text as key names
    // (e.g. "Enter", "Escape", "C-c" would be treated as keypresses without -l)
    await tmux("send-keys", "-t", sessionName, "-l", text);
  }

  if (pressEnter) {
    if (!usesPasteBuffer) {
      await tmux("send-keys", "-t", sessionName, "Enter");
      return;
    }

    // For large paste-buffer payloads, allow enough time for terminal input handling.
    const adaptivePasteDelayMs = Math.min(
      MAX_ADAPTIVE_PASTE_DELAY_MS,
      BASE_PASTE_DELAY_MS + (text.length / 1000) * PASTE_DELAY_PER_1K_CHARS_MS,
    );
    await sleep(adaptivePasteDelayMs);

    // Capture baseline immediately before Enter so retries compare against
    // true pre-submit state (not intermediate paste rendering changes).
    const baselinePane = await capturePane(sessionName, CAPTURE_PANE_LINES).catch(() => "");
    await tmux("send-keys", "-t", sessionName, "Enter");

    let previousPane = baselinePane;
    for (const retryDelayMs of ENTER_RETRY_DELAYS_MS) {
      await sleep(retryDelayMs);
      const currentPane = await capturePane(sessionName, CAPTURE_PANE_LINES).catch(() => "");

      if (currentPane.trim() !== previousPane.trim()) {
        return;
      }

      await tmux("send-keys", "-t", sessionName, "Enter");
      previousPane = currentPane;
    }
  }
}

/**
 * Capture recent output from a tmux pane.
 *
 * @param sessionName - tmux session name
 * @param lines - Number of scrollback lines to capture (default 30)
 */
export async function capturePane(sessionName: string, lines = 30): Promise<string> {
  return tmux("capture-pane", "-t", sessionName, "-p", "-S", `-${lines}`);
}

/** Kill a tmux session. */
export async function killSession(sessionName: string): Promise<void> {
  await tmux("kill-session", "-t", sessionName);
}

/**
 * Get the TTY device for a tmux session's first pane.
 * Useful for finding processes running in the session.
 */
export async function getPaneTTY(sessionName: string): Promise<string | null> {
  try {
    const output = await tmux("list-panes", "-t", sessionName, "-F", "#{pane_tty}");
    const tty = output.trim().split("\n")[0];
    return tty || null;
  } catch {
    return null;
  }
}
