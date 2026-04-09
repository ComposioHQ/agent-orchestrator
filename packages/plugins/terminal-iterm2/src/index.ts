import { execFile } from "node:child_process";
import { platform } from "node:os";
import {
  escapeAppleScript,
  type PluginModule,
  type Terminal,
  type Session,
} from "@composio/ao-core";

export const manifest = {
  name: "iterm2",
  slot: "terminal" as const,
  description: "Terminal plugin: macOS iTerm2 tab management",
  version: "0.1.0",
};

// Re-export for backwards compatibility
export { escapeAppleScript } from "@composio/ao-core";

export interface ITerm2OpenSpec {
  sessionName: string;
  attachCommand: string;
  newWindow?: boolean;
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
 * Creates a new window if no window is open.
 */
async function openNewTab(
  sessionName: string,
  attachCommand: string,
  newWindow?: boolean,
): Promise<void> {
  const safe = escapeAppleScript(sessionName);
  const commandInAppleScript = escapeAppleScript(
    `printf '\\\\033]0;${shellEscape(sessionName)}\\\\007' && ${attachCommand}`,
  );
  const script = `
tell application "iTerm2"
    activate
    if ${newWindow ? "true" : "(count of windows) is 0"} then
        create window with default profile
    else
        tell current window
            create tab with default profile
        end tell
    end if
    tell current session of current window
        set name to "${safe}"
        write text "${commandInAppleScript}"
    end tell
end tell`;

  await runAppleScript(script);
}

function getDockerTmuxSessionName(session: Session): string {
  const handle = session.runtimeHandle;
  const tmuxSessionName = handle?.data["tmuxSessionName"];
  return typeof tmuxSessionName === "string" && tmuxSessionName.length > 0
    ? tmuxSessionName
    : session.id;
}

function buildTmuxAttachCommand(attachTarget: string): string {
  const handleName = shellEscape(attachTarget);
  return `tmux attach -t '${handleName}'`;
}

function getOpenSpec(session: Session): { sessionName: string; attachCommand: string } {
  if (session.runtimeHandle?.runtimeName === "docker") {
    const containerName = session.runtimeHandle.id;
    const tmuxSessionName = getDockerTmuxSessionName(session);
    const safeContainerName = shellEscape(containerName);
    const safeTmuxSessionName = shellEscape(tmuxSessionName);
    return {
      sessionName: containerName,
      attachCommand: `docker exec -it '${safeContainerName}' tmux attach -t '${safeTmuxSessionName}'`,
    };
  }

  const sessionName = session.runtimeHandle?.id ?? session.id;
  return {
    sessionName,
    attachCommand: buildTmuxAttachCommand(sessionName),
  };
}

function isMacOS(): boolean {
  return platform() === "darwin";
}

export async function openCommandInITerm2(spec: ITerm2OpenSpec): Promise<boolean> {
  if (!isMacOS()) return false;
  const found = await findAndSelectExistingTab(spec.sessionName);
  if (!found) {
    await openNewTab(spec.sessionName, spec.attachCommand, spec.newWindow);
  }
  return true;
}

export function create(): Terminal {
  return {
    name: "iterm2",

    async openSession(session: Session): Promise<void> {
      if (!isMacOS()) {
        // eslint-disable-next-line no-console
        console.warn("[terminal-iterm2] iTerm2 is only available on macOS");
        return;
      }
      const spec = getOpenSpec(session);

      await openCommandInITerm2(spec);
    },

    async openAll(sessions: Session[]): Promise<void> {
      if (!isMacOS() || sessions.length === 0) return;

      for (const session of sessions) {
        const spec = getOpenSpec(session);
        await openCommandInITerm2(spec);
        // Small delay between tab operations to avoid AppleScript race conditions
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    },

    async isSessionOpen(session: Session): Promise<boolean> {
      if (!isMacOS()) return false;
      const sessionName = getOpenSpec(session).sessionName;
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
