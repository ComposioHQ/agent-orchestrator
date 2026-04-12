import "server-only";

/**
 * Server-side singleton for core services.
 *
 * Lazily initializes config, plugin registry, and session manager.
 * Cached in globalThis to survive Next.js HMR reloads in development.
 *
 * NOTE: Plugins are explicitly imported here because Next.js webpack
 * cannot resolve dynamic `import(variable)` expressions used by the
 * core plugin registry's loadBuiltins(). Static imports let webpack
 * bundle them correctly.
 */

import { existsSync } from "node:fs";
import {
  loadConfig,
  getGlobalConfigPath,
  createPluginRegistry,
  createSessionManager,
  createLifecycleManager,
  type OrchestratorConfig,
  type PluginRegistry,
  type OpenCodeSessionManager,
  type LifecycleManager,
  type SCM,
  type ProjectConfig,
  type Tracker,
  type Issue,
  type Session,
  isOrchestratorSession,
  TERMINAL_STATUSES,
} from "@aoagents/ao-core";

// Static plugin imports — webpack needs these to be string literals
import pluginRuntimeTmux from "@aoagents/ao-plugin-runtime-tmux";
import pluginAgentClaudeCode from "@aoagents/ao-plugin-agent-claude-code";
import pluginAgentCodex from "@aoagents/ao-plugin-agent-codex";
import pluginAgentCursor from "@aoagents/ao-plugin-agent-cursor";
import pluginAgentOpencode from "@aoagents/ao-plugin-agent-opencode";
import pluginWorkspaceWorktree from "@aoagents/ao-plugin-workspace-worktree";
import pluginScmGithub from "@aoagents/ao-plugin-scm-github";
import pluginTrackerGithub from "@aoagents/ao-plugin-tracker-github";
import pluginTrackerLinear from "@aoagents/ao-plugin-tracker-linear";

export interface Services {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: OpenCodeSessionManager;
  lifecycleManager: LifecycleManager;
}

// Cache in globalThis for Next.js HMR stability
const globalForServices = globalThis as typeof globalThis & {
  _aoServices?: Services;
  _aoServicesInit?: Promise<Services>;
};

/** Get (or lazily initialize) the core services singleton. */
export function getServices(): Promise<Services> {
  if (globalForServices._aoServices) {
    return Promise.resolve(globalForServices._aoServices);
  }
  if (!globalForServices._aoServicesInit) {
    globalForServices._aoServicesInit = initServices().catch((err) => {
      // Clear the cached promise so the next call retries instead of
      // permanently returning a rejected promise.
      globalForServices._aoServicesInit = undefined;
      throw err;
    });
  }
  return globalForServices._aoServicesInit;
}

export function invalidateServicesCache(): void {
  try {
    globalForServices._aoServices?.lifecycleManager.stop();
  } catch {
    // Best-effort cleanup during cache invalidation.
  }
  globalForServices._aoServices = undefined;
  globalForServices._aoServicesInit = undefined;
}

function loadCanonicalConfig(): OrchestratorConfig {
  const globalConfigPath = getGlobalConfigPath();
  if (existsSync(globalConfigPath)) {
    return loadConfig(globalConfigPath);
  }

  return loadConfig();
}

async function initServices(): Promise<Services> {
  const config = loadCanonicalConfig();
  const registry = createPluginRegistry();

  // Register plugins explicitly (webpack can't handle dynamic import() in core)
  registry.register(pluginRuntimeTmux);
  registry.register(pluginAgentClaudeCode);
  registry.register(pluginAgentCodex);
  registry.register(pluginAgentCursor);
  registry.register(pluginAgentOpencode);
  registry.register(pluginWorkspaceWorktree);
  registry.register(pluginScmGithub);
  registry.register(pluginTrackerGithub);
  registry.register(pluginTrackerLinear);

  const sessionManager = createSessionManager({ config, registry });

  // Start the lifecycle manager — polls sessions every 30s, triggers reactions
  // (CI failure → send fix message, review comments → forward to agent, etc.)
  const lifecycleManager = createLifecycleManager({ config, registry, sessionManager });
  lifecycleManager.start(30_000);

  const services = { config, registry, sessionManager, lifecycleManager };
  globalForServices._aoServices = services;
  return services;
}

// ---------------------------------------------------------------------------
// Backlog auto-claim — polls for labeled issues and auto-spawns agents
// ---------------------------------------------------------------------------

const BACKLOG_LABEL = "agent:backlog";
const BACKLOG_POLL_INTERVAL = 60_000; // 1 minute
const MAX_CONCURRENT_AGENTS = 5; // Max active agent sessions across all projects

const globalForBacklog = globalThis as typeof globalThis & {
  _aoBacklogStarted?: boolean;
  _aoBacklogTimer?: ReturnType<typeof setInterval>;
};

/** Start the backlog auto-claim loop. Idempotent — safe to call multiple times. */
export function startBacklogPoller(): void {
  if (globalForBacklog._aoBacklogStarted) return;
  globalForBacklog._aoBacklogStarted = true;

  // Run immediately, then on interval
  void pollBacklog();
  globalForBacklog._aoBacklogTimer = setInterval(() => void pollBacklog(), BACKLOG_POLL_INTERVAL);
}

// Track which issues we've already processed to avoid repeated API calls
const processedIssues = new Set<string>();

/** Label GitHub issues for verification when their PRs have been merged. */
async function labelIssuesForVerification(
  sessions: Session[],
  config: OrchestratorConfig,
  registry: PluginRegistry,
): Promise<void> {
  const batches = new Map<
    string,
    { project: ProjectConfig; tracker: Tracker; sessions: Session[] }
  >();

  for (const session of sessions) {
    if (session.status !== "merged" || !session.issueId) continue;
    const key = `${session.projectId}:${session.issueId}`;
    if (processedIssues.has(key)) continue;

    const project = config.projects[session.projectId];
    if (!project?.tracker?.plugin || project.enabled === false) {
      processedIssues.add(key);
      continue;
    }

    const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
    if (!tracker?.updateIssue) {
      processedIssues.add(key);
      continue;
    }

    const batchKey = `${session.projectId}:${project.tracker.plugin}`;
    const batch = batches.get(batchKey);
    if (batch) {
      batch.sessions.push(session);
    } else {
      batches.set(batchKey, { project, tracker, sessions: [session] });
    }
  }

  await Promise.allSettled(
    [...batches.values()].flatMap(({ project, tracker, sessions: trackerSessions }) =>
      trackerSessions.map(async (session) => {
        const key = `${session.projectId}:${session.issueId}`;
        try {
          await tracker.updateIssue(
            session.issueId!,
            {
              labels: ["merged-unverified"],
              removeLabels: ["agent:backlog", "agent:in-progress"],
              comment: `PR merged. Issue awaiting human verification on staging.`,
            },
            project,
          );
        } catch (err) {
          console.error(`[backlog] Failed to close issue ${session.issueId}:`, err);
        }
        processedIssues.add(key);
      }),
    ),
  );
}

function getEnabledTrackerProjects(
  config: OrchestratorConfig,
  registry: PluginRegistry,
): Array<{ projectId: string; project: ProjectConfig; tracker: Tracker }> {
  return Object.entries(config.projects).flatMap(([projectId, project]) => {
    if (project.enabled === false || !project.tracker?.plugin) return [];
    const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
    if (!tracker) return [];
    return [{ projectId, project, tracker }];
  });
}

async function listTrackerIssuesByProject(
  trackerProjects: Array<{ projectId: string; project: ProjectConfig; tracker: Tracker }>,
  args: { state: "open"; labels: string[]; limit: number },
): Promise<Map<string, Issue[]>> {
  const entries = await Promise.all(
    trackerProjects.map(async ({ projectId, tracker, project }) => {
      if (!tracker.listIssues) return [projectId, []] as const;
      try {
        return [projectId, await tracker.listIssues(args, project)] as const;
      } catch {
        return [projectId, []] as const;
      }
    }),
  );
  return new Map(entries);
}

async function relabelReopenedIssues(
  config: OrchestratorConfig,
  registry: PluginRegistry,
): Promise<void> {
  const trackerProjects = getEnabledTrackerProjects(config, registry).filter(
    ({ tracker }) => tracker.listIssues && tracker.updateIssue,
  );
  const reopenedByProject = await listTrackerIssuesByProject(trackerProjects, {
    state: "open",
    labels: ["agent:done"],
    limit: 20,
  });

  await Promise.allSettled(
    trackerProjects.flatMap(({ project, tracker, projectId }) =>
      (reopenedByProject.get(projectId) ?? []).map(async (issue) => {
        try {
          await tracker.updateIssue!(
            issue.id,
            {
              labels: [BACKLOG_LABEL],
              removeLabels: ["agent:done"],
              comment: "Issue reopened — returning to agent backlog.",
            },
            project,
          );
          console.log(`[backlog] Relabeled reopened issue ${issue.id} → ${BACKLOG_LABEL}`);
        } catch (err) {
          console.error(`[backlog] Failed to relabel reopened issue ${issue.id}:`, err);
        }
      }),
    ),
  );
}

function getEnabledProjects(config: OrchestratorConfig): OrchestratorConfig["projects"] {
  return Object.fromEntries(
    Object.entries(config.projects).filter(([, project]) => project.enabled !== false),
  );
}

async function claimBacklogIssues(
  config: OrchestratorConfig,
  registry: PluginRegistry,
  sessionManager: OpenCodeSessionManager,
  activeIssueIds: Set<string>,
  initialAvailableSlots: number,
): Promise<void> {
  let availableSlots = initialAvailableSlots;
  if (availableSlots <= 0) return;

  const trackerProjects = getEnabledTrackerProjects(config, registry).filter(
    ({ tracker }) => tracker.listIssues,
  );
  const backlogByProject = await listTrackerIssuesByProject(trackerProjects, {
    state: "open",
    labels: [BACKLOG_LABEL],
    limit: 10,
  });

  for (const { projectId, project, tracker } of trackerProjects) {
    if (availableSlots <= 0) break;
    for (const issue of backlogByProject.get(projectId) ?? []) {
      if (availableSlots <= 0) break;
      if (activeIssueIds.has(issue.id.toLowerCase())) continue;

      try {
        await sessionManager.spawn({ projectId, issueId: issue.id });
        availableSlots--;
        activeIssueIds.add(issue.id.toLowerCase());

        if (tracker.updateIssue) {
          await tracker.updateIssue(
            issue.id,
            {
              labels: ["agent:in-progress"],
              removeLabels: ["agent:backlog"],
              comment: "Claimed by agent orchestrator — session spawned.",
            },
            project,
          );
        }
      } catch (err) {
        console.error(`[backlog] Failed to spawn session for issue ${issue.id}:`, err);
      }
    }
  }
}

export async function pollBacklog(): Promise<void> {
  try {
    const { config, registry, sessionManager } = await getServices();
    const enabledProjects = getEnabledProjects(config);

    // Get all sessions
    const allSessions = await sessionManager.list();
    // Label issues for verification when PRs are merged
    await labelIssuesForVerification(allSessions, config, registry);

    // Detect reopened issues: open state + agent:done label → relabel as agent:backlog
    await relabelReopenedIssues(config, registry);

    const allSessionPrefixes = Object.entries(enabledProjects).map(
      ([id, p]) => p.sessionPrefix ?? id,
    );
    const workerSessions = allSessions.filter(
      (session) =>
        !isOrchestratorSession(
          session,
          enabledProjects[session.projectId]?.sessionPrefix ?? session.projectId,
          allSessionPrefixes,
        ) &&
        enabledProjects[session.projectId] &&
        !TERMINAL_STATUSES.has(session.status),
    );
    const activeIssueIds = new Set(
      workerSessions
        .map((session) => session.issueId?.toLowerCase())
        .filter((issueId): issueId is string => Boolean(issueId)),
    );

    // Auto-scaling: respect max concurrent agents
    let availableSlots = MAX_CONCURRENT_AGENTS - workerSessions.length;
    if (availableSlots <= 0) return; // At capacity
    await claimBacklogIssues(config, registry, sessionManager, activeIssueIds, availableSlots);
  } catch (err) {
    console.error("[backlog] Poll failed:", err);
  }
}

/** Get backlog issues across all projects (for dashboard display). */
export async function getBacklogIssues(): Promise<Array<Issue & { projectId: string }>> {
  const results: Array<Issue & { projectId: string }> = [];
  try {
    const { config, registry } = await getServices();
    for (const [projectId, project] of Object.entries(config.projects)) {
      if (!project.tracker?.plugin) continue;
      const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
      if (!tracker?.listIssues) continue;

      try {
        const issues = await tracker.listIssues(
          { state: "open", labels: [BACKLOG_LABEL], limit: 20 },
          project,
        );
        for (const issue of issues) {
          results.push({ ...issue, projectId });
        }
      } catch {
        // Skip unavailable trackers
      }
    }
  } catch {
    // Services unavailable
  }
  return results;
}

/** Get issues labeled merged-unverified across all projects (for dashboard verify tab). */
export async function getVerifyIssues(): Promise<Array<Issue & { projectId: string }>> {
  const results: Array<Issue & { projectId: string }> = [];
  try {
    const { config, registry } = await getServices();
    for (const [projectId, project] of Object.entries(config.projects)) {
      if (!project.tracker?.plugin) continue;
      const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
      if (!tracker?.listIssues) continue;

      try {
        const issues = await tracker.listIssues(
          { state: "open", labels: ["merged-unverified"], limit: 20 },
          project,
        );
        for (const issue of issues) {
          results.push({ ...issue, projectId });
        }
      } catch {
        // Skip unavailable trackers
      }
    }
  } catch {
    // Services unavailable
  }
  return results;
}

/** Resolve the SCM plugin for a project. Returns null if not configured. */
export function getSCM(registry: PluginRegistry, project: ProjectConfig | undefined): SCM | null {
  if (!project?.scm?.plugin) return null;
  return registry.get<SCM>("scm", project.scm.plugin);
}
