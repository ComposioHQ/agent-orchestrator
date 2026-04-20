import { ACTIVITY_STATE, isOrchestratorSession, isTerminalSession } from "@aoagents/ao-core";
import { getServices, getSCM } from "@/lib/services";
import {
  sessionToDashboard,
  resolveProject,
  enrichSessionPR,
  enrichSessionsMetadata,
  computeStats,
  listDashboardOrchestrators,
} from "@/lib/serialize";
import { getCorrelationId, jsonWithCorrelation, recordApiObservation } from "@/lib/observability";
import { filterProjectSessions } from "@/lib/project-utils";
import { settlesWithin } from "@/lib/async-utils";

const METADATA_ENRICH_TIMEOUT_MS = 3_000;
const PR_ENRICH_TIMEOUT_MS = 4_000;
const PER_PR_ENRICH_TIMEOUT_MS = 1_500;

function compareOrchestratorRecency(a: { lastActivityAt?: Date | null; createdAt?: Date | null; id: string }, b: { lastActivityAt?: Date | null; createdAt?: Date | null; id: string }): number {
  return (
    (b.lastActivityAt?.getTime() ?? 0) - (a.lastActivityAt?.getTime() ?? 0) ||
    (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0) ||
    a.id.localeCompare(b.id)
  );
}

function listProjectOrchestratorSessions(
  sessions: Parameters<typeof listDashboardOrchestrators>[0],
  projects: Parameters<typeof listDashboardOrchestrators>[1],
): Parameters<typeof listDashboardOrchestrators>[0] {
  const allSessionPrefixes = Object.entries(projects).map(
    ([projectId, project]) => project.sessionPrefix ?? projectId,
  );

  const projectOrchestrators = sessions
    .filter((session) =>
      isOrchestratorSession(
        session,
        projects[session.projectId]?.sessionPrefix ?? session.projectId,
        allSessionPrefixes,
      ),
    )
    .sort(compareOrchestratorRecency);

  const liveOrchestrators = projectOrchestrators.filter((session) => !isTerminalSession(session));
  return liveOrchestrators.length > 0 ? liveOrchestrators : projectOrchestrators;
}

function selectPreferredOrchestratorId(
  sessions: Parameters<typeof listDashboardOrchestrators>[0],
  projects: Parameters<typeof listDashboardOrchestrators>[1],
): string | null {
  return listProjectOrchestratorSessions(sessions, projects)[0]?.id ?? null;
}

function listPreferredProjectOrchestrators(
  sessions: Parameters<typeof listDashboardOrchestrators>[0],
  projects: Parameters<typeof listDashboardOrchestrators>[1],
) {
  const preferredOrchestrators = listProjectOrchestratorSessions(sessions, projects);
  const liveOrchestrators = preferredOrchestrators.filter((session) => !isTerminalSession(session));
  return listDashboardOrchestrators(
    liveOrchestrators.length > 0 ? liveOrchestrators : preferredOrchestrators,
    projects,
  );
}

export async function GET(request: Request) {
  const correlationId = getCorrelationId(request);
  const startedAt = Date.now();
  try {
    const { searchParams } = new URL(request.url);
    const projectFilter = searchParams.get("project");
    const activeOnly = searchParams.get("active") === "true";
    const orchestratorOnly = searchParams.get("orchestratorOnly") === "true";

    const { config, registry, sessionManager } = await getServices();
    const requestedProjectId =
      projectFilter && projectFilter !== "all" && config.projects[projectFilter]
        ? projectFilter
        : undefined;
    const coreSessions = await sessionManager.listCached(requestedProjectId);
    const visibleSessions = filterProjectSessions(coreSessions, projectFilter, config.projects);
    const orchestrators = requestedProjectId
      ? listPreferredProjectOrchestrators(visibleSessions, config.projects)
      : listDashboardOrchestrators(visibleSessions, config.projects);
    const orchestratorId = requestedProjectId
      ? selectPreferredOrchestratorId(visibleSessions, config.projects)
      : (orchestrators.length === 1 ? (orchestrators[0]?.id ?? null) : null);

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

    const allSessionPrefixes = Object.entries(config.projects).map(
      ([projectId, p]) => p.sessionPrefix ?? projectId,
    );
    let workerSessions = visibleSessions.filter(
      (session) =>
        !isOrchestratorSession(
          session,
          config.projects[session.projectId]?.sessionPrefix ?? session.projectId,
          allSessionPrefixes,
        ),
    );

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
      const prEnrichPromises: Promise<boolean>[] = [];

      for (let i = 0; i < workerSessions.length; i++) {
        const core = workerSessions[i];
        if (!core?.pr) continue;

        const project = resolveProject(core, config.projects);
        const scm = getSCM(registry, project);
        if (!scm) continue;

        prEnrichPromises.push(
          settlesWithin(
            enrichSessionPR(dashboardSessions[i], scm, core.pr),
            PER_PR_ENRICH_TIMEOUT_MS,
          ),
        );
      }

      if (prEnrichPromises.length > 0) {
        await settlesWithin(Promise.allSettled(prEnrichPromises), PR_ENRICH_TIMEOUT_MS);
      }
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
