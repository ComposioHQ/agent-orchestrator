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

import {
  createPluginRegistry,
  createSessionManager,
  createLifecycleManager,
  decompose,
  getLeaves,
  getSiblings,
  formatPlanTree,
  type OrchestratorConfig,
  type PluginRegistry,
  type OpenCodeSessionManager,
  type LifecycleManager,
  type SCM,
  type ProjectConfig,
  type Tracker,
  type Issue,
  type Session,
  type DecomposerConfig,
  DEFAULT_DECOMPOSER_CONFIG,
  isOrchestratorSession,
  TERMINAL_STATUSES,
} from "@composio/ao-core";

// Static plugin imports — webpack needs these to be string literals
import pluginRuntimeTmux from "@composio/ao-plugin-runtime-tmux";
import pluginAgentClaudeCode from "@composio/ao-plugin-agent-claude-code";
import pluginAgentOpencode from "@composio/ao-plugin-agent-opencode";
import pluginWorkspaceWorktree from "@composio/ao-plugin-workspace-worktree";
import pluginScmGithub from "@composio/ao-plugin-scm-github";
import pluginTrackerGithub from "@composio/ao-plugin-tracker-github";
import pluginTrackerLinear from "@composio/ao-plugin-tracker-linear";
import { getCachedConfig } from "./config-cache.js";

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
  _aoServicesConfig?: OrchestratorConfig;
};

export { getCachedConfig };

/** Get (or lazily initialize) the core services singleton. */
export function getServices(): Promise<Services> {
  const config = getCachedConfig();

  if (globalForServices._aoServices && globalForServices._aoServicesConfig === config) {
    return Promise.resolve(globalForServices._aoServices);
  }

  if (
    globalForServices._aoServices &&
    globalForServices._aoServicesConfig &&
    globalForServices._aoServicesConfig !== config
  ) {
    try {
      globalForServices._aoServices.lifecycleManager.stop();
    } catch {
      void 0;
    }
    globalForServices._aoServices = undefined;
  }

  if (globalForServices._aoServicesInit && globalForServices._aoServicesConfig === config) {
    return globalForServices._aoServicesInit;
  }

  globalForServices._aoServicesConfig = config;
  globalForServices._aoServicesInit = initServices(config)
    .then((services) => {
      if (globalForServices._aoServicesConfig !== config) {
        try {
          services.lifecycleManager.stop();
        } catch {
          void 0;
        }
        return services;
      }

      globalForServices._aoServices = services;
      return services;
    })
    .catch((err) => {
      if (globalForServices._aoServicesConfig === config) {
        // Clear the cached promise so the next call retries instead of
        // permanently returning a rejected promise.
        globalForServices._aoServicesInit = undefined;
        globalForServices._aoServicesConfig = undefined;
      }
      throw err;
    });
  return globalForServices._aoServicesInit;
}

async function initServices(config: OrchestratorConfig): Promise<Services> {
  const registry = createPluginRegistry();

  // Register plugins explicitly (webpack can't handle dynamic import() in core)
  registry.register(pluginRuntimeTmux);
  registry.register(pluginAgentClaudeCode);
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

  return { config, registry, sessionManager, lifecycleManager };
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
  const mergedSessions = sessions.filter(
    (s) =>
      s.status === "merged" && s.issueId && !processedIssues.has(`${s.projectId}:${s.issueId}`),
  );

  for (const session of mergedSessions) {
    const key = `${session.projectId}:${session.issueId}`;
    const project = config.projects[session.projectId];
    if (!project?.tracker) {
      processedIssues.add(key);
      continue;
    }

    const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
    if (!tracker?.updateIssue) {
      processedIssues.add(key);
      continue;
    }

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
  }
}

/**
 * Detect reopened issues (open + agent:done label) and swap the label
 * back to agent:backlog so pollBacklog picks them up on the next cycle.
 */
async function relabelReopenedIssues(
  config: OrchestratorConfig,
  registry: PluginRegistry,
): Promise<void> {
  for (const [, project] of Object.entries(config.projects)) {
    if (!project.tracker) continue;
    const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
    if (!tracker?.listIssues || !tracker.updateIssue) continue;

    let reopened: Issue[];
    try {
      reopened = await tracker.listIssues(
        { state: "open", labels: ["agent:done"], limit: 20 },
        project,
      );
    } catch {
      continue;
    }

    for (const issue of reopened) {
      try {
        await tracker.updateIssue(
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
    }
  }
}

export async function pollBacklog(): Promise<void> {
  try {
    const { config, registry, sessionManager } = await getServices();

    // Get all sessions
    const allSessions = await sessionManager.list();
    // Label issues for verification when PRs are merged
    await labelIssuesForVerification(allSessions, config, registry);

    // Detect reopened issues: open state + agent:done label → relabel as agent:backlog
    await relabelReopenedIssues(config, registry);

    const workerSessions = allSessions.filter(
      (session) => !isOrchestratorSession(session) && !TERMINAL_STATUSES.has(session.status),
    );
    const activeIssueIds = new Set(
      workerSessions.filter((s) => s.issueId).map((s) => s.issueId!.toLowerCase()),
    );

    // Auto-scaling: respect max concurrent agents
    let availableSlots = MAX_CONCURRENT_AGENTS - workerSessions.length;
    if (availableSlots <= 0) return; // At capacity

    for (const [projectId, project] of Object.entries(config.projects)) {
      if (availableSlots <= 0) break;
      if (!project.tracker) continue;

      const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
      if (!tracker?.listIssues) continue;

      let backlogIssues: Issue[];
      try {
        backlogIssues = await tracker.listIssues(
          { state: "open", labels: [BACKLOG_LABEL], limit: 10 },
          project,
        );
      } catch {
        continue; // Tracker unavailable — skip this project
      }

      for (const issue of backlogIssues) {
        if (availableSlots <= 0) break;

        // Skip if already being worked on
        if (activeIssueIds.has(issue.id.toLowerCase())) continue;

        try {
          const decompConfig = project.decomposer;
          const shouldDecompose = decompConfig?.enabled ?? false;

          if (shouldDecompose) {
            // Decompose the issue before spawning
            const taskDescription = `${issue.title}\n\n${issue.description}`;
            const decomposerConfig: DecomposerConfig = {
              ...DEFAULT_DECOMPOSER_CONFIG,
              ...decompConfig,
            };

            console.log(`[backlog] Decomposing issue ${issue.id}: "${issue.title}"`);
            const plan = await decompose(taskDescription, decomposerConfig);
            const leaves = getLeaves(plan.tree);

            if (leaves.length <= 1) {
              // Atomic — spawn directly
              await sessionManager.spawn({ projectId, issueId: issue.id });
              availableSlots--;
            } else if (decomposerConfig.requireApproval) {
              // Post plan as comment and wait for human approval
              const treeText = formatPlanTree(plan.tree);
              if (tracker.updateIssue) {
                await tracker.updateIssue(
                  issue.id,
                  {
                    comment: `## Decomposition Plan\n\n\`\`\`\n${treeText}\n\`\`\`\n\n${leaves.length} subtasks identified. Remove \`agent:backlog\` and add \`agent:decompose-approved\` to execute.`,
                    labels: ["agent:decompose-pending"],
                    removeLabels: ["agent:backlog"],
                  },
                  project,
                );
              }
              console.log(
                `[backlog] Posted decomposition plan for ${issue.id} (${leaves.length} subtasks, awaiting approval)`,
              );
              continue;
            } else {
              // Auto-execute: spawn each leaf with lineage context
              console.log(
                `[backlog] Auto-executing decomposition for ${issue.id} (${leaves.length} subtasks)`,
              );
              for (const leaf of leaves) {
                if (availableSlots <= 0) break;
                const siblings = getSiblings(plan.tree, leaf.id);
                await sessionManager.spawn({
                  projectId,
                  issueId: issue.id,
                  lineage: leaf.lineage,
                  siblings,
                });
                availableSlots--;
              }
            }
          } else {
            // No decomposition — spawn directly (classic behavior)
            await sessionManager.spawn({ projectId, issueId: issue.id });
            availableSlots--;
          }

          activeIssueIds.add(issue.id.toLowerCase());

          // Mark as claimed on the tracker
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
      if (!project.tracker) continue;
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
      if (!project.tracker) continue;
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
  if (!project?.scm) return null;
  return registry.get<SCM>("scm", project.scm.plugin);
}
