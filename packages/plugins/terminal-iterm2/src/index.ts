import { execFile } from "node:child_process";
import type { PluginModule, Terminal, Session } from "@agent-orchestrator/core";

export const manifest = {
  name: "iterm2",
  slot: "terminal" as const,
  description: "Terminal plugin: macOS iTerm2 tab management",
  version: "0.1.0",
};

/**
 * Escape a string for safe interpolation inside AppleScript double-quoted strings.
 * Handles backslashes and double quotes which would otherwise break or inject.
 */
export function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Run an AppleScript snippet and return stdout.
 */
function runAppleScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

/**
 * Escape a string for safe interpolation inside a shell single-quoted context.
 * Replaces ' with '\'' (end quote, escaped quote, start quote).
 */
function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/**
 * Check if an iTerm2 tab already exists for this session by matching session name.
 * Returns true if found (and selects it), false otherwise.
 */
async function findAndSelectExistingTab(sessionName: string): Promise<boolean> {
  const safe = escapeAppleScript(sessionName);
  const script = `
tell application "iTerm2"
    repeat with aWindow in windows
        repeat with aTab in tabs of aWindow
            repeat with aSession in sessions of aTab
                try
                    if name of aSession is equal to "${safe}" then
                        select aWindow
                        select aTab
                        return "FOUND"
                    end if
                end try
            end repeat
        end repeat
    end repeat
    return "NOT_FOUND"
end tell`;

  const result = await runAppleScript(script);
  return result === "FOUND";
}

/**
 * Check if an iTerm2 tab exists for this session WITHOUT selecting it.
 * Pure query — no side effects on the UI.
 */
async function hasExistingTab(sessionName: string): Promise<boolean> {
  const safe = escapeAppleScript(sessionName);
  const script = `
tell application "iTerm2"
    repeat with aWindow in windows
        repeat with aTab in tabs of aWindow
            repeat with aSession in sessions of aTab
                try
                    if name of aSession is equal to "${safe}" then
                        return "FOUND"
                    end if
                end try
            end repeat
        end repeat
    end repeat
    return "NOT_FOUND"
end tell`;

  const result = await runAppleScript(script);
  return result === "FOUND";
}

/**
 * Open a new iTerm2 tab and attach to the given tmux session.
 */
async function openNewTab(sessionName: string): Promise<void> {
  const safe = escapeAppleScript(sessionName);
  const shellSafe = shellEscape(sessionName);
  const script = `
tell application "iTerm2"
    activate
    tell current window
        create tab with default profile
        tell current session
            set name to "${safe}"
            write text "printf '\\\\033]0;${safe}\\\\007' && tmux attach -t '${shellSafe}'"
        end tell
    end tell
end tell`;

  await runAppleScript(script);
}

function getSessionName(session: Session): string {
  // Use the runtime handle id if available (tmux session name), otherwise session id
  return session.runtimeHandle?.id ?? session.id;
}

export function create(): Terminal {
  return {
    name: "iterm2",

    async openSession(session: Session): Promise<void> {
      const sessionName = getSessionName(session);

      // Try to find and select an existing tab first
      const found = await findAndSelectExistingTab(sessionName);
      if (!found) {
        await openNewTab(sessionName);
      }
    },

    async openAll(sessions: Session[]): Promise<void> {
      if (sessions.length === 0) return;

      for (const session of sessions) {
        const sessionName = getSessionName(session);
        const found = await findAndSelectExistingTab(sessionName);
        if (!found) {
          await openNewTab(sessionName);
        }
        // Small delay between tab operations to avoid AppleScript race conditions
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    },

    async isSessionOpen(session: Session): Promise<boolean> {
      const sessionName = getSessionName(session);
      try {
        // Query-only check — does NOT select/focus the tab
        return await hasExistingTab(sessionName);
      } catch {
        return false;
      }
    },
  };
}

export default { manifest, create } satisfies PluginModule<Terminal>;
