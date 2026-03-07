import { getServices, startBacklogPoller } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";
import { getAttentionLevel } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/events — SSE stream for real-time lifecycle events
 *
 * Sends session state updates to connected clients.
 * Also starts the lifecycle manager and backlog poller on first connection.
 */
export async function GET(): Promise<Response> {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let updates: ReturnType<typeof setInterval> | undefined;

  // Start backlog poller (idempotent — lifecycle manager is started in services.ts)
  startBacklogPoller();

  const stream = new ReadableStream({
    start(controller) {
      // Send initial snapshot
      void (async () => {
        try {
          const { sessionManager, lifecycleManager } = await getServices();
          const sessions = await sessionManager.list();
          const dashboardSessions = sessions.map(sessionToDashboard);

          // Include lifecycle state map for debugging/display
          const lifecycleStates = Object.fromEntries(lifecycleManager.getStates());

          const initialEvent = {
            type: "snapshot",
            sessions: dashboardSessions.map((s) => ({
              id: s.id,
              status: s.status,
              activity: s.activity,
              attentionLevel: getAttentionLevel(s),
              lastActivityAt: s.lastActivityAt,
            })),
            lifecycle: lifecycleStates,
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(initialEvent)}\n\n`));
        } catch {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "snapshot", sessions: [] })}\n\n`),
          );
        }
      })();

      // Send periodic heartbeat
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          clearInterval(heartbeat);
          clearInterval(updates);
        }
      }, 15000);

      // Poll for session state changes every 5 seconds
      updates = setInterval(() => {
        void (async () => {
          let dashboardSessions;
          try {
            const { sessionManager } = await getServices();
            const sessions = await sessionManager.list();
            dashboardSessions = sessions.map(sessionToDashboard);
          } catch {
            return;
          }

          try {
            const event = {
              type: "snapshot",
              sessions: dashboardSessions.map((s) => ({
                id: s.id,
                status: s.status,
                activity: s.activity,
                attentionLevel: getAttentionLevel(s),
                lastActivityAt: s.lastActivityAt,
              })),
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            clearInterval(updates);
            clearInterval(heartbeat);
          }
        })();
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
