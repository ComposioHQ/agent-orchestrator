import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PluginModule, Terminal, Session } from "@composio/ao-core";

const execFileAsync = promisify(execFile);

export const manifest = {
  name: "cmux",
  slot: "terminal" as const,
  description: "Terminal plugin: cmux pane management",
  version: "0.1.0",
};

function getSessionName(session: Session): string {
  return session.runtimeHandle?.id ?? session.id;
}

export function create(): Terminal {
  return {
    name: "cmux",

    async openSession(session: Session): Promise<void> {
      const sessionName = getSessionName(session);

      // Try to focus an existing pane by name first
      try {
        await execFileAsync(
          "cmux",
          ["pane", "focus", "--name", sessionName],
          { timeout: 30_000 },
        );
        return;
      } catch {
        // Pane doesn't exist — create a new one
      }

      // Create a new pane with the session name, running tmux attach
      await execFileAsync(
        "cmux",
        [
          "pane",
          "create",
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
        // Small delay between pane operations to avoid race conditions
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    },

    async isSessionOpen(session: Session): Promise<boolean> {
      const sessionName = getSessionName(session);
      try {
        const { stdout } = await execFileAsync(
          "cmux",
          ["pane", "list", "--format", "json"],
          { timeout: 30_000 },
        );
        const panes: unknown = JSON.parse(stdout);
        if (!Array.isArray(panes)) return false;
        return panes.some(
          (p: unknown) =>
            typeof p === "object" &&
            p !== null &&
            "name" in p &&
            (p as { name: string }).name === sessionName,
        );
      } catch {
        return false;
      }
    },
  };
}

export default { manifest, create } satisfies PluginModule<Terminal>;
