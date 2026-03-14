import { buildDashboardPayload } from "@/lib/dashboard-data";
import { parseDashboardRouteState } from "@/lib/dashboard-route-state";
import { getCorrelationId, jsonWithCorrelation, recordApiObservation } from "@/lib/observability";
import { getServices } from "@/lib/services";

export async function GET(request: Request) {
  const correlationId = getCorrelationId(request);
  const startedAt = Date.now();
  try {
    const { searchParams } = new URL(request.url);
    const routeState = parseDashboardRouteState(searchParams);
    const projectFilter = routeState.project;
    const activeOnly = searchParams.get("active") === "true";

    const { config, registry, sessionManager } = await getServices();
    const payload = await buildDashboardPayload(
      {
        projectFilter,
        activeOnly,
        view: routeState.view,
      },
      { config, registry, sessionManager },
    );
    const orchestrators = payload.orchestrators;
    const orchestratorId = orchestrators.length === 1 ? (orchestrators[0]?.id ?? null) : null;

    recordApiObservation({
      config,
      method: "GET",
      path: "/api/sessions",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 200,
      data: { sessionCount: payload.sessions.length, activeOnly },
    });

    return jsonWithCorrelation(
      {
        sessions: payload.sessions,
        stats: payload.stats,
        orchestratorId,
        orchestrators,
        globalPause: payload.globalPause,
        view: payload.view,
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
