import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { shellEscape, type PluginModule, type Terminal, type Session } from "@composio/ao-core";

const execFileAsync = promisify(execFile);

export const manifest = {
  name: "zellij",
  slot: "terminal" as const,
  description: "Terminal plugin: Zellij tab management",
  version: "0.1.0",
};

function sessionTarget(session: Session): string {
  return session.runtimeHandle?.id ?? session.id;
}

async function zellij(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("zellij", args, { timeout: 20_000 });
  return stdout.trim();
}

async function isSessionOpenByName(name: string): Promise<boolean> {
  try {
    const out = await zellij(["action", "query-tab-names"]);
    return out.split("\n").some((line) => line.trim() === name);
  } catch {
    return false;
  }
}

async function openTab(name: string): Promise<void> {
  const cmd = `tmux attach -t '${shellEscape(name)}'`;
  await zellij(["action", "new-tab", "--name", name, "--", "sh", "-lc", cmd]);
}

export function create(): Terminal {
  return {
    name: "zellij",

    async openSession(session: Session): Promise<void> {
      const name = sessionTarget(session);
      const open = await isSessionOpenByName(name);
      if (!open) await openTab(name);
    },

    async openAll(sessions: Session[]): Promise<void> {
      for (const session of sessions) {
        await this.openSession(session);
      }
    },

    async isSessionOpen(session: Session): Promise<boolean> {
      return isSessionOpenByName(sessionTarget(session));
    },
  };
}

export default { manifest, create } satisfies PluginModule<Terminal>;
