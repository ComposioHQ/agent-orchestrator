import chalk from "chalk";
import type { Command } from "commander";
import {
  type Session,
  type CIStatus,
  type SCM,
  type OrchestratorConfig,
  loadConfig,
  SessionNotRestorableError,
  WorkspaceMissingError,
} from "@composio/ao-core";
import { git, getTmuxActivity } from "../lib/shell.js";
import { formatAge } from "../lib/format.js";
import { getSessionManager } from "../lib/create-session-manager.js";
import { getSCM } from "../lib/plugins.js";
import { detectSessionPR } from "../lib/scm-data.js";

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

  session
    .command("table")
    .description("Print structured table of all sessions with PR/CI/bugbot data")
    .option("-p, --project <id>", "Filter by project ID")
    .option("--json", "Output as JSON instead of table")
    .action(async (opts: { project?: string; json?: boolean }) => {
      const config = loadConfig();
      if (opts.project && !config.projects[opts.project]) {
        console.error(`Unknown project: ${opts.project}`);
        process.exit(1);
      }

      const sm = await getSessionManager(config);
      const sessions = await sm.list(opts.project);
      const port = config.port ?? 3000;

      // Gather enriched data for each session in parallel
      const rows = await Promise.all(
        sessions
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((s) => gatherTableRow(s, config, port)),
      );

      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      // Compute column widths from data
      const cols = computeColumnWidths(rows);

      // Print header
      const hdr =
        pad("SESSION", cols.session) +
        pad("STATUS", cols.status) +
        pad("ACTIVITY", cols.activity) +
        pad("PR", cols.pr) +
        pad("CI", cols.ci) +
        pad("BUGBOT", cols.bugbot) +
        pad("SESSION_URL", cols.sessionUrl) +
        "PR_URL";
      console.log(hdr);

      // Print rows
      for (const row of rows) {
        const line =
          pad(row.session, cols.session) +
          pad(row.status, cols.status) +
          pad(row.activity, cols.activity) +
          pad(row.pr, cols.pr) +
          pad(row.ci, cols.ci) +
          pad(String(row.bugbot), cols.bugbot) +
          pad(row.sessionUrl, cols.sessionUrl) +
          row.prUrl;
        console.log(line);
      }
    });
}

interface TableRow {
  session: string;
  status: string;
  activity: string;
  pr: string;
  ci: string;
  bugbot: number;
  sessionUrl: string;
  prUrl: string;
}

async function gatherTableRow(
  session: Session,
  config: OrchestratorConfig,
  port: number,
): Promise<TableRow> {
  const project = config.projects[session.projectId];
  let scm: SCM | null = null;
  if (project) {
    try {
      scm = getSCM(config, session.projectId);
    } catch {
      // Unknown/misconfigured SCM plugin — proceed without SCM data
    }
  }

  const { prNumber, prUrl, prInfo } = await detectSessionPR(session, scm, project);
  const prLabel = prNumber ? `#${prNumber}` : "-";
  let ciStatus: CIStatus | null = null;
  let bugbotCount = 0;

  if (prInfo && scm) {
    const [ci, automated] = await Promise.all([
      scm.getCISummary(prInfo).catch(() => null),
      scm.getAutomatedComments(prInfo).catch(() => []),
    ]);
    ciStatus = ci;
    bugbotCount = automated.length;
  }

  // Map CI status to display value
  let ciDisplay: string;
  switch (ciStatus) {
    case "passing":
      ciDisplay = "green";
      break;
    case "failing":
      ciDisplay = "red";
      break;
    case "pending":
      ciDisplay = "pending";
      break;
    default:
      ciDisplay = "-";
  }

  const sessionUrl = `http://localhost:${port}/sessions/${session.id}`;

  return {
    session: session.id,
    status: session.status,
    activity: session.activity ?? "unknown",
    pr: prLabel,
    ci: ciDisplay,
    bugbot: bugbotCount,
    sessionUrl,
    prUrl,
  };
}

function computeColumnWidths(rows: TableRow[]): Record<string, number> {
  const min = (key: keyof TableRow, header: string) => {
    const max = Math.max(header.length, ...rows.map((r) => String(r[key]).length));
    return max + 2; // 2-char padding
  };
  return {
    session: min("session", "SESSION"),
    status: min("status", "STATUS"),
    activity: min("activity", "ACTIVITY"),
    pr: min("pr", "PR"),
    ci: min("ci", "CI"),
    bugbot: min("bugbot", "BUGBOT"),
    sessionUrl: min("sessionUrl", "SESSION_URL"),
  };
}

function pad(str: string, width: number): string {
  return str.padEnd(width);
}
