import { type NextRequest } from "next/server";
import { getServices } from "@/lib/services";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";

/** GET /api/agents — list registered agent plugins */
export async function GET(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  try {
    const { registry } = await getServices();
    const agents = registry.list("agent");
    return jsonWithCorrelation(
      {
        agents: agents.map((a: { name: string; description?: string }) => ({
          name: a.name,
          description: a.description,
        })),
      },
      { status: 200 },
      correlationId,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to list agents";
    return jsonWithCorrelation({ error: msg }, { status: 500 }, correlationId);
  }
}
