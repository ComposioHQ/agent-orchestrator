import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import {
  createScheduler,
  getSessionsDir,
  loadConfig,
  readPlanBlob,
  type OrchestratorConfig,
  type TaskGraph,
  type TaskNode,
  type TaskNodeState,
} from "@composio/ao-core";
import { exec } from "../lib/shell.js";
import { banner } from "../lib/format.js";
import { getSessionManager } from "../lib/create-session-manager.js";

interface PlannedTask {
  id: string;
  issueId: string;
  dependencies: string[];
  state: TaskNodeState;
  priority?: number;
  runCount?: number;
  readySince?: number;
}

interface PlanSchedule {
  planLabel: string;
  graph: TaskGraph;
  tasksByLookup: Map<string, PlannedTask>;
  readyQueue: TaskNode[];
}

interface SkipReason {
  target: string;
  reason: string;
}

const PLAN_TASK_STATES = new Set(["pending", "ready", "running", "complete", "blocked", "paused"]);
const COMPLETED_ALIASES = new Set(["complete", "completed", "done", "closed", "merged"]);

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function getStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function mapTaskState(rawTask: Record<string, unknown>): TaskNodeState {
  const rawState = getString(rawTask["state"] ?? rawTask["status"]);
  if (!rawState) return "pending";
  const normalized = rawState.toLowerCase();
  if (PLAN_TASK_STATES.has(normalized)) return normalized as TaskNodeState;
  if (COMPLETED_ALIASES.has(normalized)) return "complete";
  if (normalized === "in_progress" || normalized === "in-progress" || normalized === "working") {
    return "running";
  }
  if (normalized === "todo" || normalized === "queued" || normalized === "open") {
    return "pending";
  }
  return "pending";
}

function extractTaskCandidates(blob: unknown): unknown[] {
  if (!blob || typeof blob !== "object") return [];
  const record = blob as Record<string, unknown>;

  if (Array.isArray(record["tasks"])) return record["tasks"];
  if (Array.isArray(record["nodes"])) return record["nodes"];

  const graph = record["graph"];
  if (graph && typeof graph === "object") {
    const nodes = (graph as Record<string, unknown>)["nodes"];
    if (Array.isArray(nodes)) return nodes;
    if (nodes && typeof nodes === "object") return Object.values(nodes as Record<string, unknown>);
  }

  return [];
}

function parsePlannedTask(candidate: unknown): PlannedTask | null {
  if (!candidate || typeof candidate !== "object") return null;
  const record = candidate as Record<string, unknown>;

  const id = getString(record["id"] ?? record["taskId"]);
  if (!id) return null;

  const issueId = getString(record["issueId"] ?? record["issue"] ?? record["ticket"] ?? id) ?? id;
  const dependencies = getStringList(record["dependencies"] ?? record["dependsOn"] ?? record["deps"]);

  return {
    id,
    issueId,
    dependencies,
    state: mapTaskState(record),
    priority: getNumber(record["priority"]),
    runCount: getNumber(record["runCount"]),
    readySince: getNumber(record["readySince"]),
  };
}

function buildPlanSchedule(
  config: OrchestratorConfig,
  projectId: string,
  planSessionId: string,
  concurrencyCap: number,
): PlanSchedule {
  const project = config.projects[projectId];
  if (!project) {
    throw new Error(`Unknown project: ${projectId}`);
  }

  const sessionsDir = getSessionsDir(config.configPath, project.path);
  const plan = readPlanBlob<unknown>(sessionsDir, planSessionId);
  if (!plan) {
    throw new Error(`No plan artifact found for session ${planSessionId}`);
  }
  if (plan.planStatus !== "validated") {
    throw new Error(
      `Plan ${plan.planId}.v${plan.planVersion} is "${plan.planStatus}" (must be "validated")`,
    );
  }

  const tasks = extractTaskCandidates(plan.blob).map(parsePlannedTask).filter((t): t is PlannedTask => t !== null);
  if (tasks.length === 0) {
    throw new Error(`Plan ${plan.planId}.v${plan.planVersion} has no parseable tasks`);
  }

  const tasksByLookup = new Map<string, PlannedTask>();
  for (const task of tasks) {
    const key = normalizeId(task.id);
    if (tasksByLookup.has(key)) {
      throw new Error(`Plan ${plan.planId}.v${plan.planVersion} has duplicate task ID "${task.id}"`);
    }
    tasksByLookup.set(key, task);
  }

  const graph: TaskGraph = { nodes: {} };
  for (const task of tasks) {
    graph.nodes[task.id] = {
      id: task.id,
      dependencies: task.dependencies,
      state: task.state,
      priority: task.priority,
      runCount: task.runCount,
      readySince: task.readySince,
    };
  }

  const scheduler = createScheduler({ concurrencyCap });
  const { readyQueue } = scheduler.getReadyQueue(graph);

  return {
    planLabel: `${plan.planId}.v${plan.planVersion}`,
    graph,
    tasksByLookup,
    readyQueue,
  };
}

function findIncompleteDependencies(task: PlannedTask, graph: TaskGraph): string[] {
  const blockedBy: string[] = [];
  for (const dependencyId of task.dependencies) {
    const dependency = graph.nodes[dependencyId];
    if (!dependency || dependency.state !== "complete") blockedBy.push(dependencyId);
  }
  return blockedBy;
}

function reasonForNotReady(task: PlannedTask, schedule: PlanSchedule): string {
  if (task.state === "blocked" || task.state === "paused") {
    return `blocked (state: ${task.state})`;
  }
  if (task.state === "running") {
    return "already running in plan";
  }
  if (task.state === "complete") {
    return "already complete in plan";
  }

  const blockedBy = findIncompleteDependencies(task, schedule.graph);
  if (blockedBy.length > 0) {
    return `blocked by incomplete dependencies: ${blockedBy.join(", ")}`;
  }

  return "deferred by scheduler capacity";
}

function selectReadyPlanTasks(
  schedule: PlanSchedule,
  targetIds: string[],
  existingIssueMap: Map<string, string>,
): { selected: PlannedTask[]; skipped: SkipReason[] } {
  const skipped: SkipReason[] = [];
  const dedupedTargets: string[] = [];
  const seenTargets = new Set<string>();

  for (const targetId of targetIds) {
    const key = normalizeId(targetId);
    if (seenTargets.has(key)) {
      skipped.push({ target: targetId, reason: "duplicate in this batch" });
      continue;
    }
    seenTargets.add(key);
    dedupedTargets.push(targetId);
  }

  const readyIndex = new Map(schedule.readyQueue.map((task, index) => [normalizeId(task.id), index]));
  const selected: PlannedTask[] = [];
  for (const targetId of dedupedTargets) {
    const lookup = schedule.tasksByLookup.get(normalizeId(targetId));
    if (!lookup) {
      skipped.push({ target: targetId, reason: "not found in validated plan" });
      continue;
    }

    const existingSession = existingIssueMap.get(normalizeId(lookup.issueId));
    if (existingSession) {
      skipped.push({
        target: targetId,
        reason: `already has session: ${existingSession}`,
      });
      continue;
    }

    if (!readyIndex.has(normalizeId(lookup.id))) {
      skipped.push({ target: targetId, reason: reasonForNotReady(lookup, schedule) });
      continue;
    }

    selected.push(lookup);
  }

  selected.sort(
    (a, b) =>
      (readyIndex.get(normalizeId(a.id)) ?? Number.MAX_SAFE_INTEGER) -
      (readyIndex.get(normalizeId(b.id)) ?? Number.MAX_SAFE_INTEGER),
  );

  return { selected, skipped };
}

function parseConcurrencyCap(value: string): number {
  return Number.parseInt(value, 10);
}

async function spawnSession(
  config: OrchestratorConfig,
  projectId: string,
  issueId?: string,
  openTab?: boolean,
  agent?: string,
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

    spinner.succeed(`Session ${chalk.green(session.id)} created`);

    console.log(`  Worktree: ${chalk.dim(session.workspacePath ?? "-")}`);
    if (session.branch) console.log(`  Branch:   ${chalk.dim(session.branch)}`);

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
    spinner.fail("Failed to create session");
    throw err;
  }
}

export function registerSpawn(program: Command): void {
  program
    .command("spawn")
    .description("Spawn a single agent session")
    .argument("<project>", "Project ID from config")
    .argument("[issue]", "Issue identifier (e.g. INT-1234, #42) - must exist in tracker")
    .option("--open", "Open session in terminal tab")
    .option("--agent <name>", "Override the agent plugin (e.g. codex, claude-code)")
    .option(
      "--plan-session <sessionId>",
      "Interpret [issue] as a plan task ID from this validated plan session",
    )
    .action(
      async (
        projectId: string,
        issueId: string | undefined,
        opts: { open?: boolean; agent?: string; planSession?: string },
      ) => {
      const config = loadConfig();
      if (!config.projects[projectId]) {
        console.error(
          chalk.red(
            `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
          ),
        );
        process.exit(1);
      }

      try {
        let resolvedIssueId = issueId;
        if (opts.planSession) {
          if (!issueId) {
            throw new Error("Task ID is required when using --plan-session");
          }
          const schedule = buildPlanSchedule(config, projectId, opts.planSession, 1);
          const { selected, skipped } = selectReadyPlanTasks(schedule, [issueId], new Map());
          if (skipped.length > 0) {
            throw new Error(`Task ${issueId} not schedulable: ${skipped[0]?.reason ?? "unknown reason"}`);
          }

          const selectedTask = selected[0];
          if (!selectedTask) {
            throw new Error(`Task ${issueId} not schedulable`);
          }
          resolvedIssueId = selectedTask.issueId;

          console.log(chalk.bold("Scheduling rationale:"));
          console.log(`  Plan: ${chalk.dim(schedule.planLabel)}`);
          console.log(`  Spawning task ${chalk.cyan(selectedTask.id)} -> issue ${chalk.cyan(selectedTask.issueId)}`);
          console.log();
        }

        await spawnSession(config, projectId, resolvedIssueId, opts.open, opts.agent);
      } catch (err) {
        console.error(chalk.red(`✗ ${err}`));
        process.exit(1);
      }
      },
    );
}

export function registerBatchSpawn(program: Command): void {
  program
    .command("batch-spawn")
    .description("Spawn sessions for multiple issues or plan tasks with scheduling")
    .argument("<project>", "Project ID from config")
    .argument("<issues...>", "Issue identifiers or plan task IDs (with --plan-session)")
    .option("--open", "Open sessions in terminal tabs")
    .option("--plan-session <sessionId>", "Resolve targets via scheduler using this validated plan session")
    .option("--concurrency <n>", "Max tasks to take from ready queue in scheduler mode", parseConcurrencyCap)
    .action(
      async (
        projectId: string,
        issues: string[],
        opts: { open?: boolean; planSession?: string; concurrency?: number },
      ) => {
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

      const sm = await getSessionManager(config);
      const created: Array<{ session: string; issue: string }> = [];
      const skipped: SkipReason[] = [];
      const failed: Array<{ issue: string; error: string }> = [];

      // Load existing sessions once before the loop to avoid repeated reads + enrichment.
      // Exclude dead/killed sessions so crashed sessions don't block respawning.
      const deadStatuses = new Set(["killed", "done", "exited"]);
      const existingSessions = await sm.list(projectId);
      const existingIssueMap: Map<string, string> = new Map(
        existingSessions
          .filter(
            (s: { issueId: string | null; status: string }) =>
              s.issueId !== null && !deadStatuses.has(s.status),
          )
          .map((s: { issueId: string | null; id: string }) => [s.issueId!.toLowerCase(), s.id]),
      );

      let targets: Array<{ issueId: string; displayTarget: string }> = issues.map((issue) => ({
        issueId: issue,
        displayTarget: issue,
      }));

      if (opts.planSession) {
        const concurrencyCap = opts.concurrency ?? issues.length;
        if (!Number.isInteger(concurrencyCap) || concurrencyCap <= 0) {
          throw new Error(`Invalid --concurrency value: ${String(opts.concurrency)}`);
        }

        const schedule = buildPlanSchedule(config, projectId, opts.planSession, concurrencyCap);
        const { selected, skipped: schedulerSkipped } = selectReadyPlanTasks(
          schedule,
          issues,
          existingIssueMap,
        );

        console.log(chalk.bold("Scheduling rationale:"));
        console.log(`  Plan: ${chalk.dim(schedule.planLabel)}`);
        console.log(
          `  Ready queue: ${
            schedule.readyQueue.length > 0
              ? schedule.readyQueue.map((task) => task.id).join(", ")
              : chalk.dim("(empty)")
          }`,
        );
        console.log(`  Scheduler cap: ${concurrencyCap}`);

        for (const skippedTarget of schedulerSkipped) {
          console.log(chalk.yellow(`  Skip ${skippedTarget.target} — ${skippedTarget.reason}`));
          skipped.push(skippedTarget);
        }

        targets = selected.map((task) => ({
          issueId: task.issueId,
          displayTarget: task.id,
        }));
      }

      const spawnedIssues = new Set<string>();
      for (const target of targets) {
        const normalizedIssue = normalizeId(target.issueId);

        if (spawnedIssues.has(normalizedIssue)) {
          const reason = "duplicate in this batch";
          console.log(chalk.yellow(`  Skip ${target.displayTarget} — ${reason}`));
          skipped.push({ target: target.displayTarget, reason });
          continue;
        }

        const existingSessionId = existingIssueMap.get(normalizedIssue);
        if (existingSessionId) {
          const reason = `already has session: ${existingSessionId}`;
          console.log(chalk.yellow(`  Skip ${target.displayTarget} — ${reason}`));
          skipped.push({ target: target.displayTarget, reason });
          continue;
        }

        try {
          const sessionName = await spawnSession(config, projectId, target.issueId, opts.open);
          created.push({ session: sessionName, issue: target.displayTarget });
          spawnedIssues.add(normalizedIssue);
        } catch (err) {
          const message = String(err);
          console.error(chalk.red(`  ✗ ${target.displayTarget} — ${err}`));
          failed.push({ issue: target.displayTarget, error: message });
        }

        await new Promise((r) => setTimeout(r, 500));
      }

      console.log(chalk.bold("\nSummary:"));
      console.log(`  Created: ${chalk.green(String(created.length))} sessions`);
      console.log(`  Skipped: ${chalk.yellow(String(skipped.length))}`);
      console.log(`  Failed:  ${chalk.red(String(failed.length))}`);

      if (created.length > 0) {
        console.log(chalk.bold("\nCreated sessions:"));
        for (const { session, issue } of created) {
          console.log(`  ${chalk.green(session)} -> ${issue}`);
        }
      }
      if (skipped.length > 0) {
        console.log(chalk.bold("\nSkipped:"));
        for (const item of skipped) {
          console.log(`  ${item.target} -> ${item.reason}`);
        }
      }
      if (failed.length > 0) {
        console.log(chalk.yellow(`\n${failed.length} failed:`));
        failed.forEach((f) => {
          console.log(chalk.dim(`  - ${f.issue}: ${f.error}`));
        });
      }
      console.log();
      },
    );
}
