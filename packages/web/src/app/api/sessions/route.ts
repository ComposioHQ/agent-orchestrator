import { ACTIVITY_STATE, isOrchestratorSession, type Session } from "@aoagents/ao-core";
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
import type { DashboardOrchestratorLink } from "@/lib/types";
import { selectCanonicalProjectOrchestrator } from "@/lib/orchestrator-utils";

const METADATA_ENRICH_TIMEOUT_MS = 3_000;
const PR_ENRICH_TIMEOUT_MS = 4_000;
const PER_PR_ENRICH_TIMEOUT_MS = 1_500;

function hasTerminalPRState(session: Session): boolean {
  const prState = session.lifecycle?.pr.state;
  return prState === "merged" || prState === "closed";
}
export async function GET(request: Request) {
  const correlationId = getCorrelationId(request);
  const startedAt = Date.now();
  try {
    const { searchParams } = new URL(request.url);
    const projectFilter = searchParams.get("project");
    const activeOnly = searchParams.get("active") === "true";
    const orchestratorOnly = searchParams.get("orchestratorOnly") === "true";
    const fresh = searchParams.get("fresh") === "true";

    const { config, registry, sessionManager } = await getServices();
    const requestedProjectId =
      projectFilter && projectFilter !== "all" && config.projects[projectFilter]
        ? projectFilter
        : undefined;
    const coreSessions = fresh
      ? await sessionManager.list(requestedProjectId)
      : await sessionManager.listCached(requestedProjectId);
    const visibleSessions = filterProjectSessions(coreSessions, projectFilter, config.projects);
    const allSessionPrefixes = Object.entries(config.projects).map(
      ([projectId, p]) => p.sessionPrefix ?? projectId,
    );
    const orchestrators = requestedProjectId
      ? (() => {
          const project = config.projects[requestedProjectId];
          const canonical = project
            ? selectCanonicalProjectOrchestrator(
                visibleSessions,
                project.sessionPrefix ?? requestedProjectId,
                allSessionPrefixes,
              )
            : null;
          return canonical
            ? [{
                id: canonical.id,
                projectId: canonical.projectId,
                projectName: project?.name ?? canonical.projectId,
              } satisfies DashboardOrchestratorLink]
            : [];
        })()
      : listDashboardOrchestrators(visibleSessions, config.projects);
    const orchestratorId =
      requestedProjectId || orchestrators.length === 1 ? (orchestrators[0]?.id ?? null) : null;

    if (orchestratorOnly) {
      recordApiObservation({
        config,
        method: "GET",
        path: "/api/sessions",
        correlationId,
        startedAt,
        outcome: "success",
        statusCode: 200,
        data: { orchestratorOnly: true, orchestratorCount: orchestrators.length, fresh },
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
        const pr = core?.pr;
        if (!pr) continue;

        const project = resolveProject(core, config.projects);
        const scm = getSCM(registry, project);
        if (!scm) continue;

        prEnrichPromises.push(
          settlesWithin(
            hasTerminalPRState(core)
              ? enrichSessionPR(dashboardSessions[i], scm, pr, { cacheOnly: true }).then(
                  (cached) =>
                    cached
                      ? true
                      : enrichSessionPR(dashboardSessions[i], scm, pr),
                )
              : enrichSessionPR(dashboardSessions[i], scm, pr),
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
      data: { sessionCount: dashboardSessions.length, activeOnly, fresh },
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
