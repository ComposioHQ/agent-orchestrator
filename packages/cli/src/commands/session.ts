import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig, type OrchestratorConfig } from "@agent-orchestrator/core";
import { tmux, git, gh, getTmuxSessions, getTmuxActivity } from "../lib/shell.js";
import { getSessionDir, readMetadata, archiveMetadata } from "../lib/metadata.js";
import { formatAge } from "../lib/format.js";
import { findProjectForSession, matchesPrefix } from "../lib/session-utils.js";

async function killSession(
  config: OrchestratorConfig,
  projectId: string,
  sessionName: string,
): Promise<void> {
  const sessionDir = getSessionDir(config.dataDir, projectId);
  const metaFile = `${sessionDir}/${sessionName}`;
  const meta = readMetadata(metaFile);

  // Kill tmux session
  const killed = await tmux("kill-session", "-t", sessionName);
  if (killed !== null) {
    console.log(chalk.green(`  Killed tmux session: ${sessionName}`));
  }

  // Remove worktree if we know about it
  const worktree = meta?.worktree;
  if (worktree) {
    const project = config.projects[projectId];
    if (project) {
      const removed = await git(["worktree", "remove", "--force", worktree], project.path);
      if (removed !== null) {
        console.log(chalk.green(`  Removed worktree: ${worktree}`));
      } else {
        console.log(chalk.yellow(`  Failed to remove worktree: ${worktree}`));
      }
    }
  }

  // Archive metadata
  archiveMetadata(sessionDir, sessionName);
  console.log(chalk.green(`  Archived metadata`));
}

export function registerSession(program: Command): void {
  const session = program.command("session").description("Session management (ls, kill, cleanup)");

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
      const allTmux = await getTmuxSessions();
      const projects = opts.project
        ? { [opts.project]: config.projects[opts.project] }
        : config.projects;

      for (const [projectId, project] of Object.entries(projects)) {
        const prefix = project.sessionPrefix || projectId;
        const sessionDir = getSessionDir(config.dataDir, projectId);
        const projectSessions = allTmux.filter((s) => matchesPrefix(s, prefix));

        console.log(chalk.bold(`\n${project.name || projectId}:`));

        if (projectSessions.length === 0) {
          console.log(chalk.dim("  (no active sessions)"));
          continue;
        }

        for (const name of projectSessions.sort()) {
          const meta = readMetadata(`${sessionDir}/${name}`);
          const activityTs = await getTmuxActivity(name);
          const age = activityTs ? formatAge(activityTs) : "-";

          let branchStr = meta?.branch || "";
          if (meta?.worktree) {
            const liveBranch = await git(["branch", "--show-current"], meta.worktree);
            if (liveBranch) branchStr = liveBranch;
          }

          const parts = [chalk.green(name), chalk.dim(`(${age})`)];
          if (branchStr) parts.push(chalk.cyan(branchStr));
          if (meta?.status) parts.push(chalk.dim(`[${meta.status}]`));
          if (meta?.pr) parts.push(chalk.blue(meta.pr));

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
      const projectId = findProjectForSession(config, sessionName);
      if (!projectId) {
        console.error(chalk.red(`Could not determine project for session: ${sessionName}`));
        process.exit(1);
      }
      await killSession(config, projectId, sessionName);
      console.log(chalk.green(`\nSession ${sessionName} killed.`));
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
      const allTmux = await getTmuxSessions();
      const projects = opts.project
        ? { [opts.project]: config.projects[opts.project] }
        : config.projects;

      console.log(chalk.bold("Checking for completed sessions...\n"));

      let cleaned = 0;
      let found = 0;

      for (const [projectId, project] of Object.entries(projects)) {
        const prefix = project.sessionPrefix || projectId;
        const sessionDir = getSessionDir(config.dataDir, projectId);
        const projectSessions = allTmux.filter((s) => matchesPrefix(s, prefix));

        for (const sessionName of projectSessions) {
          const meta = readMetadata(`${sessionDir}/${sessionName}`);
          if (!meta) continue;

          let shouldKill = false;
          let reason = "";

          // Check if PR is merged
          if (meta.pr) {
            const prNum = meta.pr.match(/(\d+)\s*$/)?.[1];
            if (prNum && project.repo) {
              const state = await gh([
                "pr",
                "view",
                prNum,
                "--repo",
                project.repo,
                "--json",
                "state",
                "-q",
                ".state",
              ]);
              if (state === "MERGED") {
                shouldKill = true;
                reason = `PR #${prNum} merged`;
              }
            }
          }

          if (shouldKill) {
            found++;
            if (opts.dryRun) {
              console.log(chalk.yellow(`  Would kill ${sessionName}: ${reason}`));
            } else {
              try {
                console.log(chalk.yellow(`  Killing ${sessionName}: ${reason}`));
                await killSession(config, projectId, sessionName);
                cleaned++;
              } catch (err) {
                console.error(chalk.red(`  Failed to kill ${sessionName}: ${err}`));
              }
            }
          }
        }
      }

      if (opts.dryRun) {
        if (found === 0) {
          console.log(chalk.dim("  No sessions to clean up."));
        } else {
          console.log(
            chalk.dim(
              `\nDry run complete. ${found} session${found !== 1 ? "s" : ""} would be cleaned.`,
            ),
          );
        }
      } else if (cleaned === 0) {
        console.log(chalk.dim("  No sessions to clean up."));
      } else {
        console.log(chalk.green(`\nCleanup complete. ${cleaned} sessions cleaned.`));
      }
    });
}
