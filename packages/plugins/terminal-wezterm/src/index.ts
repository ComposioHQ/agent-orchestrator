import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { shellEscape, type PluginModule, type Terminal, type Session } from "@composio/ao-core";

const execFileAsync = promisify(execFile);

export const manifest = {
  name: "wezterm",
  slot: "terminal" as const,
  description: "Terminal plugin: WezTerm tab management",
  version: "0.1.0",
};

function sessionTarget(session: Session): string {
  return session.runtimeHandle?.id ?? session.id;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function isTabPresent(sessionName: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("wezterm", ["cli", "list"], { timeout: 15_000 });
    const boundaryPattern = new RegExp(`(^|\\s)${escapeRegExp(sessionName)}(\\s|$)`);
    return stdout
      .split("\n")
      .some((line) => boundaryPattern.test(line));
  } catch {
    return false;
  }
}

async function openWezTermTab(sessionName: string): Promise<void> {
  const attachCmd = `tmux attach -t '${shellEscape(sessionName)}'`;
  await execFileAsync("wezterm", ["cli", "spawn", "--new-window", "sh", "-lc", attachCmd], {
    timeout: 15_000,
  });
}

export function create(): Terminal {
  return {
    name: "wezterm",

    async openSession(session: Session): Promise<void> {
      const name = sessionTarget(session);
      const alreadyOpen = await isTabPresent(name);
      if (!alreadyOpen) {
        await openWezTermTab(name);
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
