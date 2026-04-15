import { type NextRequest } from "next/server";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import { getAliveTmuxSessions } from "@/lib/tmux-async";

/** GET /api/tmux-sessions — List all tmux sessions on server */
export async function GET(request: NextRequest) {
  const correlationId = getCorrelationId(request);

  try {
    const sessions = Array.from(await getAliveTmuxSessions());
    return jsonWithCorrelation({ sessions }, { status: 200 }, correlationId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to list tmux sessions";
    return jsonWithCorrelation({ error: msg }, { status: 400 }, correlationId);
  }
}
