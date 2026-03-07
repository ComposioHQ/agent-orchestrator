import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform } from "node:os";
import type { PluginModule, Terminal, Session } from "@composio/ao-core";

const execFileAsync = promisify(execFile);

export const manifest = {
  name: "windows-terminal",
  slot: "terminal" as const,
  description: "Terminal plugin: Windows Terminal (wt.exe) tab management",
  version: "0.1.0",
};

function getSessionName(session: Session): string {
  return session.runtimeHandle?.id ?? session.id;
}

function isWindows(): boolean {
  return platform() === "win32";
}

export function create(): Terminal {
  return {
    name: "windows-terminal",

    async openSession(session: Session): Promise<void> {
      if (!isWindows()) {
        // eslint-disable-next-line no-console
        console.warn(
          "[terminal-windows-terminal] Windows Terminal is only available on Windows",
        );
        return;
      }

      const sessionName = getSessionName(session);

      // Open a new tab in Windows Terminal.
      // wt.exe does not provide a way to query existing tabs or focus them,
      // so we always open a new tab.
      await execFileAsync(
        "wt.exe",
        [
          "nt",
          "--title",
          sessionName,
          "tmux",
          "attach",
          "-t",
          sessionName,
        ],
        { timeout: 30_000 },
      );
    },

    async openAll(sessions: Session[]): Promise<void> {
      if (!isWindows() || sessions.length === 0) {
        if (!isWindows()) {
          // eslint-disable-next-line no-console
          console.warn(
            "[terminal-windows-terminal] Windows Terminal is only available on Windows",
          );
        }
        return;
      }

      for (const session of sessions) {
        await this.openSession(session);
        // Small delay between tab operations to avoid race conditions
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    },

    async isSessionOpen(_session: Session): Promise<boolean> {
      // Windows Terminal does not expose a CLI API to query open tabs by title.
      // Always return false — a new tab will be opened each time.
      return false;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Terminal>;
