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
  type OrchestratorConfig,
  type DecomposerConfig,
  DEFAULT_DECOMPOSER_CONFIG,
} from "@composio/ao-core";
import { exec } from "../lib/shell.js";
import { banner } from "../lib/format.js";
import { getSessionManager } from "../lib/create-session-manager.js";
import { ensureLifecycleWorker } from "../lib/lifecycle-service.js";
import { preflight } from "../lib/preflight.js";
import { findProjectForDirectory } from "../lib/project-resolution.js";
import { formatAttachCommand } from "../lib/attach.js";
import { openInIterm } from "../lib/open-iterm.js";
import {
  appendStringOption,
  resolveRuntimeOverride,
  type RuntimeOverride,
  type RuntimeOverrideFlagOptions,
} from "../lib/runtime-overrides.js";

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
  const matchedProjectId = findProjectForDirectory(config.projects, cwd);
  if (matchedProjectId) {
    return matchedProjectId;
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
  runtimeOverride: RuntimeOverride,
  options?: SpawnClaimOptions,
): Promise<void> {
  const project = config.projects[projectId];
  await preflight.checkRuntime(
    runtimeOverride.effectiveRuntime,
    runtimeOverride.effectiveRuntimeConfig,
  );
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
  runtimeOverride?: Pick<RuntimeOverride, "runtime" | "runtimeConfig">,
  claimOptions?: SpawnClaimOptions,
): Promise<string> {
  const spinner = ora("Creating session").start();

  try {
    const sm = await getSessionManager(config);
    spinner.text = "Spawning session via core";

    const session = await sm.spawn({
      projectId,
      issueId,
      ...(agent ? { agent } : {}),
      ...(runtimeOverride?.runtime ? { runtime: runtimeOverride.runtime } : {}),
      ...(runtimeOverride?.runtimeConfig ? { runtimeConfig: runtimeOverride.runtimeConfig } : {}),
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

    // Warn if prompt delivery failed (for post-launch agents like Claude Code)
    const promptDelivered = session.metadata?.promptDelivered;
    if (promptDelivered === "false") {
      console.log();
      console.warn(
        chalk.yellow(
          `  ⚠ Prompt delivery failed — agent may be idle.\n` +
            `    Use '${chalk.cyan("ao send " + session.id + ' "message..."')}' to send instructions manually.`,
        ),
      );
    }
    const tmuxTarget = session.runtimeHandle?.id ?? session.id;
    const attachInfo = await sm.getAttachInfo(session.id).catch(() => null);
    const runtimeName = session.runtimeHandle?.runtimeName ?? config.defaults.runtime;
    console.log(
      `  Attach:   ${chalk.dim(
        formatAttachCommand(
          attachInfo,
          runtimeName === "tmux" ? `tmux attach -t ${tmuxTarget}` : "(attach command unavailable)",
        ),
      )}`,
    );
    console.log();

    // Open terminal tab if requested
    if (openTab) {
      await openInIterm({
        tabTitle: tmuxTarget,
        tmuxTarget,
        runtimeName,
        attachInfo,
      });
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
    .argument("[second]", "" /* hidden second arg to catch old two-arg usage */)
    .option("--open", "Open session in terminal tab")
    .option("--agent <name>", "Override the agent plugin (e.g. codex, claude-code)")
    .option("--runtime <name>", "Override the runtime plugin (e.g. tmux, docker)")
    .option("--runtime-image <image>", "Override runtimeConfig.image for docker runtime")
    .option("--runtime-config <json>", "Override runtimeConfig with a JSON object")
    .option("--runtime-cpus <cpus>", "Override runtimeConfig.limits.cpus for docker runtime")
    .option("--runtime-memory <memory>", "Override runtimeConfig.limits.memory for docker runtime")
    .option("--runtime-gpus <gpus>", "Override runtimeConfig.limits.gpus for docker runtime")
    .option("--runtime-read-only", "Set runtimeConfig.readOnlyRoot=true for docker runtime")
    .option("--runtime-network <network>", "Override runtimeConfig.network for docker runtime")
    .option(
      "--runtime-cap-drop <cap>",
      "Append a runtimeConfig.capDrop entry for docker runtime (repeatable)",
      appendStringOption,
      [],
    )
    .option(
      "--runtime-tmpfs <mount>",
      "Append a runtimeConfig.tmpfs entry for docker runtime (repeatable)",
      appendStringOption,
      [],
    )
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
          runtime?: string;
          runtimeConfig?: string;
          runtimeImage?: string;
          runtimeCpus?: string;
          runtimeMemory?: string;
          runtimeGpus?: string;
          runtimeReadOnly?: boolean;
          runtimeNetwork?: string;
          runtimeCapDrop?: string[];
          runtimeTmpfs?: string[];
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
          const runtimeOverride = resolveRuntimeOverride(config, config.projects[projectId], opts);
          await runSpawnPreflight(config, projectId, runtimeOverride, claimOptions);
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
              await spawnSession(
                config,
                projectId,
                issueId,
                opts.open,
                opts.agent,
                runtimeOverride,
                claimOptions,
              );
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
                    ...(opts.agent ? { agent: opts.agent } : {}),
                    ...(runtimeOverride.runtime ? { runtime: runtimeOverride.runtime } : {}),
                    ...(runtimeOverride.runtimeConfig
                      ? { runtimeConfig: runtimeOverride.runtimeConfig }
                      : {}),
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
            await spawnSession(
              config,
              projectId,
              issueId,
              opts.open,
              opts.agent,
              runtimeOverride,
              claimOptions,
            );
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
    .option("--runtime <name>", "Override the runtime plugin (e.g. tmux, docker)")
    .option("--runtime-image <image>", "Override runtimeConfig.image for docker runtime")
    .option("--runtime-config <json>", "Override runtimeConfig with a JSON object")
    .option("--runtime-cpus <cpus>", "Override runtimeConfig.limits.cpus for docker runtime")
    .option("--runtime-memory <memory>", "Override runtimeConfig.limits.memory for docker runtime")
    .option("--runtime-gpus <gpus>", "Override runtimeConfig.limits.gpus for docker runtime")
    .option("--runtime-read-only", "Set runtimeConfig.readOnlyRoot=true for docker runtime")
    .option("--runtime-network <network>", "Override runtimeConfig.network for docker runtime")
    .option(
      "--runtime-cap-drop <cap>",
      "Append a runtimeConfig.capDrop entry for docker runtime (repeatable)",
      appendStringOption,
      [],
    )
    .option(
      "--runtime-tmpfs <mount>",
      "Append a runtimeConfig.tmpfs entry for docker runtime (repeatable)",
      appendStringOption,
      [],
    )
    .action(
      async (
        issues: string[],
        opts: {
          open?: boolean;
          runtime?: string;
          runtimeConfig?: string;
          runtimeImage?: string;
          runtimeCpus?: string;
          runtimeMemory?: string;
          runtimeGpus?: string;
          runtimeReadOnly?: boolean;
          runtimeNetwork?: string;
          runtimeCapDrop?: string[];
          runtimeTmpfs?: string[];
        },
      ) => {
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
          const runtimeOverride = resolveRuntimeOverride(config, config.projects[projectId], opts);
          await runSpawnPreflight(config, projectId, runtimeOverride);
          await ensureLifecycleWorker(config, projectId);
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
              console.log(
                chalk.yellow(`  Skip ${issue} — already has session ${existingSessionId}`),
              );
              skipped.push({ issue, existing: existingSessionId });
              continue;
            }

            try {
              const session = await sm.spawn({
                projectId,
                issueId: issue,
                ...(runtimeOverride.runtime ? { runtime: runtimeOverride.runtime } : {}),
                ...(runtimeOverride.runtimeConfig
                  ? { runtimeConfig: runtimeOverride.runtimeConfig }
                  : {}),
              });
              created.push({ session: session.id, issue });
              spawnedIssues.add(issue.toLowerCase());
              console.log(chalk.green(`  Created ${session.id} for ${issue}`));

              if (opts.open) {
                const tmuxTarget = session.runtimeHandle?.id ?? session.id;
                const attachInfo = await sm.getAttachInfo(session.id).catch(() => null);
                await openInIterm({
                  tabTitle: tmuxTarget,
                  tmuxTarget,
                  runtimeName: session.runtimeHandle?.runtimeName ?? config.defaults.runtime,
                  attachInfo,
                });
              }
            } catch (err) {
              failed.push({
                issue,
                error: err instanceof Error ? err.message : String(err),
              });
              console.log(
                chalk.red(
                  `  Failed ${issue} — ${err instanceof Error ? err.message : String(err)}`,
                ),
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
        } catch (err) {
          console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
          process.exit(1);
        }
      },
    );
}
