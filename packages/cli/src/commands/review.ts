import chalk from "chalk";
import type { Command } from "commander";
import {
  createReviewManager,
  loadConfig,
  type CodeReview,
  type OrchestratorConfig,
  type PluginRegistry,
  type ReviewManager,
} from "@aoagents/ao-core";
import { getPluginRegistry, getSessionManager } from "../lib/create-session-manager.js";

function buildReviewManager(
  config: OrchestratorConfig,
  registry: PluginRegistry,
): ReviewManager {
  return createReviewManager({
    configPath: config.configPath,
    getProject: (projectId) => config.projects[projectId],
    resolveReviewPlugin: (projectId) => {
      const project = config.projects[projectId];
      const pluginName = project?.codeReview?.plugin;
      if (!pluginName) return null;
      return registry.get<CodeReview>("code-review", pluginName);
    },
    getSessionPrefix: (projectId) => {
      const project = config.projects[projectId];
      return project?.sessionPrefix ?? projectId;
    },
  });
}

function formatSeverity(severity: string): string {
  if (severity === "error") return chalk.red(severity.toUpperCase().padEnd(7));
  if (severity === "warning") return chalk.yellow(severity.toUpperCase().padEnd(7));
  return chalk.blue(severity.toUpperCase().padEnd(7));
}

function formatStatus(status: string): string {
  if (status === "open") return chalk.cyan(status.padEnd(14));
  if (status === "dismissed") return chalk.gray(status.padEnd(14));
  if (status === "sent_to_agent") return chalk.yellow(status.padEnd(14));
  return chalk.white(status.padEnd(14));
}

export function registerReview(program: Command): void {
  const review = program
    .command("review")
    .description("AI-powered peer review of worker PRs (code-review plugin)");

  review
    .command("run")
    .description("Trigger a code review for a worker session")
    .argument("<session>", "Worker session ID")
    .option("--base <branch>", "Base branch to diff against")
    .action(async (sessionId: string, opts: { base?: string }) => {
      const config = loadConfig();
      const registry = await getPluginRegistry(config);
      const sm = await getSessionManager(config);
      const session = await sm.get(sessionId);
      if (!session) {
        console.error(chalk.red(`Session not found: ${sessionId}`));
        process.exit(1);
      }
      if (!session.workspacePath) {
        console.error(chalk.red(`Session ${sessionId} has no workspace path`));
        process.exit(1);
      }
      const project = config.projects[session.projectId];
      if (!project?.codeReview?.plugin) {
        console.error(
          chalk.red(`Project ${session.projectId} has no codeReview.plugin configured`),
        );
        process.exit(1);
      }

      const manager = buildReviewManager(config, registry);
      const run = await manager.triggerReview({
        projectId: session.projectId,
        linkedSessionId: sessionId,
        workerWorkspacePath: session.workspacePath,
        branch: session.branch ?? project.defaultBranch,
        baseBranch: opts.base ?? project.defaultBranch,
      });

      console.log(chalk.bold(`\nReview ${run.runId}`));
      console.log(`  Reviewer: ${run.reviewerSessionId}`);
      console.log(`  HEAD: ${run.headSha}`);
      console.log(`  Outcome: ${run.outcome}`);
      console.log(`  Loop: ${run.loopState}`);
      if (run.terminationReason) {
        console.log(`  Terminated: ${run.terminationReason}`);
      }
      console.log(`  Findings: ${run.findingCount}`);
      if (run.overallSummary) {
        console.log(`\n  ${run.overallSummary}`);
      }
    });

  review
    .command("list")
    .description("List reviews for a session (or all sessions)")
    .argument("[session]", "Session ID")
    .option("-p, --project <id>", "Project ID")
    .action(async (sessionId: string | undefined, opts: { project?: string }) => {
      const config = loadConfig();
      const registry = await getPluginRegistry(config);
      const manager = buildReviewManager(config, registry);

      const projectIds = opts.project ? [opts.project] : Object.keys(config.projects);
      for (const projectId of projectIds) {
        const store = manager.getStore(projectId);
        const runs = sessionId
          ? store.listRunsForSession(sessionId)
          : store.listAllRuns();
        if (runs.length === 0) continue;
        console.log(chalk.bold(`\n${projectId}:`));
        for (const run of runs) {
          const label = `${run.reviewerSessionId} (${run.loopState})`;
          console.log(
            `  ${chalk.green(run.runId)}  ${label}  -> ${run.linkedSessionId}  ${
              run.findingCount
            } findings`,
          );
        }
      }
    });

  review
    .command("show")
    .description("Show findings for a review run")
    .argument("<runId>", "Run ID")
    .option("-p, --project <id>", "Project ID (required if multiple projects)")
    .action(async (runId: string, opts: { project?: string }) => {
      const config = loadConfig();
      const registry = await getPluginRegistry(config);
      const manager = buildReviewManager(config, registry);
      const projectIds = opts.project ? [opts.project] : Object.keys(config.projects);

      for (const projectId of projectIds) {
        const store = manager.getStore(projectId);
        const run = store.getRun(runId);
        if (!run) continue;
        console.log(chalk.bold(`\nRun ${run.runId}`));
        console.log(`  Project: ${projectId}`);
        console.log(`  Reviewer: ${run.reviewerSessionId}`);
        console.log(`  HEAD: ${run.headSha}`);
        console.log(`  Outcome: ${run.outcome}`);
        console.log(`  Loop: ${run.loopState}`);
        console.log(`  Findings: ${run.findingCount}`);
        if (run.overallSummary) {
          console.log(`\n  ${run.overallSummary}`);
        }
        const findings = store.listFindingsForRun(runId);
        if (findings.length === 0) {
          console.log(chalk.gray("\n  (no findings)"));
          return;
        }
        console.log();
        for (const f of findings) {
          console.log(
            `  ${formatSeverity(f.severity)} ${formatStatus(f.status)} ${chalk.bold(
              f.title,
            )}`,
          );
          console.log(`    ${f.filePath}:${f.startLine}-${f.endLine}`);
          if (f.belowConfidenceThreshold) {
            console.log(`    ${chalk.gray(`(below confidence threshold: ${f.confidence})`)}`);
          }
          console.log(`    ${chalk.gray(f.findingId)}`);
        }
        return;
      }
      console.error(chalk.red(`Run not found: ${runId}`));
      process.exit(1);
    });

  review
    .command("dismiss")
    .description("Dismiss a finding")
    .argument("<runId>", "Run ID")
    .argument("<findingId>", "Finding ID")
    .option("-p, --project <id>", "Project ID")
    .option("--by <user>", "Dismissed by (defaults to $USER)", process.env["USER"] ?? "operator")
    .action(
      async (
        runId: string,
        findingId: string,
        opts: { project?: string; by: string },
      ) => {
        const config = loadConfig();
        const registry = await getPluginRegistry(config);
        const manager = buildReviewManager(config, registry);
        const projectIds = opts.project ? [opts.project] : Object.keys(config.projects);
        for (const projectId of projectIds) {
          const store = manager.getStore(projectId);
          const run = store.getRun(runId);
          if (!run) continue;
          const updated = await manager.dismissFinding({
            projectId,
            runId,
            findingId,
            dismissedBy: opts.by,
          });
          console.log(chalk.green(`Dismissed finding ${updated.findingId}`));
          return;
        }
        console.error(chalk.red(`Run not found: ${runId}`));
        process.exit(1);
      },
    );

  review
    .command("send")
    .description("Send a finding (or all open findings) to the coding agent")
    .argument("<runId>", "Run ID")
    .argument("[findingId]", "Finding ID (omit to send all open findings)")
    .option("-p, --project <id>", "Project ID")
    .action(async (runId: string, findingId: string | undefined, opts: { project?: string }) => {
      const config = loadConfig();
      const registry = await getPluginRegistry(config);
      const sm = await getSessionManager(config);
      const manager = buildReviewManager(config, registry);
      const projectIds = opts.project ? [opts.project] : Object.keys(config.projects);

      for (const projectId of projectIds) {
        const store = manager.getStore(projectId);
        const run = store.getRun(runId);
        if (!run) continue;
        const findings = store.listFindingsForRun(runId);
        const target = findingId
          ? findings.filter((f) => f.findingId === findingId)
          : findings.filter((f) => f.status === "open");
        if (target.length === 0) {
          console.log(chalk.yellow("No matching open findings to send."));
          return;
        }

        const message = [
          `Code review findings on your PR:`,
          ``,
          ...target.map(
            (f) =>
              `- [${f.severity.toUpperCase()}] ${f.filePath}:${f.startLine}-${f.endLine} — ${f.title}\n    ${f.description.split("\n").join("\n    ")}`,
          ),
          ``,
          `Please address each one, push fixes, and reply.`,
        ].join("\n");

        try {
          await sm.send(run.linkedSessionId, message);
        } catch (err) {
          console.error(
            chalk.red(
              `Failed to deliver to worker ${run.linkedSessionId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            ),
          );
          process.exit(1);
        }

        await manager.markSentToAgent({
          projectId,
          runId,
          findingIds: target.map((f) => f.findingId),
        });
        console.log(chalk.green(`Sent ${target.length} finding(s) to ${run.linkedSessionId}`));
        return;
      }
      console.error(chalk.red(`Run not found: ${runId}`));
      process.exit(1);
    });

  review
    .command("cancel")
    .description("Cancel a running review")
    .argument("<runId>", "Run ID")
    .option("-p, --project <id>", "Project ID")
    .action(async (runId: string, opts: { project?: string }) => {
      const config = loadConfig();
      const registry = await getPluginRegistry(config);
      const manager = buildReviewManager(config, registry);
      const projectIds = opts.project ? [opts.project] : Object.keys(config.projects);
      for (const projectId of projectIds) {
        const store = manager.getStore(projectId);
        const run = store.getRun(runId);
        if (!run) continue;
        await manager.terminateRun({ projectId, runId, reason: "manual_cancel" });
        console.log(chalk.green(`Cancelled review ${runId}`));
        return;
      }
      console.error(chalk.red(`Run not found: ${runId}`));
      process.exit(1);
    });
}
