import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import { getTerminalTransportHealth } from "@/lib/terminal-transport";

export async function GET(request: Request) {
  const correlationId = getCorrelationId(request);
  const health = await getTerminalTransportHealth();
  return jsonWithCorrelation(health, { status: 200 }, correlationId);
}
