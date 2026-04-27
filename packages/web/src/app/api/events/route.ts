import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";
import { getAttentionLevel } from "@/lib/types";
import { filterWorkerSessions } from "@/lib/project-utils";
import {
  createCorrelationId,
  createProjectObserver,
  type ProjectObserver,
} from "@aoagents/ao-core";

export const dynamic = "force-dynamic";

const SESSION_EVENTS_POLL_INTERVAL_MS = 5000;

/**
 * GET /api/events — SSE stream for real-time lifecycle events
 *
 * Sends session state updates to connected clients.
 * Polls SessionManager.list() on an interval (no SSE push from core yet).
 */
export async function GET(request: Request): Promise<Response> {
  const encoder = new TextEncoder();
  const correlationId = createCorrelationId("sse");
  const { searchParams } = new URL(request.url);
  const projectFilter = searchParams.get("project");
  type ServicesConfig = Awaited<ReturnType<typeof getServices>>["config"];
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let updates: ReturnType<typeof setInterval> | undefined;
  let observerProjectId: string | undefined;
  let observer: ProjectObserver | null = null;
  let streamClosed = false;

  const ensureObserver = (config: ServicesConfig): ProjectObserver | null => {
    if (!observerProjectId) {
      const requestedProjectId =
        projectFilter && projectFilter !== "all" && config.projects[projectFilter]
          ? projectFilter
          : undefined;
      observerProjectId = requestedProjectId ?? Object.keys(config.projects)[0];
    }
    if (!observerProjectId) return null;
    if (!observer) {
      observer = createProjectObserver(config, "web-events");
    }
    return observer;
  };

  const stopStream = () => {
    if (streamClosed) return;
    streamClosed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (updates) clearInterval(updates);
  };

  const encodeEvent = (payload: unknown) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);

  const stream = new ReadableStream({
    start(controller) {
      const safeEnqueue = (payload: unknown): boolean => {
        if (streamClosed) return false;
        try {
          controller.enqueue(encodeEvent(payload));
          return true;
        } catch {
          stopStream();
          return false;
        }
      };

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

          const attentionZones = config.dashboard?.attentionZones ?? "simple";
          const initialEvent = {
            type: "snapshot",
            correlationId,
            emittedAt: new Date().toISOString(),
            sessions: dashboardSessions.map((s) => ({
              id: s.id,
              status: s.status,
              activity: s.activity,
              attentionLevel: getAttentionLevel(s, attentionZones),
              lastActivityAt: s.lastActivityAt,
            })),
          };
          safeEnqueue(initialEvent);
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
        } catch (error) {
          safeEnqueue({
            type: "error",
            correlationId,
            emittedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : "Failed to load live dashboard data",
          });
        }
      })();

      // Send periodic heartbeat
      heartbeat = setInterval(() => {
        if (streamClosed) return;
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          stopStream();
        }
      }, 15000);

      // Poll for session state changes frequently enough that new workers
      // appear in the dashboard/sidebar quickly after the orchestrator spawns them.
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
              const attentionZones = config.dashboard?.attentionZones ?? "simple";
              const event = {
                type: "snapshot",
                correlationId,
                emittedAt: new Date().toISOString(),
                sessions: dashboardSessions.map((s) => ({
                  id: s.id,
                  status: s.status,
                  activity: s.activity,
                  attentionLevel: getAttentionLevel(s, attentionZones),
                  lastActivityAt: s.lastActivityAt,
                })),
              };
              safeEnqueue(event);
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
            } catch (error) {
              safeEnqueue({
                type: "error",
                correlationId,
                emittedAt: new Date().toISOString(),
                error: error instanceof Error ? error.message : "Live dashboard update failed",
              });
            }
          } catch (error) {
            safeEnqueue({
              type: "error",
              correlationId,
              emittedAt: new Date().toISOString(),
              error: error instanceof Error ? error.message : "Live dashboard update failed",
            });
          }
        })();
      }, SESSION_EVENTS_POLL_INTERVAL_MS);
    },
    cancel() {
      stopStream();
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
