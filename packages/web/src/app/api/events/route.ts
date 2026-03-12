import { getServices, startBacklogPoller } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";
import { getAttentionLevel } from "@/lib/types";
import { filterWorkerSessions } from "@/lib/project-utils";
import type { Session } from "@composio/ao-core";

export const dynamic = "force-dynamic";

/** GET /api/events — SSE stream for real-time lifecycle events
 * Query params:
 * - project: Filter to a specific project. "all" = no filter.
 */
export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const projectFilter = searchParams.get("project");

  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let updates: ReturnType<typeof setInterval> | undefined;

  const filterSessions = (
    sessions: Session[],
    config: { projects: Record<string, { sessionPrefix?: string }> },
  ) => filterWorkerSessions(sessions, projectFilter, config.projects);

  startBacklogPoller();

  const stream = new ReadableStream({
    start(controller) {
      void (async () => {
        try {
          const { sessionManager, config } = await getServices();
          const sessions = await sessionManager.list();
          const filteredSessions = filterSessions(sessions, config);
          const dashboardSessions = filteredSessions.map(sessionToDashboard);

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
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "snapshot", sessions: [] })}\n\n`),
          );
        }
      })();

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          clearInterval(heartbeat);
          clearInterval(updates);
        }
      }, 15000);

      updates = setInterval(() => {
        void (async () => {
          let dashboardSessions;
          try {
            const { sessionManager, config } = await getServices();
            const sessions = await sessionManager.list();
            const filteredSessions = filterSessions(sessions, config);
            dashboardSessions = filteredSessions.map(sessionToDashboard);
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
