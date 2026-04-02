import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";
import { getAttentionLevel } from "@/lib/types";
import { filterWorkerSessions } from "@/lib/project-utils";
import { loadTerminals } from "@/lib/standalone-terminals";
import { execFileSync } from "node:child_process";
import {
  createCorrelationId,
  createProjectObserver,
  type ProjectObserver,
} from "@composio/ao-core";

export const dynamic = "force-dynamic";

function findTmux(): string {
  const candidates = [
    "/opt/homebrew/bin/tmux",
    "/usr/local/bin/tmux",
    "/usr/bin/tmux",
  ];
  for (const p of candidates) {
    try {
      execFileSync(p, ["-V"], { timeout: 5000 });
      return p;
    } catch {
      continue;
    }
  }
  return "tmux";
}

function isTmuxSessionAlive(tmuxPath: string, tmuxName: string): boolean {
  try {
    execFileSync(tmuxPath, ["has-session", "-t", `=${tmuxName}`], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

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

          let terminalStatuses: Array<{ id: string; tmuxName: string; label: string; alive: boolean }> = [];
          try {
            const terminals = loadTerminals();
            const tmuxPath = findTmux();
            terminalStatuses = terminals.map((t) => ({
              id: t.id,
              tmuxName: t.tmuxName,
              label: t.label,
              alive: isTmuxSessionAlive(tmuxPath, t.tmuxName),
            }));
          } catch {
            // ignore terminal fetch errors
          }

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
            terminals: terminalStatuses,
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

      // Poll for session state changes every 3 seconds
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

            let terminalStatuses: Array<{ id: string; tmuxName: string; label: string; alive: boolean }> = [];
            try {
              const terminals = loadTerminals();
              const tmuxPath = findTmux();
              terminalStatuses = terminals.map((t) => ({
                id: t.id,
                tmuxName: t.tmuxName,
                label: t.label,
                alive: isTmuxSessionAlive(tmuxPath, t.tmuxName),
              }));
            } catch {
              // ignore terminal fetch errors
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
                terminals: terminalStatuses,
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
      }, 3000);
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
