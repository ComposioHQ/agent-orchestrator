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
  type Tracker,
  type ProjectConfig,
  isOrchestratorSession,
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
  role: "worker" | "orchestrator";
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
  const suppressPROwnership = isOrchestratorSession(session);
  let branch = session.branch;
  const status = session.status;
  const summary = session.metadata["summary"] ?? null;
  const prUrl = suppressPROwnership ? null : (session.metadata["pr"] ?? null);
  const issue = session.issueId;

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

  // Use activity from session (already enriched by sessionManager.list()).
  // If enrichment revived status to working but did not infer a more specific
  // activity state, fall back so the status table doesn't misleadingly show
  // "unknown" for a live worker.
  const activity = session.activity ?? (status === "working" ? "active" : null);

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

  if (branch && !suppressPROwnership) {
    try {
      const project = projectConfig.projects[session.projectId];
      if (project) {
        // Use a session copy with the live branch so detectPR queries
        // GitHub for the actual worktree branch, not stale metadata.
        const scmSession = branch !== session.branch
          ? { ...session, branch }
          : session;
        const prInfo: PRInfo | null = await scm.detectPR(scmSession, project);
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
    role: isOrchestratorSession(session) ? "orchestrator" : "worker",
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

function printSessionRow(info: SessionInfo): void {
  const prStr = info.prNumber ? `#${info.prNumber}` : "-";

  const row =
    padCol(chalk.green(info.name), COL.session) +
    padCol(info.branch ? chalk.cyan(info.branch) : chalk.dim("-"), COL.branch) +
    padCol(info.prNumber ? chalk.blue(prStr) : chalk.dim(prStr), COL.pr) +
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

function printOrchestratorRow(info: SessionInfo): void {
  const lastActivity =
    info.lastActivity === "-" ? chalk.dim("unknown") : chalk.dim(info.lastActivity);
  console.log(
    `  ${chalk.magenta("Orchestrator:")} ${chalk.green(info.name)} ${chalk.dim("(")}${lastActivity}${chalk.dim(")")}`,
  );
  const displaySummary = info.claudeSummary || info.summary;
  if (displaySummary) {
    console.log(`                ${chalk.dim(displaySummary.slice(0, 60))}`);
  }
}

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show all sessions with branch, activity, PR, and CI status")
    .option("-p, --project <id>", "Filter by project ID")
    .option("--json", "Output as JSON")
    .action(async (opts: { project?: string; json?: boolean }) => {
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

      // Use session manager to list sessions (metadata-based, not tmux-based)
      const sm = await getSessionManager(config);
      const sessions = await sm.list(opts.project);

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
      const jsonOutput: SessionInfo[] = [];
      let totalWorkers = 0;
      let totalOrchestrators = 0;

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
        const sessionInfos = await Promise.all(infoPromises);

        const orchestrators = sessionInfos.filter((info) => info.role === "orchestrator");
        const workers = sessionInfos.filter((info) => info.role === "worker");

        totalWorkers += workers.length;
        totalOrchestrators += orchestrators.length;

        for (const info of sessionInfos) {
          if (opts.json) {
            jsonOutput.push(info);
          }
        }

        if (opts.json) {
          continue;
        }

        if (orchestrators.length > 0) {
          for (const info of orchestrators) {
            printOrchestratorRow(info);
          }
        }

        if (workers.length === 0) {
          console.log(chalk.dim("  (no active sessions)"));
          console.log();
          continue;
        }

        printTableHeader();
        for (const info of workers) {
          printSessionRow(info);
        }
        console.log();
      }

      if (opts.json) {
        console.log(JSON.stringify(jsonOutput, null, 2));
      } else {
        console.log(
          chalk.dim(
            `  ${totalWorkers} active session${totalWorkers !== 1 ? "s" : ""} across ${projectIds.length} project${projectIds.length !== 1 ? "s" : ""}` +
              (totalOrchestrators > 0
                ? ` · ${totalOrchestrators} orchestrator${totalOrchestrators !== 1 ? "s" : ""}`
                : ""),
          ),
        );

        // Check for issues awaiting verification across all projects
        try {
          const { createPluginRegistry } = await import("@composio/ao-core");
          const registry = createPluginRegistry();
          await registry.loadFromConfig(config, (pkg: string) => import(pkg));

          let unverifiedTotal = 0;
          for (const projectId of projectIds) {
            const project: ProjectConfig | undefined = config.projects[projectId];
            if (!project?.tracker) continue;
            const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
            if (!tracker?.listIssues) continue;
            try {
              const issues = await tracker.listIssues(
                { state: "open", labels: ["merged-unverified"], limit: 20 },
                project,
              );
              unverifiedTotal += issues.length;
            } catch {
              // Tracker query failed — not critical
            }
          }

          if (unverifiedTotal > 0) {
            console.log(
              chalk.yellow(
                `  ⚠ ${unverifiedTotal} issue${unverifiedTotal !== 1 ? "s" : ""} awaiting verification (use \`ao verify --list\` to see them)`,
              ),
            );
          }
        } catch {
          // Plugin registry or tracker unavailable — skip silently
        }

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
