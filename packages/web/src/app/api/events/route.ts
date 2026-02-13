import { mockSessions } from "@/lib/mock-data";
import { getAttentionLevel } from "@/lib/types";

/**
 * GET /api/events — SSE stream for real-time lifecycle events
 *
 * Sends session state updates to connected clients.
 * In production, this will be wired to the core EventBus.
 */
export async function GET(): Promise<Response> {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Send initial state
      const initialEvent = {
        type: "snapshot",
        sessions: mockSessions.map((s) => ({
          id: s.id,
          status: s.status,
          activity: s.activity,
          attentionLevel: getAttentionLevel(s),
          lastActivityAt: s.lastActivityAt,
        })),
      };
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify(initialEvent)}\n\n`),
      );

      // Send periodic heartbeat
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15000);

      // Simulate activity updates every 5 seconds
      const updates = setInterval(() => {
        try {
          const randomSession = mockSessions[Math.floor(Math.random() * mockSessions.length)];
          const event = {
            type: "session.activity",
            sessionId: randomSession.id,
            activity: randomSession.activity,
            status: randomSession.status,
            attentionLevel: getAttentionLevel(randomSession),
            timestamp: new Date().toISOString(),
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          clearInterval(updates);
          clearInterval(heartbeat);
        }
      }, 5000);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
