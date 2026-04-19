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

import {
  loadConfig,
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
import pluginRuntimeProcess from "@aoagents/ao-plugin-runtime-process";
import pluginRuntimeTmux from "@aoagents/ao-plugin-runtime-tmux";
import pluginAgentAider from "@aoagents/ao-plugin-agent-aider";
import pluginAgentClaudeCode from "@aoagents/ao-plugin-agent-claude-code";
import pluginAgentCodex from "@aoagents/ao-plugin-agent-codex";
import pluginAgentCursor from "@aoagents/ao-plugin-agent-cursor";
import pluginAgentOpencode from "@aoagents/ao-plugin-agent-opencode";
import pluginWorkspaceClone from "@aoagents/ao-plugin-workspace-clone";
import pluginWorkspaceWorktree from "@aoagents/ao-plugin-workspace-worktree";
import pluginScmGithub from "@aoagents/ao-plugin-scm-github";
import pluginScmGitlab from "@aoagents/ao-plugin-scm-gitlab";
import pluginNotifierComposio from "@aoagents/ao-plugin-notifier-composio";
import pluginNotifierDesktop from "@aoagents/ao-plugin-notifier-desktop";
import pluginNotifierDiscord from "@aoagents/ao-plugin-notifier-discord";
import pluginNotifierOpenclaw from "@aoagents/ao-plugin-notifier-openclaw";
import pluginNotifierSlack from "@aoagents/ao-plugin-notifier-slack";
import pluginNotifierWebhook from "@aoagents/ao-plugin-notifier-webhook";
import pluginTerminalIterm2 from "@aoagents/ao-plugin-terminal-iterm2";
import pluginTerminalWeb from "@aoagents/ao-plugin-terminal-web";
import pluginTrackerGithub from "@aoagents/ao-plugin-tracker-github";
import pluginTrackerGitlab from "@aoagents/ao-plugin-tracker-gitlab";
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

const WEB_BUILTIN_PLUGIN_MODULES = {
  // Runtimes
  "@aoagents/ao-plugin-runtime-tmux": pluginRuntimeTmux,
  "@aoagents/ao-plugin-runtime-process": pluginRuntimeProcess,
  // Agents
  "@aoagents/ao-plugin-agent-claude-code": pluginAgentClaudeCode,
  "@aoagents/ao-plugin-agent-codex": pluginAgentCodex,
  "@aoagents/ao-plugin-agent-cursor": pluginAgentCursor,
  "@aoagents/ao-plugin-agent-aider": pluginAgentAider,
  "@aoagents/ao-plugin-agent-opencode": pluginAgentOpencode,
  // Workspaces
  "@aoagents/ao-plugin-workspace-worktree": pluginWorkspaceWorktree,
  "@aoagents/ao-plugin-workspace-clone": pluginWorkspaceClone,
  // Trackers
  "@aoagents/ao-plugin-tracker-github": pluginTrackerGithub,
  "@aoagents/ao-plugin-tracker-linear": pluginTrackerLinear,
  "@aoagents/ao-plugin-tracker-gitlab": pluginTrackerGitlab,
  // SCM
  "@aoagents/ao-plugin-scm-github": pluginScmGithub,
  "@aoagents/ao-plugin-scm-gitlab": pluginScmGitlab,
  // Notifiers
  "@aoagents/ao-plugin-notifier-composio": pluginNotifierComposio,
  "@aoagents/ao-plugin-notifier-desktop": pluginNotifierDesktop,
  "@aoagents/ao-plugin-notifier-discord": pluginNotifierDiscord,
  "@aoagents/ao-plugin-notifier-openclaw": pluginNotifierOpenclaw,
  "@aoagents/ao-plugin-notifier-slack": pluginNotifierSlack,
  "@aoagents/ao-plugin-notifier-webhook": pluginNotifierWebhook,
  // Terminals
  "@aoagents/ao-plugin-terminal-iterm2": pluginTerminalIterm2,
  "@aoagents/ao-plugin-terminal-web": pluginTerminalWeb,
} as const;

/** Package names statically bundled for the web server — must match `BUILTIN_PLUGIN_PACKAGES` in core. */
export const WEB_BUILTIN_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze(
  Object.keys(WEB_BUILTIN_PLUGIN_MODULES),
);

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

async function initServices(): Promise<Services> {
  const config = loadConfig();
  const registry = createPluginRegistry();

  // Load builtins through core so web bootstrapping matches CLI/core registry behavior,
  // while still using static imports that Next.js can bundle.
  await registry.loadBuiltins(config, async (pkg) => {
    const mod = WEB_BUILTIN_PLUGIN_MODULES[pkg as keyof typeof WEB_BUILTIN_PLUGIN_MODULES];
    if (!mod) {
      throw new Error(`Built-in plugin "${pkg}" is not bundled by the web services bootstrap`);
    }
    return mod;
  });

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
  const mergedSessions = sessions.filter(
    (s) =>
      s.lifecycle.pr.state === "merged" &&
      s.issueId &&
      !processedIssues.has(`${s.projectId}:${s.issueId}`),
  );

  for (const session of mergedSessions) {
    const key = `${session.projectId}:${session.issueId}`;
    const project = config.projects[session.projectId];
    if (!project?.tracker?.plugin) {
      processedIssues.add(key);
      continue;
    }

    const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
    if (!tracker?.updateIssue) {
      processedIssues.add(key);
      continue;
    }

    const issueId = session.issueId;
    if (!issueId) {
      processedIssues.add(key);
      continue;
    }

    try {
      await tracker.updateIssue(
        issueId,
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
    if (!project.tracker?.plugin) continue;
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

    const allSessionPrefixes = Object.entries(config.projects).map(
      ([id, p]) => p.sessionPrefix ?? id,
    );
    const workerSessions = allSessions.filter(
      (session) =>
        !isOrchestratorSession(
          session,
          config.projects[session.projectId]?.sessionPrefix ?? session.projectId,
          allSessionPrefixes,
        ) && !TERMINAL_STATUSES.has(session.status),
    );
    const activeIssueIds = new Set(
      workerSessions
        .map((session) => session.issueId?.toLowerCase())
        .filter((issueId): issueId is string => Boolean(issueId)),
    );

    // Auto-scaling: respect max concurrent agents
    let availableSlots = MAX_CONCURRENT_AGENTS - workerSessions.length;
    if (availableSlots <= 0) return; // At capacity

    for (const [projectId, project] of Object.entries(config.projects)) {
      if (availableSlots <= 0) break;
      if (!project.tracker?.plugin) continue;

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
          await sessionManager.spawn({ projectId, issueId: issue.id });
          availableSlots--;

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
