/**
 * Route timing wrapper — higher-order function for API route instrumentation.
 *
 * Wraps Next.js API route handlers with timing instrumentation, logging
 * each request's duration and status to the API request log.
 */

import type { ApiLogEntry } from "@composio/ao-core";
import { logApiRequest } from "./request-logger.js";

type RouteHandler = (req: Request, ctx?: unknown) => Promise<Response>;

/** Extract session ID from URL path (e.g., /api/sessions/ao-1/kill -> ao-1). */
function extractSessionId(path: string): string | null {
  const match = path.match(/\/sessions\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Wrap a route handler with timing instrumentation.
 * Logs method, path, status code, and duration for every request.
 */
export function withTiming(handler: RouteHandler, _routeName: string): RouteHandler {
  return async (req: Request, ctx?: unknown) => {
    const start = Date.now();
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const sessionId = extractSessionId(path);

    let response: Response;
    let error: string | undefined;

    try {
      response = await handler(req, ctx);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      response = new Response(JSON.stringify({ error: error }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const durationMs = Date.now() - start;

    const log: ApiLogEntry = {
      ts: new Date().toISOString(),
      method,
      path,
      sessionId,
      statusCode: response.status,
      durationMs,
      error,
    };

    logApiRequest(log);

    return response;
  };
}

/**
 * Create a timing context for manual instrumentation within a route.
 * Use when you need to log sub-operation timings (e.g., PR enrichment).
 */
export function createTimingContext(): TimingContext {
  return {
    timings: {},
    start: Date.now(),
    mark(name: string, startMs: number): void {
      this.timings[name] = Date.now() - startMs;
    },
  };
}

export interface TimingContext {
  timings: Record<string, number>;
  start: number;
  mark(name: string, startMs: number): void;
}
