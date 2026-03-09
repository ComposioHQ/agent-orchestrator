/**
 * Session Manager — CRUD for agent sessions.
 *
 * Orchestrates Runtime, Agent, and Workspace plugins to:
 * - Spawn new sessions (create workspace → create runtime → launch agent)
 * - List sessions (from metadata + live runtime checks)
 * - Kill sessions (agent → runtime → workspace cleanup)
 * - Cleanup completed sessions (PR merged / issue closed)
 * - Send messages to running sessions
 *
 * Reference: scripts/claude-ao-session, scripts/send-to-session
 */

import { statSync, existsSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import {
  isIssueNotFoundError,
  isRestorable,
  NON_RESTORABLE_STATUSES,
  SessionNotFoundError,
  SessionNotRestorableError,
  WorkspaceMissingError,
  type OpenCodeSessionManager,
  type Session,
  type SessionId,
  type SessionSpawnConfig,
  type OrchestratorSpawnConfig,
  type SessionStatus,
  type CleanupResult,
  type ClaimPROptions,
  type ClaimPRResult,
  type OrchestratorConfig,
  type ProjectConfig,
  type SessionKillOptions,
  type SessionKillStepResult,
  type Runtime,
  type Agent,
  type Workspace,
  type Tracker,
  type SCM,
  type PluginRegistry,
  type RuntimeHandle,
  type Issue,
  PR_STATE,
} from "./types.js";
import {
  readMetadataRaw,
  readArchivedMetadataRaw,
  updateArchivedMetadata,
  writeMetadata,
  updateMetadata,
  deleteMetadata,
  listMetadata,
  reserveSessionId,
} from "./metadata.js";
import { buildPrompt } from "./prompt-builder.js";
import {
  getSessionsDir,
  getWorktreesDir,
  getProjectBaseDir,
  generateTmuxName,
  generateConfigHash,
  validateAndStoreOrigin,
} from "./paths.js";
import { asValidOpenCodeSessionId } from "./opencode-session-id.js";
import { normalizeOrchestratorSessionStrategy } from "./orchestrator-session-strategy.js";

const execFileAsync = promisify(execFile);
const OPENCODE_DISCOVERY_TIMEOUT_MS = 2_000;
const OPENCODE_INTERACTIVE_DISCOVERY_TIMEOUT_MS = 10_000;
const PROCESS_LIST_TIMEOUT_MS = 5_000;
const PROCESS_TERMINATION_TIMEOUT_MS = 5_000;
const PROCESS_TERMINATION_POLL_MS = 200;
const TMUX_KILL_TIMEOUT_MS = 5_000;
const GIT_CLEANUP_TIMEOUT_MS = 30_000;

interface ProcessSnapshot {
  pid: number;
  ppid: number;
  command: string;
}

function getErrorCode(err: unknown): string | undefined {
  if (!(err instanceof Error) || !("code" in err)) return undefined;
  const code = err.code;
  return typeof code === "string" ? code : undefined;
}

function getExitCode(err: unknown): number | null {
  if (!(err instanceof Error) || !("code" in err)) return null;
  const code = err.code;
  return typeof code === "number" ? code : null;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emitKillStep(
  options: SessionKillOptions | undefined,
  result: SessionKillStepResult,
): void {
  options?.onStep?.(result);
}

function parsePid(raw: unknown): number | null {
  const pid = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return pid;
}

async function isPidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return getErrorCode(err) === "EPERM";
  }
}

function sendSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (err: unknown) {
    const code = getErrorCode(err);
    if (code === "ESRCH") return;
    throw err;
  }
}

async function listProcesses(): Promise<ProcessSnapshot[]> {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,args="], {
    timeout: PROCESS_LIST_TIMEOUT_MS,
  });

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) return [];

      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      if (!Number.isFinite(pid) || !Number.isFinite(ppid) || pid <= 0 || ppid < 0) {
        return [];
      }

      return [{ pid, ppid, command: match[3] ?? "" }];
    });
}

function collectProcessTree(
  processes: ProcessSnapshot[],
  rootPids: Iterable<number>,
): ProcessSnapshot[] {
  const processByPid = new Map<number, ProcessSnapshot>();
  const childrenByParent = new Map<number, number[]>();

  for (const process of processes) {
    processByPid.set(process.pid, process);
    const children = childrenByParent.get(process.ppid) ?? [];
    children.push(process.pid);
    childrenByParent.set(process.ppid, children);
  }

  const queue = [...new Set([...rootPids].filter((pid) => pid > 0))];
  const visited = new Set<number>();
  const collected: ProcessSnapshot[] = [];

  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined || visited.has(pid)) continue;
    visited.add(pid);

    const process = processByPid.get(pid);
    if (process) {
      collected.push(process);
    }

    const children = childrenByParent.get(pid) ?? [];
    for (const childPid of children) {
      if (!visited.has(childPid)) {
        queue.push(childPid);
      }
    }
  }

  return collected;
}

async function getTmuxPaneRootPids(sessionId: string): Promise<number[]> {
  const { stdout } = await execFileAsync(
    "tmux",
    ["list-panes", "-t", sessionId, "-F", "#{pane_pid}"],
    { timeout: TMUX_KILL_TIMEOUT_MS },
  );

  return [
    ...new Set(
      stdout
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isFinite(pid) && pid > 0),
    ),
  ];
}

async function captureSessionProcessTree(handle: RuntimeHandle): Promise<ProcessSnapshot[]> {
  const rootPids: number[] = [];

  if (handle.runtimeName === "tmux" && handle.id) {
    rootPids.push(...(await getTmuxPaneRootPids(handle.id)));
  }

  if (handle.runtimeName === "process") {
    const pid = parsePid(handle.data["pid"]);
    if (pid !== null) {
      rootPids.push(pid);
    }
  }

  if (rootPids.length === 0) {
    return [];
  }

  const processes = await listProcesses();
  return collectProcessTree(processes, rootPids);
}

async function terminateProcesses(processes: ProcessSnapshot[]): Promise<{
  total: number;
  forceKilled: number;
  survivors: number[];
}> {
  const pids = [...new Set(processes.map((process) => process.pid).filter((pid) => pid > 0))];

  if (pids.length === 0) {
    return { total: 0, forceKilled: 0, survivors: [] };
  }

  for (const pid of pids) {
    sendSignal(pid, "SIGTERM");
  }

  const deadline = Date.now() + PROCESS_TERMINATION_TIMEOUT_MS;
  let survivors = await Promise.all(
    pids.map(async (pid) => ((await isPidAlive(pid)) ? pid : null)),
  ).then((alive) => alive.filter((pid): pid is number => pid !== null));

  while (survivors.length > 0 && Date.now() < deadline) {
    await sleep(PROCESS_TERMINATION_POLL_MS);
    survivors = await Promise.all(
      survivors.map(async (pid) => ((await isPidAlive(pid)) ? pid : null)),
    ).then((alive) => alive.filter((pid): pid is number => pid !== null));
  }

  let forceKilled = 0;
  if (survivors.length > 0) {
    forceKilled = survivors.length;
    for (const pid of survivors) {
      sendSignal(pid, "SIGKILL");
    }
    await sleep(PROCESS_TERMINATION_POLL_MS);
    survivors = await Promise.all(
      survivors.map(async (pid) => ((await isPidAlive(pid)) ? pid : null)),
    ).then((alive) => alive.filter((pid): pid is number => pid !== null));
  }

  return { total: pids.length, forceKilled, survivors };
}

async function hasTmuxSession(sessionId: string): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["has-session", "-t", sessionId], {
      timeout: TMUX_KILL_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

async function gitBranchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: repoPath,
      timeout: GIT_CLEANUP_TIMEOUT_MS,
    });
    return true;
  } catch (err: unknown) {
    if (getExitCode(err) === 1) {
      return false;
    }
    throw err;
  }
}

async function isGitWorktreeRegistered(repoPath: string, workspacePath: string): Promise<boolean> {
  const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoPath,
    timeout: GIT_CLEANUP_TIMEOUT_MS,
  });

  const normalizedWorkspace = resolve(workspacePath);
  return stdout.split("\n").some((line) => {
    if (!line.startsWith("worktree ")) return false;
    return resolve(line.slice("worktree ".length)) === normalizedWorkspace;
  });
}

async function forceRemoveGitWorktree(repoPath: string, workspacePath: string): Promise<void> {
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", workspacePath], {
      cwd: repoPath,
      timeout: GIT_CLEANUP_TIMEOUT_MS,
    });
  } catch {
    // Fall through — we verify end state after prune + directory cleanup.
  }

  try {
    await execFileAsync("git", ["worktree", "prune"], {
      cwd: repoPath,
      timeout: GIT_CLEANUP_TIMEOUT_MS,
    });
  } catch {
    // Best effort — verification below decides success/failure.
  }

  if (existsSync(workspacePath)) {
    rmSync(workspacePath, { recursive: true, force: true });
  }

  const stillExists = existsSync(workspacePath);
  const stillRegistered = await isGitWorktreeRegistered(repoPath, workspacePath);
  if (stillExists || stillRegistered) {
    throw new Error(
      [
        stillRegistered ? `git still lists worktree ${workspacePath}` : null,
        stillExists ? `directory still exists at ${workspacePath}` : null,
      ]
        .filter(Boolean)
        .join("; "),
    );
  }
}

async function deleteLocalBranch(repoPath: string, branch: string): Promise<"deleted" | "missing"> {
  if (!(await gitBranchExists(repoPath, branch))) {
    return "missing";
  }

  await execFileAsync("git", ["branch", "-D", branch], {
    cwd: repoPath,
    timeout: GIT_CLEANUP_TIMEOUT_MS,
  });

  if (await gitBranchExists(repoPath, branch)) {
    throw new Error(`branch ${branch} still exists after deletion attempt`);
  }

  return "deleted";
}

function errorIncludesSessionNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { stderr?: string; stdout?: string };
  const combined = [err.message, e.stderr, e.stdout].filter(Boolean).join("\n");
  return /session not found/i.test(combined);
}

async function deleteOpenCodeSession(sessionId: string): Promise<void> {
  const validatedSessionId = asValidOpenCodeSessionId(sessionId);
  if (!validatedSessionId) return;
  const retryDelaysMs = [0, 200, 600];
  let lastError: unknown;
  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      await execFileAsync("opencode", ["session", "delete", validatedSessionId], {
        timeout: 30_000,
      });
      return;
    } catch (err) {
      if (errorIncludesSessionNotFound(err)) {
        return;
      }
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

interface OpenCodeSessionListEntry {
  id: string;
  title: string;
  updatedAt?: number;
}

async function fetchOpenCodeSessionList(
  timeoutMs = OPENCODE_DISCOVERY_TIMEOUT_MS,
): Promise<OpenCodeSessionListEntry[]> {
  try {
    const { stdout } = await execFileAsync("opencode", ["session", "list", "--format", "json"], {
      timeout: timeoutMs,
    });
    const parsed = safeJsonParse<unknown>(stdout);
    if (!Array.isArray(parsed)) return [];

    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const title = typeof entry["title"] === "string" ? entry["title"] : "";
      const id = asValidOpenCodeSessionId(entry["id"]);
      if (!id) return [];
      const rawUpdated = entry["updated"];
      let updatedAt: number | undefined;
      if (typeof rawUpdated === "number" && Number.isFinite(rawUpdated)) {
        updatedAt = rawUpdated;
      } else if (typeof rawUpdated === "string") {
        const parsedUpdated = Date.parse(rawUpdated);
        if (!Number.isNaN(parsedUpdated)) {
          updatedAt = parsedUpdated;
        }
      }
      return [{ id, title, ...(updatedAt !== undefined ? { updatedAt } : {}) }];
    });
  } catch {
    return [];
  }
}

async function discoverOpenCodeSessionIdsByTitle(
  sessionId: string,
  timeoutMs = OPENCODE_DISCOVERY_TIMEOUT_MS,
  sessionListPromise?: Promise<OpenCodeSessionListEntry[]>,
): Promise<string[]> {
  const sessions = await (sessionListPromise ?? fetchOpenCodeSessionList(timeoutMs));
  const title = `AO:${sessionId}`;
  return sessions
    .filter((entry) => entry.title === title)
    .sort((a, b) => {
      const ta = a.updatedAt ?? -Infinity;
      const tb = b.updatedAt ?? -Infinity;
      if (ta === tb) return 0;
      return tb - ta;
    })
    .map((entry) => entry.id);
}

async function discoverOpenCodeSessionIdByTitle(
  sessionId: string,
  timeoutMs?: number,
  sessionListPromise?: Promise<OpenCodeSessionListEntry[]>,
): Promise<string | undefined> {
  const matches = await discoverOpenCodeSessionIdsByTitle(sessionId, timeoutMs, sessionListPromise);
  return matches[0];
}

/** Escape regex metacharacters in a string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Get the next session number for a project. */
function getNextSessionNumber(existingSessions: string[], prefix: string): number {
  let max = 0;
  const pattern = new RegExp(`^${escapeRegex(prefix)}-(\\d+)$`);
  for (const name of existingSessions) {
    const match = name.match(pattern);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > max) max = num;
    }
  }
  return max + 1;
}

/** Safely parse JSON, returning null on failure. */
function safeJsonParse<T>(str: string): T | null {
  try {
    return JSON.parse(str) as T;
  } catch {
    return null;
  }
}

/** Valid session statuses for validation. */
const VALID_STATUSES: ReadonlySet<string> = new Set([
  "spawning",
  "working",
  "pr_open",
  "ci_failed",
  "review_pending",
  "changes_requested",
  "approved",
  "mergeable",
  "merged",
  "cleanup",
  "needs_input",
  "stuck",
  "errored",
  "killed",
  "done",
  "terminated",
]);

const PR_TRACKING_STATUSES: ReadonlySet<string> = new Set([
  "pr_open",
  "ci_failed",
  "review_pending",
  "changes_requested",
  "approved",
  "mergeable",
]);

const SEND_RESTORE_READY_TIMEOUT_MS = 5_000;
const SEND_RESTORE_READY_POLL_MS = 500;
const SEND_CONFIRMATION_ATTEMPTS = 3;
const SEND_CONFIRMATION_POLL_MS = 500;
const SEND_CONFIRMATION_OUTPUT_LINES = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Validate and normalize a status string. */
function validateStatus(raw: string | undefined): SessionStatus {
  // Bash scripts write "starting" — treat as "working"
  if (raw === "starting") return "working";
  if (raw && VALID_STATUSES.has(raw)) return raw as SessionStatus;
  return "spawning";
}

/** Reconstruct a Session object from raw metadata key=value pairs. */
function metadataToSession(
  sessionId: SessionId,
  meta: Record<string, string>,
  createdAt?: Date,
  modifiedAt?: Date,
): Session {
  return {
    id: sessionId,
    projectId: meta["project"] ?? "",
    status: validateStatus(meta["status"]),
    activity: null,
    branch: meta["branch"] || null,
    issueId: meta["issue"] || null,
    pr: meta["pr"]
      ? (() => {
          // Parse owner/repo from GitHub PR URL: https://github.com/owner/repo/pull/123
          const prUrl = meta["pr"];
          const ghMatch = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
          return {
            number: ghMatch
              ? parseInt(ghMatch[3], 10)
              : parseInt(prUrl.match(/\/(\d+)$/)?.[1] ?? "0", 10),
            url: prUrl,
            title: "",
            owner: ghMatch?.[1] ?? "",
            repo: ghMatch?.[2] ?? "",
            branch: meta["branch"] ?? "",
            baseBranch: "",
            isDraft: false,
          };
        })()
      : null,
    workspacePath: meta["worktree"] || null,
    runtimeHandle: meta["runtimeHandle"]
      ? safeJsonParse<RuntimeHandle>(meta["runtimeHandle"])
      : null,
    agentInfo: meta["summary"] ? { summary: meta["summary"], agentSessionId: null } : null,
    createdAt: meta["createdAt"] ? new Date(meta["createdAt"]) : (createdAt ?? new Date()),
    lastActivityAt: modifiedAt ?? new Date(),
    restoredAt: meta["restoredAt"] ? new Date(meta["restoredAt"]) : undefined,
    metadata: meta,
  };
}

export interface SessionManagerDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
}

/** Create a SessionManager instance. */
export function createSessionManager(deps: SessionManagerDeps): OpenCodeSessionManager {
  const { config, registry } = deps;

  interface LocatedSession {
    raw: Record<string, string>;
    sessionsDir: string;
    project: ProjectConfig;
    projectId: string;
  }

  /**
   * Get the sessions directory for a project.
   */
  function getProjectSessionsDir(project: ProjectConfig): string {
    return getSessionsDir(config.configPath, project.path);
  }

  function normalizePath(path: string): string {
    return resolve(path).replace(/\/$/, "");
  }

  function isPathInside(path: string, parentPath: string): boolean {
    const normalizedPath = normalizePath(path);
    const normalizedParent = normalizePath(parentPath);
    return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
  }

  function getManagedWorkspaceRoots(project: ProjectConfig, projectId?: string): string[] {
    const roots = [getWorktreesDir(config.configPath, project.path)];
    const legacyIds = new Set<string>();
    if (projectId) {
      legacyIds.add(projectId);
    }
    legacyIds.add(basename(project.path));

    for (const id of legacyIds) {
      roots.push(join(homedir(), ".worktrees", id));
    }

    return roots;
  }

  function shouldDestroyWorkspacePath(
    project: ProjectConfig | undefined,
    projectId: string | undefined,
    workspacePath: string,
  ): boolean {
    if (!project) return false;
    if (normalizePath(workspacePath) === normalizePath(project.path)) return false;

    const roots = getManagedWorkspaceRoots(project, projectId);
    return roots.some((root) => isPathInside(workspacePath, root));
  }

  /**
   * List all session files across all projects (or filtered by projectId).
   * Scans project-specific directories under ~/.agent-orchestrator/{hash}-{projectId}/sessions/
   *
   * Note: projectId is the config key (e.g., "test-project"), not the path basename.
   */
  function listAllSessions(projectIdFilter?: string): { sessionName: string; projectId: string }[] {
    const results: { sessionName: string; projectId: string }[] = [];

    // Scan each project's sessions directory
    for (const [projectKey, project] of Object.entries(config.projects)) {
      // Use config key as projectId for consistency with metadata
      const projectId = projectKey;

      // Filter by project if specified
      if (projectIdFilter && projectId !== projectIdFilter) continue;

      const sessionsDir = getSessionsDir(config.configPath, project.path);
      if (!existsSync(sessionsDir)) continue;

      const files = readdirSync(sessionsDir);
      for (const file of files) {
        if (file === "archive" || file.startsWith(".")) continue;
        const fullPath = join(sessionsDir, file);
        try {
          if (statSync(fullPath).isFile()) {
            results.push({ sessionName: file, projectId });
          }
        } catch {
          // Skip files that can't be stat'd
        }
      }
    }

    return results;
  }

  function listArchivedSessionIds(sessionsDir: string): string[] {
    const archiveDir = join(sessionsDir, "archive");
    if (!existsSync(archiveDir)) return [];
    const ids = new Set<string>();
    for (const file of readdirSync(archiveDir)) {
      const match = file.match(/^([a-zA-Z0-9_-]+)_\d/);
      if (match?.[1]) ids.add(match[1]);
    }
    return [...ids];
  }

  function markArchivedOpenCodeCleanup(sessionsDir: string, sessionId: SessionId): void {
    updateArchivedMetadata(sessionsDir, sessionId, {
      opencodeSessionId: "",
      opencodeCleanedAt: new Date().toISOString(),
    });
  }

  function sortSessionIdsForReuse(ids: string[]): string[] {
    const numericSuffix = (id: string): number | undefined => {
      const match = id.match(/-(\d+)$/);
      if (!match) return undefined;
      const parsed = Number.parseInt(match[1], 10);
      return Number.isNaN(parsed) ? undefined : parsed;
    };

    return [...ids].sort((a, b) => {
      const aNum = numericSuffix(a);
      const bNum = numericSuffix(b);
      if (aNum !== undefined && bNum !== undefined && aNum !== bNum) {
        return bNum - aNum;
      }
      if (aNum !== undefined && bNum === undefined) return -1;
      if (aNum === undefined && bNum !== undefined) return 1;
      return b.localeCompare(a);
    });
  }

  function findOpenCodeSessionIds(
    sessionsDir: string,
    criteria: { issueId?: string; sessionId?: string },
  ): string[] {
    const matchesCriteria = (id: string, raw: Record<string, string> | null): boolean => {
      if (!raw) return false;
      if (raw["agent"] !== "opencode") return false;
      if (criteria.issueId !== undefined && raw["issue"] !== criteria.issueId) return false;
      if (criteria.sessionId !== undefined && id !== criteria.sessionId) return false;
      return true;
    };

    const ids: string[] = [];
    const maybeAdd = (id: string, raw: Record<string, string> | null) => {
      if (!matchesCriteria(id, raw)) return;
      const mapped = asValidOpenCodeSessionId(raw?.["opencodeSessionId"]);
      if (!mapped) return;
      ids.push(mapped);
    };

    for (const id of sortSessionIdsForReuse(listMetadata(sessionsDir))) {
      maybeAdd(id, readMetadataRaw(sessionsDir, id));
    }
    for (const id of sortSessionIdsForReuse(listArchivedSessionIds(sessionsDir))) {
      maybeAdd(id, readArchivedMetadataRaw(sessionsDir, id));
    }

    return [...new Set(ids)];
  }

  async function resolveOpenCodeSessionReuse(options: {
    sessionsDir: string;
    criteria: { issueId?: string; sessionId?: string };
    strategy: "reuse" | "delete" | "ignore";
    includeTitleDiscoveryForSessionId?: boolean;
  }): Promise<string | undefined> {
    const { sessionsDir, criteria, strategy, includeTitleDiscoveryForSessionId = false } = options;
    if (strategy === "ignore") return undefined;

    let candidateIds = findOpenCodeSessionIds(sessionsDir, criteria);

    if (strategy === "delete") {
      if (includeTitleDiscoveryForSessionId && criteria.sessionId) {
        candidateIds = [
          ...candidateIds,
          ...(await discoverOpenCodeSessionIdsByTitle(criteria.sessionId)),
        ];
      }

      for (const openCodeSessionId of [...new Set(candidateIds)]) {
        await deleteOpenCodeSession(openCodeSessionId);
      }
      return undefined;
    }

    if (candidateIds.length === 0 && criteria.sessionId) {
      candidateIds = await discoverOpenCodeSessionIdsByTitle(criteria.sessionId);
    }

    return candidateIds[0];
  }

  /** Resolve which plugins to use for a project. */
  function resolvePlugins(project: ProjectConfig, agentOverride?: string) {
    const runtime = registry.get<Runtime>("runtime", project.runtime ?? config.defaults.runtime);
    const agent = registry.get<Agent>(
      "agent",
      agentOverride ?? project.agent ?? config.defaults.agent,
    );
    const workspace = registry.get<Workspace>(
      "workspace",
      project.workspace ?? config.defaults.workspace,
    );
    const tracker = project.tracker
      ? registry.get<Tracker>("tracker", project.tracker.plugin)
      : null;
    const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;

    return { runtime, agent, workspace, tracker, scm };
  }

  async function ensureOpenCodeSessionMapping(
    session: Session,
    sessionName: string,
    sessionsDir: string,
    effectiveAgentName: string,
    sessionListPromise?: Promise<OpenCodeSessionListEntry[]>,
  ): Promise<void> {
    if (effectiveAgentName !== "opencode") return;
    if (asValidOpenCodeSessionId(session.metadata["opencodeSessionId"])) return;

    const discovered = await discoverOpenCodeSessionIdByTitle(
      sessionName,
      OPENCODE_DISCOVERY_TIMEOUT_MS,
      sessionListPromise,
    );
    if (!discovered) return;

    session.metadata["opencodeSessionId"] = discovered;
    updateMetadata(sessionsDir, sessionName, { opencodeSessionId: discovered });
  }

  function findSessionRecord(sessionId: SessionId): LocatedSession | null {
    for (const [projectId, project] of Object.entries(config.projects)) {
      const sessionsDir = getProjectSessionsDir(project);
      const raw = readMetadataRaw(sessionsDir, sessionId);
      if (!raw) continue;
      return { raw, sessionsDir, project, projectId };
    }

    return null;
  }

  function requireSessionRecord(sessionId: SessionId): LocatedSession {
    const located = findSessionRecord(sessionId);
    if (!located) {
      throw new SessionNotFoundError(sessionId);
    }
    return located;
  }

  /**
   * Ensure session has a runtime handle (fabricate one if missing) and enrich
   * with live runtime state + activity detection. Used by both list() and get().
   */
  async function ensureHandleAndEnrich(
    session: Session,
    sessionName: string,
    sessionsDir: string,
    project: ProjectConfig,
    effectiveAgentName: string,
    plugins: ReturnType<typeof resolvePlugins>,
    sessionListPromise?: Promise<OpenCodeSessionListEntry[]>,
  ): Promise<void> {
    await ensureOpenCodeSessionMapping(
      session,
      sessionName,
      sessionsDir,
      effectiveAgentName,
      sessionListPromise,
    );

    const handleFromMetadata = session.runtimeHandle !== null;
    if (!handleFromMetadata) {
      session.runtimeHandle = {
        id: sessionName,
        runtimeName: project.runtime ?? config.defaults.runtime,
        data: {},
      };
    }
    await enrichSessionWithRuntimeState(session, plugins, handleFromMetadata);
  }

  /**
   * Enrich session with live runtime state (alive/exited) and activity detection.
   * Mutates the session object in place.
   */
  const TERMINAL_SESSION_STATUSES = new Set(["killed", "done", "merged", "terminated", "cleanup"]);

  async function enrichSessionWithRuntimeState(
    session: Session,
    plugins: ReturnType<typeof resolvePlugins>,
    handleFromMetadata: boolean,
  ): Promise<void> {
    // Skip all subprocess/IO work for sessions already known to be terminal.
    if (TERMINAL_SESSION_STATUSES.has(session.status)) {
      session.activity = "exited";
      return;
    }

    // Check runtime liveness — but only if the handle came from metadata.
    // Fabricated handles (constructed as fallback for external sessions) should
    // NOT override status to "killed" — we don't know if the session ever had
    // a tmux session, and we'd clobber meaningful statuses like "pr_open".
    if (handleFromMetadata && session.runtimeHandle && plugins.runtime) {
      try {
        const alive = await plugins.runtime.isAlive(session.runtimeHandle);
        if (!alive) {
          session.status = "killed";
          session.activity = "exited";
          return;
        }
      } catch {
        // Can't check liveness — continue to activity detection
      }
    }

    // Detect activity independently of runtime handle.
    // Activity detection reads JSONL files on disk — it only needs workspacePath,
    // not a runtime handle. Gating on runtimeHandle caused sessions created by
    // external scripts (which don't store runtimeHandle) to always show "unknown".
    if (plugins.agent) {
      try {
        const detected = await plugins.agent.getActivityState(session, config.readyThresholdMs);
        if (detected !== null) {
          session.activity = detected.state;
          if (detected.timestamp && detected.timestamp > session.lastActivityAt) {
            session.lastActivityAt = detected.timestamp;
          }
        }
      } catch {
        // Can't detect activity — keep existing value
      }

      // Enrich with live agent session info (summary, cost).
      try {
        const info = await plugins.agent.getSessionInfo(session);
        if (info) {
          session.agentInfo = info;
        }
      } catch {
        // Can't get session info — keep existing values
      }
    }
  }

  // Define methods as local functions so `this` is not needed
  async function spawn(spawnConfig: SessionSpawnConfig): Promise<Session> {
    const project = config.projects[spawnConfig.projectId];
    if (!project) {
      throw new Error(`Unknown project: ${spawnConfig.projectId}`);
    }

    const plugins = resolvePlugins(project);
    if (!plugins.runtime) {
      throw new Error(`Runtime plugin '${project.runtime ?? config.defaults.runtime}' not found`);
    }

    // Allow --agent override to swap the agent plugin for this session
    if (spawnConfig.agent) {
      const overrideAgent = registry.get<Agent>("agent", spawnConfig.agent);
      if (!overrideAgent) {
        throw new Error(`Agent plugin '${spawnConfig.agent}' not found`);
      }
      plugins.agent = overrideAgent;
    }

    if (!plugins.agent) {
      throw new Error(`Agent plugin '${project.agent ?? config.defaults.agent}' not found`);
    }

    // Validate issue exists BEFORE creating any resources
    let resolvedIssue: Issue | undefined;
    if (spawnConfig.issueId && plugins.tracker) {
      try {
        // Fetch and validate the issue exists
        resolvedIssue = await plugins.tracker.getIssue(spawnConfig.issueId, project);
      } catch (err) {
        // Issue fetch failed - determine why
        if (isIssueNotFoundError(err)) {
          // Ad-hoc issue string — proceed without tracker context.
          // Branch will be generated as feat/{issueId} (line 329-331)
        } else {
          // Other error (auth, network, etc) - fail fast
          throw new Error(`Failed to fetch issue ${spawnConfig.issueId}: ${err}`, { cause: err });
        }
      }
    }

    // Get the sessions directory for this project
    const sessionsDir = getProjectSessionsDir(project);

    // Validate and store .origin file (new architecture only)
    if (config.configPath) {
      validateAndStoreOrigin(config.configPath, project.path);
    }

    // Determine session ID — atomically reserve to prevent concurrent collisions
    const existingSessions = listMetadata(sessionsDir);
    let num = getNextSessionNumber(existingSessions, project.sessionPrefix);
    let sessionId: string;
    let tmuxName: string | undefined;
    for (let attempts = 0; attempts < 10; attempts++) {
      sessionId = `${project.sessionPrefix}-${num}`;
      // Generate tmux name if using new architecture
      if (config.configPath) {
        tmuxName = generateTmuxName(config.configPath, project.sessionPrefix, num);
      }
      if (reserveSessionId(sessionsDir, sessionId)) break;
      num++;
      if (attempts === 9) {
        throw new Error(
          `Failed to reserve session ID after 10 attempts (prefix: ${project.sessionPrefix})`,
        );
      }
    }
    // Reassign to satisfy TypeScript's flow analysis (not redundant from compiler's perspective)
    sessionId = `${project.sessionPrefix}-${num}`;
    if (config.configPath) {
      tmuxName = generateTmuxName(config.configPath, project.sessionPrefix, num);
    }

    // Determine branch name — explicit branch always takes priority
    let branch: string;
    if (spawnConfig.branch) {
      branch = spawnConfig.branch;
    } else if (spawnConfig.issueId && plugins.tracker && resolvedIssue) {
      branch = plugins.tracker.branchName(spawnConfig.issueId, project);
    } else if (spawnConfig.issueId) {
      // If the issueId is already branch-safe (e.g. "INT-9999"), use as-is.
      // Otherwise sanitize free-text (e.g. "fix login bug") into a valid slug.
      const id = spawnConfig.issueId;
      const isBranchSafe = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes("..");
      const slug = isBranchSafe
        ? id
        : id
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .slice(0, 60)
            .replace(/^-+|-+$/g, "");
      branch = `feat/${slug || sessionId}`;
    } else {
      branch = `session/${sessionId}`;
    }

    // Create workspace (if workspace plugin is available)
    let workspacePath = project.path;
    if (plugins.workspace) {
      try {
        const wsInfo = await plugins.workspace.create({
          projectId: spawnConfig.projectId,
          project,
          sessionId,
          branch,
        });
        workspacePath = wsInfo.path;

        // Run post-create hooks — clean up workspace on failure
        if (plugins.workspace.postCreate) {
          try {
            await plugins.workspace.postCreate(wsInfo, project);
          } catch (err) {
            if (shouldDestroyWorkspacePath(project, spawnConfig.projectId, workspacePath)) {
              try {
                await plugins.workspace.destroy(workspacePath);
              } catch {
                /* best effort */
              }
            }
            throw err;
          }
        }
      } catch (err) {
        // Clean up reserved session ID on workspace failure
        try {
          deleteMetadata(sessionsDir, sessionId, false);
        } catch {
          /* best effort */
        }
        throw err;
      }
    }

    // Generate prompt with validated issue
    let issueContext: string | undefined;
    if (spawnConfig.issueId && plugins.tracker && resolvedIssue) {
      try {
        issueContext = await plugins.tracker.generatePrompt(spawnConfig.issueId, project);
      } catch {
        // Non-fatal: continue without detailed issue context
        // Silently ignore errors - caller can check if issueContext is undefined
      }
    }

    const composedPrompt = buildPrompt({
      project,
      projectId: spawnConfig.projectId,
      issueId: spawnConfig.issueId,
      issueContext,
      userPrompt: spawnConfig.prompt,
    });

    // Get agent launch config and create runtime — clean up workspace on failure
    const opencodeIssueSessionStrategy = project.opencodeIssueSessionStrategy ?? "reuse";
    const reusedOpenCodeSessionId =
      plugins.agent.name === "opencode" && spawnConfig.issueId
        ? await resolveOpenCodeSessionReuse({
            sessionsDir,
            criteria: { issueId: spawnConfig.issueId },
            strategy: opencodeIssueSessionStrategy,
          })
        : undefined;
    const configuredSubagent =
      typeof project.agentConfig?.["subagent"] === "string"
        ? project.agentConfig["subagent"]
        : undefined;

    const agentLaunchConfig = {
      sessionId,
      projectConfig: {
        ...project,
        agentConfig: {
          ...(project.agentConfig ?? {}),
          ...(reusedOpenCodeSessionId ? { opencodeSessionId: reusedOpenCodeSessionId } : {}),
        },
      },
      issueId: spawnConfig.issueId,
      prompt: composedPrompt,
      permissions: project.agentConfig?.permissions,
      model: project.agentConfig?.model,
      subagent: spawnConfig.subagent ?? configuredSubagent,
    };

    let handle: RuntimeHandle;
    try {
      const launchCommand = plugins.agent.getLaunchCommand(agentLaunchConfig);
      const environment = plugins.agent.getEnvironment(agentLaunchConfig);

      handle = await plugins.runtime.create({
        sessionId: tmuxName ?? sessionId, // Use tmux name for runtime if available
        workspacePath,
        launchCommand,
        environment: {
          ...environment,
          AO_SESSION: sessionId,
          AO_DATA_DIR: sessionsDir, // Pass sessions directory (not root dataDir)
          AO_SESSION_NAME: sessionId, // User-facing session name
          ...(tmuxName && { AO_TMUX_NAME: tmuxName }), // Tmux session name if using new arch
        },
      });
    } catch (err) {
      // Clean up workspace and reserved ID if agent config or runtime creation failed
      if (
        plugins.workspace &&
        shouldDestroyWorkspacePath(project, spawnConfig.projectId, workspacePath)
      ) {
        try {
          await plugins.workspace.destroy(workspacePath);
        } catch {
          /* best effort */
        }
      }
      try {
        deleteMetadata(sessionsDir, sessionId, false);
      } catch {
        /* best effort */
      }
      throw err;
    }

    // Write metadata and run post-launch setup — clean up on failure
    const session: Session = {
      id: sessionId,
      projectId: spawnConfig.projectId,
      status: "spawning",
      activity: "active",
      branch,
      issueId: spawnConfig.issueId ?? null,
      pr: null,
      workspacePath,
      runtimeHandle: handle,
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {
        ...(reusedOpenCodeSessionId ? { opencodeSessionId: reusedOpenCodeSessionId } : {}),
      },
    };

    try {
      writeMetadata(sessionsDir, sessionId, {
        worktree: workspacePath,
        branch,
        status: "spawning",
        tmuxName, // Store tmux name for mapping
        issue: spawnConfig.issueId,
        project: spawnConfig.projectId,
        agent: plugins.agent.name, // Persist agent name for lifecycle manager
        createdAt: new Date().toISOString(),
        runtimeHandle: JSON.stringify(handle),
        opencodeSessionId: reusedOpenCodeSessionId,
      });

      if (plugins.agent.postLaunchSetup) {
        await plugins.agent.postLaunchSetup(session);
      }

      if (
        plugins.agent.name === "opencode" &&
        opencodeIssueSessionStrategy === "reuse" &&
        !session.metadata["opencodeSessionId"]
      ) {
        const discovered = await discoverOpenCodeSessionIdByTitle(
          sessionId,
          OPENCODE_INTERACTIVE_DISCOVERY_TIMEOUT_MS,
        );
        if (discovered) {
          session.metadata["opencodeSessionId"] = discovered;
        }
      }

      if (Object.keys(session.metadata || {}).length > 0) {
        updateMetadata(sessionsDir, sessionId, session.metadata);
      }
    } catch (err) {
      // Clean up runtime and workspace on post-launch failure
      try {
        await plugins.runtime.destroy(handle);
      } catch {
        /* best effort */
      }
      if (
        plugins.workspace &&
        shouldDestroyWorkspacePath(project, spawnConfig.projectId, workspacePath)
      ) {
        try {
          await plugins.workspace.destroy(workspacePath);
        } catch {
          /* best effort */
        }
      }
      try {
        deleteMetadata(sessionsDir, sessionId, false);
      } catch {
        /* best effort */
      }
      throw err;
    }

    // Send initial prompt post-launch for agents that need it (e.g. Claude Code
    // exits after -p, so we send the prompt after it starts in interactive mode).
    // This is intentionally outside the try/catch above — a prompt delivery failure
    // should NOT destroy the session. The agent is running; user can retry with `ao send`.
    if (plugins.agent.promptDelivery === "post-launch" && agentLaunchConfig.prompt) {
      try {
        // Wait for agent to start and be ready for input
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        await plugins.runtime.sendMessage(handle, agentLaunchConfig.prompt);
      } catch {
        // Non-fatal: agent is running but didn't receive the initial prompt.
        // User can retry with `ao send`.
      }
    }

    return session;
  }

  async function spawnOrchestrator(orchestratorConfig: OrchestratorSpawnConfig): Promise<Session> {
    const project = config.projects[orchestratorConfig.projectId];
    if (!project) {
      throw new Error(`Unknown project: ${orchestratorConfig.projectId}`);
    }

    const plugins = resolvePlugins(project);
    if (!plugins.runtime) {
      throw new Error(`Runtime plugin '${project.runtime ?? config.defaults.runtime}' not found`);
    }
    if (!plugins.agent) {
      throw new Error(`Agent plugin '${project.agent ?? config.defaults.agent}' not found`);
    }

    const sessionId = `${project.sessionPrefix}-orchestrator`;
    const orchestratorSessionStrategy = normalizeOrchestratorSessionStrategy(
      project.orchestratorSessionStrategy,
    );

    // Generate tmux name if using new architecture
    let tmuxName: string | undefined;
    if (config.configPath) {
      const hash = generateConfigHash(config.configPath);
      tmuxName = `${hash}-${sessionId}`;
    }

    // Get the sessions directory for this project
    const sessionsDir = getProjectSessionsDir(project);

    // Validate and store .origin file
    if (config.configPath) {
      validateAndStoreOrigin(config.configPath, project.path);
    }

    // Setup agent hooks for automatic metadata updates
    if (plugins.agent.setupWorkspaceHooks) {
      await plugins.agent.setupWorkspaceHooks(project.path, { dataDir: sessionsDir });
    }

    // Write system prompt to a file to avoid shell/tmux truncation.
    // Long prompts (2000+ chars) get mangled when inlined in shell commands
    // via tmux send-keys or paste-buffer. File-based approach is reliable.
    let systemPromptFile: string | undefined;
    if (orchestratorConfig.systemPrompt) {
      const baseDir = getProjectBaseDir(config.configPath, project.path);
      mkdirSync(baseDir, { recursive: true });
      systemPromptFile = join(baseDir, "orchestrator-prompt.md");
      writeFileSync(systemPromptFile, orchestratorConfig.systemPrompt, "utf-8");
    }

    const existingOrchestrator = await get(sessionId);
    if (existingOrchestrator?.runtimeHandle) {
      const existingAlive = await plugins.runtime
        .isAlive(existingOrchestrator.runtimeHandle)
        .catch(() => false);
      if (existingAlive && orchestratorSessionStrategy === "reuse") {
        existingOrchestrator.metadata["orchestratorSessionReused"] = "true";
        return existingOrchestrator;
      }
      if (existingAlive && orchestratorSessionStrategy !== "reuse") {
        await plugins.runtime.destroy(existingOrchestrator.runtimeHandle).catch(() => undefined);
      }
    }

    const reusableOpenCodeSessionId =
      plugins.agent.name === "opencode" && orchestratorSessionStrategy === "reuse"
        ? await resolveOpenCodeSessionReuse({
            sessionsDir,
            criteria: { sessionId },
            strategy: "reuse",
          })
        : undefined;
    const configuredSubagent =
      typeof project.agentConfig?.["subagent"] === "string"
        ? project.agentConfig["subagent"]
        : undefined;

    if (plugins.agent.name === "opencode" && orchestratorSessionStrategy === "delete") {
      await resolveOpenCodeSessionReuse({
        sessionsDir,
        criteria: { sessionId },
        strategy: "delete",
        includeTitleDiscoveryForSessionId: true,
      });
    }

    // Get agent launch config — uses systemPromptFile, no issue/tracker interaction.
    // Orchestrator ALWAYS gets permissionless mode — it must run ao CLI commands autonomously.
    const agentLaunchConfig = {
      sessionId,
      projectConfig: {
        ...project,
        agentConfig: {
          ...(project.agentConfig ?? {}),
          ...(reusableOpenCodeSessionId ? { opencodeSessionId: reusableOpenCodeSessionId } : {}),
        },
      },
      permissions: "permissionless" as const,
      model: project.agentConfig?.orchestratorModel ?? project.agentConfig?.model,
      systemPromptFile,
      subagent: configuredSubagent,
    };

    const launchCommand = plugins.agent.getLaunchCommand(agentLaunchConfig);
    const environment = plugins.agent.getEnvironment(agentLaunchConfig);

    const handle = await plugins.runtime.create({
      sessionId: tmuxName ?? sessionId,
      workspacePath: project.path,
      launchCommand,
      environment: {
        ...environment,
        AO_SESSION: sessionId,
        AO_DATA_DIR: sessionsDir,
        AO_SESSION_NAME: sessionId,
        ...(tmuxName && { AO_TMUX_NAME: tmuxName }),
      },
    });

    // Write metadata and run post-launch setup
    const session: Session = {
      id: sessionId,
      projectId: orchestratorConfig.projectId,
      status: "working",
      activity: "active",
      branch: project.defaultBranch,
      issueId: null,
      pr: null,
      workspacePath: project.path,
      runtimeHandle: handle,
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {
        ...(reusableOpenCodeSessionId ? { opencodeSessionId: reusableOpenCodeSessionId } : {}),
      },
    };

    try {
      writeMetadata(sessionsDir, sessionId, {
        worktree: project.path,
        branch: project.defaultBranch,
        status: "working",
        role: "orchestrator",
        tmuxName,
        project: orchestratorConfig.projectId,
        agent: plugins.agent.name,
        createdAt: new Date().toISOString(),
        runtimeHandle: JSON.stringify(handle),
        opencodeSessionId: reusableOpenCodeSessionId,
      });

      if (plugins.agent.postLaunchSetup) {
        await plugins.agent.postLaunchSetup(session);
      }

      if (
        plugins.agent.name === "opencode" &&
        orchestratorSessionStrategy === "reuse" &&
        !session.metadata["opencodeSessionId"]
      ) {
        const discovered = await discoverOpenCodeSessionIdByTitle(
          sessionId,
          OPENCODE_INTERACTIVE_DISCOVERY_TIMEOUT_MS,
        );
        if (discovered) {
          session.metadata["opencodeSessionId"] = discovered;
        }
      }

      if (Object.keys(session.metadata || {}).length > 0) {
        updateMetadata(sessionsDir, sessionId, session.metadata);
      }
    } catch (err) {
      // Clean up runtime on post-launch failure
      try {
        await plugins.runtime.destroy(handle);
      } catch {
        /* best effort */
      }
      try {
        deleteMetadata(sessionsDir, sessionId, false);
      } catch {
        /* best effort */
      }
      throw err;
    }

    return session;
  }

  async function list(projectId?: string): Promise<Session[]> {
    const allSessions = listAllSessions(projectId);
    let openCodeSessionListPromise: Promise<OpenCodeSessionListEntry[]> | undefined;

    const tasks = allSessions.map(async ({ sessionName, projectId: sessionProjectId }) => {
      const project = config.projects[sessionProjectId];
      if (!project) return null;

      const sessionsDir = getProjectSessionsDir(project);
      const raw = readMetadataRaw(sessionsDir, sessionName);
      if (!raw) return null;

      let createdAt: Date | undefined;
      let modifiedAt: Date | undefined;
      try {
        const metaPath = join(sessionsDir, sessionName);
        const stats = statSync(metaPath);
        createdAt = stats.birthtime;
        modifiedAt = stats.mtime;
      } catch {
        // If stat fails, timestamps will fall back to current time
      }

      const session = metadataToSession(sessionName, raw, createdAt, modifiedAt);
      const selectedAgentName = raw["agent"];
      const effectiveAgentName = selectedAgentName ?? project.agent ?? config.defaults.agent;
      const plugins = resolvePlugins(project, effectiveAgentName);
      const sessionListPromise =
        effectiveAgentName === "opencode"
          ? (openCodeSessionListPromise ??= fetchOpenCodeSessionList())
          : undefined;

      let enrichTimeoutId: ReturnType<typeof setTimeout> | null = null;
      const enrichTimeout = new Promise<void>((resolve) => {
        enrichTimeoutId = setTimeout(resolve, 2_000);
      });
      const enrichPromise = ensureHandleAndEnrich(
        session,
        sessionName,
        sessionsDir,
        project,
        effectiveAgentName,
        plugins,
        sessionListPromise,
      ).catch(() => {});
      try {
        await Promise.race([enrichPromise, enrichTimeout]);
      } finally {
        if (enrichTimeoutId) {
          clearTimeout(enrichTimeoutId);
        }
      }

      return session;
    });

    const resolved = await Promise.all(tasks);
    return resolved.filter((session): session is Session => session !== null);
  }

  async function get(sessionId: SessionId): Promise<Session | null> {
    // Try to find the session in any project's sessions directory
    for (const project of Object.values(config.projects)) {
      const sessionsDir = getProjectSessionsDir(project);
      const raw = readMetadataRaw(sessionsDir, sessionId);
      if (!raw) continue;

      // Get file timestamps for createdAt/lastActivityAt
      let createdAt: Date | undefined;
      let modifiedAt: Date | undefined;
      try {
        const metaPath = join(sessionsDir, sessionId);
        const stats = statSync(metaPath);
        createdAt = stats.birthtime;
        modifiedAt = stats.mtime;
      } catch {
        // If stat fails, timestamps will fall back to current time
      }

      const session = metadataToSession(sessionId, raw, createdAt, modifiedAt);

      const selectedAgentName = raw["agent"];
      const effectiveAgentName = selectedAgentName ?? project.agent ?? config.defaults.agent;
      const plugins = resolvePlugins(project, effectiveAgentName);
      await ensureHandleAndEnrich(
        session,
        sessionId,
        sessionsDir,
        project,
        effectiveAgentName,
        plugins,
      );

      return session;
    }

    return null;
  }

  async function kill(sessionId: SessionId, options?: SessionKillOptions): Promise<void> {
    const { raw, sessionsDir, project, projectId } = requireSessionRecord(sessionId);

    const cleanupAgent = raw["agent"] ?? project.agent ?? config.defaults.agent;
    const plugins = resolvePlugins(project, cleanupAgent);
    const worktree = raw["worktree"];
    const branch = raw["branch"];
    const runtimeHandleRaw = raw["runtimeHandle"];
    const runtimeHandle = runtimeHandleRaw ? safeJsonParse<RuntimeHandle>(runtimeHandleRaw) : null;
    const managedWorktree =
      typeof worktree === "string" && shouldDestroyWorkspacePath(project, projectId, worktree);
    const usesGitWorktreeCleanup =
      (plugins.workspace?.name ?? project.workspace ?? config.defaults.workspace) === "worktree";
    const failures: string[] = [];

    const reportStep = (result: SessionKillStepResult): void => {
      emitKillStep(options, result);
      if (result.status === "failed") {
        failures.push(`${result.step}: ${result.message}`);
      }
    };

    let sessionProcesses: ProcessSnapshot[] = [];
    let processDiscoveryError: string | null = null;
    if (runtimeHandle) {
      try {
        sessionProcesses = await captureSessionProcessTree(runtimeHandle);
      } catch (err: unknown) {
        processDiscoveryError = formatError(err);
      }
    }

    if (runtimeHandleRaw && !runtimeHandle) {
      reportStep({
        step: "runtime",
        status: "failed",
        message: "Invalid runtime handle metadata",
      });
    } else if (!runtimeHandle) {
      reportStep({
        step: "runtime",
        status: "skipped",
        message: "No runtime handle recorded",
      });
    } else {
      const runtimeName = runtimeHandle.runtimeName || project.runtime || config.defaults.runtime;
      const runtimePlugin = registry.get<Runtime>("runtime", runtimeName);
      let runtimeCleanupError: string | null = null;

      if (runtimePlugin) {
        try {
          await runtimePlugin.destroy(runtimeHandle);
        } catch (err: unknown) {
          runtimeCleanupError = formatError(err);
        }
      } else if (runtimeHandle.runtimeName !== "tmux") {
        runtimeCleanupError = `Runtime plugin '${runtimeName}' not found`;
      }

      if (runtimeHandle.runtimeName === "tmux") {
        let usedFallbackKill = false;
        if (await hasTmuxSession(runtimeHandle.id)) {
          try {
            await execFileAsync("tmux", ["kill-session", "-t", runtimeHandle.id], {
              timeout: TMUX_KILL_TIMEOUT_MS,
            });
            usedFallbackKill = true;
          } catch (err: unknown) {
            const fallbackError = formatError(err);
            runtimeCleanupError = runtimeCleanupError
              ? `${runtimeCleanupError}; fallback tmux kill failed: ${fallbackError}`
              : fallbackError;
          }
        }

        if (await hasTmuxSession(runtimeHandle.id)) {
          reportStep({
            step: "runtime",
            status: "failed",
            message: runtimeCleanupError
              ? `Failed to kill tmux session ${runtimeHandle.id}: ${runtimeCleanupError}`
              : `tmux session ${runtimeHandle.id} is still running`,
          });
        } else {
          const extra = runtimeCleanupError
            ? ` (runtime plugin reported: ${runtimeCleanupError})`
            : usedFallbackKill
              ? " (forced via direct tmux kill-session)"
              : "";
          reportStep({
            step: "runtime",
            status: "success",
            message: `Killed tmux session ${runtimeHandle.id}${extra}`,
          });
        }
      } else if (runtimeHandle.runtimeName === "process") {
        const pid = parsePid(runtimeHandle.data["pid"]);
        const alive = pid !== null ? await isPidAlive(pid) : false;
        if (alive) {
          reportStep({
            step: "runtime",
            status: "failed",
            message: runtimeCleanupError
              ? `Failed to stop process runtime ${runtimeHandle.id}: ${runtimeCleanupError}`
              : `process ${pid} is still running`,
          });
        } else {
          const extra = runtimeCleanupError
            ? ` (runtime plugin reported: ${runtimeCleanupError})`
            : "";
          reportStep({
            step: "runtime",
            status: "success",
            message: `Stopped process runtime ${runtimeHandle.id}${extra}`,
          });
        }
      } else if (runtimeCleanupError) {
        reportStep({
          step: "runtime",
          status: "failed",
          message: `Failed to stop ${runtimeName} runtime ${runtimeHandle.id}: ${runtimeCleanupError}`,
        });
      } else {
        reportStep({
          step: "runtime",
          status: "success",
          message: `Stopped ${runtimeName} runtime ${runtimeHandle.id}`,
        });
      }
    }

    if (!runtimeHandle) {
      reportStep({
        step: "agent",
        status: "skipped",
        message: "No runtime handle available for process cleanup",
      });
    } else if (processDiscoveryError) {
      reportStep({
        step: "agent",
        status: "failed",
        message: `Could not discover session process tree: ${processDiscoveryError}`,
      });
    } else {
      try {
        const result = await terminateProcesses(sessionProcesses);
        if (result.survivors.length > 0) {
          reportStep({
            step: "agent",
            status: "failed",
            message: `Processes still alive after SIGKILL: ${result.survivors.join(", ")}`,
          });
        } else if (result.total === 0) {
          reportStep({
            step: "agent",
            status: "success",
            message: "Session process tree already stopped",
          });
        } else {
          const forcedDetail =
            result.forceKilled > 0
              ? `; escalated to SIGKILL for ${result.forceKilled} process${result.forceKilled === 1 ? "" : "es"}`
              : "";
          reportStep({
            step: "agent",
            status: "success",
            message: `Stopped session process tree (${result.total} process${result.total === 1 ? "" : "es"}${forcedDetail})`,
          });
        }
      } catch (err: unknown) {
        reportStep({
          step: "agent",
          status: "failed",
          message: `Failed to stop session process tree: ${formatError(err)}`,
        });
      }
    }

    if (worktree && managedWorktree) {
      let workspaceCleanupError: string | null = null;
      if (plugins.workspace) {
        try {
          await plugins.workspace.destroy(worktree);
        } catch (err: unknown) {
          workspaceCleanupError = formatError(err);
        }
      } else if (!usesGitWorktreeCleanup) {
        workspaceCleanupError = "Workspace plugin not found";
      }

      if (!usesGitWorktreeCleanup) {
        reportStep({
          step: "worktree",
          status: workspaceCleanupError ? "failed" : "success",
          message: workspaceCleanupError
            ? `Failed to remove workspace ${worktree}: ${workspaceCleanupError}`
            : `Removed workspace ${worktree}`,
        });
      } else {
        try {
          await forceRemoveGitWorktree(project.path, worktree);
          reportStep({
            step: "worktree",
            status: "success",
            message: workspaceCleanupError
              ? `Removed worktree ${worktree} (workspace plugin reported: ${workspaceCleanupError})`
              : `Removed worktree ${worktree}`,
          });
        } catch (err: unknown) {
          const detail = [
            formatError(err),
            workspaceCleanupError ? `workspace plugin reported: ${workspaceCleanupError}` : null,
          ]
            .filter(Boolean)
            .join("; ");
          reportStep({
            step: "worktree",
            status: "failed",
            message: `Failed to remove worktree ${worktree}: ${detail}`,
          });
        }
      }
    } else if (worktree) {
      reportStep({
        step: "worktree",
        status: "skipped",
        message: `Skipped unmanaged workspace ${worktree}`,
      });
    } else {
      reportStep({
        step: "worktree",
        status: "skipped",
        message: "No workspace recorded",
      });
    }

    if (!branch) {
      reportStep({
        step: "branch",
        status: "skipped",
        message: "No branch recorded",
      });
    } else if (branch === project.defaultBranch) {
      reportStep({
        step: "branch",
        status: "skipped",
        message: `Skipped default branch ${branch}`,
      });
    } else if (!managedWorktree || !usesGitWorktreeCleanup) {
      reportStep({
        step: "branch",
        status: "skipped",
        message: usesGitWorktreeCleanup
          ? `Skipped local branch cleanup for unmanaged workspace ${worktree ?? "(unknown)"}`
          : `Skipped local branch cleanup for non-worktree session ${sessionId}`,
      });
    } else {
      try {
        const branchResult = await deleteLocalBranch(project.path, branch);
        reportStep({
          step: "branch",
          status: "success",
          message:
            branchResult === "deleted"
              ? `Deleted local branch ${branch}`
              : `Local branch ${branch} already absent`,
        });
      } catch (err: unknown) {
        reportStep({
          step: "branch",
          status: "failed",
          message: `Failed to delete local branch ${branch}: ${formatError(err)}`,
        });
      }
    }

    let didPurgeOpenCodeSession = false;
    if (options?.purgeOpenCode === true && cleanupAgent === "opencode") {
      const mappedOpenCodeSessionId =
        asValidOpenCodeSessionId(raw["opencodeSessionId"]) ??
        (await discoverOpenCodeSessionIdByTitle(
          sessionId,
          OPENCODE_INTERACTIVE_DISCOVERY_TIMEOUT_MS,
        ));

      if (mappedOpenCodeSessionId) {
        try {
          await deleteOpenCodeSession(mappedOpenCodeSessionId);
          didPurgeOpenCodeSession = true;
          reportStep({
            step: "opencode",
            status: "success",
            message: `Deleted OpenCode session ${mappedOpenCodeSessionId}`,
          });
        } catch (err: unknown) {
          reportStep({
            step: "opencode",
            status: "failed",
            message: `Failed to delete OpenCode session ${mappedOpenCodeSessionId}: ${formatError(err)}`,
          });
        }
      } else {
        reportStep({
          step: "opencode",
          status: "skipped",
          message: "No OpenCode session mapping found",
        });
      }
    }

    try {
      deleteMetadata(sessionsDir, sessionId, true);
      if (didPurgeOpenCodeSession) {
        markArchivedOpenCodeCleanup(sessionsDir, sessionId);
      }
      reportStep({
        step: "metadata",
        status: "success",
        message: `Archived metadata for ${sessionId}`,
      });
    } catch (err: unknown) {
      reportStep({
        step: "metadata",
        status: "failed",
        message: `Failed to archive metadata for ${sessionId}: ${formatError(err)}`,
      });
    }

    if (failures.length > 0) {
      throw new Error(
        `Session ${sessionId} cleanup completed with ${failures.length} failure${failures.length === 1 ? "" : "s"}: ${failures.join("; ")}`,
      );
    }
  }

  async function cleanup(
    projectId?: string,
    options?: { dryRun?: boolean; purgeOpenCode?: boolean },
  ): Promise<CleanupResult> {
    const result: CleanupResult = { killed: [], skipped: [], errors: [] };
    const sessions = await list(projectId);
    const activeSessionKeys = new Set(
      sessions.map((session) => `${session.projectId}:${session.id}`),
    );

    const killedKeys = new Set<string>();
    const skippedKeys = new Set<string>();

    const toEntryKey = (entryProjectId: string, id: string): string => `${entryProjectId}:${id}`;
    const fromEntryKey = (entryKey: string): { projectId: string; id: string } => {
      const separatorIndex = entryKey.indexOf(":");
      if (separatorIndex === -1) {
        return { projectId: "", id: entryKey };
      }
      return {
        projectId: entryKey.slice(0, separatorIndex),
        id: entryKey.slice(separatorIndex + 1),
      };
    };

    const pushKilled = (entryProjectId: string, id: string): void => {
      const key = toEntryKey(entryProjectId, id);
      skippedKeys.delete(key);
      killedKeys.add(key);
    };

    const pushSkipped = (entryProjectId: string, id: string): void => {
      const key = toEntryKey(entryProjectId, id);
      if (killedKeys.has(key)) return;
      skippedKeys.add(key);
    };

    const shouldPurgeOpenCode = options?.purgeOpenCode !== false;

    for (const session of sessions) {
      try {
        // Never clean up orchestrator sessions — they manage the lifecycle.
        // Check explicit role metadata first, fall back to naming convention
        // for pre-existing sessions spawned before the role field was added.
        if (session.metadata["role"] === "orchestrator" || session.id.endsWith("-orchestrator")) {
          pushSkipped(session.projectId, session.id);
          continue;
        }

        const project = config.projects[session.projectId];
        if (!project) {
          pushSkipped(session.projectId, session.id);
          continue;
        }

        const plugins = resolvePlugins(project);
        let shouldKill = false;

        // Check if PR is merged
        if (session.pr && plugins.scm) {
          try {
            const prState = await plugins.scm.getPRState(session.pr);
            if (prState === PR_STATE.MERGED || prState === PR_STATE.CLOSED) {
              shouldKill = true;
            }
          } catch {
            // Can't check PR — skip
          }
        }

        // Check if issue is completed
        if (!shouldKill && session.issueId && plugins.tracker) {
          try {
            const completed = await plugins.tracker.isCompleted(session.issueId, project);
            if (completed) shouldKill = true;
          } catch {
            // Can't check issue — skip
          }
        }

        // Check if runtime is dead
        if (!shouldKill && session.runtimeHandle && plugins.runtime) {
          try {
            const alive = await plugins.runtime.isAlive(session.runtimeHandle);
            if (!alive) shouldKill = true;
          } catch {
            // Can't check — skip
          }
        }

        if (shouldKill) {
          if (!options?.dryRun) {
            await kill(session.id, { purgeOpenCode: shouldPurgeOpenCode });
          }
          pushKilled(session.projectId, session.id);
        } else {
          pushSkipped(session.projectId, session.id);
        }
      } catch (err) {
        result.errors.push({
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    for (const [projectKey, project] of Object.entries(config.projects)) {
      if (projectId && projectKey !== projectId) continue;

      const sessionsDir = getProjectSessionsDir(project);
      for (const archivedId of listArchivedSessionIds(sessionsDir)) {
        if (activeSessionKeys.has(`${projectKey}:${archivedId}`)) continue;

        const archived = readArchivedMetadataRaw(sessionsDir, archivedId);
        if (!archived) continue;

        if (archived["role"] === "orchestrator" || archivedId.endsWith("-orchestrator")) {
          pushSkipped(projectKey, archivedId);
          continue;
        }

        const cleanupAgent = archived["agent"] ?? project.agent ?? config.defaults.agent;
        const mappedOpenCodeSessionId = asValidOpenCodeSessionId(archived["opencodeSessionId"]);
        if (cleanupAgent === "opencode" && archived["opencodeCleanedAt"]) {
          pushSkipped(projectKey, archivedId);
          continue;
        }
        if (cleanupAgent === "opencode" && mappedOpenCodeSessionId && shouldPurgeOpenCode) {
          if (!options?.dryRun) {
            try {
              await deleteOpenCodeSession(mappedOpenCodeSessionId);
              markArchivedOpenCodeCleanup(sessionsDir, archivedId);
            } catch (err) {
              result.errors.push({
                sessionId: archivedId,
                error: `Failed to delete OpenCode session ${mappedOpenCodeSessionId}: ${err instanceof Error ? err.message : String(err)}`,
              });
              continue;
            }
          }
          pushKilled(projectKey, archivedId);
        } else {
          pushSkipped(projectKey, archivedId);
        }
      }
    }

    const allEntryKeys = [...killedKeys, ...skippedKeys];
    const idCounts = new Map<string, number>();
    for (const entryKey of allEntryKeys) {
      const { id } = fromEntryKey(entryKey);
      idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    }

    const formatEntry = (entryKey: string): string => {
      const { projectId: entryProjectId, id } = fromEntryKey(entryKey);
      return (idCounts.get(id) ?? 0) > 1 ? `${entryProjectId}:${id}` : id;
    };

    result.killed = [...killedKeys].map(formatEntry);
    result.skipped = [...skippedKeys].map(formatEntry);

    return result;
  }

  async function send(sessionId: SessionId, message: string): Promise<void> {
    const { raw, sessionsDir, project } = requireSessionRecord(sessionId);
    const persistedStatus = validateStatus(raw["status"]);
    const selectedAgent = raw["agent"] ?? project.agent ?? config.defaults.agent;
    if (selectedAgent === "opencode" && !asValidOpenCodeSessionId(raw["opencodeSessionId"])) {
      const discovered = await discoverOpenCodeSessionIdByTitle(
        sessionId,
        OPENCODE_INTERACTIVE_DISCOVERY_TIMEOUT_MS,
      );
      if (discovered) {
        raw["opencodeSessionId"] = discovered;
        updateMetadata(sessionsDir, sessionId, { opencodeSessionId: discovered });
      }
    }
    const parsedHandle = raw["runtimeHandle"]
      ? safeJsonParse<RuntimeHandle>(raw["runtimeHandle"])
      : null;
    const runtimeName = parsedHandle?.runtimeName ?? project.runtime ?? config.defaults.runtime;
    const agentName = raw["agent"] ?? project.agent ?? config.defaults.agent;

    const runtimePlugin = registry.get<Runtime>("runtime", runtimeName);
    if (!runtimePlugin) {
      throw new Error(`No runtime plugin for session ${sessionId}`);
    }

    const agentPlugin = registry.get<Agent>("agent", agentName);
    if (!agentPlugin) {
      throw new Error(`No agent plugin for session ${sessionId}`);
    }

    const captureOutput = async (handle: RuntimeHandle): Promise<string> => {
      try {
        return (await runtimePlugin.getOutput(handle, SEND_CONFIRMATION_OUTPUT_LINES)) ?? "";
      } catch {
        return "";
      }
    };

    const detectActivityFromOutput = (output: string) => {
      if (!output) return null;
      try {
        return agentPlugin.detectActivity(output);
      } catch {
        return null;
      }
    };

    const hasQueuedMessage = (output: string): boolean => {
      return output.includes("Press up to edit queued messages");
    };

    const waitForRestoredSession = async (restoredSession: Session): Promise<void> => {
      const handle = restoredSession.runtimeHandle;
      if (!handle) {
        return;
      }

      const deadline = Date.now() + SEND_RESTORE_READY_TIMEOUT_MS;
      while (true) {
        const [runtimeAlive, processRunning, output] = await Promise.all([
          runtimePlugin.isAlive(handle).catch(() => true),
          agentPlugin.isProcessRunning(handle).catch(() => true),
          captureOutput(handle),
        ]);

        if (runtimeAlive && (processRunning || output.trim().length > 0)) {
          return;
        }

        if (Date.now() >= deadline) {
          return;
        }

        await sleep(SEND_RESTORE_READY_POLL_MS);
      }
    };

    const restoreForDelivery = async (reason: string, session: Session): Promise<Session> => {
      if (NON_RESTORABLE_STATUSES.has(session.status)) {
        throw new Error(`Cannot send to session ${sessionId}: ${reason}`);
      }

      try {
        const restored = await restore(sessionId);
        await waitForRestoredSession(restored);
        return restored;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`Cannot send to session ${sessionId}: ${reason} (${detail})`, {
          cause: err,
        });
      }
    };

    const prepareSession = async (forceRestore = false): Promise<Session> => {
      const current = await get(sessionId);
      if (!current) {
        throw new SessionNotFoundError(sessionId);
      }

      const handle =
        current.runtimeHandle ??
        ({
          id: sessionId,
          runtimeName,
          data: {},
        } satisfies RuntimeHandle);
      const normalized = current.runtimeHandle ? current : { ...current, runtimeHandle: handle };

      if (forceRestore) {
        return restoreForDelivery(
          "session needed to be restarted before delivery",
          normalized,
        );
      }

      const [runtimeAlive, processRunning] = await Promise.all([
        runtimePlugin.isAlive(handle).catch(() => true),
        agentPlugin.isProcessRunning(handle).catch(() => true),
      ]);

      // Prefer the live runtime/process check over stale metadata status.
      // Sessions can sit idle at their prompt with statuses like "done" or
      // "stuck" while still accepting new input. If the runtime is alive and
      // the agent process is still present, we should deliver directly instead
      // of forcing a restore based only on the recorded status.
      if (runtimeAlive && processRunning) {
        return normalized;
      }

      if (isRestorable(normalized)) {
        return restoreForDelivery("session is not running", normalized);
      }

      if (!runtimeAlive || !processRunning) {
        return restoreForDelivery(
          !runtimeAlive ? "runtime is not alive" : "agent process is not running",
          normalized,
        );
      }

      return normalized;
    };

    const sendWithConfirmation = async (session: Session): Promise<void> => {
      const handle = session.runtimeHandle;
      if (!handle) {
        throw new Error(`Session ${sessionId} has no runtime handle`);
      }

      const baselineOutput = await captureOutput(handle);
      const baselineActivity = detectActivityFromOutput(baselineOutput) ?? session.activity;

      await runtimePlugin.sendMessage(handle, message);

      for (let attempt = 1; attempt <= SEND_CONFIRMATION_ATTEMPTS; attempt++) {
        // Sleep before each check (including the first) so the runtime has time
        // to reflect the message in its output.
        await sleep(SEND_CONFIRMATION_POLL_MS);

        const output = await captureOutput(handle);
        const activity = detectActivityFromOutput(output) ?? session.activity;
        const delivered =
          hasQueuedMessage(output) ||
          (output.length > 0 && output !== baselineOutput) ||
          (baselineActivity !== "active" && activity === "active") ||
          (baselineActivity !== "waiting_input" && activity === "waiting_input");

        if (delivered) {
          return;
        }
      }

      // Message was already sent via runtimePlugin.sendMessage above — if we
      // cannot *confirm* delivery (e.g. agent is slow to show output), treat it
      // as a soft success rather than throwing.  Throwing here caused the caller
      // to report failure, which prevented the dispatch-hash from updating and
      // led to duplicate messages on the next poll cycle.
      return;
    };

    let prepared = await prepareSession();

    try {
      await sendWithConfirmation(prepared);
    } catch (err) {
      const shouldRetryWithRestore =
        prepared.restoredAt === undefined && !NON_RESTORABLE_STATUSES.has(prepared.status);

      if (!shouldRetryWithRestore) {
        if (err instanceof Error) {
          throw err;
        }
        throw new Error(String(err), { cause: err });
      }

      prepared = await prepareSession(true);
      try {
        await sendWithConfirmation(prepared);
      } catch (retryErr) {
        if (retryErr instanceof Error) {
          throw retryErr;
        }
        throw new Error(String(retryErr), { cause: retryErr });
      }
    }

    // A freshly delivered prompt means the session is actively working again,
    // even if the last persisted status was idle/stuck/review-related.
    if (!NON_RESTORABLE_STATUSES.has(persistedStatus)) {
      updateMetadata(sessionsDir, sessionId, { status: "working" });
    }
  }

  async function claimPR(
    sessionId: SessionId,
    prRef: string,
    options?: ClaimPROptions,
  ): Promise<ClaimPRResult> {
    const reference = prRef.trim();
    if (!reference) throw new Error("PR reference is required");

    const { raw, sessionsDir, project, projectId } = requireSessionRecord(sessionId);
    if (raw["role"] === "orchestrator") {
      throw new Error(`Session ${sessionId} is an orchestrator session and cannot claim PRs`);
    }

    const plugins = resolvePlugins(project, raw["agent"]);
    const scm = plugins.scm;
    if (!scm?.resolvePR || !scm.checkoutPR) {
      throw new Error(
        `SCM plugin ${project.scm?.plugin ? `"${project.scm.plugin}" ` : ""}does not support claiming existing PRs`,
      );
    }

    const pr = await scm.resolvePR(reference, project);
    const prState = await scm.getPRState(pr);
    if (prState !== PR_STATE.OPEN) {
      throw new Error(`Cannot claim PR #${pr.number} because it is ${prState}`);
    }

    const conflictingSessions = new Set<SessionId>();
    for (const { sessionName } of listAllSessions(projectId)) {
      if (sessionName === sessionId) continue;

      const otherRaw = readMetadataRaw(sessionsDir, sessionName);
      if (!otherRaw || otherRaw["role"] === "orchestrator") continue;

      const samePr = otherRaw["pr"] === pr.url;
      const sameBranch =
        otherRaw["branch"] === pr.branch && (otherRaw["prAutoDetect"] ?? "on") !== "off";

      if (samePr || sameBranch) {
        conflictingSessions.add(sessionName);
      }
    }

    const takenOverFrom = [...conflictingSessions];
    if (takenOverFrom.length > 0 && !options?.takeover) {
      throw new Error(
        `PR #${pr.number} is already tracked by ${takenOverFrom.join(", ")}. Re-run with takeover enabled to transfer ownership.`,
      );
    }

    const workspacePath = raw["worktree"];
    if (!workspacePath) {
      throw new Error(`Session ${sessionId} has no workspace to check out PR #${pr.number}`);
    }

    const branchChanged = await scm.checkoutPR(pr, workspacePath);

    updateMetadata(sessionsDir, sessionId, {
      pr: pr.url,
      status: "pr_open",
      branch: pr.branch,
      prAutoDetect: "",
    });

    for (const previousSessionId of takenOverFrom) {
      const previousRaw = readMetadataRaw(sessionsDir, previousSessionId);
      if (!previousRaw) continue;

      updateMetadata(sessionsDir, previousSessionId, {
        pr: "",
        prAutoDetect: "off",
        ...(PR_TRACKING_STATUSES.has(previousRaw["status"] ?? "") ? { status: "working" } : {}),
      });
    }

    let githubAssigned = false;
    let githubAssignmentError: string | undefined;
    if (options?.assignOnGithub) {
      if (!scm.assignPRToCurrentUser) {
        githubAssignmentError = `SCM plugin "${scm.name}" does not support assigning PRs`;
      } else {
        try {
          await scm.assignPRToCurrentUser(pr);
          githubAssigned = true;
        } catch (err) {
          githubAssignmentError = err instanceof Error ? err.message : String(err);
        }
      }
    }

    return {
      sessionId,
      projectId,
      pr,
      branchChanged,
      githubAssigned,
      githubAssignmentError,
      takenOverFrom,
    };
  }

  async function remap(sessionId: SessionId, force = false): Promise<string> {
    const { raw, sessionsDir, project } = requireSessionRecord(sessionId);

    const selectedAgent = raw["agent"] ?? project.agent ?? config.defaults.agent;
    if (selectedAgent !== "opencode") {
      throw new Error(`Session ${sessionId} is not using the opencode agent`);
    }

    const mapped = asValidOpenCodeSessionId(raw["opencodeSessionId"]);
    const discovered = force
      ? await discoverOpenCodeSessionIdByTitle(sessionId, OPENCODE_INTERACTIVE_DISCOVERY_TIMEOUT_MS)
      : (mapped ??
        (await discoverOpenCodeSessionIdByTitle(
          sessionId,
          OPENCODE_INTERACTIVE_DISCOVERY_TIMEOUT_MS,
        )));
    if (!discovered) {
      throw new Error(`OpenCode session mapping is missing for ${sessionId}`);
    }

    updateMetadata(sessionsDir, sessionId, { opencodeSessionId: discovered });
    return discovered;
  }

  async function restore(sessionId: SessionId): Promise<Session> {
    // 1. Find session metadata across all projects (active first, then archive)
    let raw: Record<string, string> | null = null;
    let sessionsDir: string | null = null;
    let project: ProjectConfig | undefined;
    let projectId: string | undefined;
    let fromArchive = false;

    const activeRecord = findSessionRecord(sessionId);
    if (activeRecord) {
      raw = activeRecord.raw;
      sessionsDir = activeRecord.sessionsDir;
      project = activeRecord.project;
      projectId = activeRecord.projectId;
    }

    // Fall back to archived metadata (killed/cleaned sessions)
    if (!raw) {
      for (const [key, proj] of Object.entries(config.projects)) {
        const dir = getProjectSessionsDir(proj);
        const archived = readArchivedMetadataRaw(dir, sessionId);
        if (archived) {
          raw = archived;
          sessionsDir = dir;
          project = proj;
          projectId = key;
          fromArchive = true;
          break;
        }
      }
    }

    if (!raw || !sessionsDir || !project || !projectId) {
      throw new SessionNotFoundError(sessionId);
    }

    const selectedAgent = raw["agent"] ?? project.agent ?? config.defaults.agent;
    if (selectedAgent === "opencode" && !asValidOpenCodeSessionId(raw["opencodeSessionId"])) {
      const discovered = await discoverOpenCodeSessionIdByTitle(
        sessionId,
        OPENCODE_INTERACTIVE_DISCOVERY_TIMEOUT_MS,
      );
      if (!discovered) {
        throw new SessionNotRestorableError(sessionId, "OpenCode session mapping is missing");
      }
      raw = { ...raw, opencodeSessionId: discovered };
      if (!fromArchive) {
        updateMetadata(sessionsDir, sessionId, { opencodeSessionId: discovered });
      }
    }

    // 2. Reconstruct Session from metadata and enrich with live runtime state.
    //    metadataToSession sets activity: null, so without enrichment a crashed
    //    session (status "working", agent exited) would not be detected as terminal
    //    and isRestorable would reject it.
    const session = metadataToSession(sessionId, raw);
    const plugins = resolvePlugins(project, raw["agent"]);
    await enrichSessionWithRuntimeState(session, plugins, true);

    // 3. Validate restorability
    if (!isRestorable(session)) {
      if (NON_RESTORABLE_STATUSES.has(session.status)) {
        throw new SessionNotRestorableError(sessionId, `status is "${session.status}"`);
      }
      throw new SessionNotRestorableError(sessionId, "session is not in a terminal state");
    }

    if (fromArchive) {
      writeMetadata(sessionsDir, sessionId, {
        worktree: raw["worktree"] ?? "",
        branch: raw["branch"] ?? "",
        status: raw["status"] ?? "killed",
        role: raw["role"],
        tmuxName: raw["tmuxName"],
        issue: raw["issue"],
        pr: raw["pr"],
        prAutoDetect:
          raw["prAutoDetect"] === "off" ? "off" : raw["prAutoDetect"] === "on" ? "on" : undefined,
        summary: raw["summary"],
        project: raw["project"],
        agent: raw["agent"],
        createdAt: raw["createdAt"],
        runtimeHandle: raw["runtimeHandle"],
        opencodeSessionId: raw["opencodeSessionId"],
      });
    }

    // 4. Validate required plugins (plugins already resolved above for enrichment)
    if (!plugins.runtime) {
      throw new Error(`Runtime plugin '${project.runtime ?? config.defaults.runtime}' not found`);
    }
    if (!plugins.agent) {
      throw new Error(`Agent plugin '${project.agent ?? config.defaults.agent}' not found`);
    }

    // 5. Check workspace
    const workspacePath = raw["worktree"] || project.path;
    const workspaceExists = plugins.workspace?.exists
      ? await plugins.workspace.exists(workspacePath)
      : existsSync(workspacePath);

    if (!workspaceExists) {
      // Try to restore workspace if plugin supports it
      if (!plugins.workspace?.restore) {
        throw new WorkspaceMissingError(workspacePath, "workspace plugin does not support restore");
      }
      if (!session.branch) {
        throw new WorkspaceMissingError(workspacePath, "branch metadata is missing");
      }
      try {
        const wsInfo = await plugins.workspace.restore(
          {
            projectId,
            project,
            sessionId,
            branch: session.branch,
          },
          workspacePath,
        );

        // Run post-create hooks on restored workspace
        if (plugins.workspace.postCreate) {
          await plugins.workspace.postCreate(wsInfo, project);
        }
      } catch (err) {
        throw new WorkspaceMissingError(
          workspacePath,
          `restore failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 6. Destroy old runtime if still alive (e.g. tmux session survives agent crash)
    if (session.runtimeHandle) {
      try {
        await plugins.runtime.destroy(session.runtimeHandle);
      } catch {
        // Best effort — may already be gone
      }
    }

    // 7. Get launch command — try restore command first, fall back to fresh launch
    let launchCommand: string;
    const configuredSubagent =
      typeof project.agentConfig?.["subagent"] === "string"
        ? project.agentConfig["subagent"]
        : undefined;
    const agentLaunchConfig = {
      sessionId,
      projectConfig: {
        ...project,
        agentConfig: {
          ...(project.agentConfig ?? {}),
          ...(session.metadata?.opencodeSessionId
            ? { opencodeSessionId: session.metadata.opencodeSessionId }
            : {}),
        },
      },
      issueId: session.issueId ?? undefined,
      permissions: project.agentConfig?.permissions,
      model:
        raw["role"] === "orchestrator"
          ? (project.agentConfig?.orchestratorModel ?? project.agentConfig?.model)
          : project.agentConfig?.model,
      subagent: configuredSubagent,
    };

    if (plugins.agent.getRestoreCommand) {
      const restoreCmd = await plugins.agent.getRestoreCommand(session, project);
      launchCommand = restoreCmd ?? plugins.agent.getLaunchCommand(agentLaunchConfig);
    } else {
      launchCommand = plugins.agent.getLaunchCommand(agentLaunchConfig);
    }

    const environment = plugins.agent.getEnvironment(agentLaunchConfig);

    // 8. Create runtime (reuse tmuxName from metadata)
    const tmuxName = raw["tmuxName"];
    const handle = await plugins.runtime.create({
      sessionId: tmuxName ?? sessionId,
      workspacePath,
      launchCommand,
      environment: {
        ...environment,
        AO_SESSION: sessionId,
        AO_DATA_DIR: sessionsDir,
        AO_SESSION_NAME: sessionId,
        ...(tmuxName && { AO_TMUX_NAME: tmuxName }),
      },
    });

    // 9. Update metadata — merge updates, preserving existing fields
    const now = new Date().toISOString();
    updateMetadata(sessionsDir, sessionId, {
      status: "spawning",
      runtimeHandle: JSON.stringify(handle),
      restoredAt: now,
    });

    // 10. Run postLaunchSetup (non-fatal)
    const restoredSession: Session = {
      ...session,
      status: "spawning",
      activity: "active",
      workspacePath,
      runtimeHandle: handle,
      restoredAt: new Date(now),
    };

    if (plugins.agent.postLaunchSetup) {
      try {
        const metadataBeforePostLaunch = { ...(restoredSession.metadata ?? {}) };
        await plugins.agent.postLaunchSetup(restoredSession);

        const metadataAfterPostLaunch = restoredSession.metadata ?? {};
        const metadataUpdates = Object.fromEntries(
          Object.entries(metadataAfterPostLaunch).filter(
            ([key, value]) => metadataBeforePostLaunch[key] !== value,
          ),
        );

        if (Object.keys(metadataUpdates).length > 0) {
          updateMetadata(sessionsDir, sessionId, metadataUpdates);
        }
      } catch {
        // Non-fatal — session is already running
      }
    }

    return restoredSession;
  }

  return { spawn, spawnOrchestrator, restore, list, get, kill, cleanup, send, claimPR, remap };
}
