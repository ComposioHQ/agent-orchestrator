import { execFile } from "node:child_process";
import { platform } from "node:os";
import { escapeAppleScript, type PluginModule, type Terminal, type Session } from "@composio/ao-core";

export const manifest = {
  name: "ghostty",
  slot: "terminal" as const,
  description: "Terminal plugin: Ghostty terminal management",
  version: "0.1.0",
};

function getSessionName(session: Session): string {
  return session.runtimeHandle?.id ?? session.id;
}

function isMacOS(): boolean {
  return platform() === "darwin";
}

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
 * Replaces ' with '\'' (end quote, escaped quote, start quote).
 */
function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/**
 * Open a Ghostty tab on macOS using AppleScript.
 * Ghostty supports AppleScript automation on macOS similar to iTerm2.
 */
async function openTabMacOS(sessionName: string): Promise<void> {
  const safe = escapeAppleScript(sessionName);
  const shellSafe = shellEscape(sessionName);
  const shellInAppleScript = escapeAppleScript(shellSafe);
  const script = `
tell application "Ghostty"
    activate
    tell application "System Events"
        tell process "Ghostty"
            keystroke "t" using command down
            delay 0.3
        end tell
    end tell
    delay 0.3
    tell application "System Events"
        tell process "Ghostty"
            keystroke "tmux attach -t '${shellInAppleScript}'"
            keystroke return
        end tell
    end tell
end tell`;

  await runAppleScript(script);
  // Set the window title via escape sequence
  const titleScript = `
tell application "System Events"
    tell process "Ghostty"
        keystroke "printf '\\\\033]0;${safe}\\\\007'"
        keystroke return
    end tell
end tell`;
  try {
    await runAppleScript(titleScript);
  } catch {
    // Title setting is best-effort
  }
}

export function create(): Terminal {
  return {
    name: "ghostty",

    async openSession(session: Session): Promise<void> {
      if (isMacOS()) {
        const sessionName = getSessionName(session);
        await openTabMacOS(sessionName);
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          "[terminal-ghostty] Ghostty terminal automation is only supported on macOS. " +
            "Linux support requires xdotool or a Ghostty CLI API (not yet available).",
        );
      }
    },

    async openAll(sessions: Session[]): Promise<void> {
      if (!isMacOS() || sessions.length === 0) {
        if (!isMacOS()) {
          // eslint-disable-next-line no-console
          console.warn(
            "[terminal-ghostty] Ghostty terminal automation is only supported on macOS.",
          );
        }
        return;
      }

      for (const session of sessions) {
        await this.openSession(session);
        // Small delay between tab operations to avoid AppleScript race conditions
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    },

    async isSessionOpen(_session: Session): Promise<boolean> {
      // Ghostty does not expose a reliable API to query open tabs by title.
      // On macOS, we could attempt to parse window titles via System Events,
      // but this is fragile. Return false to always open a new tab.
      return false;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Terminal>;
