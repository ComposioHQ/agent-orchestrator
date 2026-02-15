import { existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { loadConfig, buildPrompt, tmuxSendKeys, type OrchestratorConfig, type ProjectConfig } from "@composio/ao-core";
import { exec, git, getTmuxSessions } from "../lib/shell.js";
import { getSessionDir, writeMetadata, findSessionForIssue } from "../lib/metadata.js";
import { banner } from "../lib/format.js";
import { getAgent } from "../lib/plugins.js";
import { escapeRegex } from "../lib/session-utils.js";

/**
 * Find the next available session number for a prefix.
 *
 * There is an inherent TOCTOU gap between reading the session list and creating
 * the tmux session. If two spawns race, tmux new-session will fail with a
 * duplicate name error, which spawnSession already handles by throwing to the
 * caller (batch-spawn catches per-item failures and continues).
 */
async function getNextSessionNumber(prefix: string): Promise<number> {
  const sessions = await getTmuxSessions();
  let max = 0;
  const pattern = new RegExp(`^${escapeRegex(prefix)}-(\\d+)$`);
  for (const s of sessions) {
    const m = s.match(pattern);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return max + 1;
}

async function spawnSession(
  config: OrchestratorConfig,
  projectId: string,
  project: ProjectConfig,
  issueId?: string,
  openTab?: boolean,
  exploratory?: boolean,
): Promise<string> {
  const prefix = project.sessionPrefix || projectId;
  const num = await getNextSessionNumber(prefix);
  const sessionName = `${prefix}-${num}`;
  const worktreePath = join(config.worktreeDir, projectId, sessionName);

  const spinner = ora(`Creating session ${sessionName}`).start();

  try {
    // Fetch latest from remote
    await git(["fetch", "origin", "--quiet"], project.path);

    // Create worktree — sanitize issueId for git ref safety
    const safeBranchSuffix = issueId
      ? issueId
          .replace(/^#/, "") // strip leading #
          .replace(/[^\w./-]/g, "-") // replace non-ref-safe chars
          .replace(/\.{2,}/g, ".") // no consecutive dots
          .replace(/^[.-]|[.-]$/g, "") // no leading/trailing dots or dashes
      : undefined;
    const branch = safeBranchSuffix ? `feat/${safeBranchSuffix}` : undefined;
    const defaultRef = `origin/${project.defaultBranch}`;

    if (branch) {
      const result = await git(
        ["worktree", "add", "-b", branch, worktreePath, defaultRef],
        project.path,
      );
      if (result === null) {
        // Branch already exists — check it out in the new worktree
        const fallback = await git(["worktree", "add", worktreePath, branch], project.path);
        if (fallback === null) {
          throw new Error(`Failed to create worktree at ${worktreePath} for branch ${branch}`);
        }
      }
    } else {
      const detached = await git(
        ["worktree", "add", worktreePath, defaultRef, "--detach"],
        project.path,
      );
      if (detached === null) {
        throw new Error(`Failed to create detached worktree at ${worktreePath}`);
      }
    }

    spinner.text = "Setting up workspace";

    // Symlink shared resources
    if (project.symlinks) {
      for (const link of project.symlinks) {
        const src = join(project.path, link);
        const dest = join(worktreePath, link);
        if (existsSync(src)) {
          try {
            unlinkSync(dest);
          } catch {
            // ignore
          }
          symlinkSync(src, dest);
        }
      }
    }

    // Always symlink common files if they exist
    for (const file of ["CLAUDE.local.md", ".claude"]) {
      const src = join(project.path, file);
      const dest = join(worktreePath, file);
      if (existsSync(src) && !existsSync(dest)) {
        try {
          const type = lstatSync(src).isDirectory() ? "dir" : "file";
          symlinkSync(src, dest, type);
        } catch {
          // ignore
        }
      }
    }

    spinner.text = "Creating tmux session";

    // Create tmux session
    const envVar = `${prefix.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}_SESSION`;
    await exec("tmux", [
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-c",
      worktreePath,
      "-e",
      `${envVar}=${sessionName}`,
      "-e",
      "DIRENV_LOG_FORMAT=",
    ]);

    // Run post-create hooks before agent launch (so environment is ready)
    if (project.postCreate) {
      for (const cmd of project.postCreate) {
        await exec("tmux", ["send-keys", "-t", sessionName, "-l", cmd]);
        await exec("tmux", ["send-keys", "-t", sessionName, "Enter"]);
      }
      // Allow hooks to complete before starting agent
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Start agent via plugin
    const agent = getAgent(config, projectId);
    const launchCmd = agent.getLaunchCommand({
      sessionId: sessionName,
      projectConfig: project,
      issueId,
      permissions: project.agentConfig?.permissions,
    });

    await exec("tmux", ["send-keys", "-t", sessionName, "-l", launchCmd]);
    await exec("tmux", ["send-keys", "-t", sessionName, "Enter"]);

    spinner.text = "Writing metadata";

    // Write metadata
    const sessionDir = getSessionDir(config.dataDir, projectId);
    mkdirSync(sessionDir, { recursive: true });
    const liveBranch = await git(["branch", "--show-current"], worktreePath);

    writeMetadata(join(sessionDir, sessionName), {
      worktree: worktreePath,
      branch: liveBranch || branch || "detached",
      status: "spawning",
      project: projectId,
      ...(issueId ? { issue: issueId } : {}),
      ...(exploratory ? { exploratory: "true" } : {}),
      createdAt: new Date().toISOString(),
    });

    spinner.succeed(`Session ${chalk.green(sessionName)} created`);

    console.log(`  Worktree: ${chalk.dim(worktreePath)}`);
    if (branch) console.log(`  Branch:   ${chalk.dim(branch)}`);
    if (exploratory) console.log(`  Mode:     ${chalk.cyan("exploratory")} (no PR/CI/review)`);
    console.log(`  Attach:   ${chalk.dim(`tmux attach -t ${sessionName}`)}`);
    console.log();

    // Send composed prompt via tmux send-keys (keeps agent interactive for follow-ups)
    const composedPrompt = buildPrompt({
      project,
      projectId,
      issueId,
      exploratory,
    });

    if (composedPrompt) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await tmuxSendKeys(sessionName, composedPrompt);
    }

    // Open terminal tab if requested
    if (openTab) {
      try {
        await exec("open-iterm-tab", [sessionName]);
      } catch {
        // Terminal plugin not available
      }
    }

    // Output for scripting
    console.log(`SESSION=${sessionName}`);
    return sessionName;
  } catch (err) {
    spinner.fail(`Failed to create session ${sessionName}`);
    throw err;
  }
}

export function registerSpawn(program: Command): void {
  program
    .command("spawn")
    .description("Spawn a single agent session")
    .argument("<project>", "Project ID from config")
    .argument("[issue]", "Issue identifier (e.g. INT-1234, #42)")
    .option("--open", "Open session in terminal tab")
    .option("--exploratory", "Run in exploratory mode (no PR, CI monitoring, or review routing)")
    .action(async (projectId: string, issueId: string | undefined, opts: { open?: boolean; exploratory?: boolean }) => {
      const config = loadConfig();
      const project = config.projects[projectId];
      if (!project) {
        console.error(
          chalk.red(
            `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
          ),
        );
        process.exit(1);
      }
      await spawnSession(config, projectId, project, issueId, opts.open, opts.exploratory);
    });
}

export function registerBatchSpawn(program: Command): void {
  program
    .command("batch-spawn")
    .description("Spawn sessions for multiple issues with duplicate detection")
    .argument("<project>", "Project ID from config")
    .argument("<issues...>", "Issue identifiers")
    .option("--open", "Open sessions in terminal tabs")
    .action(async (projectId: string, issues: string[], opts: { open?: boolean }) => {
      const config = loadConfig();
      const project = config.projects[projectId];
      if (!project) {
        console.error(
          chalk.red(
            `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
          ),
        );
        process.exit(1);
      }

      console.log(banner("BATCH SESSION SPAWNER"));
      console.log();
      console.log(`  Project: ${chalk.bold(projectId)}`);
      console.log(`  Issues:  ${issues.join(", ")}`);
      console.log();

      let allTmux = await getTmuxSessions();
      const sessionDir = getSessionDir(config.dataDir, projectId);
      const created: Array<{ session: string; issue: string }> = [];
      const skipped: Array<{ issue: string; existing: string }> = [];
      const failed: string[] = [];
      const spawnedIssues = new Set<string>();

      for (const issue of issues) {
        // Duplicate detection — check both existing sessions and same-run duplicates
        if (spawnedIssues.has(issue.toLowerCase())) {
          console.log(chalk.yellow(`  Skip ${issue} — duplicate in this batch`));
          skipped.push({ issue, existing: "(this batch)" });
          continue;
        }
        const existing = await findSessionForIssue(sessionDir, issue, allTmux);
        if (existing) {
          console.log(chalk.yellow(`  Skip ${issue} — already has session: ${existing}`));
          skipped.push({ issue, existing });
          continue;
        }

        try {
          const sessionName = await spawnSession(config, projectId, project, issue, opts.open);
          created.push({ session: sessionName, issue });
          spawnedIssues.add(issue.toLowerCase());
          // Refresh tmux session list so next iteration sees the new session
          allTmux = await getTmuxSessions();
        } catch (err) {
          console.error(chalk.red(`  Failed to spawn for ${issue}: ${err}`));
          failed.push(issue);
        }

        // Small delay between spawns
        await new Promise((r) => setTimeout(r, 500));
      }

      console.log(chalk.bold("\nSummary:"));
      console.log(`  Created: ${chalk.green(String(created.length))} sessions`);
      console.log(`  Skipped: ${chalk.yellow(String(skipped.length))} (duplicate)`);
      console.log(`  Failed:  ${chalk.red(String(failed.length))}`);

      if (created.length > 0) {
        console.log(chalk.bold("\nCreated sessions:"));
        for (const { session, issue } of created) {
          console.log(`  ${chalk.green(session)} -> ${issue}`);
        }
      }
      if (skipped.length > 0) {
        console.log(chalk.bold("\nSkipped (duplicate):"));
        for (const { issue, existing } of skipped) {
          console.log(`  ${issue} -> existing: ${existing}`);
        }
      }
      console.log();
    });
}
