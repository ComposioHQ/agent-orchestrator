import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";
import { getAttentionLevel } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/events — SSE stream for real-time lifecycle events
 *
 * Sends session state updates to connected clients.
 * Polls SessionManager.list() on an interval (no SSE push from core yet).
 */
export async function GET(): Promise<Response> {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let updates: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      // Send initial snapshot
      void (async () => {
        try {
          const { sessionManager } = await getServices();
          const sessions = await sessionManager.list();
          const dashboardSessions = sessions.map(sessionToDashboard);

          const initialEvent = {
            type: "snapshot",
            sessions: dashboardSessions.map((s) => ({
              id: s.id,
              status: s.status,
              activity: s.activity,
              attentionLevel: getAttentionLevel(s),
              lastActivityAt: s.lastActivityAt,
            })),
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(initialEvent)}\n\n`));
        } catch {
          // If services aren't available, send empty snapshot
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
          try {
            const { sessionManager } = await getServices();
            const sessions = await sessionManager.list();
            const dashboardSessions = sessions.map(sessionToDashboard);

            for (const s of dashboardSessions) {
              const event = {
                type: "session.activity",
                sessionId: s.id,
                activity: s.activity,
                status: s.status,
                attentionLevel: getAttentionLevel(s),
                timestamp: new Date().toISOString(),
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            }
          } catch {
            // enqueue failure means the stream is closed — clean up both intervals
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
