import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { resolve } from "node:path";
import {
  loadConfig,
  decompose,
  getLeaves,
  getSiblings,
  formatPlanTree,
  TERMINAL_STATUSES,
  expandHome,
  type OrchestratorConfig,
  type DecomposerConfig,
  DEFAULT_DECOMPOSER_CONFIG,
} from "@composio/ao-core";
import { exec } from "../lib/shell.js";
import { banner } from "../lib/format.js";
import { getSessionManager } from "../lib/create-session-manager.js";
import { ensureLifecycleWorker } from "../lib/lifecycle-service.js";
import { preflight } from "../lib/preflight.js";

/**
 * Auto-detect the project ID from the config.
 * - If only one project exists, use it.
 * - If multiple projects exist, match cwd against project paths.
 * - Falls back to AO_PROJECT_ID env var (set when called from an agent session).
 */
function autoDetectProject(config: OrchestratorConfig): string {
  const projectIds = Object.keys(config.projects);
  if (projectIds.length === 0) {
    throw new Error("No projects configured. Run 'ao start' first.");
  }
  if (projectIds.length === 1) {
    return projectIds[0];
  }

  // Try AO_PROJECT_ID env var (set by AO when spawning agent sessions)
  const envProject = process.env.AO_PROJECT_ID;
  if (envProject && config.projects[envProject]) {
    return envProject;
  }

  // Try matching cwd to a project path
  const cwd = resolve(process.cwd());
  for (const [id, project] of Object.entries(config.projects)) {
    if (project.path && resolve(expandHome(project.path)) === cwd) {
      return id;
    }
  }

  throw new Error(
    `Multiple projects configured. Specify one: ${projectIds.join(", ")}\n` +
      `Or run from within a project directory.`,
  );
}

interface SpawnClaimOptions {
  claimPr?: string;
  assignOnGithub?: boolean;
}

/**
 * Run pre-flight checks for a project once, before any sessions are spawned.
 * Validates runtime and tracker prerequisites so failures surface immediately
 * rather than repeating per-session in a batch.
 */
async function runSpawnPreflight(
  config: OrchestratorConfig,
  projectId: string,
  options?: SpawnClaimOptions,
): Promise<void> {
  const project = config.projects[projectId];
  const runtime = project?.runtime ?? config.defaults.runtime;
  if (runtime === "tmux") {
    await preflight.checkTmux();
  }
  const needsGitHubAuth =
    project?.tracker?.plugin === "github" ||
    (options?.claimPr && project?.scm?.plugin === "github");
  if (needsGitHubAuth) {
    await preflight.checkGhAuth();
  }
}

async function spawnSession(
  config: OrchestratorConfig,
  projectId: string,
  issueId?: string,
  openTab?: boolean,
  agent?: string,
  claimOptions?: SpawnClaimOptions,
): Promise<string> {
  const spinner = ora("Creating session").start();

  try {
    const sm = await getSessionManager(config);
    spinner.text = "Spawning session via core";

    const session = await sm.spawn({
      projectId,
      issueId,
      agent,
    });

    let branchStr = session.branch ?? "";
    let claimedPrUrl: string | null = null;

    if (claimOptions?.claimPr) {
      spinner.text = `Claiming PR ${claimOptions.claimPr}`;
      try {
        const claimResult = await sm.claimPR(session.id, claimOptions.claimPr, {
          assignOnGithub: claimOptions.assignOnGithub,
        });
        branchStr = claimResult.pr.branch;
        claimedPrUrl = claimResult.pr.url;
      } catch (err) {
        throw new Error(
          `Session ${session.id} was created, but failed to claim PR ${claimOptions.claimPr}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }

    spinner.succeed(
      claimedPrUrl
        ? `Session ${chalk.green(session.id)} created and claimed PR`
        : `Session ${chalk.green(session.id)} created`,
    );

    console.log(`  Worktree: ${chalk.dim(session.workspacePath ?? "-")}`);
    if (branchStr) console.log(`  Branch:   ${chalk.dim(branchStr)}`);
    if (claimedPrUrl) console.log(`  PR:       ${chalk.dim(claimedPrUrl)}`);

    // Show the tmux name for attaching (stored in metadata or runtimeHandle)
    const tmuxTarget = session.runtimeHandle?.id ?? session.id;
    console.log(`  Attach:   ${chalk.dim(`tmux attach -t ${tmuxTarget}`)}`);
    console.log();

    // Open terminal tab if requested
    if (openTab) {
      try {
        await exec("open-iterm-tab", [tmuxTarget]);
      } catch {
        // Terminal plugin not available
      }
    }

    // Output for scripting
    console.log(`SESSION=${session.id}`);
    return session.id;
  } catch (err) {
    spinner.fail("Failed to create or initialize session");
    throw err;
  }
}

export function registerSpawn(program: Command): void {
  program
    .command("spawn")
    .description("Spawn a single agent session")
    .argument("[first]", "Issue identifier (project is auto-detected)")
    .argument("[second]", "", /* hidden second arg to catch old two-arg usage */)
    .option("--open", "Open session in terminal tab")
    .option("--agent <name>", "Override the agent plugin (e.g. codex, claude-code)")
    .option("--claim-pr <pr>", "Immediately claim an existing PR for the spawned session")
    .option("--assign-on-github", "Assign the claimed PR to the authenticated GitHub user")
    .option("--decompose", "Decompose issue into subtasks before spawning")
    .option("--max-depth <n>", "Max decomposition depth (default: 3)")
    .action(
      async (
        first: string | undefined,
        second: string | undefined,
        opts: {
          open?: boolean;
          agent?: string;
          claimPr?: string;
          assignOnGithub?: boolean;
          decompose?: boolean;
          maxDepth?: string;
        },
      ) => {
        // Catch old two-arg usage: ao spawn <project> <issue>
        if (first && second) {
          console.warn(
            chalk.yellow(
              `⚠ 'ao spawn <project> <issue>' is no longer supported.\n` +
                `  The project is now auto-detected. Use:\n\n` +
                `    ao spawn ${second}    # spawn with issue ${second}\n` +
                `    ao spawn              # spawn without an issue\n`,
            ),
          );
          process.exit(1);
        }

        const config = loadConfig();
        let projectId: string;
        let issueId: string | undefined;

        if (first) {
          issueId = first;
          try {
            projectId = autoDetectProject(config);
          } catch (err) {
            console.error(chalk.red(err instanceof Error ? err.message : String(err)));
            process.exit(1);
          }
        } else {
          // No args: auto-detect project, no issue
          try {
            projectId = autoDetectProject(config);
          } catch (err) {
            console.error(chalk.red(err instanceof Error ? err.message : String(err)));
            process.exit(1);
          }
        }

        if (!opts.claimPr && opts.assignOnGithub) {
          console.error(chalk.red("--assign-on-github requires --claim-pr on `ao spawn`."));
          process.exit(1);
        }

        const claimOptions: SpawnClaimOptions = {
          claimPr: opts.claimPr,
          assignOnGithub: opts.assignOnGithub,
        };

        try {
          await runSpawnPreflight(config, projectId, claimOptions);
          await ensureLifecycleWorker(config, projectId);

          if (opts.decompose && issueId) {
            // Decompose the issue before spawning
            const project = config.projects[projectId];
            const decompConfig: DecomposerConfig = {
              ...DEFAULT_DECOMPOSER_CONFIG,
              ...(project.decomposer ?? {}),
              maxDepth: opts.maxDepth
                ? parseInt(opts.maxDepth, 10)
                : (project.decomposer?.maxDepth ?? 3),
            };

            const spinner = ora("Decomposing task...").start();
            const issueTitle = issueId;

            const plan = await decompose(issueTitle, decompConfig);
            const leaves = getLeaves(plan.tree);
            spinner.succeed(`Decomposed into ${chalk.bold(String(leaves.length))} subtasks`);

            console.log();
            console.log(chalk.dim(formatPlanTree(plan.tree)));
            console.log();

            if (leaves.length <= 1) {
              console.log(chalk.yellow("Task is atomic — spawning directly."));
              await spawnSession(config, projectId, issueId, opts.open, opts.agent, claimOptions);
            } else {
              // Create child issues and spawn sessions with lineage context
              const sm = await getSessionManager(config);
              console.log(chalk.bold(`Spawning ${leaves.length} sessions with lineage context...`));
              console.log();

              for (const leaf of leaves) {
                const siblings = getSiblings(plan.tree, leaf.id);
                try {
                  const session = await sm.spawn({
                    projectId,
                    issueId, // All work on the same parent issue for now
                    lineage: leaf.lineage,
                    siblings,
                    agent: opts.agent,
                  });
                  console.log(`  ${chalk.green("✓")} ${session.id} — ${leaf.description}`);
                } catch (err) {
                  console.error(
                    `  ${chalk.red("✗")} ${leaf.description} — ${err instanceof Error ? err.message : err}`,
                  );
                }
                await new Promise((r) => setTimeout(r, 500));
              }
            }
          } else {
            await spawnSession(config, projectId, issueId, opts.open, opts.agent, claimOptions);
          }
        } catch (err) {
          console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
          process.exit(1);
        }
      },
    );
}

export function registerBatchSpawn(program: Command): void {
  program
    .command("batch-spawn")
    .description("Spawn sessions for multiple issues with duplicate detection")
    .argument("<issues...>", "Issue identifiers (project is auto-detected)")
    .option("--open", "Open sessions in terminal tabs")
    .action(async (issues: string[], opts: { open?: boolean }) => {
      const config = loadConfig();
      let projectId: string;

      try {
        projectId = autoDetectProject(config);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      if (!config.projects[projectId]) {
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

      // Pre-flight once before the loop so a missing prerequisite fails fast
      try {
        await runSpawnPreflight(config, projectId);
        await ensureLifecycleWorker(config, projectId);
      } catch (err) {
        console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }

      const sm = await getSessionManager(config);
      const created: Array<{ session: string; issue: string }> = [];
      const skipped: Array<{ issue: string; existing: string }> = [];
      const failed: Array<{ issue: string; error: string }> = [];
      const spawnedIssues = new Set<string>();

      // Load existing sessions once before the loop to avoid repeated reads + enrichment.
      // Exclude terminal sessions so completed/merged sessions don't block respawning
      // (e.g. when an issue is reopened after its PR was merged).
      const existingSessions = await sm.list(projectId);
      const existingIssueMap = new Map(
        existingSessions
          .filter((s) => s.issueId && !TERMINAL_STATUSES.has(s.status))
          .map((s) => [s.issueId!.toLowerCase(), s.id]),
      );

      for (const issue of issues) {
        // Duplicate detection — check both existing sessions and same-run duplicates
        if (spawnedIssues.has(issue.toLowerCase())) {
          console.log(chalk.yellow(`  Skip ${issue} — duplicate in this batch`));
          skipped.push({ issue, existing: "(this batch)" });
          continue;
        }

        // Check existing sessions (pre-loaded before loop)
        const existingSessionId = existingIssueMap.get(issue.toLowerCase());
        if (existingSessionId) {
          console.log(chalk.yellow(`  Skip ${issue} — already has session ${existingSessionId}`));
          skipped.push({ issue, existing: existingSessionId });
          continue;
        }

        try {
          const session = await sm.spawn({ projectId, issueId: issue });
          created.push({ session: session.id, issue });
          spawnedIssues.add(issue.toLowerCase());
          console.log(chalk.green(`  Created ${session.id} for ${issue}`));

          if (opts.open) {
            try {
              const tmuxTarget = session.runtimeHandle?.id ?? session.id;
              await exec("open-iterm-tab", [tmuxTarget]);
            } catch {
              // best effort
            }
          }
        } catch (err) {
          failed.push({
            issue,
            error: err instanceof Error ? err.message : String(err),
          });
          console.log(
            chalk.red(`  Failed ${issue} — ${err instanceof Error ? err.message : String(err)}`),
          );
        }
      }

      console.log();
      if (created.length > 0) {
        console.log(chalk.green(`Created ${created.length} sessions:`));
        for (const item of created) console.log(`  ${item.session} ← ${item.issue}`);
      }
      if (skipped.length > 0) {
        console.log(chalk.yellow(`Skipped ${skipped.length} issues:`));
        for (const item of skipped) console.log(`  ${item.issue} (existing: ${item.existing})`);
      }
      if (failed.length > 0) {
        console.log(chalk.red(`Failed ${failed.length} issues:`));
        for (const item of failed) console.log(`  ${item.issue}: ${item.error}`);
      }
      console.log();
    });
}
