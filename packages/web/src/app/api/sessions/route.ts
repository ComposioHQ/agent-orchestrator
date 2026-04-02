import { ACTIVITY_STATE, isOrchestratorSession, resolveProjectConfig } from "@composio/ao-core";
import { getServices, getSCM } from "@/lib/services";
import { getPortfolioServices, getCachedPortfolioSessions } from "@/lib/portfolio-services";
import {
  sessionToDashboard,
  resolveProject,
  enrichSessionPR,
  enrichSessionsMetadata,
  computeStats,
  listDashboardOrchestrators,
} from "@/lib/serialize";
import { getCorrelationId, jsonWithCorrelation, recordApiObservation } from "@/lib/observability";
import { resolveGlobalPause } from "@/lib/global-pause";
import { filterProjectSessions } from "@/lib/project-utils";
import { getAttentionLevel, getTriageRank, type PortfolioActionItem, type DashboardSession } from "@/lib/types";

const METADATA_ENRICH_TIMEOUT_MS = 3_000;
const PR_ENRICH_TIMEOUT_MS = 4_000;
const PER_PR_ENRICH_TIMEOUT_MS = 1_500;

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

/** Handle scope=portfolio: aggregate sessions across all portfolio projects */
async function handlePortfolioScope(correlationId: string, _startedAt: number) {
  const { portfolio } = getPortfolioServices();
  const portfolioSessions = await getCachedPortfolioSessions();

  const dashboardSessions: DashboardSession[] = [];
  const actionItems: PortfolioActionItem[] = [];

  for (const ps of portfolioSessions) {
    if (isOrchestratorSession(ps.session)) continue;
    const dashSession = sessionToDashboard(ps.session);
    dashboardSessions.push(dashSession);
    const level = getAttentionLevel(dashSession);
    actionItems.push({
      session: dashSession,
      projectId: ps.project.id,
      projectName: ps.project.name,
      attentionLevel: level,
      triageRank: getTriageRank(level),
    });
  }

  // Enrich PRs with live data (best-effort, with timeout)
  try {
    const { registry } = await getServices();
    const enrichPromises: Promise<unknown>[] = [];
    for (const ps of portfolioSessions) {
      if (isOrchestratorSession(ps.session) || !ps.session.pr) continue;
      const resolved = resolveProjectConfig(ps.project);
      if (!resolved) continue;
      const scm = getSCM(registry, resolved.project);
      if (!scm) continue;
      const dashSession = dashboardSessions.find(d => d.id === ps.session.id);
      if (!dashSession) continue;
      enrichPromises.push(enrichSessionPR(dashSession, scm, ps.session.pr));
    }
    await settlesWithin(Promise.allSettled(enrichPromises), PR_ENRICH_TIMEOUT_MS);

    // Recompute attention levels after enrichment
    for (const item of actionItems) {
      item.attentionLevel = getAttentionLevel(item.session);
      item.triageRank = getTriageRank(item.attentionLevel);
    }
  } catch {
    // Enrichment failure is non-fatal
  }

  actionItems.sort((a, b) => {
    if (a.triageRank !== b.triageRank) return a.triageRank - b.triageRank;
    return new Date(b.session.lastActivityAt).getTime() - new Date(a.session.lastActivityAt).getTime();
  });

  const projectSummaries = portfolio.map(p => ({
    id: p.id,
    name: p.name,
    degraded: p.degraded,
    degradedReason: p.degradedReason,
  }));

  return jsonWithCorrelation(
    {
      sessions: dashboardSessions,
      actionItems,
      stats: computeStats(dashboardSessions),
      projectSummaries,
    },
    { status: 200 },
    correlationId,
  );
}

export async function GET(request: Request) {
  const correlationId = getCorrelationId(request);
  const startedAt = Date.now();
  try {
    const { searchParams } = new URL(request.url);
    const scope = searchParams.get("scope");
    const projectFilter = searchParams.get("project");
    const activeOnly = searchParams.get("active") === "true";
    const orchestratorOnly = searchParams.get("orchestratorOnly") === "true";

    // Portfolio scope: aggregate across all portfolio projects
    if (scope === "portfolio") {
      return await handlePortfolioScope(correlationId, startedAt);
    }

    const { config, registry, sessionManager } = await getServices();
    const requestedProjectId =
      projectFilter && projectFilter !== "all" && config.projects[projectFilter]
        ? projectFilter
        : undefined;
    const coreSessions = await sessionManager.list(requestedProjectId);
    const visibleSessions = filterProjectSessions(coreSessions, projectFilter, config.projects);
    const orchestrators = listDashboardOrchestrators(visibleSessions, config.projects);
    const orchestratorId = orchestrators.length === 1 ? (orchestrators[0]?.id ?? null) : null;

    if (orchestratorOnly) {
      recordApiObservation({
        config,
        method: "GET",
        path: "/api/sessions",
        correlationId,
        startedAt,
        outcome: "success",
        statusCode: 200,
        data: { orchestratorOnly: true, orchestratorCount: orchestrators.length },
      });

      return jsonWithCorrelation(
        {
          orchestratorId,
          orchestrators,
          sessions: [],
        },
        { status: 200 },
        correlationId,
      );
    }

    const allSessions = requestedProjectId ? await sessionManager.list() : coreSessions;

    let workerSessions = visibleSessions.filter((session) => !isOrchestratorSession(session));

    // Convert to dashboard format
    let dashboardSessions = workerSessions.map(sessionToDashboard);

    if (activeOnly) {
      const activeIndices = dashboardSessions
        .map((session, index) => (session.activity !== ACTIVITY_STATE.EXITED ? index : -1))
        .filter((index) => index !== -1);
      workerSessions = activeIndices.map((index) => workerSessions[index]);
      dashboardSessions = activeIndices.map((index) => dashboardSessions[index]);
    }

    const metadataSettled = await settlesWithin(
      enrichSessionsMetadata(workerSessions, dashboardSessions, config, registry),
      METADATA_ENRICH_TIMEOUT_MS,
    );

    if (metadataSettled) {
      const enrichPromises = workerSessions.map((core, i) => {
        if (!core?.pr) return Promise.resolve();

        const project = resolveProject(core, config.projects);
        const scm = getSCM(registry, project);
        if (!scm) return Promise.resolve();

        return settlesWithin(
          enrichSessionPR(dashboardSessions[i], scm, core.pr),
          PER_PR_ENRICH_TIMEOUT_MS,
        );
      });

      await settlesWithin(Promise.allSettled(enrichPromises), PR_ENRICH_TIMEOUT_MS);
    }

    recordApiObservation({
      config,
      method: "GET",
      path: "/api/sessions",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 200,
      data: { sessionCount: dashboardSessions.length, activeOnly },
    });

    return jsonWithCorrelation(
      {
        sessions: dashboardSessions,
        stats: computeStats(dashboardSessions),
        orchestratorId,
        orchestrators,
        globalPause: resolveGlobalPause(allSessions),
      },
      { status: 200 },
      correlationId,
    );
  } catch (err) {
    const { config } = await getServices().catch(() => ({ config: undefined }));
    if (config) {
      recordApiObservation({
        config,
        method: "GET",
        path: "/api/sessions",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        reason: err instanceof Error ? err.message : "Failed to list sessions",
      });
    }
    return jsonWithCorrelation(
      { error: err instanceof Error ? err.message : "Failed to list sessions" },
      { status: 500 },
      correlationId,
    );
  }
}
