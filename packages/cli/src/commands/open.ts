import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig } from "@composio/ao-core";
import { exec } from "../lib/shell.js";
import { getSessionManager } from "../lib/create-session-manager.js";
import { getAttachCommand } from "../lib/runtime.js";

async function openInTerminal(sessionName: string, newWindow?: boolean): Promise<boolean> {
  try {
    const args = newWindow ? ["--new-window", sessionName] : [sessionName];
    await exec("open-iterm-tab", args);
    return true;
  } catch {
    // Fall back to attach hint
    return false;
  }
}

export function registerOpen(program: Command): void {
  program
    .command("open")
    .description("Open session(s) in terminal tabs")
    .argument("[target]", 'Session name, project ID, or "all" to open everything')
    .option("-w, --new-window", "Open in a new terminal window")
    .action(async (target: string | undefined, opts: { newWindow?: boolean }) => {
      const config = loadConfig();
      const sm = await getSessionManager(config);
      const sessions = await sm.list();

      let sessionsToOpen = sessions;

      if (!target || target === "all") {
      } else if (config.projects[target]) {
        sessionsToOpen = sessions.filter((session) => session.projectId === target);
      } else if (sessions.some((session) => session.id === target)) {
        sessionsToOpen = sessions.filter((session) => session.id === target);
      } else {
        console.error(
          chalk.red(`Unknown target: ${target}\nSpecify a session name, project ID, or "all".`),
        );
        process.exit(1);
      }

      if (sessionsToOpen.length === 0) {
        console.log(chalk.dim("No sessions to open."));
        return;
      }

      console.log(
        chalk.bold(
          `Opening ${sessionsToOpen.length} session${sessionsToOpen.length > 1 ? "s" : ""}...\n`,
        ),
      );

      for (const session of sessionsToOpen.sort((a, b) => a.id.localeCompare(b.id))) {
        const runtimeName = session.runtimeHandle?.runtimeName ?? "tmux";
        if (runtimeName === "tmux") {
          const opened = await openInTerminal(
            session.runtimeHandle?.id ?? session.id,
            opts.newWindow,
          );
          if (opened) {
            console.log(chalk.green(`  Opened: ${session.id}`));
            continue;
          }
        }

        console.log(
          `  ${chalk.yellow(session.id)} — attach with: ${chalk.dim(getAttachCommand(session.runtimeHandle, session.id))}`,
        );
        if (runtimeName !== "tmux") {
          console.log(chalk.dim(`    iTerm auto-open is only supported for tmux sessions.`));
        } else {
          console.log(
            chalk.dim(`    open-iterm-tab is unavailable; use the attach command above.`),
          );
        }
      }
      console.log();
    });
}
