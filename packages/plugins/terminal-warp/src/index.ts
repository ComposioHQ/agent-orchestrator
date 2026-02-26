import { execFile } from "node:child_process";
import { platform } from "node:os";
import {
  escapeAppleScript,
  type PluginModule,
  type Terminal,
  type Session,
} from "@composio/ao-core";

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "warp",
  slot: "terminal" as const,
  description: "Terminal plugin: Warp terminal tab management",
  version: "0.1.0",
};

// =============================================================================
// Helpers
// =============================================================================

/**
 * Run an AppleScript snippet and return stdout.
 */
function runAppleScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { timeout: 30_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

/**
 * Escape a string for safe interpolation inside a shell single-quoted context.
 */
function shellEscapeLocal(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/**
 * Get the session name from a Session object.
 * Uses the runtime handle id (tmux session name) if available, otherwise session id.
 */
function getSessionName(session: Session): string {
  return session.runtimeHandle?.id ?? session.id;
}

function isMacOS(): boolean {
  return platform() === "darwin";
}

/**
 * Open a Warp tab via AppleScript and attach to the given tmux session.
 * On macOS, Warp supports AppleScript for tab/window management.
 */
async function openWarpTab(sessionName: string): Promise<void> {
  const shellSafe = shellEscapeLocal(sessionName);
  const shellInAppleScript = escapeAppleScript(shellSafe);

  if (isMacOS()) {
    const script = `
tell application "Warp"
    activate
    delay 0.5
end tell
tell application "System Events"
    tell process "Warp"
        keystroke "t" using {command down}
        delay 0.3
    end tell
end tell
tell application "Warp"
    tell application "System Events"
        tell process "Warp"
            keystroke "tmux attach -t '${shellInAppleScript}'"
            key code 36
        end tell
    end tell
end tell`;

    await runAppleScript(script);
  } else {
    // On non-macOS, attempt to use warp-cli if available
    await new Promise<void>((resolve, reject) => {
      execFile(
        "warp-cli",
        ["new-tab", "--command", `tmux attach -t '${shellSafe}'`],
        { timeout: 30_000 },
        (err) => {
          if (err) reject(err);
          else resolve();
        },
      );
    });
  }
}

/**
 * Check if a Warp window/tab exists for this session by querying tmux clients.
 * Since Warp doesn't expose a direct query API, we check if a tmux client
 * is attached to the target session from a Warp terminal.
 */
async function isWarpSessionAttached(sessionName: string): Promise<boolean> {
  try {
    const result = await new Promise<string>((resolve, reject) => {
      execFile(
        "tmux",
        ["list-clients", "-t", sessionName, "-F", "#{client_name}"],
        { timeout: 30_000 },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout.trim());
        },
      );
    });
    // If there's at least one client attached, consider it open
    return result.length > 0;
  } catch {
    return false;
  }
}

// =============================================================================
// Terminal Implementation
// =============================================================================

export function create(): Terminal {
  return {
    name: "warp",

    async openSession(session: Session): Promise<void> {
      const sessionName = getSessionName(session);
      await openWarpTab(sessionName);
    },

    async openAll(sessions: Session[]): Promise<void> {
      if (sessions.length === 0) return;

      for (const session of sessions) {
        const sessionName = getSessionName(session);
        await openWarpTab(sessionName);
        // Small delay between tab operations to avoid race conditions
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    },

    async isSessionOpen(session: Session): Promise<boolean> {
      const sessionName = getSessionName(session);
      try {
        return await isWarpSessionAttached(sessionName);
      } catch {
        return false;
      }
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export default { manifest, create } satisfies PluginModule<Terminal>;
