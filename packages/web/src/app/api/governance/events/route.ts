import { getGovernanceSnapshot } from "@/lib/governance-mock";

export const dynamic = "force-dynamic";

/**
 * GET /api/governance/events — SSE stream for real-time governance state
 *
 * Mirrors the pattern from /api/events but streams governance data
 * (proposals, forks, timeline) instead of session snapshots.
 */
export async function GET(request: Request): Promise<Response> {
  const encoder = new TextEncoder();
  const { searchParams } = new URL(request.url);
  const forkFilter = searchParams.get("fork") ?? undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let updates: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      // Send initial snapshot
      try {
        const snapshot = getGovernanceSnapshot(forkFilter);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`));
      } catch {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "governance_snapshot", emittedAt: new Date().toISOString(), proposals: [], forks: [], timeline: [] })}\n\n`,
          ),
        );
      }

      // Heartbeat every 15s
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          clearInterval(heartbeat);
          clearInterval(updates);
        }
      }, 15000);

      // Poll governance state every 5s
      updates = setInterval(() => {
        try {
          const snapshot = getGovernanceSnapshot(forkFilter);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`));
        } catch {
          clearInterval(updates);
          clearInterval(heartbeat);
        }
      }, 5000);
    },
    cancel() {
      clearInterval(heartbeat);
      clearInterval(updates);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
