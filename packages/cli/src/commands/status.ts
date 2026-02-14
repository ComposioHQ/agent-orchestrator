import chalk from "chalk";
import type { Command } from "commander";
import {
  type Agent,
  type OrchestratorConfig,
  type Session,
  type RuntimeHandle,
  loadConfig,
} from "@agent-orchestrator/core";
import { git, getTmuxSessions, getTmuxActivity } from "../lib/shell.js";
import { getSessionDir, readMetadata } from "../lib/metadata.js";
import { banner, header, formatAge, statusColor } from "../lib/format.js";
import { getAgent, getAgentByName } from "../lib/plugins.js";
import { matchesPrefix } from "../lib/session-utils.js";

interface SessionInfo {
  name: string;
  branch: string | null;
  status: string | null;
  summary: string | null;
  claudeSummary: string | null;
  pr: string | null;
  issue: string | null;
  lastActivity: string;
  project: string | null;
}

/**
 * Build a minimal Session object for agent.getSessionInfo().
 * Only runtimeHandle and workspacePath are needed by the introspection logic.
 */
function buildSessionForIntrospect(sessionName: string, workspacePath?: string): Session {
  const handle: RuntimeHandle = {
    id: sessionName,
    runtimeName: "tmux",
    data: {},
  };
  return {
    id: sessionName,
    projectId: "",
    status: "working",
    activity: "idle",
    branch: null,
    issueId: null,
    pr: null,
    workspacePath: workspacePath || null,
    runtimeHandle: handle,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
  };
}

async function gatherSessionInfo(
  sessionName: string,
  sessionDir: string,
  agent: Agent,
): Promise<SessionInfo> {
  const metaFile = `${sessionDir}/${sessionName}`;
  const meta = readMetadata(metaFile);

  let branch = meta?.branch ?? null;
  const status = meta?.status ?? null;
  const summary = meta?.summary ?? null;
  const pr = meta?.pr ?? null;
  const issue = meta?.issue ?? null;
  const project = meta?.project ?? null;

  // Get live branch from worktree if available
  const worktree = meta?.worktree;
  if (worktree) {
    const liveBranch = await git(["branch", "--show-current"], worktree);
    if (liveBranch) branch = liveBranch;
  }

  // Get last activity time
  const activityTs = await getTmuxActivity(sessionName);
  const lastActivity = activityTs ? formatAge(activityTs) : "-";

  // Get agent's auto-generated summary via introspection
  let claudeSummary: string | null = null;
  try {
    const session = buildSessionForIntrospect(sessionName, worktree);
    const introspection = await agent.getSessionInfo(session);
    claudeSummary = introspection?.summary ?? null;
  } catch {
    // Introspection failed — not critical
  }

  return {
    name: sessionName,
    branch,
    status,
    summary,
    claudeSummary,
    pr,
    issue,
    lastActivity,
    project,
  };
}

function printSession(info: SessionInfo): void {
  const statusStr = info.status ? ` ${statusColor(info.status)}` : "";
  console.log(`  ${chalk.green(info.name)} ${chalk.dim(`(${info.lastActivity})`)}${statusStr}`);
  if (info.branch) {
    console.log(`     ${chalk.dim("Branch:")} ${info.branch}`);
  }
  if (info.issue) {
    console.log(`     ${chalk.dim("Issue:")}  ${info.issue}`);
  }
  if (info.pr) {
    console.log(`     ${chalk.dim("PR:")}     ${chalk.blue(info.pr)}`);
  }
  if (info.claudeSummary) {
    console.log(`     ${chalk.dim("Claude:")} ${info.claudeSummary.slice(0, 65)}`);
  } else if (info.summary) {
    console.log(`     ${chalk.dim("Summary:")} ${info.summary.slice(0, 65)}`);
  }
}

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show all sessions with branch, activity, PR, and CI status")
    .option("-p, --project <id>", "Filter by project ID")
    .option("--json", "Output as JSON")
    .action(async (opts: { project?: string; json?: boolean }) => {
      let config: OrchestratorConfig;
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

      const allTmux = await getTmuxSessions();
      const projects = opts.project
        ? { [opts.project]: config.projects[opts.project] }
        : config.projects;

      if (!opts.json) {
        console.log(banner("AGENT ORCHESTRATOR STATUS"));
        console.log();
      }

      let totalSessions = 0;
      const jsonOutput: SessionInfo[] = [];

      for (const [projectId, projectConfig] of Object.entries(projects)) {
        const prefix = projectConfig.sessionPrefix || projectId;
        const sessionDir = getSessionDir(config.dataDir, projectId);
        const projectSessions = allTmux.filter((s) => matchesPrefix(s, prefix));

        // Resolve agent for this project
        const agent = getAgent(config, projectId);

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

        totalSessions += projectSessions.length;

        for (const session of projectSessions.sort()) {
          const info = await gatherSessionInfo(session, sessionDir, agent);
          if (opts.json) {
            jsonOutput.push(info);
          } else {
            printSession(info);
            console.log();
          }
        }
      }

      if (opts.json) {
        console.log(JSON.stringify(jsonOutput, null, 2));
      } else {
        console.log(
          chalk.dim(
            `\n  ${totalSessions} active session${totalSessions !== 1 ? "s" : ""} across ${Object.keys(projects).length} project${Object.keys(projects).length !== 1 ? "s" : ""}`,
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
      const sessionObj = buildSessionForIntrospect(session);
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
