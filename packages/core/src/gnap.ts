/**
 * GNAP (Git-Native Agent Protocol) — persistent state layer for task handoffs.
 *
 * Implements GNAP Protocol v4 for persisting task state alongside code in a
 * `.gnap/` directory within the project's git repository. This enables:
 * - Long-running task persistence across agent restarts
 * - Clear ownership (who's working on what)
 * - Git-based task state that lives alongside the code
 *
 * Protocol reference: https://github.com/farol-team/gnap
 *
 * Integration: Called by SessionManager on spawn and LifecycleManager on
 * status transitions. Enabled per-project via `gnap.enabled` in config.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  openSync,
  closeSync,
  unlinkSync,
  constants,
} from "node:fs";
import { join, resolve } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import type { SessionStatus } from "./types.js";

// =============================================================================
// GNAP PROTOCOL TYPES (v4)
// =============================================================================

/** GNAP task states following the protocol state machine. */
export type GnapTaskState =
  | "backlog"
  | "ready"
  | "in_progress"
  | "review"
  | "done"
  | "blocked"
  | "cancelled";

/** A comment on a GNAP task. */
export interface GnapComment {
  by: string;
  at: string;
  text: string;
}

/** GNAP task entity — one JSON file per task in `.gnap/tasks/`. */
export interface GnapTask {
  id: string;
  title: string;
  desc?: string;
  assigned_to: string[];
  state: GnapTaskState;
  created_by: string;
  created_at: string;
  updated_at?: string;
  parent?: string;
  priority?: number;
  due?: string;
  blocked?: boolean;
  blocked_reason?: string;
  reviewer?: string;
  tags?: string[];
  comments?: GnapComment[];
}

/** Agent types in GNAP. */
export type GnapAgentType = "ai" | "human";

/** Agent status in GNAP. */
export type GnapAgentStatus = "active" | "idle" | "offline";

/** GNAP agent entry in `agents.json`. */
export interface GnapAgent {
  id: string;
  name: string;
  type: GnapAgentType;
  status: GnapAgentStatus;
  capabilities?: string[];
}

/** GNAP agents file — maps agent IDs to agent info. */
export interface GnapAgentsFile {
  [agentId: string]: GnapAgent;
}

/** GNAP run states. */
export type GnapRunState = "running" | "completed" | "failed" | "cancelled";

/** GNAP run entity — one JSON file per execution attempt in `.gnap/runs/`. */
export interface GnapRun {
  id: string;
  task_id: string;
  agent_id: string;
  state: GnapRunState;
  started_at: string;
  completed_at?: string;
  result?: string;
  error?: string;
  commits?: string[];
}

/** GNAP message types. */
export type GnapMessageType = "directive" | "status" | "request" | "info" | "alert";

/** GNAP message entity — one JSON file per message in `.gnap/messages/`. */
export interface GnapMessage {
  id: string;
  from: string;
  to: string[];
  type: GnapMessageType;
  text: string;
  sent_at: string;
  thread?: string;
  channel?: string;
  read_by?: string[];
}

/** GNAP config for a project. */
export interface GnapConfig {
  /** Enable GNAP state persistence (default: false) */
  enabled: boolean;
  /** Directory for GNAP files relative to project root (default: ".gnap") */
  dir?: string;
}

export const DEFAULT_GNAP_CONFIG: GnapConfig = {
  enabled: false,
  dir: ".gnap",
};

/** Current GNAP protocol version. */
const GNAP_PROTOCOL_VERSION = "4";

// =============================================================================
// VALIDATION
// =============================================================================

/**
 * Validate that an ID is safe for use as a filename component.
 * Rejects path traversal attempts (e.g. "../../etc/evil") and empty IDs.
 * Throws on invalid IDs to prevent writing outside the `.gnap/` directory.
 */
function validateGnapId(id: string, entity: string): void {
  if (!id) {
    throw new Error(`${entity} ID must not be empty`);
  }
  // Reject path separators and traversal sequences
  if (id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(`${entity} ID contains invalid path characters: ${id}`);
  }
}

/**
 * Safely build a file path within a base directory, preventing path traversal.
 * Validates that the resolved path stays within the expected base directory.
 */
function safeFilePath(baseDir: string, id: string, entity: string): string {
  validateGnapId(id, entity);
  const filePath = join(baseDir, `${id}.json`);
  // Double-check: resolved path must stay within baseDir
  const resolvedBase = resolve(baseDir);
  const resolvedFile = resolve(filePath);
  if (!resolvedFile.startsWith(resolvedBase + "/") && resolvedFile !== resolvedBase) {
    throw new Error(`${entity} ID resolves outside target directory: ${id}`);
  }
  return filePath;
}

// =============================================================================
// DIRECTORY OPERATIONS
// =============================================================================

/** Get the GNAP root directory for a project. */
export function getGnapDir(projectPath: string, gnapDir = ".gnap"): string {
  return join(projectPath, gnapDir);
}

/** Get the GNAP tasks directory. */
function getTasksDir(gnapRoot: string): string {
  return join(gnapRoot, "tasks");
}

/** Get the GNAP runs directory. */
function getRunsDir(gnapRoot: string): string {
  return join(gnapRoot, "runs");
}

/** Get the GNAP messages directory. */
function getMessagesDir(gnapRoot: string): string {
  return join(gnapRoot, "messages");
}

/**
 * Initialize the `.gnap/` directory structure for a project.
 * Creates directories and version file if they don't exist.
 * Safe to call multiple times (idempotent).
 */
export function initGnapDir(projectPath: string, gnapDir = ".gnap"): string {
  const root = getGnapDir(projectPath, gnapDir);

  mkdirSync(getTasksDir(root), { recursive: true });
  mkdirSync(getRunsDir(root), { recursive: true });
  mkdirSync(getMessagesDir(root), { recursive: true });

  // Write version file
  const versionPath = join(root, "version");
  if (!existsSync(versionPath)) {
    writeFileSync(versionPath, GNAP_PROTOCOL_VERSION, "utf-8");
  }

  // Initialize empty agents.json if it doesn't exist
  const agentsPath = join(root, "agents.json");
  if (!existsSync(agentsPath)) {
    writeFileSync(agentsPath, "{}\n", "utf-8");
  }

  return root;
}

/**
 * Check if a GNAP directory is initialized for a project.
 */
export function isGnapInitialized(projectPath: string, gnapDir = ".gnap"): boolean {
  const root = getGnapDir(projectPath, gnapDir);
  return existsSync(join(root, "version"));
}

// =============================================================================
// TASK OPERATIONS
// =============================================================================

/**
 * Write a GNAP task file. Creates or overwrites the task file.
 */
export function writeGnapTask(projectPath: string, task: GnapTask, gnapDir = ".gnap"): void {
  const root = getGnapDir(projectPath, gnapDir);
  const tasksDir = getTasksDir(root);
  mkdirSync(tasksDir, { recursive: true });

  const taskPath = safeFilePath(tasksDir, task.id, "Task");
  atomicWriteFileSync(taskPath, JSON.stringify(task, null, 2) + "\n");
}

/**
 * Read a GNAP task by ID. Returns null if the task doesn't exist.
 */
export function readGnapTask(
  projectPath: string,
  taskId: string,
  gnapDir = ".gnap",
): GnapTask | null {
  const taskPath = safeFilePath(getTasksDir(getGnapDir(projectPath, gnapDir)), taskId, "Task");
  if (!existsSync(taskPath)) return null;

  try {
    return JSON.parse(readFileSync(taskPath, "utf-8")) as GnapTask;
  } catch {
    return null;
  }
}

/**
 * Update specific fields of a GNAP task. Merges updates with existing data.
 */
export function updateGnapTask(
  projectPath: string,
  taskId: string,
  updates: Partial<GnapTask>,
  gnapDir = ".gnap",
): boolean {
  const existing = readGnapTask(projectPath, taskId, gnapDir);
  if (!existing) return false;

  const updated: GnapTask = {
    ...existing,
    ...updates,
    updated_at: new Date().toISOString(),
  };

  writeGnapTask(projectPath, updated, gnapDir);
  return true;
}

/**
 * List all GNAP tasks for a project.
 */
export function listGnapTasks(projectPath: string, gnapDir = ".gnap"): GnapTask[] {
  const tasksDir = getTasksDir(getGnapDir(projectPath, gnapDir));
  if (!existsSync(tasksDir)) return [];

  const tasks: GnapTask[] = [];
  for (const file of readdirSync(tasksDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const content = readFileSync(join(tasksDir, file), "utf-8");
      tasks.push(JSON.parse(content) as GnapTask);
    } catch {
      // Skip corrupt files
    }
  }

  return tasks;
}

// =============================================================================
// AGENT OPERATIONS
// =============================================================================

/**
 * Read all agents from the agents.json file.
 */
export function readGnapAgents(projectPath: string, gnapDir = ".gnap"): GnapAgentsFile {
  const agentsPath = join(getGnapDir(projectPath, gnapDir), "agents.json");
  if (!existsSync(agentsPath)) return {};

  try {
    return JSON.parse(readFileSync(agentsPath, "utf-8")) as GnapAgentsFile;
  } catch {
    return {};
  }
}

/**
 * Write or update an agent in agents.json.
 *
 * Uses a lockfile to make the read-modify-write cycle safe against
 * concurrent processes (e.g. parallel agent spawns).
 */
export function writeGnapAgent(
  projectPath: string,
  agent: GnapAgent,
  gnapDir = ".gnap",
): void {
  validateGnapId(agent.id, "Agent");
  const root = getGnapDir(projectPath, gnapDir);
  mkdirSync(root, { recursive: true });

  const agentsPath = join(root, "agents.json");
  const lockPath = `${agentsPath}.lock`;

  // Acquire lockfile (O_EXCL ensures only one process wins)
  const maxRetries = 5;
  let lockFd: number | null = null;
  for (let i = 0; i < maxRetries; i++) {
    try {
      lockFd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      break;
    } catch {
      // Lock held by another process — brief busy-wait and retry
      const waitMs = 10 + Math.random() * 20;
      const end = Date.now() + waitMs;
      while (Date.now() < end) {
        // spin
      }
    }
  }

  try {
    // Read current agents (inside lock)
    const agents = readGnapAgents(projectPath, gnapDir);
    agents[agent.id] = agent;
    atomicWriteFileSync(agentsPath, JSON.stringify(agents, null, 2) + "\n");
  } finally {
    // Release lock
    if (lockFd !== null) {
      closeSync(lockFd);
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // Lock file already removed — harmless
    }
  }
}

// =============================================================================
// RUN OPERATIONS
// =============================================================================

/**
 * Write a GNAP run file.
 */
export function writeGnapRun(projectPath: string, run: GnapRun, gnapDir = ".gnap"): void {
  const root = getGnapDir(projectPath, gnapDir);
  const runsDir = getRunsDir(root);
  mkdirSync(runsDir, { recursive: true });

  const runPath = safeFilePath(runsDir, run.id, "Run");
  atomicWriteFileSync(runPath, JSON.stringify(run, null, 2) + "\n");
}

/**
 * Read a GNAP run by ID. Returns null if the run doesn't exist.
 */
export function readGnapRun(
  projectPath: string,
  runId: string,
  gnapDir = ".gnap",
): GnapRun | null {
  const runPath = safeFilePath(getRunsDir(getGnapDir(projectPath, gnapDir)), runId, "Run");
  if (!existsSync(runPath)) return null;

  try {
    return JSON.parse(readFileSync(runPath, "utf-8")) as GnapRun;
  } catch {
    return null;
  }
}

/**
 * Update specific fields of a GNAP run.
 */
export function updateGnapRun(
  projectPath: string,
  runId: string,
  updates: Partial<GnapRun>,
  gnapDir = ".gnap",
): boolean {
  const existing = readGnapRun(projectPath, runId, gnapDir);
  if (!existing) return false;

  const updated: GnapRun = { ...existing, ...updates };
  writeGnapRun(projectPath, updated, gnapDir);
  return true;
}

// =============================================================================
// MESSAGE OPERATIONS
// =============================================================================

/**
 * Write a GNAP message file.
 */
export function writeGnapMessage(
  projectPath: string,
  message: GnapMessage,
  gnapDir = ".gnap",
): void {
  const root = getGnapDir(projectPath, gnapDir);
  const messagesDir = getMessagesDir(root);
  mkdirSync(messagesDir, { recursive: true });

  const messagePath = safeFilePath(messagesDir, message.id, "Message");
  atomicWriteFileSync(messagePath, JSON.stringify(message, null, 2) + "\n");
}

// =============================================================================
// STATE MAPPING
// =============================================================================

/**
 * Map an AO SessionStatus to a GNAP task state.
 *
 * AO status machine → GNAP state machine:
 *   spawning     → ready        (task assigned, agent starting)
 *   working      → in_progress  (agent actively coding)
 *   pr_open      → review       (PR created, awaiting review)
 *   ci_failed    → in_progress  (agent needs to fix CI)
 *   review_pending → review     (waiting for human review)
 *   changes_requested → in_progress (agent addressing feedback)
 *   approved     → review       (approved but not yet merged)
 *   mergeable    → review       (ready to merge)
 *   merged       → done         (PR merged, task complete)
 *   needs_input  → blocked      (agent needs human input)
 *   stuck        → blocked      (agent is stuck)
 *   errored      → blocked      (agent hit an error)
 *   killed       → cancelled    (session killed)
 *   idle         → in_progress  (agent idle but task not done)
 *   done         → done         (task completed)
 *   terminated   → cancelled    (session terminated)
 *   cleanup      → cancelled    (session being cleaned up)
 */
export function sessionStatusToGnapState(status: SessionStatus): GnapTaskState {
  switch (status) {
    case "spawning":
      return "ready";
    case "working":
    case "ci_failed":
    case "changes_requested":
    case "idle":
      return "in_progress";
    case "pr_open":
    case "review_pending":
    case "approved":
    case "mergeable":
      return "review";
    case "merged":
    case "done":
      return "done";
    case "needs_input":
    case "stuck":
    case "errored":
      return "blocked";
    case "killed":
    case "terminated":
    case "cleanup":
      return "cancelled";
    default:
      return "in_progress";
  }
}

/**
 * Map a GNAP task state to a GNAP run state.
 */
export function gnapTaskStateToRunState(state: GnapTaskState): GnapRunState {
  switch (state) {
    case "done":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "blocked":
      return "failed";
    default:
      return "running";
  }
}

// =============================================================================
// SESSION-TO-GNAP SYNC
// =============================================================================

/** Options for syncing a session to GNAP state. */
export interface GnapSyncOptions {
  projectPath: string;
  gnapDir?: string;
  sessionId: string;
  agentName: string;
  issueId?: string;
  issueTitle?: string;
  issueDescription?: string;
  status: SessionStatus;
  branch?: string;
  parentTaskId?: string;
}

/**
 * Generate a deterministic GNAP task ID from a session's issue or session ID.
 * Uses the issue ID if available, otherwise falls back to session ID.
 * Always returns a non-empty string safe for use as a filename.
 */
export function generateGnapTaskId(sessionId: string, issueId?: string): string {
  if (issueId) {
    // Sanitize issue ID for use as filename: replace slashes, spaces, special chars
    const sanitized = issueId
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    // Fall back to sessionId if sanitization produced an empty string
    // (e.g. issueId was "#" or "///")
    if (sanitized) return sanitized;
  }
  return sessionId;
}

/**
 * Sync an AO session's state to GNAP task files.
 *
 * This is the main integration point — called by SessionManager on spawn
 * and by LifecycleManager on status transitions. It:
 * 1. Initializes the `.gnap/` directory if needed
 * 2. Registers the agent in `agents.json`
 * 3. Creates or updates the task in `tasks/`
 * 4. Creates or updates the run in `runs/`
 */
export function syncSessionToGnap(opts: GnapSyncOptions): void {
  const gnapDir = opts.gnapDir ?? ".gnap";

  // Initialize GNAP directory if needed
  if (!isGnapInitialized(opts.projectPath, gnapDir)) {
    initGnapDir(opts.projectPath, gnapDir);
  }

  const now = new Date().toISOString();
  const taskId = generateGnapTaskId(opts.sessionId, opts.issueId);
  const agentId = opts.sessionId; // Use session ID as agent ID for uniqueness
  const gnapState = sessionStatusToGnapState(opts.status);

  // 1. Register/update agent
  writeGnapAgent(
    opts.projectPath,
    {
      id: agentId,
      name: `${opts.agentName} (${opts.sessionId})`,
      type: "ai",
      status: gnapState === "done" || gnapState === "cancelled" ? "offline" : "active",
    },
    gnapDir,
  );

  // 2. Create or update task
  const existingTask = readGnapTask(opts.projectPath, taskId, gnapDir);
  if (existingTask) {
    // Update existing task
    const updates: Partial<GnapTask> = {
      state: gnapState,
    };

    // Update blocked fields
    if (gnapState === "blocked") {
      updates.blocked = true;
      updates.blocked_reason = `Agent ${opts.status}: ${opts.sessionId}`;
    } else if (existingTask.blocked) {
      updates.blocked = false;
      updates.blocked_reason = undefined;
    }

    // Add agent to assigned_to if not already there
    if (!existingTask.assigned_to.includes(agentId)) {
      updates.assigned_to = [...existingTask.assigned_to, agentId];
    }

    updateGnapTask(opts.projectPath, taskId, updates, gnapDir);
  } else {
    // Create new task
    const task: GnapTask = {
      id: taskId,
      title: opts.issueTitle ?? opts.issueId ?? `Session ${opts.sessionId}`,
      desc: opts.issueDescription,
      assigned_to: [agentId],
      state: gnapState,
      created_by: "ao-orchestrator",
      created_at: now,
      parent: opts.parentTaskId,
      tags: opts.branch ? [`branch:${opts.branch}`] : undefined,
    };

    if (gnapState === "blocked") {
      task.blocked = true;
      task.blocked_reason = `Agent ${opts.status}: ${opts.sessionId}`;
    }

    writeGnapTask(opts.projectPath, task, gnapDir);
  }

  // 3. Create or update run
  const runId = `${taskId}-${agentId}`;
  const existingRun = readGnapRun(opts.projectPath, runId, gnapDir);
  const runState = gnapTaskStateToRunState(gnapState);

  if (existingRun) {
    const runUpdates: Partial<GnapRun> = {
      state: runState,
    };
    if (runState === "completed" || runState === "failed" || runState === "cancelled") {
      runUpdates.completed_at = now;
    }
    if (runState === "failed" && opts.status === "errored") {
      runUpdates.error = `Agent errored: ${opts.sessionId}`;
    }
    updateGnapRun(opts.projectPath, runId, runUpdates, gnapDir);
  } else {
    writeGnapRun(
      opts.projectPath,
      {
        id: runId,
        task_id: taskId,
        agent_id: agentId,
        state: runState,
        started_at: now,
      },
      gnapDir,
    );
  }
}

// =============================================================================
// DECOMPOSITION SYNC
// =============================================================================

/** Options for syncing a decomposition plan to GNAP. */
export interface GnapDecompositionSyncOptions {
  projectPath: string;
  gnapDir?: string;
  /** Unique ID for this decomposition plan (default: auto-generated from timestamp) */
  planId?: string;
  rootTaskDescription: string;
  /** Leaf tasks from the decomposition — each will get a GNAP task file. */
  tasks: Array<{
    id: string;
    description: string;
    parentId?: string;
    sessionId?: string;
  }>;
}

/**
 * Sync a decomposition plan to GNAP task files.
 * Creates a parent task and child tasks for each leaf.
 */
export function syncDecompositionToGnap(opts: GnapDecompositionSyncOptions): void {
  const gnapDir = opts.gnapDir ?? ".gnap";

  if (!isGnapInitialized(opts.projectPath, gnapDir)) {
    initGnapDir(opts.projectPath, gnapDir);
  }

  const now = new Date().toISOString();

  // Use provided planId or generate a unique one to avoid collisions
  // across multiple decomposition invocations
  const parentTaskId = opts.planId ?? `plan-${Date.now()}`;
  writeGnapTask(
    opts.projectPath,
    {
      id: parentTaskId,
      title: opts.rootTaskDescription,
      assigned_to: [],
      state: "in_progress",
      created_by: "ao-decomposer",
      created_at: now,
      tags: ["decomposed"],
    },
    gnapDir,
  );

  // Create child tasks
  for (const task of opts.tasks) {
    writeGnapTask(
      opts.projectPath,
      {
        id: task.id,
        title: task.description,
        assigned_to: task.sessionId ? [task.sessionId] : [],
        state: task.sessionId ? "in_progress" : "ready",
        created_by: "ao-decomposer",
        created_at: now,
        parent: task.parentId ?? parentTaskId,
      },
      gnapDir,
    );
  }
}
