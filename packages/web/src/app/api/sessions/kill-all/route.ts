import { type NextRequest } from "next/server";
import { getServices } from "@/lib/services";
import {
  getCorrelationId,
  jsonWithCorrelation,
  recordApiObservation,
} from "@/lib/observability";

/** POST /api/sessions/kill-all — Kill all sessions */
export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  const startedAt = Date.now();

  try {
    const body = await request.json().catch(() => ({}));
    const projectId = typeof body.projectId === "string" ? body.projectId : undefined;

    const { config, sessionManager } = await getServices();
    const result = await sessionManager.killAll(projectId);

    recordApiObservation({
      config,
      method: "POST",
      path: "/api/sessions/kill-all",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 200,
      projectId,
    });

    return jsonWithCorrelation(result, { status: 200 }, correlationId);
  } catch (err) {
    const { config } = await getServices().catch(() => ({ config: undefined }));
    if (config) {
      recordApiObservation({
        config,
        method: "POST",
        path: "/api/sessions/kill-all",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        reason: err instanceof Error ? err.message : "Failed to kill all sessions",
      });
    }
    const msg = err instanceof Error ? err.message : "Failed to kill all sessions";
    return jsonWithCorrelation({ error: msg }, { status: 500 }, correlationId);
  }
}
