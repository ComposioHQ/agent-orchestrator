import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";
import {
  pollSessionsActivity,
  onActivity,
  type ActivityEvent,
  type SessionGitActivity,
} from "@/lib/git-activity";

export const dynamic = "force-dynamic";

/**
 * GET /api/activity — SSE stream for Mission Control activity events
 *
 * Sends:
 * - Initial snapshot of all session git activity
 * - Real-time commit/file change events as they happen
 * - Session state updates (PR opened, CI status, etc.)
 */
export async function GET(): Promise<Response> {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let poller: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;

  const stream = new ReadableStream({
    start(controller) {
      // Buffer for events to send
      const eventBuffer: ActivityEvent[] = [];
      let isSendingInitial = true;

      // Subscribe to real-time activity events
      unsubscribe = onActivity((event) => {
        if (isSendingInitial) {
          eventBuffer.push(event);
        } else {
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: "activity", event })}\n\n`),
            );
          } catch {
            // Stream closed
          }
        }
      });

      // Send initial snapshot
      void (async () => {
        try {
          const { config, sessionManager } = await getServices();
          const sessions = await sessionManager.list();
          const activeSessions = sessions.filter(
            (s) => !["done", "terminated", "killed"].includes(s.status),
          );
          const dashboardSessions = activeSessions.map(sessionToDashboard);

          // Get default branch from first project config
          const firstProject = Object.values(config.projects)[0];
          const defaultBranch = firstProject?.defaultBranch ?? "main";

          // Poll initial activity
          const activity = await pollSessionsActivity(dashboardSessions, defaultBranch);

          // Convert to serializable format
          const activitySnapshot: Record<string, SessionGitActivity> = {};
          for (const [id, act] of activity) {
            activitySnapshot[id] = {
              ...act,
              lastPolledAt: act.lastPolledAt,
              commits: act.commits.map((c) => ({
                ...c,
                timestamp: c.timestamp,
              })),
            };
          }

          // Send initial snapshot
          const initialEvent = {
            type: "snapshot",
            sessions: dashboardSessions.map((s) => ({
              id: s.id,
              branch: s.branch,
              status: s.status,
              activity: s.activity,
              pr: s.pr
                ? {
                    number: s.pr.number,
                    url: s.pr.url,
                    state: s.pr.state,
                    ciStatus: s.pr.ciStatus,
                  }
                : null,
            })),
            gitActivity: activitySnapshot,
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(initialEvent)}\n\n`));

          // Send any buffered events
          isSendingInitial = false;
          for (const event of eventBuffer) {
            try {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: "activity", event })}\n\n`),
              );
            } catch {
              break;
            }
          }
          eventBuffer.length = 0;
        } catch {
          // If services aren't available, send empty snapshot
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "snapshot", sessions: [], gitActivity: {} })}\n\n`,
            ),
          );
          isSendingInitial = false;
        }
      })();

      // Send periodic heartbeat
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          clearInterval(heartbeat);
          clearInterval(poller);
        }
      }, 15000);

      // Poll for git activity every 10 seconds
      poller = setInterval(() => {
        void (async () => {
          try {
            const { config, sessionManager } = await getServices();
            const sessions = await sessionManager.list();
            const activeSessions = sessions.filter(
              (s) => !["done", "terminated", "killed"].includes(s.status),
            );
            const dashboardSessions = activeSessions.map(sessionToDashboard);

            const firstProject = Object.values(config.projects)[0];
            const defaultBranch = firstProject?.defaultBranch ?? "main";

            // Poll activity — this will emit events via the subscription
            const activity = await pollSessionsActivity(dashboardSessions, defaultBranch);

            // Send session state update
            const stateUpdate = {
              type: "state_update",
              sessions: dashboardSessions.map((s) => ({
                id: s.id,
                status: s.status,
                activity: s.activity,
                pr: s.pr
                  ? {
                      number: s.pr.number,
                      state: s.pr.state,
                      ciStatus: s.pr.ciStatus,
                    }
                  : null,
              })),
              gitActivity: Object.fromEntries(
                Array.from(activity.entries()).map(([id, act]) => [
                  id,
                  {
                    commitsAhead: act.commitsAhead,
                    recentFiles: act.recentFiles.slice(0, 10),
                  },
                ]),
              ),
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(stateUpdate)}\n\n`));
          } catch {
            // Transient error — skip this poll
          }
        })();
      }, 10000);
    },
    cancel() {
      clearInterval(heartbeat);
      clearInterval(poller);
      if (unsubscribe) unsubscribe();
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
