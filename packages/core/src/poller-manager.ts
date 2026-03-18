/**
 * Poller Manager — orchestrates pollers that scan for work and spawn sessions.
 *
 * This is the "outer initiation loop" that was missing from the AO.
 * Pollers can scan for:
 * - Open PRs without agents
 * - New issues in trackers
 * - External work queues
 *
 * Reference: bd-uxs.2
 */

import { randomUUID } from "node:crypto";
import type {
  OrchestratorConfig,
  Poller,
  PollerConfig,
  PollerWorkItem,
  PluginRegistry,
  SessionManager,
  SessionSpawnConfig,
} from "./types.js";
import { parseDuration } from "./lifecycle-manager.js";
import { resolveAgentSelection } from "./agent-selection.js";
import { createProjectObserver } from "./observability.js";

export interface PollerManagerDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
}

/** Track spawn counts for respawn cap */
interface SpawnTracker {
  count: number;
  windowStart: Date;
}

interface PollerManagerImpl {
  start(): void;
  stop(): void;
  pollAll(): Promise<void>;
}

/** Create a PollerManager instance */
export function createPollerManager(deps: PollerManagerDeps): PollerManagerImpl {
  const { config, registry, sessionManager } = deps;
  const observer = createProjectObserver(config, "poller-manager");

  const pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  const spawnTrackers = new Map<string, SpawnTracker>(); // "projectId:workItemId"

  /** Get all enabled pollers across all projects */
  function getEnabledPollers(): Array<{ projectId: string; config: PollerConfig; poller: Poller }> {
    const result: Array<{ projectId: string; config: PollerConfig; poller: Poller }> = [];

    for (const [projectId, project] of Object.entries(config.projects)) {
      const projectPollers = project.pollers ?? config.pollers ?? {};
      for (const [_pollerName, pollerConfig] of Object.entries(projectPollers)) {
        if (!pollerConfig.enabled) continue;

        const poller = registry.get<Poller>("poller", pollerConfig.type);
        if (poller) {
          result.push({ projectId, config: pollerConfig, poller });
        }
      }
    }

    return result;
  }

  /** Check if we've exceeded the respawn cap for a work item */
  function isRespawnCapExceeded(
    projectId: string,
    workItemId: string,
    pollerConfig: PollerConfig,
  ): boolean {
    const trackerKey = `${projectId}:${workItemId}`;
    const respawnCap = pollerConfig.respawnCap;
    if (!respawnCap) return false;

    let tracker = spawnTrackers.get(trackerKey);
    const windowMs = parseDuration(respawnCap.window);

    // Reset window if expired (only if windowMs > 0 to avoid disabling cap)
    if (!tracker || (windowMs > 0 && Date.now() - tracker.windowStart.getTime() > windowMs)) {
      tracker = { count: 0, windowStart: new Date() };
      spawnTrackers.set(trackerKey, tracker);
    }

    return tracker.count >= respawnCap.max;
  }

  /** Increment spawn count for a work item */
  function incrementSpawnCount(projectId: string, workItemId: string): void {
    const trackerKey = `${projectId}:${workItemId}`;
    let tracker = spawnTrackers.get(trackerKey);
    if (!tracker) {
      tracker = { count: 0, windowStart: new Date() };
      spawnTrackers.set(trackerKey, tracker);
    }
    tracker.count++;
  }

  /** Build session spawn config from work item and poller config */
  async function buildSpawnConfig(
    projectId: string,
    workItem: PollerWorkItem,
    pollerConfig: PollerConfig,
  ): Promise<SessionSpawnConfig> {
    const project = config.projects[projectId];
    const agentName = resolveAgentSelection({
      role: "worker",
      project,
      defaults: config.defaults,
      persistedAgent: pollerConfig.agent,
    }).agentName;

    // Build prompt from template if provided
    let prompt = pollerConfig.promptTemplate ?? "Fix the CI failure for PR: {{url}}";
    prompt = prompt.replace(/\{\{url\}\}/g, workItem.url);
    prompt = prompt.replace(/\{\{title\}\}/g, workItem.title);
    prompt = prompt.replace(/\{\{id\}\}/g, workItem.id);

    return {
      projectId,
      issueId: workItem.id,
      branch: `fix/${workItem.id}`,
      prompt,
      agent: agentName,
    };
  }

  /** Poll a single poller and spawn sessions for new work */
  async function pollOne(
    projectId: string,
    pollerConfig: PollerConfig,
    poller: Poller,
  ): Promise<void> {
    const correlationId = randomUUID();
    const startedAt = Date.now();

    try {
      const workItems = await poller.poll(projectId);

      observer.recordOperation({
        metric: "api_request",
        operation: "poller.poll",
        outcome: "success",
        correlationId,
        projectId,
        durationMs: Date.now() - startedAt,
        data: { workItemCount: workItems.length },
        level: "info",
      });

      // Check for existing sessions to avoid duplicates
      const existingSessions = await sessionManager.list(projectId);
      const existingWorkItemIds = new Set(
        existingSessions.filter((s) => s.issueId).map((s) => s.issueId as string),
      );

      // Spawn sessions for new work items
      for (const workItem of workItems) {
        // Skip if already being worked on
        if (existingWorkItemIds.has(workItem.id)) {
          continue;
        }

        // Check respawn cap
        if (isRespawnCapExceeded(projectId, workItem.id, pollerConfig)) {
          observer.recordOperation({
            metric: "api_request",
            operation: "poller.respawn_cap_exceeded",
            outcome: "success",
            correlationId,
            projectId,
            data: { workItemId: workItem.id },
            level: "info",
          });
          continue;
        }

        try {
          const spawnConfig = await buildSpawnConfig(projectId, workItem, pollerConfig);
          const session = await poller.spawnSession(workItem, projectId, spawnConfig);

          if (session) {
            incrementSpawnCount(projectId, workItem.id);
            observer.recordOperation({
              metric: "spawn",
              operation: "poller.spawn",
              outcome: "success",
              correlationId,
              projectId,
              sessionId: session.id,
              data: { workItem },
              level: "info",
            });
          }
        } catch (error) {
          observer.recordOperation({
            metric: "spawn",
            operation: "poller.spawn",
            outcome: "failure",
            correlationId,
            projectId,
            reason: error instanceof Error ? error.message : String(error),
            level: "warn",
          });
        }
      }
    } catch (error) {
      observer.recordOperation({
        metric: "api_request",
        operation: "poller.poll",
        outcome: "failure",
        correlationId,
        projectId,
        durationMs: Date.now() - startedAt,
        reason: error instanceof Error ? error.message : String(error),
        level: "warn",
      });
    }
  }

  /** Run one polling cycle across all pollers */
  async function pollAll(): Promise<void> {
    const enabledPollers = getEnabledPollers();

    await Promise.allSettled(
      enabledPollers.map(({ projectId, config: pollerConfig, poller }) =>
        pollOne(projectId, pollerConfig, poller),
      ),
    );
  }

  /** Run one polling cycle for pollers matching a specific interval */
  async function pollByInterval(interval: string): Promise<void> {
    const enabledPollers = getEnabledPollers().filter(
      ({ config: pollerConfig }) => pollerConfig.interval === interval,
    );

    await Promise.allSettled(
      enabledPollers.map(({ projectId, config: pollerConfig, poller }) =>
        pollOne(projectId, pollerConfig, poller),
      ),
    );
  }

  /** Start all pollers */
  function start(): void {
    // Collect all unique poll intervals
    const intervals = new Set<string>();
    for (const { config: pollerConfig } of getEnabledPollers()) {
      if (pollerConfig.interval) {
        intervals.add(pollerConfig.interval);
      }
    }

    // Start a timer for each unique interval
    for (const interval of intervals) {
      const intervalMs = parseDuration(interval);
      if (intervalMs <= 0) continue;

      // Avoid duplicate timers
      if (pollTimers.has(interval)) continue;

      const timer = setInterval(() => void pollByInterval(interval), intervalMs);
      pollTimers.set(interval, timer);
    }

    // Run immediately on start - only pollers without explicit intervals
    // Pollers with specific intervals will run on their timers
    for (const { projectId, config: pollerConfig, poller } of getEnabledPollers()) {
      if (!pollerConfig.interval) {
        void pollOne(projectId, pollerConfig, poller);
      }
    }
  }

  /** Stop all pollers */
  function stop(): void {
    for (const timer of pollTimers.values()) {
      clearInterval(timer);
    }
    pollTimers.clear();
  }

  return {
    start,
    stop,
    pollAll,
  };
}

export type { PollerManagerImpl as PollerManager };
