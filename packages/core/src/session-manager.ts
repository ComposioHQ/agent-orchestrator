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

import { statSync } from "node:fs";
import { join } from "node:path";
import {
  isIssueNotFoundError,
  SessionNotRestorableError,
  WorkspaceMissingError,
  NON_RESTORABLE_STATUSES,
  TERMINAL_STATUSES,
  TERMINAL_ACTIVITIES,
  type SessionManager,
  type Session,
  type SessionId,
  type SessionSpawnConfig,
  type SessionStatus,
  type CleanupResult,
  type OrchestratorConfig,
  type ProjectConfig,
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
  writeMetadata,
  updateMetadata,
  deleteMetadata,
  listMetadata,
  reserveSessionId,
} from "./metadata.js";
import { buildPrompt } from "./prompt-builder.js";

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
    activity: "idle",
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
export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const { config, registry } = deps;

  /** Resolve which plugins to use for a project. */
  function resolvePlugins(project: ProjectConfig) {
    const runtime = registry.get<Runtime>("runtime", project.runtime ?? config.defaults.runtime);
    const agent = registry.get<Agent>("agent", project.agent ?? config.defaults.agent);
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

  /**
   * Enrich session with live runtime state (alive/exited) and activity detection.
   * Mutates the session object in place.
   */
  async function enrichSessionWithRuntimeState(
    session: Session,
    plugins: ReturnType<typeof resolvePlugins>,
  ): Promise<void> {
    if (!session.runtimeHandle) return;

    if (plugins.runtime) {
      try {
        const alive = await plugins.runtime.isAlive(session.runtimeHandle);
        if (!alive) {
          session.status = "killed";
          session.activity = "exited";
        } else if (plugins.agent) {
          // Runtime is alive — detect activity using agent-native mechanism
          try {
            session.activity = await plugins.agent.getActivityState(session);
          } catch {
            // Can't detect activity — explicitly set to idle
            session.activity = "idle";
          }
        }
      } catch {
        // Can't check — assume still alive
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
          // Issue doesn't exist - fail fast with clear message
          throw new Error(
            `Issue ${spawnConfig.issueId} does not exist in tracker. ` +
              `Create the issue first, then spawn with the created issue ID.`,
            { cause: err },
          );
        } else {
          // Other error (auth, network, etc) - fail fast
          throw new Error(`Failed to fetch issue ${spawnConfig.issueId}: ${err}`, { cause: err });
        }
      }
    }

    // Determine session ID — atomically reserve to prevent concurrent collisions
    const existingSessions = listMetadata(config.dataDir);
    let num = getNextSessionNumber(existingSessions, project.sessionPrefix);
    let sessionId: string;
    for (let attempts = 0; attempts < 10; attempts++) {
      sessionId = `${project.sessionPrefix}-${num}`;
      if (reserveSessionId(config.dataDir, sessionId)) break;
      num++;
      if (attempts === 9) {
        throw new Error(
          `Failed to reserve session ID after 10 attempts (prefix: ${project.sessionPrefix})`,
        );
      }
    }
    // Reassign to satisfy TypeScript's flow analysis (not redundant from compiler's perspective)
    sessionId = `${project.sessionPrefix}-${num}`;

    // Determine branch name — explicit branch always takes priority
    let branch: string;
    if (spawnConfig.branch) {
      branch = spawnConfig.branch;
    } else if (spawnConfig.issueId && plugins.tracker) {
      branch = plugins.tracker.branchName(spawnConfig.issueId, project);
    } else if (spawnConfig.issueId) {
      branch = `feat/${spawnConfig.issueId}`;
    } else {
      branch = project.defaultBranch;
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
            if (workspacePath !== project.path) {
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
          deleteMetadata(config.dataDir, sessionId, false);
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
    const agentLaunchConfig = {
      sessionId,
      projectConfig: project,
      issueId: spawnConfig.issueId,
      prompt: composedPrompt ?? spawnConfig.prompt,
      permissions: project.agentConfig?.permissions,
      model: project.agentConfig?.model,
    };

    let handle: RuntimeHandle;
    try {
      const launchCommand = plugins.agent.getLaunchCommand(agentLaunchConfig);
      const environment = plugins.agent.getEnvironment(agentLaunchConfig);

      handle = await plugins.runtime.create({
        sessionId,
        workspacePath,
        launchCommand,
        environment: {
          ...environment,
          AO_SESSION: sessionId,
          AO_DATA_DIR: config.dataDir,
        },
      });
    } catch (err) {
      // Clean up workspace and reserved ID if agent config or runtime creation failed
      if (plugins.workspace && workspacePath !== project.path) {
        try {
          await plugins.workspace.destroy(workspacePath);
        } catch {
          /* best effort */
        }
      }
      try {
        deleteMetadata(config.dataDir, sessionId, false);
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
      metadata: {},
    };

    try {
      writeMetadata(config.dataDir, sessionId, {
        worktree: workspacePath,
        branch,
        status: "spawning",
        issue: spawnConfig.issueId,
        project: spawnConfig.projectId,
        createdAt: new Date().toISOString(),
        runtimeHandle: JSON.stringify(handle),
        permissions: project.agentConfig?.permissions,
      });

      if (plugins.agent.postLaunchSetup) {
        await plugins.agent.postLaunchSetup(session);
      }
    } catch (err) {
      // Clean up runtime and workspace on post-launch failure
      try {
        await plugins.runtime.destroy(handle);
      } catch {
        /* best effort */
      }
      if (plugins.workspace && workspacePath !== project.path) {
        try {
          await plugins.workspace.destroy(workspacePath);
        } catch {
          /* best effort */
        }
      }
      try {
        deleteMetadata(config.dataDir, sessionId, false);
      } catch {
        /* best effort */
      }
      throw err;
    }

    return session;
  }

  async function list(projectId?: string): Promise<Session[]> {
    const sessionIds = listMetadata(config.dataDir);
    const sessions: Session[] = [];

    for (const sid of sessionIds) {
      const raw = readMetadataRaw(config.dataDir, sid);
      if (!raw) continue;

      // Filter by project if specified
      if (projectId && raw["project"] !== projectId) continue;

      // Get file timestamps for createdAt/lastActivityAt
      let createdAt: Date | undefined;
      let modifiedAt: Date | undefined;
      try {
        const metaPath = join(config.dataDir, sid);
        const stats = statSync(metaPath);
        createdAt = stats.birthtime;
        modifiedAt = stats.mtime;
      } catch {
        // If stat fails, timestamps will fall back to current time
      }

      const session = metadataToSession(sid, raw, createdAt, modifiedAt);

      // Enrich with live runtime state and activity detection
      if (session.runtimeHandle) {
        const project = config.projects[session.projectId];
        if (project) {
          const plugins = resolvePlugins(project);
          await enrichSessionWithRuntimeState(session, plugins);
        }
      }

      sessions.push(session);
    }

    return sessions;
  }

  async function get(sessionId: SessionId): Promise<Session | null> {
    const raw = readMetadataRaw(config.dataDir, sessionId);
    if (!raw) return null;

    // Get file timestamps for createdAt/lastActivityAt
    let createdAt: Date | undefined;
    let modifiedAt: Date | undefined;
    try {
      const metaPath = join(config.dataDir, sessionId);
      const stats = statSync(metaPath);
      createdAt = stats.birthtime;
      modifiedAt = stats.mtime;
    } catch {
      // If stat fails, timestamps will fall back to current time
    }

    const session = metadataToSession(sessionId, raw, createdAt, modifiedAt);

    // Enrich with live runtime state and activity detection
    if (session.runtimeHandle) {
      const project = config.projects[session.projectId];
      if (project) {
        const plugins = resolvePlugins(project);
        await enrichSessionWithRuntimeState(session, plugins);
      }
    }

    return session;
  }

  async function kill(sessionId: SessionId): Promise<void> {
    const raw = readMetadataRaw(config.dataDir, sessionId);
    if (!raw) throw new Error(`Session ${sessionId} not found`);

    const projectId = raw["project"] ?? "";
    const project = config.projects[projectId];

    // Destroy runtime — prefer handle.runtimeName to find the correct plugin
    if (raw["runtimeHandle"]) {
      const handle = safeJsonParse<RuntimeHandle>(raw["runtimeHandle"]);
      if (handle) {
        const runtimePlugin = registry.get<Runtime>(
          "runtime",
          handle.runtimeName ??
            (project ? (project.runtime ?? config.defaults.runtime) : config.defaults.runtime),
        );
        if (runtimePlugin) {
          try {
            await runtimePlugin.destroy(handle);
          } catch {
            // Runtime might already be gone
          }
        }
      }
    }

    // Destroy workspace — skip if worktree is the project path (no isolation was used)
    const worktree = raw["worktree"];
    const isProjectPath = project && worktree === project.path;
    if (worktree && !isProjectPath) {
      const workspacePlugin = project
        ? resolvePlugins(project).workspace
        : registry.get<Workspace>("workspace", config.defaults.workspace);
      if (workspacePlugin) {
        try {
          await workspacePlugin.destroy(worktree);
        } catch {
          // Workspace might already be gone
        }
      }
    }

    // Archive metadata
    deleteMetadata(config.dataDir, sessionId, true);
  }

  async function cleanup(projectId?: string): Promise<CleanupResult> {
    const result: CleanupResult = { killed: [], skipped: [], errors: [] };
    const sessions = await list(projectId);

    for (const session of sessions) {
      try {
        const project = config.projects[session.projectId];
        if (!project) {
          result.skipped.push(session.id);
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
          await kill(session.id);
          result.killed.push(session.id);
        } else {
          result.skipped.push(session.id);
        }
      } catch (err) {
        result.errors.push({
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }

  async function send(sessionId: SessionId, message: string): Promise<void> {
    const raw = readMetadataRaw(config.dataDir, sessionId);
    if (!raw) throw new Error(`Session ${sessionId} not found`);

    // Build handle: use stored runtimeHandle, or fall back to session ID as tmux session name
    let handle: RuntimeHandle;
    if (raw["runtimeHandle"]) {
      const parsed = safeJsonParse<RuntimeHandle>(raw["runtimeHandle"]);
      if (!parsed) {
        throw new Error(`Corrupted runtime handle for session ${sessionId}`);
      }
      handle = parsed;
    } else {
      // Sessions created by bash scripts don't have runtimeHandle — use session ID as tmux handle
      handle = { id: sessionId, runtimeName: config.defaults.runtime, data: {} };
    }

    // Prefer handle.runtimeName to find the correct plugin
    const project = config.projects[raw["project"] ?? ""];
    const runtimePlugin = registry.get<Runtime>(
      "runtime",
      handle.runtimeName ??
        (project ? (project.runtime ?? config.defaults.runtime) : config.defaults.runtime),
    );
    if (!runtimePlugin) {
      throw new Error(`No runtime plugin for session ${sessionId}`);
    }

    await runtimePlugin.sendMessage(handle, message);
  }

  async function restore(sessionId: SessionId): Promise<Session> {
    // 1. Load session metadata
    const metadata = readMetadataRaw(config.dataDir, sessionId);
    if (!metadata) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const oldStatus = validateStatus(metadata["status"]);

    // 2. Validate restorable status - must be terminal AND not non-restorable
    if (NON_RESTORABLE_STATUSES.has(oldStatus)) {
      throw new SessionNotRestorableError(sessionId, oldStatus);
    }

    // Check if session is in a terminal state (killed, done, terminated, cleanup)
    // This prevents restoring active sessions (working, pr_open, spawning, etc.)
    if (!TERMINAL_STATUSES.has(oldStatus)) {
      // For sessions with non-terminal status, also check activity state
      const currentSession = await get(sessionId);
      if (currentSession && !TERMINAL_ACTIVITIES.has(currentSession.activity)) {
        throw new SessionNotRestorableError(sessionId, oldStatus);
      }
    }

    const projectId = metadata["project"] ?? "";
    const project = config.projects[projectId];
    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    const workspacePath = metadata["worktree"] ?? "";
    const branch = metadata["branch"] ?? "";

    if (!workspacePath || !branch) {
      throw new Error(`Session ${sessionId} missing worktree or branch metadata`);
    }

    const plugins = resolvePlugins(project);
    if (!plugins.runtime) {
      throw new Error(`Runtime plugin '${project.runtime ?? config.defaults.runtime}' not found`);
    }
    if (!plugins.agent) {
      throw new Error(`Agent plugin '${project.agent ?? config.defaults.agent}' not found`);
    }
    if (!plugins.workspace) {
      throw new Error(`Workspace plugin '${project.workspace ?? config.defaults.workspace}' not found`);
    }

    // 3. Ensure workspace exists
    const workspaceExists = await plugins.workspace.exists(workspacePath);

    if (!workspaceExists) {
      // Check if branch still exists in repo (if SCM plugin available)
      const scmPlugin = plugins.scm;
      if (scmPlugin) {
        const branchExists = await scmPlugin.branchExists(project.path, branch);
        if (!branchExists) {
          throw new WorkspaceMissingError(workspacePath, branch);
        }
      }
      // If no SCM plugin, attempt restore anyway - git will error if branch missing

      // Recreate worktree on same branch
      await plugins.workspace.restore(workspacePath, project.path, branch);
    }

    // 4. Get launch command (restore or regular)
    const session = await get(sessionId); // Full Session object for agent
    if (!session) {
      throw new Error(`Failed to load session ${sessionId} after metadata read`);
    }

    const restoreCmd = plugins.agent.getRestoreCommand
      ? await plugins.agent.getRestoreCommand(session)
      : null;

    const launchCommand =
      restoreCmd ??
      plugins.agent.getLaunchCommand({
        sessionId,
        projectConfig: project,
        issueId: metadata["issue"],
        permissions: project.agentConfig?.permissions,
        model: project.agentConfig?.model,
      });

    // 5. Create runtime
    const environment = plugins.agent.getEnvironment({
      sessionId,
      projectConfig: project,
      issueId: metadata["issue"],
    });

    const runtimeHandle = await plugins.runtime.create({
      sessionId,
      workspacePath,
      launchCommand,
      environment: {
        ...environment,
        AO_SESSION: sessionId,
        AO_DATA_DIR: config.dataDir,
      },
    });

    try {
      // 6. Update metadata with new runtime handle (before postLaunchSetup)
      const now = new Date().toISOString();
      updateMetadata(config.dataDir, sessionId, {
        status: "working",
        runtimeHandle: JSON.stringify(runtimeHandle),
        restoredAt: now,
        lastActivity: now,
      });

      // 7. Run post-launch setup (hooks, settings, etc.)
      if (plugins.agent.postLaunchSetup) {
        const session = await get(sessionId);
        if (session) {
          await plugins.agent.postLaunchSetup(session);
        }
      }
    } catch (err) {
      // Clean up runtime on post-restore failure
      try {
        await plugins.runtime.destroy(runtimeHandle);
      } catch {
        /* best effort */
      }
      // Revert metadata to terminated state
      try {
        updateMetadata(config.dataDir, sessionId, {
          status: oldStatus,
          runtimeHandle: metadata.runtimeHandle ?? "",
        });
      } catch {
        /* best effort */
      }
      throw err;
    }

    // 8. Return updated session
    return get(sessionId).then((s) => {
      if (!s) throw new Error(`Session ${sessionId} disappeared after restore`);
      return s;
    });
  }

  return { spawn, list, get, kill, cleanup, send, restore };
}
