import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PluginModule, Terminal, Session } from "@composio/ao-core";

const execFileAsync = promisify(execFile);

export const manifest = {
  name: "zellij",
  slot: "terminal" as const,
  description: "Terminal plugin: Zellij tab management",
  version: "0.1.0",
};

function getSessionName(session: Session): string {
  return session.runtimeHandle?.id ?? session.id;
}

export function create(): Terminal {
  return {
    name: "zellij",

    async openSession(session: Session): Promise<void> {
      const sessionName = getSessionName(session);

      // Try to focus an existing tab by name first
      try {
        await execFileAsync(
          "zellij",
          ["action", "go-to-tab-name", sessionName],
          { timeout: 30_000 },
        );
        return;
      } catch {
        // Tab doesn't exist — create a new one
      }

      // Create a new tab with the session name, running tmux attach
      await execFileAsync(
        "zellij",
        [
          "action",
          "new-tab",
          "--name",
          sessionName,
          "--",
          "tmux",
          "attach",
          "-t",
          sessionName,
        ],
        { timeout: 30_000 },
      );
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
        // zellij action go-to-tab-name succeeds if the tab exists
        await execFileAsync(
          "zellij",
          ["action", "go-to-tab-name", sessionName],
          { timeout: 30_000 },
        );
        return true;
      } catch {
        return false;
      }
    },
  };
}

export default { manifest, create } satisfies PluginModule<Terminal>;
