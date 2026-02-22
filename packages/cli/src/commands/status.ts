import chalk from "chalk";
import type { Command } from "commander";
import {
  type Agent,
  type SCM,
  type Session,
  type PRInfo,
  type CIStatus,
  type ReviewDecision,
  type ActivityState,
  loadConfig,
} from "@composio/ao-core";
import { git, getTmuxSessions, getTmuxActivity } from "../lib/shell.js";
import {
  banner,
  header,
  formatAge,
  activityIcon,
  ciStatusIcon,
  reviewDecisionIcon,
  padCol,
} from "../lib/format.js";
import { getAgentByName, getSCM } from "../lib/plugins.js";
import { getSessionManager } from "../lib/create-session-manager.js";

interface SessionInfo {
  name: string;
  branch: string | null;
  status: string | null;
  summary: string | null;
  claudeSummary: string | null;
  pr: string | null;
  prNumber: number | null;
  issue: string | null;
  lastActivity: string;
  project: string | null;
  ciStatus: CIStatus | null;
  reviewDecision: ReviewDecision | null;
  pendingThreads: number | null;
  activity: ActivityState | null;
}

async function gatherSessionInfo(
  session: Session,
  agent: Agent,
  scm: SCM,
  projectConfig: ReturnType<typeof loadConfig>,
): Promise<SessionInfo> {
  const summary = session.metadata["summary"] ?? null;
  const prUrl = session.metadata["pr"] ?? null;
  const issue = session.issueId;

  // Short-circuit for exited/archived sessions — skip expensive subprocess calls
  // (git, tmux, agent introspection, SCM) since the runtime is dead.
  if (session.activity === "exited") {
    let prNumber: number | null = null;
    if (prUrl) {
      const prMatch = /\/pull\/(\d+)/.exec(prUrl);
      if (prMatch) prNumber = parseInt(prMatch[1], 10);
    }
    return {
      name: session.id,
      branch: session.branch,
      status: session.status,
      summary,
      claudeSummary: null,
      pr: prUrl,
      prNumber,
      issue,
      lastActivity: session.lastActivityAt ? formatAge(session.lastActivityAt.getTime()) : "-",
      project: session.projectId,
      ciStatus: null,
      reviewDecision: null,
      pendingThreads: null,
      activity: "exited",
    };
  }

  let branch = session.branch;
  const status = session.status;

  // Get live branch from worktree if available
  if (session.workspacePath) {
    const liveBranch = await git(["branch", "--show-current"], session.workspacePath);
    if (liveBranch) branch = liveBranch;
  }

  // Get last activity time from tmux
  const tmuxTarget = session.runtimeHandle?.id ?? session.id;
  const activityTs = await getTmuxActivity(tmuxTarget);
  const lastActivity = activityTs ? formatAge(activityTs) : "-";

  // Get agent's auto-generated summary via introspection
  let claudeSummary: string | null = null;
  try {
    const introspection = await agent.getSessionInfo(session);
    claudeSummary = introspection?.summary ?? null;
  } catch {
    // Summary extraction failed — not critical
  }

  // Use activity from session (already enriched by sessionManager.list())
  const activity = session.activity;

  // Fetch PR, CI, and review data from SCM
  let prNumber: number | null = null;
  let ciStatus: CIStatus | null = null;
  let reviewDecision: ReviewDecision | null = null;
  let pendingThreads: number | null = null;

  // Extract PR number from metadata URL as fallback
  if (prUrl) {
    const prMatch = /\/pull\/(\d+)/.exec(prUrl);
    if (prMatch) {
      prNumber = parseInt(prMatch[1], 10);
    }
  }

  if (branch) {
    try {
      const project = projectConfig.projects[session.projectId];
      if (project) {
        const prInfo: PRInfo | null = await scm.detectPR(session, project);
        if (prInfo) {
          prNumber = prInfo.number;

          const [ci, review, threads] = await Promise.all([
            scm.getCISummary(prInfo).catch(() => null),
            scm.getReviewDecision(prInfo).catch(() => null),
            scm.getPendingComments(prInfo).catch(() => null),
          ]);

          ciStatus = ci;
          reviewDecision = review;
          pendingThreads = threads !== null ? threads.length : null;
        }
      }
    } catch {
      // SCM lookup failed — not critical
    }
  }

  return {
    name: session.id,
    branch,
    status,
    summary,
    claudeSummary,
    pr: prUrl,
    prNumber,
    issue,
    lastActivity,
    project: session.projectId,
    ciStatus,
    reviewDecision,
    pendingThreads,
    activity,
  };
}

// Column widths for the table
const COL = {
  session: 14,
  branch: 24,
  pr: 6,
  ci: 6,
  review: 6,
  threads: 4,
  activity: 9,
  age: 8,
};

function printTableHeader(): void {
  const hdr =
    padCol("Session", COL.session) +
    padCol("Branch", COL.branch) +
    padCol("PR", COL.pr) +
    padCol("CI", COL.ci) +
    padCol("Rev", COL.review) +
    padCol("Thr", COL.threads) +
    padCol("Activity", COL.activity) +
    "Age";
  console.log(chalk.dim(`  ${hdr}`));
  const totalWidth =
    COL.session + COL.branch + COL.pr + COL.ci + COL.review + COL.threads + COL.activity + 3;
  console.log(chalk.dim(`  ${"─".repeat(totalWidth)}`));
}

function printSessionRow(info: SessionInfo, dimmed = false): void {
  const prStr = info.prNumber ? `#${info.prNumber}` : "-";
  const nameStyle = dimmed ? chalk.dim : chalk.green;

  const row =
    padCol(nameStyle(info.name), COL.session) +
    padCol(info.branch ? (dimmed ? chalk.dim(info.branch) : chalk.cyan(info.branch)) : chalk.dim("-"), COL.branch) +
    padCol(info.prNumber ? (dimmed ? chalk.dim(prStr) : chalk.blue(prStr)) : chalk.dim(prStr), COL.pr) +
    padCol(ciStatusIcon(info.ciStatus), COL.ci) +
    padCol(reviewDecisionIcon(info.reviewDecision), COL.review) +
    padCol(
      info.pendingThreads !== null && info.pendingThreads > 0
        ? chalk.yellow(String(info.pendingThreads))
        : chalk.dim(info.pendingThreads !== null ? "0" : "-"),
      COL.threads,
    ) +
    padCol(activityIcon(info.activity), COL.activity) +
    chalk.dim(info.lastActivity);

  console.log(`  ${row}`);

  // Show summary on a second line if available
  const displaySummary = info.claudeSummary || info.summary;
  if (displaySummary) {
    console.log(`  ${" ".repeat(COL.session)}${chalk.dim(displaySummary.slice(0, 60))}`);
  }
}

/** Check if a session matches a search query (case-insensitive). */
function matchesSearch(info: SessionInfo, query: string): boolean {
  const q = query.toLowerCase();
  return (
    info.name.toLowerCase().includes(q) ||
    (info.branch?.toLowerCase().includes(q) ?? false) ||
    (info.pr?.toLowerCase().includes(q) ?? false) ||
    (info.prNumber !== null && String(info.prNumber).includes(q)) ||
    (info.issue?.toLowerCase().includes(q) ?? false) ||
    (info.summary?.toLowerCase().includes(q) ?? false) ||
    (info.claudeSummary?.toLowerCase().includes(q) ?? false) ||
    (info.project?.toLowerCase().includes(q) ?? false)
  );
}

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show all sessions with branch, activity, PR, and CI status")
    .option("-p, --project <id>", "Filter by project ID")
    .option("--json", "Output as JSON")
    .option("-a, --all", "Include exited/archived sessions")
    .option("--state <state>", "Filter by session state (active, exited)")
    .option("-s, --search <query>", "Search sessions by PR, branch, issue, or summary")
    .action(async (opts: { project?: string; json?: boolean; all?: boolean; state?: string; search?: string }) => {
      let config: ReturnType<typeof loadConfig>;
      try {
        config = loadConfig();
      } catch {
        console.log(chalk.yellow("No config found. Run `ao init` first."));
        console.log(chalk.dim("Falling back to session discovery...\n"));
        await showFallbackStatus();
        return;
      }

      if (opts.project && !config.projects[opts.project]) {
        console.error(chalk.red(`Unknown project: ${opts.project}`));
        process.exit(1);
      }

      // Determine whether to include archived sessions
      const includeArchived = opts.all || opts.state === "exited" || !!opts.search;

      // Use session manager to list sessions (metadata-based, not tmux-based)
      const sm = await getSessionManager(config);
      const sessions = includeArchived
        ? await sm.listAll(opts.project)
        : await sm.list(opts.project);

      if (!opts.json) {
        console.log(banner("AGENT ORCHESTRATOR STATUS"));
        console.log();
      }

      // Group sessions by project
      const byProject = new Map<string, Session[]>();
      for (const s of sessions) {
        const list = byProject.get(s.projectId) ?? [];
        list.push(s);
        byProject.set(s.projectId, list);
      }

      // Show projects that have no sessions too (if not filtered)
      const projectIds = opts.project ? [opts.project] : Object.keys(config.projects);
      let totalActive = 0;
      let totalExited = 0;
      const jsonOutput: SessionInfo[] = [];

      for (const projectId of projectIds) {
        const projectConfig = config.projects[projectId];
        if (!projectConfig) continue;

        const projectSessions = (byProject.get(projectId) ?? []).sort((a, b) =>
          a.id.localeCompare(b.id),
        );

        // Resolve agent and SCM for this project
        const agentName = projectConfig.agent ?? config.defaults.agent;
        const agent = getAgentByName(agentName);
        const scm = getSCM(config, projectId);

        if (!opts.json) {
          console.log(header(projectConfig.name || projectId));
        }

        if (projectSessions.length === 0) {
          if (!opts.json) {
            console.log(chalk.dim("  (no active sessions)"));
            console.log();
          }
          continue;
        }

        // Gather all session info in parallel
        const infoPromises = projectSessions.map((s) => gatherSessionInfo(s, agent, scm, config));
        const allInfos = await Promise.all(infoPromises);

        // Apply search filter if specified
        let filteredInfos = allInfos;
        if (opts.search) {
          filteredInfos = allInfos.filter((info) => matchesSearch(info, opts.search!));
        }

        // Apply state filter
        if (opts.state === "exited") {
          filteredInfos = filteredInfos.filter((info) => info.activity === "exited");
        } else if (opts.state === "active") {
          filteredInfos = filteredInfos.filter((info) => info.activity !== "exited");
        }

        // Separate active and exited sessions
        const activeSessions = filteredInfos.filter((info) => info.activity !== "exited");
        const exitedSessions = filteredInfos.filter((info) => info.activity === "exited");

        totalActive += activeSessions.length;
        totalExited += exitedSessions.length;

        if (filteredInfos.length === 0) {
          if (!opts.json) {
            let label = "(no active sessions)";
            if (opts.search) label = "(no matching sessions)";
            else if (opts.state === "exited") label = "(no exited sessions)";
            else if (opts.state === "active") label = "(no active sessions)";
            console.log(chalk.dim(`  ${label}`));
            console.log();
          }
          continue;
        }

        // Print active sessions
        if (activeSessions.length > 0) {
          if (!opts.json) {
            printTableHeader();
          }
          for (const info of activeSessions) {
            if (opts.json) {
              jsonOutput.push(info);
            } else {
              printSessionRow(info);
            }
          }
          if (!opts.json && exitedSessions.length > 0) {
            console.log();
          }
        }

        // Print exited sessions with dimmed styling
        if (exitedSessions.length > 0) {
          if (!opts.json) {
            if (activeSessions.length > 0 || includeArchived) {
              console.log(chalk.dim(`  ── exited sessions ──`));
            }
            if (activeSessions.length === 0) {
              printTableHeader();
            }
          }
          for (const info of exitedSessions) {
            if (opts.json) {
              jsonOutput.push(info);
            } else {
              printSessionRow(info, true);
            }
          }
        }

        if (!opts.json) {
          console.log();
        }
      }

      if (opts.json) {
        console.log(JSON.stringify(jsonOutput, null, 2));
      } else {
        const parts: string[] = [];
        if (totalActive > 0 || !includeArchived) {
          parts.push(`${totalActive} active session${totalActive !== 1 ? "s" : ""}`);
        }
        if (totalExited > 0) {
          parts.push(`${totalExited} exited session${totalExited !== 1 ? "s" : ""}`);
        }
        const summary = parts.length > 0 ? parts.join(", ") : "0 sessions";
        console.log(
          chalk.dim(
            `  ${summary} across ${projectIds.length} project${projectIds.length !== 1 ? "s" : ""}`,
          ),
        );
        console.log();
      }
    });
}

async function showFallbackStatus(): Promise<void> {
  const allTmux = await getTmuxSessions();
  if (allTmux.length === 0) {
    console.log(chalk.dim("No tmux sessions found."));
    return;
  }

  console.log(banner("AGENT ORCHESTRATOR STATUS"));
  console.log();
  console.log(
    chalk.dim(`  ${allTmux.length} tmux session${allTmux.length !== 1 ? "s" : ""} found\n`),
  );

  // Use claude-code as default agent for fallback introspection
  const agent = getAgentByName("claude-code");

  for (const session of allTmux.sort()) {
    const activityTs = await getTmuxActivity(session);
    const lastActivity = activityTs ? formatAge(activityTs) : "-";
    console.log(`  ${chalk.green(session)} ${chalk.dim(`(${lastActivity})`)}`);

    // Try introspection even without config
    try {
      const sessionObj: Session = {
        id: session,
        projectId: "",
        status: "working",
        activity: null,
        branch: null,
        issueId: null,
        pr: null,
        workspacePath: null,
        runtimeHandle: { id: session, runtimeName: "tmux", data: {} },
        agentInfo: null,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        metadata: {},
      };
      const introspection = await agent.getSessionInfo(sessionObj);
      if (introspection?.summary) {
        console.log(`     ${chalk.dim("Claude:")} ${introspection.summary.slice(0, 65)}`);
      }
    } catch {
      // Not critical
    }
  }
  console.log();
}
