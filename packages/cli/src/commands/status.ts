import { readFileSync, readdirSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig, type OrchestratorConfig } from "@agent-orchestrator/core";
import { exec, git, getTmuxSessions, getTmuxActivity } from "../lib/shell.js";
import { getSessionDir, readMetadata } from "../lib/metadata.js";
import { banner, header, formatAge, statusColor } from "../lib/format.js";

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
 * Extracts Claude's auto-generated summary from its internal session data.
 * Maps: tmux session → TTY → Claude PID → CWD → .claude/projects/ → JSONL summary
 */
async function getClaudeSessionInfo(
  sessionName: string,
): Promise<{ summary: string | null; sessionId: string | null }> {
  try {
    // Get the TTY for this tmux session's pane
    const ttyOutput = await exec("tmux", [
      "display-message",
      "-t",
      sessionName,
      "-p",
      "#{pane_tty}",
    ]);
    const tty = ttyOutput.stdout.trim();
    if (!tty) return { summary: null, sessionId: null };

    // Find Claude PID running on that TTY (column-based match to avoid pts/1 matching pts/10)
    const psOutput = await exec("ps", ["-eo", "pid,tty,comm"]);
    const ttyShort = tty.replace("/dev/", "");
    const pidLine = psOutput.stdout.split("\n").find((line) => {
      const cols = line.trim().split(/\s+/);
      return cols.length >= 3 && cols[1] === ttyShort && cols[2].includes("claude");
    });
    const pid = pidLine?.trim().split(/\s+/)[0];
    if (!pid) return { summary: null, sessionId: null };

    // Get Claude's working directory
    const cwdOutput = await exec("lsof", ["-p", pid, "-d", "cwd", "-Fn"]);
    const cwdMatch = cwdOutput.stdout.match(/n(.+)/);
    const cwd = cwdMatch?.[1];
    if (!cwd) return { summary: null, sessionId: null };

    // Encode path for Claude's project directory naming
    const encodedPath = cwd.replace(/\//g, "-").replace(/^-/, "");
    const claudeProjectDir = join(process.env.HOME || "~", ".claude", "projects", encodedPath);

    if (!existsSync(claudeProjectDir)) return { summary: null, sessionId: null };

    // Find the most recent session file
    const files = readdirSync(claudeProjectDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse();

    if (files.length === 0) return { summary: null, sessionId: null };

    const sessionFile = join(claudeProjectDir, files[0]);
    const sessionId = files[0].replace(".jsonl", "").slice(0, 8);

    // Read only the tail of the file (last ~8KB) to avoid loading large JSONL files
    const fileSize = statSync(sessionFile).size;
    const tailSize = Math.min(fileSize, 8192);
    let tail: string;
    if (tailSize === fileSize) {
      tail = readFileSync(sessionFile, "utf-8");
    } else {
      const buf = Buffer.alloc(tailSize);
      const fd = openSync(sessionFile, "r");
      try {
        readSync(fd, buf, 0, tailSize, fileSize - tailSize);
      } finally {
        closeSync(fd);
      }
      tail = buf.toString("utf-8");
    }
    const lines = tail.trim().split("\n").slice(-20);
    let summary: string | null = null;

    for (const line of lines.reverse()) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "summary" || entry.summary) {
          summary = entry.summary || entry.message;
          break;
        }
      } catch {
        // Skip non-JSON lines
      }
    }

    return { summary, sessionId };
  } catch {
    return { summary: null, sessionId: null };
  }
}

async function gatherSessionInfo(sessionName: string, sessionDir: string): Promise<SessionInfo> {
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

  // Get Claude's auto-generated summary
  const claudeInfo = await getClaudeSessionInfo(sessionName);

  return {
    name: sessionName,
    branch,
    status,
    summary,
    claudeSummary: claudeInfo.summary,
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
        // Fall back to finding sessions without config
        await showFallbackStatus();
        return;
      }

      const allTmux = await getTmuxSessions();
      const projects = opts.project
        ? { [opts.project]: config.projects[opts.project] }
        : config.projects;

      if (opts.project && !config.projects[opts.project]) {
        console.error(chalk.red(`Unknown project: ${opts.project}`));
        process.exit(1);
      }

      if (!opts.json) {
        console.log(banner("AGENT ORCHESTRATOR STATUS"));
        console.log();
      }

      let totalSessions = 0;
      const jsonOutput: SessionInfo[] = [];

      for (const [projectId, projectConfig] of Object.entries(projects)) {
        const prefix = projectConfig.sessionPrefix || projectId;
        const sessionDir = getSessionDir(config.dataDir, projectId);
        const projectSessions = allTmux.filter((s) => s.startsWith(`${prefix}-`));

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
          const info = await gatherSessionInfo(session, sessionDir);
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

  for (const session of allTmux.sort()) {
    const activityTs = await getTmuxActivity(session);
    const lastActivity = activityTs ? formatAge(activityTs) : "-";
    console.log(`  ${chalk.green(session)} ${chalk.dim(`(${lastActivity})`)}`);
  }
  console.log();
}
