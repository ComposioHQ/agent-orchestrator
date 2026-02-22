import { NextResponse } from "next/server";
import { resolveProjectLogDir, loadConfig } from "@composio/ao-core";
import { getRequestStats } from "@/lib/request-logger";

function resolveLogDir(): string {
  const dir = resolveProjectLogDir(loadConfig());
  if (!dir) throw new Error("No projects configured.");
  return dir;
}

/**
 * GET /api/perf — Performance statistics from API request logs.
 *
 * Query params:
 *   since — ISO 8601 timestamp
 *   route — filter by route pattern
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const since = searchParams.get("since");
    const route = searchParams.get("route");

    const logDir = resolveLogDir();
    const stats = getRequestStats(logDir, {
      ...(since && { since: new Date(since) }),
      ...(route && { route }),
    });

    return NextResponse.json({
      routes: stats.routes,
      slowest: stats.slowest,
      cacheStats: stats.latestCacheStats,
      totalRequests: Object.values(stats.routes).reduce((s, r) => s + r.count, 0),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to compute perf stats" },
      { status: 500 },
    );
  }
}
