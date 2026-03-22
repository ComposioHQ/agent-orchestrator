import { ACTIVITY_STATE, isOrchestratorSession } from "@composio/ao-core";
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
import { resolveGlobalPause } from "@/lib/global-pause";
import { filterProjectSessions } from "@/lib/project-utils";

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

export async function GET(request: Request) {
  const correlationId = getCorrelationId(request);
  const startedAt = Date.now();
  try {
    const { searchParams } = new URL(request.url);
    const projectFilter = searchParams.get("project");
    const activeOnly = searchParams.get("active") === "true";

    const { config, registry, sessionManager } = await getServices();
    const requestedProjectId =
      projectFilter && projectFilter !== "all" && config.projects[projectFilter]
        ? projectFilter
        : undefined;
    const coreSessions = await sessionManager.list(requestedProjectId);
    const allSessions = requestedProjectId ? await sessionManager.list() : coreSessions;
    const visibleSessions = filterProjectSessions(coreSessions, projectFilter, config.projects);
    const orchestrators = listDashboardOrchestrators(visibleSessions, config.projects);
    const orchestratorId = orchestrators.length === 1 ? (orchestrators[0]?.id ?? null) : null;

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
      const prDeadlineAt = Date.now() + PR_ENRICH_TIMEOUT_MS;
      for (let i = 0; i < workerSessions.length; i++) {
        const core = workerSessions[i];
        if (!core?.pr) continue;

        const remainingMs = prDeadlineAt - Date.now();
        if (remainingMs <= 0) break;

        const project = resolveProject(core, config.projects);
        const scm = getSCM(registry, project);
        if (!scm) continue;

        await settlesWithin(
          enrichSessionPR(dashboardSessions[i], scm, core.pr),
          Math.min(remainingMs, PER_PR_ENRICH_TIMEOUT_MS),
        );
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
