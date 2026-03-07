import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PluginModule, Terminal, Session } from "@composio/ao-core";

const execFileAsync = promisify(execFile);

export const manifest = {
  name: "kitty",
  slot: "terminal" as const,
  description: "Terminal plugin: Kitty terminal tab management",
  version: "0.1.0",
};

interface KittyWindow {
  id: number;
  title: string;
  tabs: KittyTab[];
}

interface KittyTab {
  id: number;
  title: string;
}

function getSessionName(session: Session): string {
  return session.runtimeHandle?.id ?? session.id;
}

/** Parse the output of `kitten @ ls` into a structured list of windows. */
function parseKittyLs(stdout: string): KittyWindow[] {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed as KittyWindow[];
  } catch {
    return [];
  }
}

/** Find an existing tab by title across all kitty windows. */
function findTabByTitle(
  windows: KittyWindow[],
  title: string,
): { tabId: number } | null {
  for (const win of windows) {
    if (!Array.isArray(win.tabs)) continue;
    for (const tab of win.tabs) {
      if (tab.title === title) {
        return { tabId: tab.id };
      }
    }
  }
  return null;
}

export function create(): Terminal {
  return {
    name: "kitty",

    async openSession(session: Session): Promise<void> {
      const sessionName = getSessionName(session);

      // List existing kitty state
      let windows: KittyWindow[] = [];
      try {
        const { stdout } = await execFileAsync("kitten", ["@", "ls"], {
          timeout: 30_000,
        });
        windows = parseKittyLs(stdout);
      } catch {
        // kitten @ ls failed — kitty may not be running or remote control not enabled
      }

      const existing = findTabByTitle(windows, sessionName);

      if (existing) {
        // Focus the existing tab
        await execFileAsync(
          "kitten",
          ["@", "focus-tab", "--match", `id:${existing.tabId}`],
          { timeout: 30_000 },
        );
      } else {
        // Launch a new tab attached to the tmux session
        await execFileAsync(
          "kitten",
          [
            "@",
            "launch",
            "--type=tab",
            "--title",
            sessionName,
            "tmux",
            "attach",
            "-t",
            sessionName,
          ],
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
        const { stdout } = await execFileAsync("kitten", ["@", "ls"], {
          timeout: 30_000,
        });
        const windows = parseKittyLs(stdout);
        return findTabByTitle(windows, sessionName) !== null;
      } catch {
        return false;
      }
    },
  };
}

export default { manifest, create } satisfies PluginModule<Terminal>;
