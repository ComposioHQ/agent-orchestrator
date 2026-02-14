/**
 * tmux helpers for integration tests.
 * Creates/destroys real tmux sessions and captures their output.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TIMEOUT = 30_000;

/** Check whether tmux is available on this machine. */
export async function isTmuxAvailable(): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["-V"], { timeout: TIMEOUT });
    return true;
  } catch {
    return false;
  }
}

/** Kill all tmux sessions whose names match a prefix (cleanup helper). */
export async function killSessionsByPrefix(prefix: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync(
      "tmux",
      ["list-sessions", "-F", "#{session_name}"],
      { timeout: TIMEOUT },
    );
    const sessions = stdout
      .trim()
      .split("\n")
      .filter((s) => s.startsWith(prefix));
    for (const name of sessions) {
      try {
        await execFileAsync("tmux", ["kill-session", "-t", name], {
          timeout: TIMEOUT,
        });
      } catch {
        // session already gone
      }
    }
  } catch {
    // tmux server not running — nothing to clean up
  }
}

/** Create a new tmux session running the given shell command. */
export async function createSession(
  name: string,
  command: string,
  cwd: string,
  env?: Record<string, string>,
): Promise<void> {
  const args = [
    "new-session",
    "-d",
    "-s",
    name,
    "-x",
    "200",
    "-y",
    "50",
  ];

  // Set environment variables inside the session
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      args.push("-e", `${key}=${value}`);
    }
  }

  args.push(command);

  await execFileAsync("tmux", args, { timeout: TIMEOUT, cwd });
}

/** Capture terminal output from a tmux session pane. */
export async function capturePane(name: string, lines = 50): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "tmux",
      ["capture-pane", "-t", name, "-p", "-S", `-${lines}`],
      { timeout: TIMEOUT },
    );
    return stdout;
  } catch {
    return "";
  }
}

/** Kill a specific tmux session by name. */
export async function killSession(name: string): Promise<void> {
  try {
    await execFileAsync("tmux", ["kill-session", "-t", name], {
      timeout: TIMEOUT,
    });
  } catch {
    // already gone
  }
}

