/**
 * DAG Scheduler
 *
 * Computes a deterministic ready queue from a task graph while enforcing:
 * - dependency completion
 * - blocked/pause awareness
 * - configurable concurrency cap
 * - stable priority/fairness ordering
 */

export type TaskNodeState = "pending" | "ready" | "running" | "complete" | "blocked" | "paused";

export interface TaskNode {
  id: string;
  dependencies?: string[];
  state: TaskNodeState;
  /**
   * Higher number = higher priority.
   * Defaults to SchedulerConfig.defaultPriority (0 by default).
   */
  priority?: number;
  /**
   * Fairness hint. Lower runCount wins among equal-priority tasks.
   */
  runCount?: number;
  /**
   * Fairness hint. Older readySince wins among ties.
   * Should be an epoch milliseconds value if provided.
   */
  readySince?: number;
}

export interface TaskGraph {
  nodes: Record<string, TaskNode>;
}

export interface SchedulerConfig {
  /**
   * Max tasks that can be running at once.
   * If running tasks already hit this cap, ready queue is empty.
   */
  concurrencyCap: number;
  /**
   * Fallback priority when node.priority is undefined.
   */
  defaultPriority?: number;
}

export interface SchedulerResult {
  readyQueue: TaskNode[];
  runningCount: number;
  availableSlots: number;
}

export interface SchedulerService {
  getReadyQueue(graph: TaskGraph): SchedulerResult;
  pauseTask(graph: TaskGraph, taskId: string): TaskGraph;
  resumeTask(graph: TaskGraph, taskId: string): TaskGraph;
}

const SCHEDULABLE_STATES: ReadonlySet<TaskNodeState> = new Set(["pending", "ready"]);

function assertValidConfig(config: SchedulerConfig): void {
  if (!Number.isInteger(config.concurrencyCap) || config.concurrencyCap < 0) {
    throw new Error("Scheduler config error: concurrencyCap must be an integer >= 0");
  }
}

function cloneGraph(graph: TaskGraph): TaskGraph {
  const nodes: Record<string, TaskNode> = {};
  for (const [id, node] of Object.entries(graph.nodes)) {
    nodes[id] = {
      ...node,
      dependencies: node.dependencies ? [...node.dependencies] : [],
    };
  }
  return { nodes };
}

function dependenciesComplete(task: TaskNode, nodes: Record<string, TaskNode>): boolean {
  const dependencies = task.dependencies ?? [];
  for (const dependencyId of dependencies) {
    const dependency = nodes[dependencyId];
    if (!dependency) {
      throw new Error(`Task "${task.id}" depends on missing node "${dependencyId}"`);
    }
    if (dependency.state !== "complete") {
      return false;
    }
  }
  return true;
}

function getPriority(task: TaskNode, config: SchedulerConfig): number {
  return task.priority ?? config.defaultPriority ?? 0;
}

function getRunCount(task: TaskNode): number {
  return task.runCount ?? 0;
}

function getReadySince(task: TaskNode): number {
  return task.readySince ?? Number.MAX_SAFE_INTEGER;
}

function compareReadyTasks(a: TaskNode, b: TaskNode, config: SchedulerConfig): number {
  const priorityDiff = getPriority(b, config) - getPriority(a, config);
  if (priorityDiff !== 0) return priorityDiff;

  const runCountDiff = getRunCount(a) - getRunCount(b);
  if (runCountDiff !== 0) return runCountDiff;

  const readySinceDiff = getReadySince(a) - getReadySince(b);
  if (readySinceDiff !== 0) return readySinceDiff;

  return a.id.localeCompare(b.id);
}

function transitionStateForResume(task: TaskNode, nodes: Record<string, TaskNode>): TaskNodeState {
  return dependenciesComplete(task, nodes) ? "ready" : "pending";
}

export function createScheduler(config: SchedulerConfig): SchedulerService {
  assertValidConfig(config);

  return {
    getReadyQueue(graph: TaskGraph): SchedulerResult {
      const runningCount = Object.values(graph.nodes).filter((task) => task.state === "running").length;
      const availableSlots = Math.max(config.concurrencyCap - runningCount, 0);
      if (availableSlots === 0) {
        return { readyQueue: [], runningCount, availableSlots };
      }

      const candidates = Object.values(graph.nodes)
        .filter((task) => SCHEDULABLE_STATES.has(task.state))
        .filter((task) => dependenciesComplete(task, graph.nodes))
        .sort((a, b) => compareReadyTasks(a, b, config));

      return {
        readyQueue: candidates.slice(0, availableSlots),
        runningCount,
        availableSlots,
      };
    },

    pauseTask(graph: TaskGraph, taskId: string): TaskGraph {
      const cloned = cloneGraph(graph);
      const task = cloned.nodes[taskId];
      if (!task || task.state !== "blocked") {
        return cloned;
      }

      task.state = "paused";
      return cloned;
    },

    resumeTask(graph: TaskGraph, taskId: string): TaskGraph {
      const cloned = cloneGraph(graph);
      const task = cloned.nodes[taskId];
      if (!task || task.state !== "paused") {
        return cloned;
      }

      task.state = transitionStateForResume(task, cloned.nodes);
      return cloned;
    },
  };
}
