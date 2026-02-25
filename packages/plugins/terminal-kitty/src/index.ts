import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PluginModule, Terminal, Session } from "@composio/ao-core";

const execFileAsync = promisify(execFile);

export const manifest = {
  name: "kitty",
  slot: "terminal" as const,
  description: "Terminal plugin: Kitty tab management",
  version: "0.1.0",
};

function sessionTarget(session: Session): string {
  return session.runtimeHandle?.id ?? session.id;
}

function shellEscape(value: string): string {
  return value.replace(/'/g, "'\\''");
}

async function isTabPresent(sessionName: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("kitty", ["@", "ls"], { timeout: 15_000 });
    return stdout.includes(sessionName);
  } catch {
    return false;
  }
}

async function openKittyTab(sessionName: string): Promise<void> {
  const attachCmd = `tmux attach -t '${shellEscape(sessionName)}'`;
  await execFileAsync(
    "kitty",
    ["@", "launch", "--type=tab", "--tab-title", sessionName, "sh", "-lc", attachCmd],
    { timeout: 15_000 },
  );
}

export function create(): Terminal {
  return {
    name: "kitty",

    async openSession(session: Session): Promise<void> {
      const name = sessionTarget(session);
      const alreadyOpen = await isTabPresent(name);
      if (!alreadyOpen) {
        await openKittyTab(name);
      }
    },

    async openAll(sessions: Session[]): Promise<void> {
      for (const session of sessions) {
        await this.openSession(session);
      }
    },

    async isSessionOpen(session: Session): Promise<boolean> {
      return isTabPresent(sessionTarget(session));
    },
  };
}

export default { manifest, create } satisfies PluginModule<Terminal>;
