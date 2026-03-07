import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PluginModule, Terminal, Session } from "@composio/ao-core";

const execFileAsync = promisify(execFile);

export const manifest = {
  name: "wezterm",
  slot: "terminal" as const,
  description: "Terminal plugin: WezTerm tab management",
  version: "0.1.0",
};

interface WezTermPane {
  tab_id: number;
  pane_id: number;
  title: string;
}

function getSessionName(session: Session): string {
  return session.runtimeHandle?.id ?? session.id;
}

/** Parse the output of `wezterm cli list --format json`. */
function parseWezTermList(stdout: string): WezTermPane[] {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed as WezTermPane[];
  } catch {
    return [];
  }
}

/** Find an existing pane/tab by title. */
function findPaneByTitle(
  panes: WezTermPane[],
  title: string,
): WezTermPane | null {
  for (const pane of panes) {
    if (pane.title === title) {
      return pane;
    }
  }
  return null;
}

export function create(): Terminal {
  return {
    name: "wezterm",

    async openSession(session: Session): Promise<void> {
      const sessionName = getSessionName(session);

      // List existing panes
      let panes: WezTermPane[] = [];
      try {
        const { stdout } = await execFileAsync(
          "wezterm",
          ["cli", "list", "--format", "json"],
          { timeout: 30_000 },
        );
        panes = parseWezTermList(stdout);
      } catch {
        // wezterm cli may not be available
      }

      const existing = findPaneByTitle(panes, sessionName);

      if (existing) {
        // Activate the existing tab
        await execFileAsync(
          "wezterm",
          ["cli", "activate-tab", "--tab-id", String(existing.tab_id)],
          { timeout: 30_000 },
        );
      } else {
        // Spawn a new pane attached to the tmux session
        await execFileAsync(
          "wezterm",
          ["cli", "spawn", "--", "tmux", "attach", "-t", sessionName],
          { timeout: 30_000 },
        );
      }
    },

    async openAll(sessions: Session[]): Promise<void> {
      for (const session of sessions) {
        await this.openSession(session);
        // Small delay between tab operations to avoid race conditions
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    },

    async isSessionOpen(session: Session): Promise<boolean> {
      const sessionName = getSessionName(session);
      try {
        const { stdout } = await execFileAsync(
          "wezterm",
          ["cli", "list", "--format", "json"],
          { timeout: 30_000 },
        );
        const panes = parseWezTermList(stdout);
        return findPaneByTitle(panes, sessionName) !== null;
      } catch {
        return false;
      }
    },
  };
}

export default { manifest, create } satisfies PluginModule<Terminal>;
