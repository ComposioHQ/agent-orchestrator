import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";
import { getAttentionLevel } from "@/lib/types";
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
export async function GET(): Promise<Response> {
  const encoder = new TextEncoder();
  const correlationId = createCorrelationId("sse");
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let updates: ReturnType<typeof setInterval> | undefined;
  let observerProjectId: string | undefined;
  let observer: ProjectObserver | null = null;

  const ensureObserver = (config: {
    projects: Record<string, unknown>;
  }): ProjectObserver | null => {
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
      })();

      // Send initial snapshot
      void (async () => {
        try {
          const { config, sessionManager } = await getServices();
          const sessions = await sessionManager.list();
          const dashboardSessions = sessions.map(sessionToDashboard);
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
            const sessions = await sessionManager.list();
            dashboardSessions = sessions.map(sessionToDashboard);
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
