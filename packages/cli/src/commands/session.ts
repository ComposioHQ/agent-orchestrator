import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig, SessionNotRestorableError, WorkspaceMissingError } from "@composio/ao-core";
import { git, getTmuxActivity } from "../lib/shell.js";
import { formatAge } from "../lib/format.js";
import { getSessionManager } from "../lib/create-session-manager.js";

export function registerSession(program: Command): void {
  const session = program.command("session").description("Session management (ls, attach, kill, cleanup)");

  session
    .command("ls")
    .description("List all sessions")
    .option("-p, --project <id>", "Filter by project ID")
    .action(async (opts: { project?: string }) => {
      const config = loadConfig();
      if (opts.project && !config.projects[opts.project]) {
        console.error(chalk.red(`Unknown project: ${opts.project}`));
        process.exit(1);
      }

      const sm = await getSessionManager(config);
      const sessions = await sm.list(opts.project);

      // Group sessions by project
      const byProject = new Map<string, typeof sessions>();
      for (const s of sessions) {
        const list = byProject.get(s.projectId) ?? [];
        list.push(s);
        byProject.set(s.projectId, list);
      }

      // Iterate over all configured projects (not just ones with sessions)
      const projectIds = opts.project ? [opts.project] : Object.keys(config.projects);

      for (const projectId of projectIds) {
        const project = config.projects[projectId];
        if (!project) continue;
        console.log(chalk.bold(`\n${project.name || projectId}:`));

        const projectSessions = (byProject.get(projectId) ?? []).sort((a, b) =>
          a.id.localeCompare(b.id),
        );

        if (projectSessions.length === 0) {
          console.log(chalk.dim("  (no active sessions)"));
          continue;
        }

        for (const s of projectSessions) {
          // Get live branch from worktree if available
          let branchStr = s.branch || "";
          if (s.workspacePath) {
            const liveBranch = await git(["branch", "--show-current"], s.workspacePath);
            if (liveBranch) branchStr = liveBranch;
          }

          // Get tmux activity age
          const tmuxTarget = s.runtimeHandle?.id ?? s.id;
          const activityTs = await getTmuxActivity(tmuxTarget);
          const age = activityTs ? formatAge(activityTs) : "-";

          const parts = [chalk.green(s.id), chalk.dim(`(${age})`)];
          if (branchStr) parts.push(chalk.cyan(branchStr));
          if (s.status) parts.push(chalk.dim(`[${s.status}]`));
          const prUrl = s.metadata["pr"];
          if (prUrl) parts.push(chalk.blue(prUrl));

          console.log(`  ${parts.join("  ")}`);
        }
      }
      console.log();
    });

  session
    .command("kill")
    .description("Kill a session and remove its worktree")
    .argument("<session>", "Session name to kill")
    .action(async (sessionName: string) => {
      const config = loadConfig();
      const sm = await getSessionManager(config);

      try {
        await sm.kill(sessionName);
        console.log(chalk.green(`\nSession ${sessionName} killed.`));
      } catch (err) {
        console.error(chalk.red(`Failed to kill session ${sessionName}: ${err}`));
        process.exit(1);
      }
    });

  session
    .command("cleanup")
    .description("Kill sessions where PR is merged or issue is closed")
    .option("-p, --project <id>", "Filter by project ID")
    .option("--dry-run", "Show what would be cleaned up without doing it")
    .action(async (opts: { project?: string; dryRun?: boolean }) => {
      const config = loadConfig();
      if (opts.project && !config.projects[opts.project]) {
        console.error(chalk.red(`Unknown project: ${opts.project}`));
        process.exit(1);
      }

      console.log(chalk.bold("Checking for completed sessions...\n"));

      const sm = await getSessionManager(config);

      if (opts.dryRun) {
        // Dry-run delegates to sm.cleanup() with dryRun flag so it uses the
        // same live checks (PR state, runtime alive, tracker) as actual cleanup.
        const result = await sm.cleanup(opts.project, { dryRun: true });

        if (result.errors.length > 0) {
          for (const { sessionId, error } of result.errors) {
            console.error(chalk.red(`  Error checking ${sessionId}: ${error}`));
          }
        }

        if (result.killed.length === 0 && result.errors.length === 0) {
          console.log(chalk.dim("  No sessions to clean up."));
        } else {
          for (const id of result.killed) {
            console.log(chalk.yellow(`  Would kill ${id}`));
          }
          if (result.killed.length > 0) {
            console.log(
              chalk.dim(
                `\nDry run complete. ${result.killed.length} session${result.killed.length !== 1 ? "s" : ""} would be cleaned.`,
              ),
            );
          }
        }
      } else {
        const result = await sm.cleanup(opts.project);

        if (result.killed.length === 0 && result.errors.length === 0) {
          console.log(chalk.dim("  No sessions to clean up."));
        } else {
          if (result.killed.length > 0) {
            for (const id of result.killed) {
              console.log(chalk.green(`  Cleaned: ${id}`));
            }
          }
          if (result.errors.length > 0) {
            for (const { sessionId, error } of result.errors) {
              console.error(chalk.red(`  Error cleaning ${sessionId}: ${error}`));
            }
          }
          console.log(chalk.green(`\nCleanup complete. ${result.killed.length} sessions cleaned.`));
        }
      }
    });

  session
    .command("attach")
    .description("Attach to a running session (via runtime plugin)")
    .argument("<session>", "Session name to attach to")
    .action(async (sessionName: string) => {
      const config = loadConfig();
      const sm = await getSessionManager(config);

      const info = await sm.getAttachInfo(sessionName);
      if (!info) {
        console.error(chalk.red(`Session "${sessionName}" not found or not running.`));
        process.exit(1);
      }

      const { spawnSync } = await import("node:child_process");

      switch (info.type) {
        case "tmux":
          spawnSync("tmux", ["attach", "-t", info.target], { stdio: "inherit" });
          break;
        case "docker":
          spawnSync("docker", ["exec", "-it", info.target, "/bin/sh"], { stdio: "inherit" });
          break;
        case "ssh":
          spawnSync("ssh", [info.target], { stdio: "inherit" });
          break;
        case "web":
          console.log(chalk.cyan(`Open in browser: ${info.target}`));
          break;
        default:
          if (info.command) {
            console.log(chalk.dim(`Run: ${info.command}`));
          } else {
            console.log(chalk.yellow(`Cannot auto-attach to ${info.type} session.`));
            console.log(chalk.dim(`Target: ${info.target}`));
          }
      }
    });

  session
    .command("restore")
    .description("Restore a terminated/crashed session in-place")
    .argument("<session>", "Session name to restore")
    .action(async (sessionName: string) => {
      const config = loadConfig();
      const sm = await getSessionManager(config);

      try {
        const restored = await sm.restore(sessionName);
        console.log(chalk.green(`\nSession ${sessionName} restored.`));
        if (restored.workspacePath) {
          console.log(chalk.dim(`  Worktree: ${restored.workspacePath}`));
        }
        if (restored.branch) {
          console.log(chalk.dim(`  Branch:   ${restored.branch}`));
        }
        const tmuxTarget = restored.runtimeHandle?.id ?? sessionName;
        console.log(chalk.dim(`  Attach:   tmux attach -t ${tmuxTarget}`));
      } catch (err) {
        if (err instanceof SessionNotRestorableError) {
          console.error(chalk.red(`Cannot restore: ${err.reason}`));
        } else if (err instanceof WorkspaceMissingError) {
          console.error(chalk.red(`Workspace missing: ${err.message}`));
        } else {
          console.error(chalk.red(`Failed to restore session ${sessionName}: ${err}`));
        }
        process.exit(1);
      }
    });
}
