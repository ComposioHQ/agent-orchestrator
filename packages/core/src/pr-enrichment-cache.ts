/**
 * Per-poll-cycle cache of PR enrichment data.
 *
 * The lifecycle manager populates this cache once at the top of each poll via
 * the SCM's batch GraphQL endpoint. Downstream status and reaction logic read
 * from it (instead of issuing their own REST calls) to avoid redundant API
 * traffic. Keys are formatted as `${owner}/${repo}#${number}`.
 */

import type {
  OrchestratorConfig,
  PluginRegistry,
  PREnrichmentData,
  SCM,
  Session,
} from "./types.js";
import { createCorrelationId, type ProjectObserver } from "./observability.js";

type Observer = ProjectObserver;

export interface PREnrichmentCache {
  get(key: string): PREnrichmentData | undefined;
  clear(): void;
  populate(sessions: Session[]): Promise<void>;
}

export interface PREnrichmentCacheDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  observer: Observer;
  scopedProjectId?: string;
}

export function createPREnrichmentCache(deps: PREnrichmentCacheDeps): PREnrichmentCache {
  const { config, registry, observer, scopedProjectId } = deps;
  const cache = new Map<string, PREnrichmentData>();

  async function populate(sessions: Session[]): Promise<void> {
    cache.clear();

    // Collect all unique PRs keyed by their owning session's project/plugin.
    const prsByPlugin = new Map<string, Array<NonNullable<Session["pr"]>>>();
    const seenPRKeys = new Set<string>();
    for (const session of sessions) {
      if (!session.pr) continue;
      const project = config.projects[session.projectId];
      if (!project?.scm?.plugin) continue;

      const prKey = `${session.pr.owner}/${session.pr.repo}#${session.pr.number}`;
      if (seenPRKeys.has(prKey)) continue;
      seenPRKeys.add(prKey);

      const pluginKey = project.scm.plugin;
      if (!prsByPlugin.has(pluginKey)) {
        prsByPlugin.set(pluginKey, []);
      }
      const pluginPRs = prsByPlugin.get(pluginKey);
      if (pluginPRs) {
        pluginPRs.push(session.pr);
      }
    }

    for (const [pluginKey, pluginPRs] of prsByPlugin) {
      const scm = registry.get<SCM>("scm", pluginKey);
      if (!scm?.enrichSessionsPRBatch) continue;

      const batchStartTime = Date.now();
      try {
        const enrichmentData = await scm.enrichSessionsPRBatch(pluginPRs, {
          recordSuccess(_data) {
            const batchDuration = Date.now() - batchStartTime;
            observer?.recordOperation({
              metric: "graphql_batch",
              operation: "batch_enrichment",
              correlationId: createCorrelationId("graphql-batch"),
              outcome: "success",
              projectId: scopedProjectId,
              durationMs: batchDuration,
              data: {
                plugin: pluginKey,
                prCount: pluginPRs.length,
                prKeys: pluginPRs.map((pr) => `${pr.owner}/${pr.repo}#${pr.number}`),
              },
              level: "info",
            });
          },
          recordFailure(data) {
            const batchDuration = Date.now() - batchStartTime;
            observer?.recordOperation({
              metric: "graphql_batch",
              operation: "batch_enrichment",
              correlationId: createCorrelationId("graphql-batch"),
              outcome: "failure",
              reason: data.error,
              level: "warn",
              data: {
                plugin: pluginKey,
                prCount: pluginPRs.length,
                error: data.error,
                durationMs: batchDuration,
              },
            });
          },
          log(level, message) {
            observer?.recordDiagnostic?.({
              operation: "batch_enrichment.log",
              correlationId: createCorrelationId("graphql-batch"),
              projectId: scopedProjectId,
              message,
              level,
              data: {
                plugin: pluginKey,
                source: "ao-graphql-batch",
              },
            });
          },
        });

        for (const [key, data] of enrichmentData) {
          cache.set(key, data);
        }
      } catch (err) {
        // Batch fetch failed - individual calls will still work
        const errorMsg = err instanceof Error ? err.message : String(err);
        const batchCorrelationId = createCorrelationId("batch-enrichment");
        observer?.recordOperation?.({
          metric: "lifecycle_poll",
          operation: "batch_enrichment",
          correlationId: batchCorrelationId,
          outcome: "failure",
          reason: errorMsg,
          level: "warn",
          data: { plugin: pluginKey, prCount: pluginPRs.length },
        });
      }
    }
  }

  return {
    get: (key) => cache.get(key),
    clear: () => cache.clear(),
    populate,
  };
}
