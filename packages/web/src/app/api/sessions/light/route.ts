import { getServices } from "@/lib/services";
import {
  sessionToDashboard,
  listDashboardOrchestrators,
} from "@/lib/serialize";
import { getCorrelationId, jsonWithCorrelation, recordApiObservation } from "@/lib/observability";
import { resolveGlobalPause } from "@/lib/global-pause";
import { filterProjectSessions, filterWorkerSessions } from "@/lib/project-utils";

export async function GET(request: Request) {
  const correlationId = getCorrelationId(request);
  const startedAt = Date.now();
  try {
    const { searchParams } = new URL(request.url);
    const projectFilter = searchParams.get("project");

    const { config, sessionManager } = await getServices();
    const requestedProjectId =
      projectFilter && projectFilter !== "all" && config.projects[projectFilter]
        ? projectFilter
        : undefined;
    const coreSessions = await sessionManager.list(requestedProjectId);
    const visibleSessions = filterProjectSessions(coreSessions, projectFilter, config.projects);
    const orchestrators = listDashboardOrchestrators(visibleSessions, config.projects);

    const allSessions = requestedProjectId ? await sessionManager.list() : coreSessions;
    const workerSessions = filterWorkerSessions(coreSessions, projectFilter, config.projects);

    // Convert to dashboard format
    const dashboardSessions = workerSessions.map(sessionToDashboard);

    recordApiObservation({
      config,
      method: "GET",
      path: "/api/sessions/light",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 200,
      data: { sessionCount: dashboardSessions.length },
    });

    return jsonWithCorrelation(
      {
        sessions: dashboardSessions,
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
        path: "/api/sessions/light",
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
