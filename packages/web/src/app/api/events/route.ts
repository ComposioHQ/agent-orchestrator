import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";
import { getAttentionLevel } from "@/lib/types";
import { filterWorkerSessions } from "@/lib/project-utils";
import {
  createCorrelationId,
  createProjectObserver,
  type ProjectObserver,
} from "@composio/ao-core";

export const dynamic = "force-dynamic";

/**
 * GET /api/events — SSE stream for real-time lifecycle events
 *
 * Sends session state updates to connected clients.
 * Polls SessionManager.list() on an interval (no SSE push from core yet).
 */
export async function GET(request: Request): Promise<Response> {
  const effectiveRequest = request ?? new Request("http://localhost/api/events");
  const encoder = new TextEncoder();
  const correlationId = createCorrelationId("sse");
  const { searchParams } = new URL(effectiveRequest.url);
  const projectFilter = searchParams.get("project");
  type ServicesConfig = Awaited<ReturnType<typeof getServices>>["config"];
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let updates: ReturnType<typeof setInterval> | undefined;
  let observerProjectId: string | undefined;
  let observer: ProjectObserver | null = null;

  const ensureObserver = (config: ServicesConfig): ProjectObserver | null => {
    if (!observerProjectId) {
      observerProjectId = Object.keys(config.projects)[0];
    }
    if (!observerProjectId) return null;
    if (!observer) {
      observer = createProjectObserver(config, "web-events");
    }
    return observer;
  };

  const stream = new ReadableStream({
    start(controller) {
      void (async () => {
        try {
          const { config } = await getServices();
          const projectObserver = ensureObserver(config);
          if (projectObserver && observerProjectId) {
            projectObserver.recordOperation({
              metric: "sse_connect",
              operation: "sse.connect",
              outcome: "success",
              correlationId,
              projectId: observerProjectId,
              data: { path: "/api/events" },
              level: "info",
            });
            projectObserver.setHealth({
              surface: "sse.events",
              status: "ok",
              projectId: observerProjectId,
              correlationId,
              details: { projectId: observerProjectId, connection: "open" },
            });
          }
        } catch {
          void 0;
        }

        try {
          const { config, sessionManager } = await getServices();
          const requestedProjectId =
            projectFilter && projectFilter !== "all" && config.projects[projectFilter]
              ? projectFilter
              : undefined;
          const sessions = await sessionManager.list(requestedProjectId);
          const workerSessions = filterWorkerSessions(sessions, projectFilter, config.projects);
          const dashboardSessions = workerSessions.map(sessionToDashboard);
          const projectObserver = ensureObserver(config);

          const initialEvent = {
            type: "snapshot",
            correlationId,
            emittedAt: new Date().toISOString(),
            sessions: dashboardSessions.map((s) => ({
              id: s.id,
              status: s.status,
              activity: s.activity,
              attentionLevel: getAttentionLevel(s),
              lastActivityAt: s.lastActivityAt,
            })),
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(initialEvent)}\n\n`));
          if (projectObserver && observerProjectId) {
            projectObserver.recordOperation({
              metric: "sse_snapshot",
              operation: "sse.snapshot",
              outcome: "success",
              correlationId,
              projectId: observerProjectId,
              data: { sessionCount: dashboardSessions.length, initial: true },
              level: "info",
            });
          }
        } catch {
          // If services aren't available, send empty snapshot
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "snapshot", correlationId, emittedAt: new Date().toISOString(), sessions: [] })}\n\n`,
            ),
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
            const { config, sessionManager } = await getServices();
            const requestedProjectId =
              projectFilter && projectFilter !== "all" && config.projects[projectFilter]
                ? projectFilter
                : undefined;
            const sessions = await sessionManager.list(requestedProjectId);
            const workerSessions = filterWorkerSessions(sessions, projectFilter, config.projects);
            dashboardSessions = workerSessions.map(sessionToDashboard);
            const projectObserver = ensureObserver(config);

            if (projectObserver && observerProjectId) {
              projectObserver.setHealth({
                surface: "sse.events",
                status: "ok",
                projectId: observerProjectId,
                correlationId,
                details: {
                  projectId: observerProjectId,
                  sessionCount: dashboardSessions.length,
                  lastEventAt: new Date().toISOString(),
                },
              });
            }

            try {
              const event = {
                type: "snapshot",
                correlationId,
                emittedAt: new Date().toISOString(),
                sessions: dashboardSessions.map((s) => ({
                  id: s.id,
                  status: s.status,
                  activity: s.activity,
                  attentionLevel: getAttentionLevel(s),
                  lastActivityAt: s.lastActivityAt,
                })),
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
              if (projectObserver && observerProjectId) {
                projectObserver.recordOperation({
                  metric: "sse_snapshot",
                  operation: "sse.snapshot",
                  outcome: "success",
                  correlationId,
                  projectId: observerProjectId,
                  data: { sessionCount: dashboardSessions.length, initial: false },
                  level: "info",
                });
              }
            } catch {
              // enqueue failure means the stream is closed — clean up both intervals
              clearInterval(updates);
              clearInterval(heartbeat);
            }
          } catch {
            // Transient service error — skip this poll, retry on next interval
            return;
          }
        })();
      }, 5000);
    },
    cancel() {
      clearInterval(heartbeat);
      clearInterval(updates);
      void (async () => {
        try {
          const { config } = await getServices();
          const projectObserver = ensureObserver(config);
          if (!projectObserver || !observerProjectId) return;
          projectObserver.recordOperation({
            metric: "sse_disconnect",
            operation: "sse.disconnect",
            outcome: "success",
            correlationId,
            projectId: observerProjectId,
            data: { path: "/api/events" },
            level: "info",
          });
          projectObserver.setHealth({
            surface: "sse.events",
            status: "warn",
            projectId: observerProjectId,
            correlationId,
            reason: "SSE connection closed",
            details: { projectId: observerProjectId, connection: "closed" },
          });
        } catch {
          void 0;
        }
      })();
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
