import { type NextRequest } from "next/server";
import { getServices } from "@/lib/services";
import {
  getCorrelationId,
  getObservabilitySummary,
  jsonWithCorrelation,
  recordApiObservation,
} from "@/lib/observability";

export async function GET(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  const startedAt = Date.now();

  try {
    const { config } = await getServices();
    const summary = getObservabilitySummary(config);
    recordApiObservation({
      config,
      method: "GET",
      path: "/api/observability",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 200,
      data: {
        projectCount: Object.keys(summary.projects).length,
        overallStatus: summary.overallStatus,
      },
    });
    return jsonWithCorrelation(summary, { status: 200 }, correlationId);
  } catch (err) {
    const { config } = await getServices().catch(() => ({ config: undefined }));
    if (config) {
      recordApiObservation({
        config,
        method: "GET",
        path: "/api/observability",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        reason: err instanceof Error ? err.message : "Failed to read observability summary",
      });
    }
    return jsonWithCorrelation(
      { error: err instanceof Error ? err.message : "Failed to read observability summary" },
      { status: 500 },
      correlationId,
    );
  }
}
