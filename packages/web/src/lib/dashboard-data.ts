import type { OrchestratorConfig, PluginRegistry, Session, SessionManager } from "@composio/ao-core";
import {
  computeStats,
  enrichSessionPR,
  enrichSessionsMetadata,
  listDashboardOrchestrators,
  resolveProject,
  sessionToDashboard,
} from "@/lib/serialize";
import { prCache, prCacheKey } from "@/lib/cache";
import { resolveGlobalPause } from "@/lib/global-pause";
import { filterProjectSessions, filterWorkerSessions } from "@/lib/project-utils";
import { getSCM, getServices } from "@/lib/services";
import type { DashboardOrchestratorLink, DashboardPayload, DashboardSession } from "@/lib/types";

const METADATA_ENRICH_TIMEOUT_MS = 3_000;
const PR_ENRICH_TIMEOUT_MS = 4_000;
const PER_PR_ENRICH_TIMEOUT_MS = 1_500;
const TERMINAL_STATUSES = new Set(["merged", "killed", "cleanup", "done", "terminated"]);

interface BuildDashboardPayloadOptions {
  projectFilter?: string | null;
  activeOnly?: boolean;
  view?: DashboardPayload["view"];
}

interface DashboardSourceContext {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<boolean>((resolve) => {
    timeoutId = setTimeout(() => resolve(false), timeoutMs);
  });

  try {
    return await Promise.race([promise.then(() => true).catch(() => true), timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function applyCachedPREnrichment(session: DashboardSession, coreSession: Session): boolean {
  if (!coreSession.pr || !session.pr) return false;

  const cacheKey = prCacheKey(coreSession.pr.owner, coreSession.pr.repo, coreSession.pr.number);
  const cached = prCache.get(cacheKey);
  if (!cached) return false;

  session.pr.state = cached.state;
  session.pr.title = cached.title;
  session.pr.additions = cached.additions;
  session.pr.deletions = cached.deletions;
  session.pr.ciStatus = cached.ciStatus;
  session.pr.reviewDecision = cached.reviewDecision;
  session.pr.ciChecks = cached.ciChecks.map((check) => ({
    name: check.name,
    status: check.status,
    url: check.url,
  }));
  session.pr.mergeability = cached.mergeability;
  session.pr.unresolvedThreads = cached.unresolvedThreads;
  session.pr.unresolvedComments = cached.unresolvedComments;
  return true;
}

async function enrichDashboardPayloadSessions(
  workerSessions: Session[],
  dashboardSessions: DashboardSession[],
  context: DashboardSourceContext,
): Promise<void> {
  const metadataSettled = await settlesWithin(
    enrichSessionsMetadata(workerSessions, dashboardSessions, context.config, context.registry),
    METADATA_ENRICH_TIMEOUT_MS,
  );

  if (!metadataSettled) {
    return;
  }

  const prDeadlineAt = Date.now() + PR_ENRICH_TIMEOUT_MS;
  for (let index = 0; index < workerSessions.length; index++) {
    const coreSession = workerSessions[index];
    const dashboardSession = dashboardSessions[index];
    if (!coreSession?.pr || !dashboardSession) continue;

    const hadCachedPR = applyCachedPREnrichment(dashboardSession, coreSession);
    if (
      hadCachedPR &&
      (TERMINAL_STATUSES.has(coreSession.status) ||
        dashboardSession.pr?.state === "merged" ||
        dashboardSession.pr?.state === "closed")
    ) {
      continue;
    }

    const remainingMs = prDeadlineAt - Date.now();
    if (remainingMs <= 0) break;

    const project = resolveProject(coreSession, context.config.projects);
    const scm = getSCM(context.registry, project);
    if (!scm) continue;

    await settlesWithin(
      enrichSessionPR(dashboardSession, scm, coreSession.pr),
      Math.min(remainingMs, PER_PR_ENRICH_TIMEOUT_MS),
    );
  }
}

function buildDashboardSessions(
  allSessions: Session[],
  projectFilter: string | null | undefined,
  config: OrchestratorConfig,
  activeOnly: boolean,
): {
  workerSessions: Session[];
  dashboardSessions: DashboardSession[];
  orchestrators: DashboardOrchestratorLink[];
} {
  const visibleSessions = filterProjectSessions(allSessions, projectFilter, config.projects);
  const orchestrators = listDashboardOrchestrators(visibleSessions, config.projects);

  let workerSessions = filterWorkerSessions(allSessions, projectFilter, config.projects);
  let dashboardSessions = workerSessions.map(sessionToDashboard);

  if (activeOnly) {
    const activeIndices = dashboardSessions
      .map((session, index) => (session.activity !== "exited" ? index : -1))
      .filter((index) => index !== -1);
    workerSessions = activeIndices.map((index) => workerSessions[index]);
    dashboardSessions = activeIndices.map((index) => dashboardSessions[index]);
  }

  return { workerSessions, dashboardSessions, orchestrators };
}

export async function buildDashboardPayload(
  options: BuildDashboardPayloadOptions = {},
  sourceContext?: DashboardSourceContext,
): Promise<DashboardPayload> {
  const context = sourceContext ?? (await getServices());
  const requestedProjectId =
    options.projectFilter &&
    options.projectFilter !== "all" &&
    context.config.projects[options.projectFilter]
      ? options.projectFilter
      : undefined;

  const scopedSessions = await context.sessionManager.list(requestedProjectId);
  const allSessions = requestedProjectId ? await context.sessionManager.list() : scopedSessions;
  const { workerSessions, dashboardSessions, orchestrators } = buildDashboardSessions(
    scopedSessions,
    options.projectFilter,
    context.config,
    options.activeOnly ?? false,
  );

  await enrichDashboardPayloadSessions(workerSessions, dashboardSessions, context);

  return {
    sessions: dashboardSessions,
    stats: computeStats(dashboardSessions),
    orchestrators,
    globalPause: resolveGlobalPause(allSessions),
    view: options.view ?? "legacy",
  };
}
