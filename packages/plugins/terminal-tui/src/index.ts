import { execFile } from "node:child_process";
import type { PluginModule, Terminal, Session } from "@composio/ao-core";

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "tui",
  slot: "terminal" as const,
  description: "Terminal plugin: in-terminal TUI dashboard via tmux",
  version: "0.1.0",
};

// =============================================================================
// Helpers
// =============================================================================

/**
 * Get the session name from a Session object.
 * Uses the runtime handle id (tmux session name) if available, otherwise session id.
 */
function getSessionName(session: Session): string {
  return session.runtimeHandle?.id ?? session.id;
}

/**
 * Attach the current terminal to a tmux session.
 * Uses `tmux attach-session` to directly view the agent's pane.
 */
function tmuxAttach(sessionName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Spawn tmux attach in the foreground — this hands control to tmux
    const child = execFile(
      "tmux",
      ["attach-session", "-t", sessionName],
      { timeout: 0 },
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );
    // Inherit stdio so the user can interact with the tmux session
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
    process.stdin.pipe(child.stdin ?? process.stdin);
  });
}

/**
 * Check if a tmux session exists.
 */
async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "tmux",
      ["has-session", "-t", sessionName],
      { timeout: 30_000 },
      (err) => {
        resolve(!err);
      },
    );
  });
}

/**
 * Create a dashboard-style tmux layout showing all sessions.
 * Creates a new tmux window with split panes, one per session.
 */
async function createDashboardLayout(sessions: Session[]): Promise<void> {
  const dashboardSession = "ao-dashboard";

  // Kill existing dashboard session if it exists
  await new Promise<void>((resolve) => {
    execFile(
      "tmux",
      ["kill-session", "-t", dashboardSession],
      { timeout: 30_000 },
      () => resolve(),
    );
  });

  // Create the dashboard session with the first session's pane
  const firstName = getSessionName(sessions[0]!);
  await new Promise<void>((resolve, reject) => {
    execFile(
      "tmux",
      [
        "new-session",
        "-d",
        "-s", dashboardSession,
        "-x", "200",
        "-y", "50",
        `tmux attach-session -t '${firstName}'`,
      ],
      { timeout: 30_000 },
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });

  // Split and add remaining sessions
  for (let i = 1; i < sessions.length; i++) {
    const name = getSessionName(sessions[i]!);
    const splitDirection = i % 2 === 1 ? "-h" : "-v";
    await new Promise<void>((resolve, reject) => {
      execFile(
        "tmux",
        [
          "split-window",
          splitDirection,
          "-t", dashboardSession,
          `tmux attach-session -t '${name}'`,
        ],
        { timeout: 30_000 },
        (err) => {
          if (err) reject(err);
          else resolve();
        },
      );
    });
  }

  // Even out the layout
  await new Promise<void>((resolve) => {
    execFile(
      "tmux",
      ["select-layout", "-t", dashboardSession, "tiled"],
      { timeout: 30_000 },
      () => resolve(),
    );
  });

  // Attach to the dashboard
  await tmuxAttach(dashboardSession);
}

// =============================================================================
// Terminal Implementation
// =============================================================================

export function create(): Terminal {
  return {
    name: "tui",

    async openSession(session: Session): Promise<void> {
      const sessionName = getSessionName(session);
      const exists = await tmuxSessionExists(sessionName);
      if (!exists) {
        // eslint-disable-next-line no-console
        console.warn(`[terminal-tui] tmux session '${sessionName}' does not exist`);
        return;
      }
      await tmuxAttach(sessionName);
    },

    async openAll(sessions: Session[]): Promise<void> {
      if (sessions.length === 0) return;

      // Filter to sessions that have valid tmux sessions
      const validSessions: Session[] = [];
      for (const session of sessions) {
        const sessionName = getSessionName(session);
        const exists = await tmuxSessionExists(sessionName);
        if (exists) {
          validSessions.push(session);
        }
      }

      if (validSessions.length === 0) {
        // eslint-disable-next-line no-console
        console.warn("[terminal-tui] No valid tmux sessions found");
        return;
      }

      if (validSessions.length === 1) {
        // Single session — just attach directly
        await tmuxAttach(getSessionName(validSessions[0]!));
        return;
      }

      // Multiple sessions — create a dashboard layout
      await createDashboardLayout(validSessions);
    },

    async isSessionOpen(session: Session): Promise<boolean> {
      const sessionName = getSessionName(session);
      try {
        // Check if any client is attached to this tmux session
        return await new Promise<boolean>((resolve) => {
          execFile(
            "tmux",
            ["list-clients", "-t", sessionName, "-F", "#{client_name}"],
            { timeout: 30_000 },
            (err, stdout) => {
              if (err) {
                resolve(false);
                return;
              }
              resolve(stdout.trim().length > 0);
            },
          );
        });
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
