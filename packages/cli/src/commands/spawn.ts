import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import {
  loadConfig,
  decompose,
  getLeaves,
  getSiblings,
  formatPlanTree,
  TERMINAL_STATUSES,
  type OrchestratorConfig,
  type DecomposerConfig,
  DEFAULT_DECOMPOSER_CONFIG,
  isRepoUrl,
  parseRepoUrl,
  resolveCloneTarget,
  isRepoAlreadyCloned,
  generateConfigFromUrl,
  configToYaml,
  validateConfig,
  sanitizeProjectId,
} from "@composio/ao-core";
import { exec, execSilent } from "../lib/shell.js";
import { banner } from "../lib/format.js";
import { getSessionManager } from "../lib/create-session-manager.js";
import { ensureLifecycleWorker } from "../lib/lifecycle-service.js";
import { preflight } from "../lib/preflight.js";

interface SpawnClaimOptions {
  claimPr?: string;
  assignOnGithub?: boolean;
}

/**
 * Resolve an ad-hoc repo (owner/repo or URL) into a loaded config with a project entry.
 *
 * This enables `ao spawn --repo ComposioHQ/integrator #42` without pre-existing config.
 * Clones the repo if needed, generates a temporary in-memory config, and returns it
 * alongside the derived project ID.
 */
async function resolveAdHocRepo(
  repoArg: string,
): Promise<{ config: OrchestratorConfig; projectId: string }> {
  const spinner = ora();

  // Normalize owner/repo shorthand to a full URL
  const url = isRepoUrl(repoArg) ? repoArg : `https://github.com/${repoArg}`;
  const parsed = parseRepoUrl(url);

  spinner.start(`Resolving ${parsed.ownerRepo}`);

  // Determine target directory and clone if needed
  const cwd = process.cwd();
  const targetDir = resolveCloneTarget(parsed, cwd);
  const alreadyCloned = isRepoAlreadyCloned(targetDir, parsed.cloneUrl);

  if (alreadyCloned) {
    spinner.succeed(`Using existing clone at ${targetDir}`);
  } else {
    spinner.text = `Cloning ${parsed.ownerRepo}`;
    // Try gh clone → SSH → HTTPS (same strategy as `ao start <url>`)
    let cloned = false;
    if (parsed.host === "github.com") {
      const ghAvailable = (await execSilent("gh", ["auth", "status"])) !== null;
      if (ghAvailable) {
        try {
          await exec("gh", ["repo", "clone", parsed.ownerRepo, targetDir, "--", "--depth", "1"], {
            cwd,
          });
          cloned = true;
        } catch {
          // Fall through
        }
      }
    }
    if (!cloned) {
      const sshUrl = `git@${parsed.host}:${parsed.ownerRepo}.git`;
      try {
        await exec("git", ["clone", "--depth", "1", sshUrl, targetDir], { cwd });
        cloned = true;
      } catch {
        // Fall through to HTTPS
      }
    }
    if (!cloned) {
      await exec("git", ["clone", "--depth", "1", parsed.cloneUrl, targetDir], { cwd });
    }
    spinner.succeed(`Cloned ${parsed.ownerRepo} to ${targetDir}`);
  }

  // Check for existing config in the cloned repo
  const configPath = resolve(targetDir, "agent-orchestrator.yaml");
  const configPathAlt = resolve(targetDir, "agent-orchestrator.yml");

  if (existsSync(configPath)) {
    const config = loadConfig(configPath);
    // Find project matching this repo
    const projectId = findProjectByRepo(config, parsed.ownerRepo);
    return { config, projectId };
  }

  if (existsSync(configPathAlt)) {
    const config = loadConfig(configPathAlt);
    const projectId = findProjectByRepo(config, parsed.ownerRepo);
    return { config, projectId };
  }

  // Generate config in-memory (don't write to repo — spawn is lightweight)
  const rawConfig = generateConfigFromUrl({ parsed, repoPath: targetDir });
  const config = validateConfig(rawConfig);
  config.configPath = configPath;

  const projectId = sanitizeProjectId(parsed.repo);
  // Write the config so session manager can reference it
  writeFileSync(configPath, configToYaml(rawConfig));
  spinner.succeed(`Generated config: ${configPath}`);

  return { config, projectId };
}

/** Find a project ID in config that matches a given owner/repo string. */
function findProjectByRepo(config: OrchestratorConfig, ownerRepo: string): string {
  for (const [id, project] of Object.entries(config.projects)) {
    if (project.repo === ownerRepo) return id;
  }
  // Fallback: if only one project, use it
  const ids = Object.keys(config.projects);
  if (ids.length === 1) return ids[0];
  throw new Error(
    `Could not determine project for ${ownerRepo}. Available: ${ids.join(", ")}`,
  );
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
    .argument("[project]", "Project ID from config (not needed with --repo)")
    .argument("[issue]", "Issue identifier (e.g. INT-1234, #42) - must exist in tracker")
    .option("--repo <repo>", "Ad-hoc repo (owner/repo or URL) — clones, configures, and spawns")
    .option("--open", "Open session in terminal tab")
    .option("--agent <name>", "Override the agent plugin (e.g. codex, claude-code)")
    .option("--claim-pr <pr>", "Immediately claim an existing PR for the spawned session")
    .option("--assign-on-github", "Assign the claimed PR to the authenticated GitHub user")
    .option("--decompose", "Decompose issue into subtasks before spawning")
    .option("--max-depth <n>", "Max decomposition depth (default: 3)")
    .action(
      async (
        projectArg: string | undefined,
        issueId: string | undefined,
        opts: {
          repo?: string;
          open?: boolean;
          agent?: string;
          claimPr?: string;
          assignOnGithub?: boolean;
          decompose?: boolean;
          maxDepth?: string;
        },
      ) => {
        let config: OrchestratorConfig;
        let projectId: string;

        if (opts.repo) {
          // Ad-hoc repo mode: --repo owner/repo [issue]
          // When --repo is used, the first positional arg is the issue, not the project
          if (projectArg && !issueId) {
            issueId = projectArg;
          }
          try {
            const result = await resolveAdHocRepo(opts.repo);
            config = result.config;
            projectId = result.projectId;
          } catch (err) {
            console.error(
              chalk.red(`✗ Failed to resolve repo: ${err instanceof Error ? err.message : String(err)}`),
            );
            process.exit(1);
          }
        } else {
          // Standard mode: project from config
          if (!projectArg) {
            console.error(
              chalk.red(
                "Missing project argument.\n" +
                  "Usage: ao spawn <project> [issue]\n" +
                  "       ao spawn --repo <owner/repo> [issue]",
              ),
            );
            process.exit(1);
          }
          projectId = projectArg;

          try {
            config = loadConfig();
          } catch {
            console.error(
              chalk.red(
                `No config found. Either:\n` +
                  `  1. Run ${chalk.cyan("ao init")} to create a config, then ${chalk.cyan(`ao start ${projectId}`)}\n` +
                  `  2. Use ${chalk.cyan(`ao spawn --repo owner/repo [issue]`)} for ad-hoc repos`,
              ),
            );
            process.exit(1);
          }

          if (!config.projects[projectId]) {
            const available = Object.keys(config.projects);
            const suggestions = available.length > 0
              ? `Available projects: ${available.join(", ")}\n`
              : "No projects configured.\n";
            console.error(
              chalk.red(
                `Unknown project: ${projectId}\n${suggestions}` +
                  `Tip: Use ${chalk.cyan(`ao spawn --repo owner/repo [issue]`)} to spawn for an ad-hoc repo.`,
              ),
            );
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
    .argument("<project>", "Project ID from config")
    .argument("<issues...>", "Issue identifiers")
    .option("--open", "Open sessions in terminal tabs")
    .action(async (projectId: string, issues: string[], opts: { open?: boolean }) => {
      const config = loadConfig();
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
